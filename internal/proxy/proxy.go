// Package proxy implements an Anthropic API reverse proxy with an SSE tap.
//
// It sits between the Claude CLI and api.anthropic.com, forwarding every
// request (optionally via a configurable upstream HTTP proxy) and streaming
// responses back to the client unbuffered so the CLI sees tokens live. For
// streaming SSE responses it incrementally aggregates the assistant message
// content (text / tool_use / thinking blocks) and snapshots it to
// ~/.claude/cached_messages/{session_id}/{ts_ns}.json roughly every 500ms so a
// frontend can preview blocks before the CLI flushes its JSONL.
//
// This is a Go port of tools/anthropic_proxy/server.py.
package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"
)

const (
	// UpstreamHost is the default Anthropic API origin.
	UpstreamHost = "https://api.anthropic.com"
	// SessionHeader carries the Claude CLI session id (untrusted input).
	SessionHeader = "x-claude-code-session-id"
	// sseBufferMax caps the accumulated SSE parse buffer; a stream that never
	// yields an event separator would otherwise grow unbounded.
	sseBufferMax = 4 * 1024 * 1024
)

// hopByHop are headers that must not be forwarded verbatim.
var hopByHop = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailers": true,
	"transfer-encoding": true, "upgrade": true, "host": true,
	"content-length": true, "content-encoding": true,
}

// sessionIDRe restricts the session id to a UUID-ish alphabet so a malicious
// header can never form a path that escapes the cache root.
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Stats are lifetime counters surfaced via /_proxy_health.
type Stats struct {
	RequestsTotal          atomic.Int64
	SessionedRequestsTotal atomic.Int64
	SSEStreamsTotal        atomic.Int64
	SnapshotsTotal         atomic.Int64
	ClientDisconnectsTotal atomic.Int64
	UpstreamErrorsTotal    atomic.Int64
	UpstreamTruncatedTotal atomic.Int64
}

// Config configures a Server.
type Config struct {
	// UpstreamHost is the API origin; defaults to UpstreamHost.
	UpstreamHost string
	// UpstreamProxy is an outbound HTTP(S) proxy URL; empty = direct.
	UpstreamProxy string
	// CacheRoot is where snapshots are written; defaults to
	// ~/.claude/cached_messages.
	CacheRoot string
	// Logger is the structured logger; defaults to slog.Default().
	Logger *slog.Logger
}

// Server is the reverse proxy handler.
type Server struct {
	upstream  *url.URL
	cacheRoot string
	log       *slog.Logger
	client    *http.Client
	stats     Stats
	startMono time.Time
}

// New builds a Server from cfg. It returns an error if the upstream host or
// upstream proxy URL cannot be parsed, or the cache root cannot be resolved.
func New(cfg Config) (*Server, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	host := cfg.UpstreamHost
	if host == "" {
		host = UpstreamHost
	}
	up, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream host %q: %w", host, err)
	}

	cacheRoot := cfg.CacheRoot
	if cacheRoot == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home dir: %w", err)
		}
		cacheRoot = filepath.Join(home, ".claude", "cached_messages")
	}
	if err := os.MkdirAll(cacheRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create cache root %s: %w", cacheRoot, err)
	}

	// Transport tuned for reused TLS sessions to api.anthropic.com (SSE win),
	// matching the shared TCPConnector in the Python version.
	transport := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   30 * time.Second,
		ExpectContinueTimeout: time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	if cfg.UpstreamProxy != "" {
		pu, err := url.Parse(cfg.UpstreamProxy)
		if err != nil {
			return nil, fmt.Errorf("invalid upstream proxy %q: %w", cfg.UpstreamProxy, err)
		}
		transport.Proxy = http.ProxyURL(pu)
	}

	return &Server{
		upstream:  up,
		cacheRoot: cacheRoot,
		log:       logger,
		client:    &http.Client{Transport: transport, Timeout: 0},
		startMono: time.Now(),
	}, nil
}

