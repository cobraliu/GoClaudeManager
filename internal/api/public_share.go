package api

import (
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/claudestat"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// shareImageExts are images served as raw bytes for inline <img> rendering. SVG
// is text but safe in an <img> context, so it is included. Mirrors files.py
// SHARE_IMAGE_EXTS.
var shareImageExts = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {},
	".bmp": {}, ".svg": {}, ".ico": {}, ".avif": {},
}

const (
	maxShareRawSize  = 25 * 1024 * 1024 // 25 MB cap for raw image serving
	maxShareDirEnts  = 1000             // MAX_DIR_ENTRIES guard for share listings
	shareMaxFileSize = 1 * 1024 * 1024  // MAX_FILE_SIZE — text-file content cap
)

// PublicShareRouter builds the UNAUTHENTICATED public viewer router, mounted by
// the lead at /api/public/share. It backs the read-only conversation view,
// optional file browsing if the share grants it, and (for share_type=="chat")
// accepting a chat prompt delivered to the live session's tmux pane.
//
// Mirrors public_router in app/api/shares.py; paths and JSON shapes are kept
// identical so the existing share viewer needs no changes.
func PublicShareRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Get("/{hash}", func(w http.ResponseWriter, req *http.Request) { shareMeta(d, w, req) })
	r.Get("/{hash}/messages", func(w http.ResponseWriter, req *http.Request) { shareMessages(d, w, req) })
	r.Get("/{hash}/files", func(w http.ResponseWriter, req *http.Request) { shareFiles(d, w, req) })
	r.Get("/{hash}/file", func(w http.ResponseWriter, req *http.Request) { shareFile(d, w, req) })
	r.Get("/{hash}/raw", func(w http.ResponseWriter, req *http.Request) { shareRaw(d, w, req) })
	r.Post("/{hash}/prompt", func(w http.ResponseWriter, req *http.Request) { sharePrompt(d, w, req) })
	return r
}

// ── GET /{hash} ──────────────────────────────────────────────────────────────

func shareMeta(d Deps, w http.ResponseWriter, r *http.Request) {
	rec := sharedShareCache(d).Get(chi.URLParam(r, "hash"))
	if rec == nil {
		writeErr(w, http.StatusNotFound, "share not found or expired")
		return
	}
	session, _ := d.Store.GetSession(rec.SessionID)
	hasFiles := rec.FileAccess != nil && (len(rec.FileAccess.Full) > 0 || len(rec.FileAccess.Files) > 0)
	title := "Shared conversation"
	if session != nil {
		title = session.Name
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hash":          rec.Hash,
		"share_type":    rec.ShareType,
		"title":         title,
		"created_at":    rec.CreatedAt,
		"expires_at":    rec.ExpiresAt,
		"cutoff_ts":     rec.CutoffTs,
		"default_theme": rec.DefaultTheme,
		"has_files":     hasFiles,
		"session_alive": sessionAlive(session),
	})
}

func sessionAlive(s *model.Session) bool {
	return s != nil && (s.Status == model.StatusRunning || s.Status == model.StatusDetached)
}

// ── GET /{hash}/messages ─────────────────────────────────────────────────────

