// Command proxy hosts the Anthropic reverse proxy with SSE tap — a Go port of
// tools/anthropic_proxy/server.py.
//
// It forwards every request to https://api.anthropic.com (optionally via a
// configurable upstream HTTP proxy), streams responses back to the Claude CLI
// unbuffered, and snapshots in-flight assistant content from streaming SSE
// responses to ~/.claude/cached_messages/{session_id}/{ts_ns}.json.
//
//	proxy --port 19098 --upstream-proxy http://127.0.0.1:8118
package main

import (
	"flag"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/loki/goclaudemanager/internal/proxy"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	fs := flag.NewFlagSet("proxy", flag.ContinueOnError)
	host := fs.String("host", "127.0.0.1", "bind host")
	port := fs.Int("port", envInt("ANTHROPIC_PROXY_PORT", 19098), "listen port")
	upstreamProxy := fs.String("upstream-proxy", os.Getenv("ANTHROPIC_PROXY_UPSTREAM"),
		"upstream HTTP(S) proxy URL; empty to disable")
	logLevel := fs.String("log-level", envStr("ANTHROPIC_PROXY_LOG", "INFO"),
		"log level: debug|info|warn|error")
	if err := fs.Parse(argv); err != nil {
		return 2
	}

	log := newLogger(*logLevel)
	slog.SetDefault(log)

	// Self-loop guard: refuse to forward to ourselves if --upstream-proxy
	// points at the same host:port we bind (mirrors the Python guard).
	if *upstreamProxy != "" {
		if selfLoop(*host, *port, *upstreamProxy) {
			log.Error("self-loop refused: bind and upstream-proxy share host:port",
				"port", *port, "upstream_proxy", *upstreamProxy)
			return 2
		}
	}

	srv, err := proxy.New(proxy.Config{
		UpstreamProxy: *upstreamProxy,
		Logger:        log,
	})
	if err != nil {
		log.Error("init failed", "err", err)
		return 1
	}

	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	upDisplay := *upstreamProxy
	if upDisplay == "" {
		upDisplay = "(direct)"
	}
	log.Info("starting", "pid", os.Getpid(), "addr", addr, "upstream_proxy", upDisplay)

	httpSrv := &http.Server{
		Addr:    addr,
		Handler: srv.Handler(),
		// No write timeout: SSE responses are long-lived streams.
	}
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server stopped", "err", err)
		return 1
	}
	return 0
}

func newLogger(level string) *slog.Logger {
	lvl := slog.LevelInfo
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	}
	h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl})
	return slog.New(h)
}

// selfLoop reports whether forwarding to upstreamProxy would loop back to the
// address we are binding.
func selfLoop(host string, port int, upstreamProxy string) bool {
	u, err := url.Parse(upstreamProxy)
	if err != nil {
		return false
	}
	upHost := u.Hostname()
	upPort := u.Port()
	if upPort == "" {
		switch strings.ToLower(u.Scheme) {
		case "http":
			upPort = "80"
		case "https":
			upPort = "443"
		}
	}
	loopback := map[string]bool{
		"127.0.0.1": true, "localhost": true, "::1": true, "0.0.0.0": true,
	}
	return upPort == strconv.Itoa(port) && loopback[host] && loopback[upHost]
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