// Stats returns a pointer to the live counters (for /_proxy_health).
func (s *Server) Stats() *Stats { return &s.stats }

// Handler returns an http.Handler routing /_proxy_health to the health
// endpoint and everything else to the reverse proxy.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/_proxy_health", s.health)
	mux.HandleFunc("/", s.proxy)
	return mux
}

// safeSessionDir validates session_id and ensures its cache directory exists.
// Returns "" if the id is missing or fails validation.
func (s *Server) safeSessionDir(sessionID string) string {
	if !sessionIDRe.MatchString(sessionID) {
		return ""
	}
	d := filepath.Join(s.cacheRoot, sessionID)
	if err := os.MkdirAll(d, 0o755); err != nil {
		s.log.Warn("create session dir failed", "session", sessionID, "err", err)
		return ""
	}
	return d
}

func (s *Server) proxy(w http.ResponseWriter, r *http.Request) {
	s.stats.RequestsTotal.Add(1)
	t0 := time.Now()

	sessionID := r.Header.Get(SessionHeader)
	var sessionDir string
	if sessionID != "" {
		s.stats.SessionedRequestsTotal.Add(1)
		sessionDir = s.safeSessionDir(sessionID)
	}

	// Build upstream URL: upstream origin + incoming path + raw query.
	outURL := *s.upstream
	outURL.Path = singleJoiningSlash(s.upstream.Path, r.URL.Path)
	outURL.RawQuery = r.URL.RawQuery

	// Forward the request body by streaming r.Body directly (no buffering).
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, outURL.String(), r.Body)
	if err != nil {
		s.stats.UpstreamErrorsTotal.Add(1)
		s.log.Warn("build upstream request failed", "url", outURL.String(), "err", err)
		http.Error(w, "proxy build request error: "+err.Error(), http.StatusBadGateway)
		return
	}
	for k, vals := range r.Header {
		if hopByHop[lowerASCII(k)] {
			continue
		}
		for _, v := range vals {
			outReq.Header.Add(k, v)
		}
	}
	// Drop the client's Accept-Encoding so Go's Transport manages compression
	// itself: it then adds `Accept-Encoding: gzip`, transparently gunzips the
	// response body, and strips Content-Encoding/Content-Length from resp.Header.
	// This mirrors aiohttp's auto_decompress=True in the Python proxy. If we
	// forwarded the client's own Accept-Encoding (gzip/br/zstd), the Transport
	// would NOT decompress, yet we strip Content-Encoding downstream (hopByHop) —
	// so the client would receive a compressed body with no Content-Encoding
	// header and fail with "Failed to parse JSON". It also keeps the SSE tap fed
	// with plaintext "data:" lines instead of compressed bytes (events=0).
	outReq.Header.Del("Accept-Encoding")
	outReq.Host = s.upstream.Host

	s.log.Debug("req start", "method", r.Method, "path", r.URL.Path,
		"session", dash(sessionID))

	resp, err := s.client.Do(outReq)
	if err != nil {
		s.stats.UpstreamErrorsTotal.Add(1)
		s.log.Warn("upstream error", "url", outURL.String(), "session", dash(sessionID), "err", err)
		http.Error(w, "proxy upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers (minus hop-by-hop) and status downstream.
	dst := w.Header()
	for k, vals := range resp.Header {
		if hopByHop[lowerASCII(k)] {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}

	isSSE := sessionDir != "" &&
		containsCI(resp.Header.Get("Content-Type"), "text/event-stream")

	var agg *StreamAggregator
	if isSSE {
		s.stats.SSEStreamsTotal.Add(1)
		agg = NewStreamAggregator(sessionID, sessionDir, s.log)
	}

	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)

	clientGone, upstreamTruncated, bytesSent := s.stream(w, flusher, resp.Body, agg)

	// Safety-net final flush: covers a stream that ended without message_stop
	// (e.g. upstream truncation) where trailing blocks would otherwise never
	// hit disk. Idempotent via Dirty() so a clean message_stop suppresses it.
	if agg != nil && agg.Dirty() {
		agg.MaybeSnapshot("final")
	}
	if agg != nil {
		s.stats.SnapshotsTotal.Add(int64(agg.SnapshotsTaken))
	}
	if clientGone {
		s.stats.ClientDisconnectsTotal.Add(1)
	}
	if upstreamTruncated {
		s.stats.UpstreamTruncatedTotal.Add(1)
	}

	durMs := time.Since(t0).Milliseconds()
	events, snaps := 0, 0
	if agg != nil {
		events, snaps = agg.EventsSeen, agg.SnapshotsTaken
	}
	s.log.Info("req",
		"method", r.Method, "path", r.URL.Path, "session", dash(sessionID),
		"status", resp.StatusCode, "sse", isSSE, "dur_ms", durMs,
		"bytes", bytesSent, "events", events, "snapshots", snaps,
		"client_gone", clientGone, "upstream_truncated", upstreamTruncated)
}

// stream copies the upstream body to the client unbuffered, flushing after each
// chunk, and — when agg != nil — parses the SSE event stream to drive the
// aggregation. Returns whether the client went away, whether the upstream was
// truncated mid-stream, and the number of bytes sent downstream.
func (s *Server) stream(w io.Writer, flusher http.Flusher, body io.Reader, agg *StreamAggregator) (clientGone, upstreamTruncated bool, bytesSent int64) {
	buf := make([]byte, 32*1024)
	var sseBuf []byte
	sseOverflow := false

	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if _, werr := w.Write(chunk); werr != nil {
				clientGone = true
				break
			}
			bytesSent += int64(n)
			if flusher != nil {
				flusher.Flush()
			}

			if agg != nil {
				sseBuf = append(sseBuf, chunk...)
				if len(sseBuf) > sseBufferMax {
					if !sseOverflow {
						s.log.Warn("sse buffer cap hit; dropping accumulated buf",
							"bytes", len(sseBuf), "session", agg.sessionID)
					}
					sseOverflow = true
					sseBuf = sseBuf[:0]
				} else {
					events, leftover := parseSSEChunk(string(sseBuf))
					sseBuf = append(sseBuf[:0], leftover...)
					for _, ev := range events {
						agg.FeedEvent(ev)
						if ev.name == "message_stop" {
							agg.MaybeSnapshot("final")
						}
					}
					agg.MaybeSnapshot("snapshot")
				}
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				// Upstream cut the stream mid-flight after we'd sent headers.
				upstreamTruncated = true
				s.log.Info("upstream truncated mid-stream",
					"bytes", bytesSent, "err", readErr)
			}
			break
		}
	}
	return clientGone, upstreamTruncated, bytesSent
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(s.startMono).Seconds()
	upstreamProxy := ""
	if t, ok := s.client.Transport.(*http.Transport); ok && t.Proxy != nil {
		if pu, err := t.Proxy(r); err == nil && pu != nil {
			upstreamProxy = pu.String()
		}
	}
	writeJSON(w, map[string]any{
		"ok":                       true,
		"pid":                      os.Getpid(),
		"upstream_proxy":           upstreamProxy,
		"snapshot_dir":             s.cacheRoot,
		"uptime_s":                 round1(uptime),
		"requests_total":           s.stats.RequestsTotal.Load(),
		"sessioned_requests_total": s.stats.SessionedRequestsTotal.Load(),
		"sse_streams_total":        s.stats.SSEStreamsTotal.Load(),
		"snapshots_total":          s.stats.SnapshotsTotal.Load(),
		"client_disconnects_total": s.stats.ClientDisconnectsTotal.Load(),
		"upstream_errors_total":    s.stats.UpstreamErrorsTotal.Load(),
		"upstream_truncated_total": s.stats.UpstreamTruncatedTotal.Load(),
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(b)
}