// shareMessages returns a forward (oldest→newest) page of the shared
// conversation. Messages are ALWAYS ascending. tail=false returns the ascending
// slice [offset:offset+limit]; tail=true returns the LAST `limit` messages
// (offset ignored). The envelope matches the Python endpoint:
// {messages, total, title, share_type, expires_at, session_alive}.
//
// The shared viewer renders with renderConversationBody — the SAME raw-JSONL
// renderer as the Chat export — so this endpoint must return RAW renderer
// entries ({type, message:{role, content:[blocks]}, timestamp, ...}), NOT the
// simplified chat bubbles GetConversation produces. We mirror Python
// get_share_messages: read_raw_messages_page with cutoff_ts + offset windowing,
// the cursor top-level→Claude-shape transform, and codex left empty (its reader
// is not ported to Go).
func shareMessages(d Deps, w http.ResponseWriter, r *http.Request) {
	rec := sharedShareCache(d).Get(chi.URLParam(r, "hash"))
	if rec == nil {
		writeErr(w, http.StatusNotFound, "share not found or expired")
		return
	}
	session, _ := d.Store.GetSession(rec.SessionID)
	if session == nil {
		writeErr(w, http.StatusNotFound, "session no longer exists")
		return
	}

	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 1
	}
	if limit > 2000 {
		limit = 2000
	}
	tail := r.URL.Query().Get("tail") == "true"

	resp := func(messages any, total int) {
		writeJSON(w, http.StatusOK, map[string]any{
			"messages":      messages,
			"total":         total,
			"title":         session.Name,
			"share_type":    rec.ShareType,
			"expires_at":    rec.ExpiresAt,
			"session_alive": sessionAlive(session),
		})
	}

	// limited shares freeze at the cutoff timestamp (inclusive of the chosen
	// turn, matching compute_share_cutoff); full/chat shares have no cutoff.
	var cutoff *float64
	if rec.ShareType == "limited" {
		cutoff = rec.CutoffTs
	}

	// Codex transcript reader is not ported to Go — mirror the empty body the
	// other Go codex paths return.
	if session.Tool == "codex" {
		resp([]any{}, 0)
		return
	}

	// Resolve via resolveChatSID so a stale stored agent_session_id (one that no
	// longer matches a JSONL on disk) falls back to the newest transcript in the
	// cwd — otherwise the shared page renders no messages. Mirrors the Chat fix.
	chatSID := resolveChatSID(d, session)
	jsonlPath := ""
	if chatSID != "" {
		jsonlPath = resolveJSONLPath(session.Tool, chatSID, session.Cwd)
	}
	if jsonlPath == "" {
		resp([]any{}, 0)
		return
	}

	// Cursor stores {"role": ...} at top level; transform the full cutoff-filtered
	// ordered list (stable cursor-{idx} ids) to the Claude raw shape before
	// slicing, matching Python's cursor branch.
	if session.Tool == "cursor" {
		full := jsonl.ReadRawMessagesPageFull(jsonlPath, 0, cutoff, nil)
		transformed := transformCursorRaw(full.Messages)
		total := len(transformed)
		var window []map[string]any
		switch {
		case tail:
			start := total - limit
			if start < 0 {
				start = 0
			}
			window = transformed[start:]
		case offset >= total:
			window = []map[string]any{}
		default:
			end := offset + limit
			if end > total {
				end = total
			}
			window = transformed[offset:end]
		}
		if window == nil {
			window = []map[string]any{}
		}
		resp(window, total)
		return
	}

	// claude: raw renderer entries. offset=nil makes ReadRawMessagesPageFull
	// return the last `limit` entries (tail view); otherwise the ascending
	// [offset:offset+limit] slice.
	var off *int
	if !tail {
		off = &offset
	}
	page := jsonl.ReadRawMessagesPageFull(jsonlPath, limit, cutoff, off)
	resp(page.Messages, page.Total)
}

// ── public file access ───────────────────────────────────────────────────────
// A share may expose project files for read-only browsing. The spec is
// {full:[dirs], files:[files]} (paths relative to session cwd). `full` dirs
// grant their whole non-hidden, non-skipped subtree; `files` are individual
// grants. Every access goes through filesResolve (traversal guard) AND the spec
// check below. Mirrors the helpers in app/api/shares.py.

func shareNorm(rel string) string {
	return strings.Trim(strings.TrimSpace(rel), "/")
}

func shareSegmentHiddenOrSkipped(d Deps, rel string) bool {
	skip := map[string]struct{}{}
	for _, n := range d.Cfg.SkipDirs() {
		skip[n] = struct{}{}
	}
	for _, p := range strings.Split(shareNorm(rel), "/") {
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, ".") {
			return true
		}
		if _, ok := skip[p]; ok {
			return true
		}
	}
	return false
}

func shareIsUnderFull(spec *model.FileAccessSpec, rel string) bool {
	rel = shareNorm(rel)
	for _, d := range spec.Full {
		d = shareNorm(d)
		if d == "" {
			return true // full grant on the project root
		}
		if rel == d || strings.HasPrefix(rel, d+"/") {
			return true
		}
	}
	return false
}

func shareIsFileAllowed(d Deps, spec *model.FileAccessSpec, rel string) bool {
	rel = shareNorm(rel)
	for _, f := range spec.Files {
		if shareNorm(f) == rel {
			return true // explicit grant — honored even if hidden
		}
	}
	return shareIsUnderFull(spec, rel) && !shareSegmentHiddenOrSkipped(d, rel)
}

func shareHasAllowedDescendant(spec *model.FileAccessSpec, relDir string) bool {
	prefix := shareNorm(relDir)
	needle := prefix + "/"
	for _, p := range append(append([]string{}, spec.Files...), spec.Full...) {
		p = shareNorm(p)
		if prefix == "" || p == prefix || strings.HasPrefix(p, needle) {
			return true
		}
	}
	return false
}

// shareSpec resolves (rec, session, spec) for a file-enabled share, writing the
// matching HTTP error and returning ok=false otherwise.
func shareSpec(d Deps, w http.ResponseWriter, r *http.Request) (*model.ShareRecord, *model.Session, *model.FileAccessSpec, bool) {
	rec := sharedShareCache(d).Get(chi.URLParam(r, "hash"))
	if rec == nil {
		writeErr(w, http.StatusNotFound, "share not found or expired")
		return nil, nil, nil, false
	}
	spec := rec.FileAccess
	if spec == nil || (len(spec.Full) == 0 && len(spec.Files) == 0) {
		writeErr(w, http.StatusNotFound, "no files shared")
		return nil, nil, nil, false
	}
	session, _ := d.Store.GetSession(rec.SessionID)
	if session == nil {
		writeErr(w, http.StatusNotFound, "session no longer exists")
		return nil, nil, nil, false
	}
	return rec, session, spec, true
}

type shareFileEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Type      string `json:"type"`
	Size      *int64 `json:"size"`
	IsText    bool   `json:"is_text"`
	IsSqlite  bool   `json:"is_sqlite"`
	IsArchive bool   `json:"is_archive"`
}

func shareVisibleChildren(d Deps, spec *model.FileAccessSpec, sessionCwd, relDir string) []shareFileEntry {
	base := filepath.Clean(sessionCwd)
	target, ok := safeShareResolve(sessionCwd, relDir)
	if !ok {
		return []shareFileEntry{}
	}
	fullHere := shareIsUnderFull(spec, relDir)

	dirEntries, err := os.ReadDir(target)
	if err != nil {
		return []shareFileEntry{}
	}
	// Hidden entries are never listed.
	filtered := dirEntries[:0]
	for _, e := range dirEntries {
		if !strings.HasPrefix(e.Name(), ".") {
			filtered = append(filtered, e)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		fi, fj := !filtered[i].IsDir(), !filtered[j].IsDir()
		if fi != fj {
			return !fi // dirs first
		}
		return strings.ToLower(filtered[i].Name()) < strings.ToLower(filtered[j].Name())
	})

	skip := map[string]struct{}{}
	for _, n := range d.Cfg.SkipDirs() {
		skip[n] = struct{}{}
	}

	entries := make([]shareFileEntry, 0, len(filtered))
	for _, e := range filtered {
		if len(entries) >= maxShareDirEnts {
			break
		}
		isDir := e.IsDir()
		if isDir {
			if _, bad := skip[e.Name()]; bad {
				continue
			}
		}
		full := filepath.Join(target, e.Name())
		rel := filesRelTo(base, full)

		var visible bool
		switch {
		case fullHere:
			visible = true
		case isDir:
			visible = shareIsUnderFull(spec, rel) || shareHasAllowedDescendant(spec, rel)
		default:
			for _, f := range spec.Files {
				if shareNorm(f) == shareNorm(rel) {
					visible = true
					break
				}
			}
		}
		if !visible {
			continue
		}

		isSq := !isDir && filesIsSqliteName(e.Name())
		isArc := !isDir && filesIsArchiveName(e.Name())
		var size *int64
		if !isDir {
			if info, ierr := e.Info(); ierr == nil {
				sz := info.Size()
				size = &sz
			}
		}
		isText := false
		if !isDir && !isSq && !isArc {
			isText = isProbablyTextName(e.Name())
		}
		entries = append(entries, shareFileEntry{
			Name:      e.Name(),
			Path:      rel,
			Type:      ternary(isDir, "dir", "file"),
			Size:      size,
			IsText:    isText,
			IsSqlite:  isSq,
			IsArchive: isArc,
		})
	}
	return entries
}

// ── GET /{hash}/files ────────────────────────────────────────────────────────

func shareFiles(d Deps, w http.ResponseWriter, r *http.Request) {
	_, session, spec, ok := shareSpec(d, w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	target, rok := safeShareResolve(session.Cwd, path)
	if !rok {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}
	rel := shareNorm(path)
	// The requested dir must itself be visible: under a full grant, or a partial
	// container on the path to a granted entry (root is always allowed).
	if rel != "" && !(shareIsUnderFull(spec, rel) || shareHasAllowedDescendant(spec, rel)) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	base := filepath.Clean(session.Cwd)
	relCurrent := ""
	if target != base {
		relCurrent = filesRelTo(base, target)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": shareVisibleChildren(d, spec, session.Cwd, path),
		"path":    relCurrent,
	})
}

// ── GET /{hash}/file ─────────────────────────────────────────────────────────

func shareFile(d Deps, w http.ResponseWriter, r *http.Request) {
	_, session, spec, ok := shareSpec(d, w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	rel := shareNorm(path)
	if !shareIsFileAllowed(d, spec, rel) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	target, rok := safeShareResolve(session.Cwd, path)
	if !rok {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	tooLarge := info.Size() > shareMaxFileSize
	content, rerr := os.ReadFile(target)
	if tooLarge || rerr != nil || !looksTextual(content) {
		writeJSON(w, http.StatusOK, map[string]any{
			"path": rel, "content": "", "is_text": false, "too_large": tooLarge,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path": rel, "content": string(content), "is_text": true, "too_large": false,
	})
}

// ── GET /{hash}/raw ──────────────────────────────────────────────────────────

func shareRaw(d Deps, w http.ResponseWriter, r *http.Request) {
	_, session, spec, ok := shareSpec(d, w, r)
	if !ok {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	rel := shareNorm(path)
	if !shareIsFileAllowed(d, spec, rel) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	target, rok := safeShareResolve(session.Cwd, path)
	if !rok {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if _, isImg := shareImageExts[strings.ToLower(filepath.Ext(target))]; !isImg {
		writeErr(w, http.StatusUnsupportedMediaType, "only images can be served raw")
		return
	}
	if info.Size() > maxShareRawSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large")
		return
	}
	f, err := os.Open(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	defer f.Close()
	ct := mime.TypeByExtension(filepath.Ext(target))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// ── POST /{hash}/prompt (chat shares only) ───────────────────────────────────

type sharePromptReq struct {
	Text string `json:"text"`
}

func sharePrompt(d Deps, w http.ResponseWriter, r *http.Request) {
	rec := sharedShareCache(d).Get(chi.URLParam(r, "hash"))
	if rec == nil || rec.ShareType != "chat" {
		writeErr(w, http.StatusNotFound, "share not found or not interactive")
		return
	}
	var body sharePromptReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Text == "" {
		writeErr(w, http.StatusUnprocessableEntity, "text required")
		return
	}
	session, _ := d.Store.GetSession(rec.SessionID)
	if session == nil {
		writeErr(w, http.StatusNotFound, "session no longer exists")
		return
	}
	if !sessionAlive(session) {
		writeErr(w, http.StatusConflict, "offline")
		return
	}
	// AUQ guard: sdk sessions consult the pump state; tmux sessions use the
	// claude-specific PID file (nil for other tools, so a cheap no-op).
	if session.Transport == "sdk" {
		if st, ok := d.SDK.State(session.ID); ok && st.PendingAUQ != nil {
			writeErr(w, http.StatusConflict, "auq_pending")
			return
		}
	} else if sharePidWaitingForAUQ(session.ClaudeProcPID) {
		writeErr(w, http.StatusConflict, "auq_pending")
		return
	}

	if _, err := d.Store.AppendPromptHistory(session.ID, body.Text, nowUnix(), strPtr("0")); err != nil {
		slog.Warn("share prompt: append_prompt_history failed", "session", session.ID, "err", err)
	}
	if session.Transport == "sdk" {
		if err := d.SDK.Send(session.ID, body.Text); err != nil {
			writeErr(w, http.StatusInternalServerError, "send failed: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	paneTarget := session.TmuxSessionName + ":0.0"
	if err := d.Tmux.DeliverToPane(paneTarget, body.Text, true); err != nil {
		writeErr(w, http.StatusInternalServerError, "send failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func sharePidWaitingForAUQ(pid *int) bool {
	if pid == nil {
		return false
	}
	_, hintType, ok := claudestat.GetPIDWaitingState(*pid)
	return ok && hintType == "auq"
}

// ── small helpers ────────────────────────────────────────────────────────────

func strPtr(s string) *string { return &s }

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// safeShareResolve resolves rel inside root with a traversal guard, returning
// the cleaned absolute path and ok=false if it escapes root.
func safeShareResolve(root, rel string) (string, bool) {
	base := filepath.Clean(root)
	target := filepath.Clean(filepath.Join(base, rel))
	if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		return "", false
	}
	return target, true
}

// isProbablyTextName guesses text-ness from the file name alone (no I/O), used
// for directory listings. Mirrors the spirit of files.py _is_probably_text.
func isProbablyTextName(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return true // extensionless files are usually text (README, LICENSE, ...)
	}
	_, binary := shareBinaryExts[ext]
	return !binary
}

// looksTextual reports whether content is likely UTF-8 text (no NUL bytes in the
// inspected prefix), mirroring the _is_text byte heuristic.
func looksTextual(content []byte) bool {
	n := len(content)
	if n > 8192 {
		n = 8192
	}
	for _, b := range content[:n] {
		if b == 0 {
			return false
		}
	}
	return true
}

var shareBinaryExts = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".bmp": {},
	".ico": {}, ".avif": {}, ".pdf": {}, ".zip": {}, ".gz": {}, ".bz2": {},
	".xz": {}, ".tar": {}, ".tgz": {}, ".7z": {}, ".rar": {}, ".exe": {},
	".dll": {}, ".so": {}, ".dylib": {}, ".o": {}, ".a": {}, ".class": {},
	".jar": {}, ".wasm": {}, ".bin": {}, ".db": {}, ".sqlite": {}, ".sqlite3": {},
	".mp3": {}, ".mp4": {}, ".mov": {}, ".avi": {}, ".wav": {}, ".flac": {},
	".woff": {}, ".woff2": {}, ".ttf": {}, ".otf": {}, ".eot": {},
}
