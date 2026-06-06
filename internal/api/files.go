package api

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/loki/goclaudemanager/internal/fsutil"
)

// ── Constants ported from app/api/files.py ──────────────────────────────────

const (
	filesMaxFileSize    = 1 * 1024 * 1024   // MAX_FILE_SIZE (1 MB) — fs/read + fs/write cap
	filesMaxUpload      = 16 * 1024 * 1024  // MAX_UPLOAD_SIZE — fs/upload cap
	filesMaxAttachment  = 50 * 1024 * 1024  // MAX_ATTACHMENT_SIZE — upload-attachment/image cap
	filesArchiveMaxSize = 100 * 1024 * 1024 // ARCHIVE_MAX_SIZE — archive-list / extract cap
	filesRawMaxSize     = 100 * 1024 * 1024        // fs/raw cap
	filesMediaMaxSize   = 2 * 1024 * 1024 * 1024   // fs/media cap (streamed; just a sanity bound)
	filesDownloadMax    = 100 * 1024 * 1024 // _DOWNLOAD_MAX_BYTES — download-zip cap
	filesSqliteRowLimit = 500               // SQLITE_ROW_LIMIT
	filesArchiveMaxEnts = 2000              // _list_archive_entries cap
)

// attachmentUploadSubdir mirrors files.py ATTACHMENT_UPLOAD_SUBDIR (.claude/uploads).
var filesAttachmentSubdir = filepath.Join(".claude", "uploads")

// filesImageExts mirrors files.py IMAGE_EXTS.
var filesImageExts = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {},
}

// filesSqliteExts mirrors files.py SQLITE_EXTENSIONS.
var filesSqliteExts = map[string]struct{}{
	".db": {}, ".sqlite": {}, ".sqlite3": {}, ".db3": {},
}

// archive suffixes (longest-first matters for stem stripping); mirrors
// files.py ARCHIVE_EXTENSIONS_SUFFIX.
var filesArchiveSuffixes = []string{
	".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz",
	".tar", ".zip", ".gz", ".bz2", ".xz",
}

// _IMAGE_FILENAME_RE — 32-hex uuid + image extension. Load-bearing
// path-traversal guard for inline image serving.
var filesImageFilenameRE = regexp.MustCompile(`^[a-f0-9]{32}\.(?:png|jpg|jpeg|gif|webp)$`)

// _EXT_SANITIZE_RE — strips non-alphanumeric chars from stored extensions.
var filesExtSanitizeRE = regexp.MustCompile(`[^A-Za-z0-9]`)

// ── Route registration ──────────────────────────────────────────────────────

// registerFilesRoutes registers the session-scoped filesystem endpoints on r
// (paths relative to the /api/sessions mount). The caller already applies
// d.Auth.RequireUser; the uploaded-image route additionally accepts a query
// token because <img> tags cannot send Authorization headers.
func registerFilesRoutes(r chi.Router, d Deps) {
	// Read-only (backed by fsutil where possible).
	r.Get("/{id}/fs/list", func(w http.ResponseWriter, req *http.Request) { fsList(d, w, req) })
	r.Post("/{id}/fs/dirstat", func(w http.ResponseWriter, req *http.Request) { fsDirStat(d, w, req) })
	r.Get("/{id}/fs/search", func(w http.ResponseWriter, req *http.Request) { fsSearch(d, w, req) })
	r.Get("/{id}/fs/read", func(w http.ResponseWriter, req *http.Request) { fsRead(d, w, req) })
	r.Get("/{id}/fs/raw", func(w http.ResponseWriter, req *http.Request) { fsRaw(d, w, req) })
	r.Get("/{id}/fs/dir-info", func(w http.ResponseWriter, req *http.Request) { fsDirInfo(d, w, req) })
	r.Get("/{id}/fs/archive-list", func(w http.ResponseWriter, req *http.Request) { fsArchiveList(d, w, req) })
	r.Get("/{id}/fs/sqlite", func(w http.ResponseWriter, req *http.Request) { fsSqliteQuery(d, w, req) })

	// Mutating.
	r.Post("/{id}/fs/mkdir", func(w http.ResponseWriter, req *http.Request) { fsMkdir(d, w, req) })
	r.Post("/{id}/fs/upload", func(w http.ResponseWriter, req *http.Request) { fsUpload(d, w, req) })
	// Python exposes fs/write as PUT; register both PUT and POST so either works.
	r.Put("/{id}/fs/write", func(w http.ResponseWriter, req *http.Request) { fsWrite(d, w, req) })
	r.Post("/{id}/fs/write", func(w http.ResponseWriter, req *http.Request) { fsWrite(d, w, req) })
	r.Post("/{id}/fs/move", func(w http.ResponseWriter, req *http.Request) { fsMove(d, w, req) })
	r.Post("/{id}/fs/rename", func(w http.ResponseWriter, req *http.Request) { fsRename(d, w, req) })
	r.Post("/{id}/fs/delete", func(w http.ResponseWriter, req *http.Request) { fsDelete(d, w, req) })
	r.Post("/{id}/fs/extract", func(w http.ResponseWriter, req *http.Request) { fsExtract(d, w, req) })
	r.Post("/{id}/fs/download-zip", func(w http.ResponseWriter, req *http.Request) { fsDownloadZip(d, w, req) })
	r.Post("/{id}/fs/sqlite/exec", func(w http.ResponseWriter, req *http.Request) { fsSqliteExec(d, w, req) })

	// Attachment / image uploads. The GET /{id}/uploaded-image/{filename}
	// counterpart is registered in sessionsRouter OUTSIDE the RequireUser
	// group: <img> tags can't send Authorization headers, so that handler
	// authenticates its query `token` param itself.
	r.Post("/{id}/upload-attachment", func(w http.ResponseWriter, req *http.Request) { fsUploadAttachment(d, w, req) })
	r.Post("/{id}/upload-image", func(w http.ResponseWriter, req *http.Request) { fsUploadAttachment(d, w, req) })
}

// ── Shared helpers ───────────────────────────────────────────────────────────

// filesResolve resolves rel inside the session cwd, writing the matching HTTP
// error (403 traversal / 404 not found) and returning ok=false on failure.
func filesResolve(w http.ResponseWriter, root, rel string) (string, bool) {
	target, err := fsutil.SafePath(root, rel)
	if err != nil {
		writeErr(w, http.StatusForbidden, "path traversal not allowed")
		return "", false
	}
	return target, true
}

func filesRelTo(base, target string) string {
	rel, err := filepath.Rel(filepath.Clean(base), target)
	if err != nil {
		return filepath.Base(target)
	}
	return rel
}

func filesExtLower(name string) string { return strings.ToLower(filepath.Ext(name)) }

func filesIsSqliteName(name string) bool {
	_, ok := filesSqliteExts[filesExtLower(name)]
	return ok
}

func filesIsArchiveName(name string) bool {
	n := strings.ToLower(name)
	for _, s := range filesArchiveSuffixes {
		if strings.HasSuffix(n, s) {
			return true
		}
	}
	return false
}

// ── POST /{id}/fs/dirstat ────────────────────────────────────────────────────
//
// Cheap change-detection for the file tree. Returns each requested directory's
// mtime (Unix nanoseconds) WITHOUT reading its entries. Adding, removing, or
// renaming an entry bumps the containing directory's mtime (POSIX), so the
// client polls this for its currently-expanded directories and only re-fetches
// the full listing (fs/list) for directories whose mtime changed. Steady-state
// polling is thus one tiny request instead of re-transferring every expanded
// directory's contents. (Pure file-content edits don't change a directory's
// mtime, which is fine — they don't change the listing.) Missing/non-dir paths
// are omitted; the client treats an omitted path as changed/gone.
type fsDirStatReq struct {
	Paths []string `json:"paths"`
}

func fsDirStat(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body fsDirStatReq
	if !readJSON(w, r, &body) {
		return
	}
	const maxPaths = 1000
	if len(body.Paths) > maxPaths {
		body.Paths = body.Paths[:maxPaths]
	}
	stats := make(map[string]int64, len(body.Paths))
	for _, rel := range body.Paths {
		target, err := fsutil.SafePath(s.Cwd, rel)
		if err != nil {
			continue // traversal → skip (don't leak which paths are rejected)
		}
		info, err := os.Stat(target)
		if err != nil || !info.IsDir() {
			continue // gone or not a dir → omit; client re-lists/handles
		}
		stats[rel] = info.ModTime().UnixNano()
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": stats})
}

// ── GET /{id}/fs/list ────────────────────────────────────────────────────────

func fsList(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	hidden := r.URL.Query().Get("hidden") == "true"

	target, ok := filesResolve(w, s.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}
	if !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "not a directory")
		return
	}

	entries, err := fsutil.ListDir(s.Cwd, path, d.Cfg.SkipDirs(), hidden)
	if err != nil {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}
	relCurrent := filesRelTo(s.Cwd, target)
	if relCurrent == "." {
		relCurrent = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": nonNilSlice(entries),
		"path":    relCurrent,
	})
}

// ── GET /{id}/fs/search ──────────────────────────────────────────────────────

func fsSearch(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeErr(w, http.StatusUnprocessableEntity, "q required")
		return
	}
	hidden := r.URL.Query().Get("hidden") == "true"

	results, err := fsutil.SearchNames(s.Cwd, q, d.Cfg.SkipDirs(), hidden)
	if err != nil {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": nonNilSlice(results),
		"path":    "",
	})
}

// ── GET /{id}/fs/read ────────────────────────────────────────────────────────

func fsRead(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}

	// Use fsutil.ReadFile with unlimited mode so the returned content is the
	// full file (mirroring files.py read_file which returns the whole text),
	// while reusing its size/binary guards.
	fc, err := fsutil.ReadFile(s.Cwd, path, fsutil.ViewerSettings{Mode: fsutil.FileViewerModeUnlimited})
	if err != nil {
		switch {
		case errors.Is(err, fsutil.ErrTraversal):
			writeErr(w, http.StatusForbidden, "path traversal not allowed")
		case errors.Is(err, fsutil.ErrNotFound), errors.Is(err, fsutil.ErrNotFile):
			writeErr(w, http.StatusNotFound, "file not found")
		case errors.Is(err, fsutil.ErrTooLarge):
			writeErr(w, http.StatusRequestEntityTooLarge, "file too large (>1MB)")
		case errors.Is(err, fsutil.ErrBinary):
			writeErr(w, http.StatusUnsupportedMediaType, "binary file not supported")
		default:
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	// files.py FileContent shape: {path, content} only.
	writeJSON(w, http.StatusOK, map[string]any{"path": fc.Path, "content": fc.Content})
}

// ── GET /{id}/fs/raw ─────────────────────────────────────────────────────────

func fsRaw(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	download := r.URL.Query().Get("download") == "true"

	target, ok := filesResolve(w, s.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if info.Size() > filesRawMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large (>100MB)")
		return
	}

	serveFileContent(w, r, target, info, download)
}

// serveFileContent streams target with HTTP Range / conditional-GET support via
// http.ServeContent (206 Partial Content + Accept-Ranges for <video>/<audio>
// seeking; If-Range / If-None-Match / If-Modified-Since → 304 for caching). It
// sets the Content-Type from the extension, an ETag derived from mtime+size,
// and a private Cache-Control. The caller has already done auth, traversal, and
// size checks; info is the Stat result for target.
func serveFileContent(w http.ResponseWriter, r *http.Request, target string, info os.FileInfo, download bool) {
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
	w.Header().Set("ETag", fmt.Sprintf(`"%x-%x"`, info.ModTime().UnixNano(), info.Size()))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if download {
		encoded := url.PathEscape(filepath.Base(target))
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+encoded)
	}
	http.ServeContent(w, r, filepath.Base(target), info.ModTime(), f)
}

// fsServeMedia streams an audio/video (or any) file for inline playback via a
// <video>/<audio> element. Those tags cannot send an Authorization header, so —
// like fsServeUploadedImage — auth is via the query `token` param, verified
// alongside a session-ownership check. The path is resolved traversal-safe
// inside the session cwd and served through serveFileContent (Range + caching).
func fsServeMedia(d Deps, w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := d.Auth.VerifyToken(token)
	if err != nil || id == nil || id.Username == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	sessionID := chi.URLParam(r, "id")
	sess, serr := d.Store.GetSession(sessionID)
	if serr != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if sess == nil || sess.OwnerID != id.Username {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	target, ok := filesResolve(w, sess.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if info.Size() > filesMediaMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large")
		return
	}
	serveFileContent(w, r, target, info, false)
}

// ── GET /{id}/fs/dir-info ────────────────────────────────────────────────────

func fsDirInfo(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	withSizes := r.URL.Query().Get("with_sizes") != "false" // default true

	base := filepath.Clean(s.Cwd)
	var target string
	if path == "" {
		target = base
	} else {
		var ok bool
		target, ok = filesResolve(w, s.Cwd, path)
		if !ok {
			return
		}
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		writeErr(w, http.StatusNotFound, "directory not found")
		return
	}

	dirEntries, err := os.ReadDir(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	sort.SliceStable(dirEntries, func(i, j int) bool {
		fi, fj := !dirEntries[i].IsDir(), !dirEntries[j].IsDir()
		if fi != fj {
			return !fi // dirs first
		}
		return strings.ToLower(dirEntries[i].Name()) < strings.ToLower(dirEntries[j].Name())
	})

	type dirInfoItem struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	}
	items := make([]dirInfoItem, 0, len(dirEntries))
	var total int64
	for _, e := range dirEntries {
		full := filepath.Join(target, e.Name())
		rel := filesRelTo(base, full)
		if e.IsDir() {
			var sz int64
			if withSizes {
				sz = dirSize(full)
			}
			items = append(items, dirInfoItem{Name: e.Name(), Path: rel, Type: "dir", Size: sz})
			total += sz
		} else {
			fi, ferr := e.Info()
			if ferr != nil {
				continue
			}
			items = append(items, dirInfoItem{Name: e.Name(), Path: rel, Type: "file", Size: fi.Size()})
			total += fi.Size()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"total_size": total, "items": items})
}

// dirSize recursively sums file sizes under path (mirrors _dir_size).
func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, de os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !de.IsDir() {
			if fi, ferr := de.Info(); ferr == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

// ── GET /{id}/fs/archive-list ────────────────────────────────────────────────

func fsArchiveList(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	target, ok := filesResolve(w, s.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if !filesIsArchiveName(filepath.Base(target)) {
		writeErr(w, http.StatusUnsupportedMediaType, "not a supported archive format")
		return
	}
	if info.Size() > filesArchiveMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "archive too large (>100MB)")
		return
	}
	entries := listArchiveEntries(target)
	writeJSON(w, http.StatusOK, map[string]any{"entries": nonNilSlice(entries), "total": len(entries)})
}

// listArchiveEntries returns paths inside an archive (no extraction), capped at
// filesArchiveMaxEnts. Mirrors files.py _list_archive_entries.
func listArchiveEntries(path string) []string {
	n := strings.ToLower(filepath.Base(path))
	var entries []string
	switch {
	case strings.HasSuffix(n, ".zip"):
		zr, err := zip.OpenReader(path)
		if err == nil {
			defer zr.Close()
			for _, f := range zr.File {
				entries = append(entries, f.Name)
				if len(entries) >= filesArchiveMaxEnts {
					break
				}
			}
		}
	case isTarName(n):
		f, err := os.Open(path)
		if err == nil {
			defer f.Close()
			if tr, derr := tarReader(f, n); derr == nil {
				for {
					hdr, terr := tr.Next()
					if terr != nil {
						break
					}
					entries = append(entries, hdr.Name)
					if len(entries) >= filesArchiveMaxEnts {
						break
					}
				}
			}
		}
	case strings.HasSuffix(n, ".gz"):
		entries = []string{filepath.Base(path)[:len(filepath.Base(path))-3]}
	case strings.HasSuffix(n, ".bz2"):
		entries = []string{filepath.Base(path)[:len(filepath.Base(path))-4]}
	case strings.HasSuffix(n, ".xz"):
		entries = []string{filepath.Base(path)[:len(filepath.Base(path))-3]}
	}
	if len(entries) > filesArchiveMaxEnts {
		entries = entries[:filesArchiveMaxEnts]
	}
	return entries
}

func isTarName(lower string) bool {
	for _, s := range []string{".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar"} {
		if strings.HasSuffix(lower, s) {
			return true
		}
	}
	return false
}

// tarReader wraps r in the proper decompressor for a tar archive named (lower).
func tarReader(r io.Reader, lower string) (*tar.Reader, error) {
	switch {
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		return tar.NewReader(gz), nil
	case strings.HasSuffix(lower, ".tar.bz2"), strings.HasSuffix(lower, ".tbz2"):
		return tar.NewReader(bzip2.NewReader(r)), nil
	case strings.HasSuffix(lower, ".tar.xz"), strings.HasSuffix(lower, ".txz"):
		// xz decompression requires a third-party module not available in this
		// build; .tar.xz / .txz are not supported here.
		return nil, fmt.Errorf("xz-compressed archives are not supported")
	case strings.HasSuffix(lower, ".tar"):
		return tar.NewReader(r), nil
	}
	return nil, fmt.Errorf("not a tar archive")
}

// ── POST /{id}/fs/mkdir ──────────────────────────────────────────────────────

type mkdirReq struct {
	Path string `json:"path"`
}

func fsMkdir(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body mkdirReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	target, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /{id}/fs/upload ─────────────────────────────────────────────────────

func fsUpload(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if err := r.ParseMultipartForm(filesMaxUpload + 1<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	path := r.FormValue("path")
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()
	if hdr.Filename == "" {
		writeErr(w, http.StatusBadRequest, "filename required")
		return
	}

	content, err := io.ReadAll(io.LimitReader(file, filesMaxUpload+1))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(content) > filesMaxUpload {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large (>%dMB)", filesMaxUpload/1024/1024))
		return
	}

	var targetDir string
	if path != "" {
		var ok bool
		targetDir, ok = filesResolve(w, s.Cwd, path)
		if !ok {
			return
		}
	} else {
		targetDir = filepath.Clean(s.Cwd)
	}
	if info, statErr := os.Stat(targetDir); statErr == nil && !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "target path is not a directory")
		return
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// filepath.Base on the upload filename guards against traversal in the name.
	dest := filepath.Join(targetDir, filepath.Base(hdr.Filename))
	if err := os.WriteFile(dest, content, 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST/PUT /{id}/fs/write ──────────────────────────────────────────────────

type writeReq struct {
	Path          string   `json:"path"`
	Content       string   `json:"content"`
	ExpectedMtime *float64 `json:"expected_mtime"`
	Force         bool     `json:"force"`
}

func fsWrite(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body writeReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	target, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		writeErr(w, http.StatusBadRequest, "path is a directory")
		return
	}
	if len(body.Content) > filesMaxFileSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "content too large (>1MB)")
		return
	}

	if body.ExpectedMtime != nil && !body.Force {
		if info, err := os.Stat(target); err == nil {
			cur := mtimeFloat(info)
			if math.Abs(cur-*body.ExpectedMtime) > 0.001 {
				writeJSON(w, http.StatusConflict, map[string]any{
					"detail": map[string]any{
						"message":        "file was modified externally since editing began",
						"current_mtime":  cur,
						"expected_mtime": *body.ExpectedMtime,
					},
				})
				return
			}
		}
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(target, []byte(body.Content), 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mtime": mtimeFloat(info)})
}

// mtimeFloat returns the modification time as a fractional Unix timestamp,
// matching Python's stat().st_mtime.
func mtimeFloat(info os.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e9
}

// ── POST /{id}/fs/move ───────────────────────────────────────────────────────

type moveReq struct {
	Path    string `json:"path"`
	DestDir string `json:"dest_dir"`
}

func fsMove(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body moveReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	base := filepath.Clean(s.Cwd)
	src, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	if _, err := os.Lstat(src); err != nil {
		writeErr(w, http.StatusNotFound, "source not found")
		return
	}
	var dstDir string
	if body.DestDir != "" {
		dstDir, ok = filesResolve(w, s.Cwd, body.DestDir)
		if !ok {
			return
		}
	} else {
		dstDir = base
	}
	if info, err := os.Stat(dstDir); err != nil || !info.IsDir() {
		writeErr(w, http.StatusNotFound, "destination directory not found")
		return
	}
	dst := filepath.Join(dstDir, filepath.Base(src))
	// Both inside cwd (SafePath already guaranteed this for src/dstDir; dst is
	// dstDir/<name> so it is contained too).
	if dst == src {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if _, err := os.Lstat(dst); err == nil {
		writeErr(w, http.StatusConflict, fmt.Sprintf("'%s' already exists in destination", filepath.Base(src)))
		return
	}
	// Prevent moving a directory into itself or a descendant.
	if info, err := os.Stat(src); err == nil && info.IsDir() {
		if dst == src || strings.HasPrefix(dst, src+string(os.PathSeparator)) {
			writeErr(w, http.StatusBadRequest, "cannot move a directory into itself")
			return
		}
	}
	if err := os.Rename(src, dst); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /{id}/fs/rename ─────────────────────────────────────────────────────

type renameReq struct {
	Path    string `json:"path"`
	NewName string `json:"new_name"`
}

func fsRename(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body renameReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" || body.NewName == "" {
		writeErr(w, http.StatusBadRequest, "path and new_name required")
		return
	}
	if strings.ContainsAny(body.NewName, "/\\") || body.NewName == "." || body.NewName == ".." {
		writeErr(w, http.StatusBadRequest, "new_name must be a plain name, not a path")
		return
	}
	src, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	if _, err := os.Lstat(src); err != nil {
		writeErr(w, http.StatusNotFound, "source not found")
		return
	}
	dst := filepath.Join(filepath.Dir(src), body.NewName)
	if _, err := os.Lstat(dst); err == nil {
		writeErr(w, http.StatusConflict, "destination already exists")
		return
	}
	// dst stays inside cwd because it shares src's parent and has a plain name.
	base := filepath.Clean(s.Cwd)
	if dst != base && !strings.HasPrefix(dst, base+string(os.PathSeparator)) {
		writeErr(w, http.StatusForbidden, "path traversal not allowed")
		return
	}
	if err := os.Rename(src, dst); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /{id}/fs/delete ─────────────────────────────────────────────────────

type deleteReq struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

func fsDelete(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body deleteReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	base := filepath.Clean(s.Cwd)
	target, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	info, err := os.Lstat(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}
	if target == base {
		writeErr(w, http.StatusForbidden, "cannot delete workspace root")
		return
	}

	// Symlink or regular file: unlink.
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().IsRegular() {
		if err := os.Remove(target); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if info.IsDir() {
		entries, derr := os.ReadDir(target)
		if derr != nil {
			writeErr(w, http.StatusInternalServerError, derr.Error())
			return
		}
		hasEntries := len(entries) > 0
		if hasEntries && !body.Recursive {
			writeErr(w, http.StatusConflict, "directory not empty")
			return
		}
		if hasEntries {
			err = os.RemoveAll(target)
		} else {
			err = os.Remove(target)
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeErr(w, http.StatusBadRequest, "unsupported entry type")
}

// ── POST /{id}/fs/extract ────────────────────────────────────────────────────

type extractReq struct {
	Path string `json:"path"`
}

func fsExtract(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body extractReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	target, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if !filesIsArchiveName(filepath.Base(target)) {
		writeErr(w, http.StatusUnsupportedMediaType, "not a supported archive format")
		return
	}
	if info.Size() > filesArchiveMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("archive too large (%dMB > %dMB limit)", info.Size()/1024/1024, filesArchiveMaxSize/1024/1024))
		return
	}

	// Build stem: strip the first matching known archive suffix.
	name := filepath.Base(target)
	stem := name
	lower := strings.ToLower(name)
	for _, sfx := range []string{".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar", ".gz", ".bz2", ".xz", ".zip"} {
		if strings.HasSuffix(lower, sfx) {
			stem = name[:len(name)-len(sfx)]
			break
		}
	}
	ts := time.Now().Unix()
	parent := filepath.Dir(target)
	destName := fmt.Sprintf("%s-%d", stem, ts)
	dest := filepath.Join(parent, destName)
	for counter := 1; ; counter++ {
		if _, err := os.Stat(dest); os.IsNotExist(err) {
			break
		}
		destName = fmt.Sprintf("%s-%d-%d", stem, ts, counter)
		dest = filepath.Join(parent, destName)
	}

	if err := extractArchive(target, dest); err != nil {
		_ = os.RemoveAll(dest)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	rel := filesRelTo(s.Cwd, dest)
	writeJSON(w, http.StatusOK, map[string]any{"output_dir": rel})
}

// extractArchive extracts src into dest (created fresh). Mirrors files.py
// _extract_archive, including the tar safety filter (skip absolute paths and
// any member containing "..").
func extractArchive(src, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	n := strings.ToLower(filepath.Base(src))
	switch {
	case strings.HasSuffix(n, ".zip"):
		return extractZip(src, dest)
	case isTarName(n):
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		defer f.Close()
		tr, err := tarReader(f, n)
		if err != nil {
			return err
		}
		for {
			hdr, terr := tr.Next()
			if terr == io.EOF {
				break
			}
			if terr != nil {
				return terr
			}
			if filepath.IsAbs(hdr.Name) || strings.Contains(hdr.Name, "..") {
				continue
			}
			outPath := filepath.Join(dest, hdr.Name)
			// Defense-in-depth: ensure the member stays under dest.
			if outPath != dest && !strings.HasPrefix(outPath, dest+string(os.PathSeparator)) {
				continue
			}
			switch hdr.Typeflag {
			case tar.TypeDir:
				if err := os.MkdirAll(outPath, 0o755); err != nil {
					return err
				}
			case tar.TypeReg, tar.TypeRegA:
				if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
					return err
				}
				out, err := os.Create(outPath)
				if err != nil {
					return err
				}
				if _, err := io.Copy(out, tr); err != nil {
					out.Close()
					return err
				}
				out.Close()
			}
		}
		return nil
	case strings.HasSuffix(n, ".gz"):
		return extractSingle(src, filepath.Join(dest, filepath.Base(src)[:len(filepath.Base(src))-3]), func(r io.Reader) (io.Reader, error) {
			return gzip.NewReader(r)
		})
	case strings.HasSuffix(n, ".bz2"):
		return extractSingle(src, filepath.Join(dest, filepath.Base(src)[:len(filepath.Base(src))-4]), func(r io.Reader) (io.Reader, error) {
			return bzip2.NewReader(r), nil
		})
	case strings.HasSuffix(n, ".xz"):
		return fmt.Errorf("xz-compressed archives are not supported")
	}
	return fmt.Errorf("unsupported archive: %s", filepath.Base(src))
}

func extractZip(src, dest string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if filepath.IsAbs(f.Name) || strings.Contains(f.Name, "..") {
			continue
		}
		outPath := filepath.Join(dest, f.Name)
		if outPath != dest && !strings.HasPrefix(outPath, dest+string(os.PathSeparator)) {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(outPath, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(outPath)
		if err != nil {
			rc.Close()
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			out.Close()
			rc.Close()
			return err
		}
		out.Close()
		rc.Close()
	}
	return nil
}

func extractSingle(src, outPath string, wrap func(io.Reader) (io.Reader, error)) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	rd, err := wrap(f)
	if err != nil {
		return err
	}
	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rd)
	return err
}

// ── POST /{id}/fs/download-zip ───────────────────────────────────────────────

type downloadZipReq struct {
	Path     string   `json:"path"`
	Exclude  []string `json:"exclude"`
	Compress *bool    `json:"compress"`
}

func fsDownloadZip(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body downloadZipReq
	if !readJSON(w, r, &body) {
		return
	}
	compress := true
	if body.Compress != nil {
		compress = *body.Compress
	}
	base := filepath.Clean(s.Cwd)
	var target string
	if body.Path != "" {
		var ok bool
		target, ok = filesResolve(w, s.Cwd, body.Path)
		if !ok {
			return
		}
	} else {
		target = base
	}
	info, err := os.Stat(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "path not found")
		return
	}

	// Build exclusion set (relative, sanitized) mirroring the Python rsync logic.
	excludeSet := map[string]struct{}{}
	for _, ex := range body.Exclude {
		parts := []string{}
		for _, p := range strings.Split(strings.ReplaceAll(ex, "\\", "/"), "/") {
			if p != "" && p != "." {
				parts = append(parts, p)
			}
		}
		skip := false
		for _, p := range parts {
			if p == ".." {
				skip = true
				break
			}
		}
		if len(parts) > 0 && !skip {
			excludeSet[strings.Join(parts, "/")] = struct{}{}
		}
	}

	// Single file: zip directly.
	if !info.IsDir() {
		if info.Size() > filesDownloadMax {
			writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large (%dMB > 100MB)", info.Size()/1024/1024))
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, filepath.Base(target)))
		zw := zip.NewWriter(w)
		method := zip.Deflate
		if !compress {
			method = zip.Store
		}
		fw, ferr := zw.CreateHeader(&zip.FileHeader{Name: filepath.Base(target), Method: method})
		if ferr == nil {
			if f, oerr := os.Open(target); oerr == nil {
				_, _ = io.Copy(fw, f)
				f.Close()
			}
		}
		_ = zw.Close()
		return
	}

	// Directory: compute size after exclusions, then stream a zip rooted at the
	// directory name (so the archive contains <dirname>/...). Mirrors the Python
	// _zip_dir which writes paths relative to the directory.
	dirname := filepath.Base(target)
	if dirname == "" || dirname == "." || dirname == string(os.PathSeparator) {
		dirname = "workspace"
	}

	var totalSize int64
	type zipItem struct {
		full string
		rel  string
	}
	var items []zipItem
	_ = filepath.WalkDir(target, func(p string, de os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if de.IsDir() {
			return nil
		}
		rel := filesRelTo(target, p)
		// Apply exclusions on the path relative to the target dir.
		relSlash := filepath.ToSlash(rel)
		if _, ex := excludeSet[relSlash]; ex {
			return nil
		}
		// Also exclude if any ancestor dir is excluded.
		for anc := relSlash; ; {
			idx := strings.LastIndex(anc, "/")
			if idx < 0 {
				if _, ex := excludeSet[anc]; ex {
					return nil
				}
				break
			}
			anc = anc[:idx]
			if _, ex := excludeSet[anc]; ex {
				return nil
			}
		}
		if fi, ferr := de.Info(); ferr == nil {
			totalSize += fi.Size()
		}
		items = append(items, zipItem{full: p, rel: rel})
		return nil
	})

	if totalSize > filesDownloadMax {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("directory still too large after exclusions (%dMB > 100MB)", totalSize/1024/1024))
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, dirname))
	zw := zip.NewWriter(w)
	method := zip.Deflate
	if !compress {
		method = zip.Store
	}
	for _, it := range items {
		fw, ferr := zw.CreateHeader(&zip.FileHeader{Name: filepath.ToSlash(it.rel), Method: method})
		if ferr != nil {
			continue
		}
		f, oerr := os.Open(it.full)
		if oerr != nil {
			continue
		}
		_, _ = io.Copy(fw, f)
		f.Close()
	}
	_ = zw.Close()
}

// ── SQLite endpoints ─────────────────────────────────────────────────────────

func fsSqliteQuery(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeErr(w, http.StatusUnprocessableEntity, "path required")
		return
	}
	table := r.URL.Query().Get("table")
	limit := queryInt(r, "limit", 100)
	if limit < 1 {
		limit = 1
	}
	if limit > filesSqliteRowLimit {
		limit = filesSqliteRowLimit
	}
	offset := queryInt(r, "offset", 0)
	if offset < 0 {
		offset = 0
	}

	target, ok := filesResolve(w, s.Cwd, path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if !filesIsSqliteName(filepath.Base(target)) {
		writeErr(w, http.StatusUnsupportedMediaType, "not a sqlite file")
		return
	}
	rel := filesRelTo(s.Cwd, target)

	dsn := "file:" + target + "?mode=ro"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot open sqlite: "+err.Error())
		return
	}
	defer db.Close()

	tables, err := sqliteTables(db)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	resp := map[string]any{
		"tables":  nonNilSlice(tables),
		"columns": []string{},
		"rows":    [][]any{},
		"total":   0,
		"path":    rel,
	}
	if table == "" {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	// Validate against known tables to prevent injection.
	known := false
	for _, t := range tables {
		if t == table {
			known = true
			break
		}
	}
	if !known {
		writeErr(w, http.StatusNotFound, "table not found")
		return
	}

	quoted := `"` + strings.ReplaceAll(table, `"`, `""`) + `"`
	var total int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + quoted).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	rows, err := db.Query("SELECT * FROM "+quoted+" LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	cols, data, err := scanRows(rows)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp["columns"] = nonNilSlice(cols)
	resp["rows"] = data
	resp["total"] = total
	writeJSON(w, http.StatusOK, resp)
}

type sqliteExecReq struct {
	Path string `json:"path"`
	SQL  string `json:"sql"`
}

func fsSqliteExec(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body sqliteExecReq
	if !readJSON(w, r, &body) {
		return
	}
	sqlText := strings.TrimSpace(body.SQL)
	if sqlText == "" {
		writeErr(w, http.StatusBadRequest, "sql required")
		return
	}
	target, ok := filesResolve(w, s.Cwd, body.Path)
	if !ok {
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	if !filesIsSqliteName(filepath.Base(target)) {
		writeErr(w, http.StatusUnsupportedMediaType, "not a sqlite file")
		return
	}

	db, err := sql.Open("sqlite", "file:"+target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "cannot open sqlite: "+err.Error())
		return
	}
	defer db.Close()

	// Try as a query first; if it returns columns we report rows, otherwise we
	// fall back to Exec to capture affected-row counts (mirrors Python which
	// inspects cur.description).
	rows, qerr := db.Query(sqlText)
	if qerr == nil {
		cols, data, serr := scanRows(rows)
		rows.Close()
		if serr != nil {
			writeErr(w, http.StatusBadRequest, serr.Error())
			return
		}
		if len(cols) > 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"columns":  nonNilSlice(cols),
				"rows":     data,
				"affected": 0,
				"message":  fmt.Sprintf("%d row(s) returned", len(data)),
			})
			return
		}
		// No columns: statement was a write executed via Query; row count is not
		// available here, so re-run via Exec is unsafe (would double-apply). Report 0.
		writeJSON(w, http.StatusOK, map[string]any{
			"columns":  []string{},
			"rows":     [][]any{},
			"affected": 0,
			"message":  "0 row(s) affected",
		})
		return
	}

	// Query failed (e.g. multi-statement / DDL): use Exec.
	res, eerr := db.Exec(sqlText)
	if eerr != nil {
		writeErr(w, http.StatusBadRequest, eerr.Error())
		return
	}
	affected := int64(0)
	if n, aerr := res.RowsAffected(); aerr == nil && n >= 0 {
		affected = n
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"columns":  []string{},
		"rows":     [][]any{},
		"affected": affected,
		"message":  fmt.Sprintf("%d row(s) affected", affected),
	})
}

func sqliteTables(db *sql.DB) ([]string, error) {
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

// scanRows reads all rows into [][]any with column names, mirroring Python's
// list-of-lists row factory.
func scanRows(rows *sql.Rows) ([]string, [][]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	out := [][]any{}
	for rows.Next() {
		holders := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range holders {
			ptrs[i] = &holders[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, nil, err
		}
		row := make([]any, len(cols))
		for i, v := range holders {
			// []byte → string for JSON friendliness (matches sqlite3 text output).
			if b, ok := v.([]byte); ok {
				row[i] = string(b)
			} else {
				row[i] = v
			}
		}
		out = append(out, row)
	}
	return cols, out, rows.Err()
}

// ── Attachment / image uploads ───────────────────────────────────────────────

// sanitizeAttachmentExt mirrors files.py _sanitize_attachment_ext.
func sanitizeAttachmentExt(filename string) string {
	raw := filepath.Ext(filename)
	if raw == "" {
		return ""
	}
	body := strings.ToLower(raw[1:])
	body = filesExtSanitizeRE.ReplaceAllString(body, "")
	if body == "" {
		return ""
	}
	if len(body) > 16 {
		body = body[:16]
	}
	return "." + body
}

func fsUploadAttachment(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if err := r.ParseMultipartForm(filesMaxAttachment + 1<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()
	if hdr.Filename == "" {
		writeErr(w, http.StatusBadRequest, "filename required")
		return
	}

	ext := sanitizeAttachmentExt(hdr.Filename)
	content, err := io.ReadAll(io.LimitReader(file, filesMaxAttachment+1))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(content) > filesMaxAttachment {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large (>%dMB)", filesMaxAttachment/1024/1024))
		return
	}

	targetDir := filepath.Join(filepath.Clean(s.Cwd), filesAttachmentSubdir)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	storedName := strings.ReplaceAll(uuid.NewString(), "-", "") + ext
	target := filepath.Join(targetDir, storedName)
	if err := os.WriteFile(target, content, 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	_, isImage := filesImageExts[ext]
	result := map[string]any{
		"path":        target,
		"filename":    hdr.Filename,
		"stored_name": storedName,
		"size":        len(content),
		"is_image":    isImage,
	}
	if isImage {
		result["url"] = fmt.Sprintf("/api/sessions/%s/uploaded-image/%s", chi.URLParam(r, "id"), storedName)
	}
	writeJSON(w, http.StatusOK, result)
}

// fsServeUploadedImage serves an uploaded image via <img src>. Auth is via the
// query `token` param because <img> cannot send Authorization headers; the
// filename is restricted to the uuid+ext pattern (the primary traversal guard).
func fsServeUploadedImage(d Deps, w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, err := d.Auth.VerifyToken(token)
	if err != nil || id == nil || id.Username == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	filename := chi.URLParam(r, "filename")
	if !filesImageFilenameRE.MatchString(filename) {
		writeErr(w, http.StatusBadRequest, "invalid filename")
		return
	}

	sessionID := chi.URLParam(r, "id")
	sess, serr := d.Store.GetSession(sessionID)
	if serr != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if sess == nil || sess.OwnerID != id.Username {
		writeErr(w, http.StatusNotFound, "session not found")
		return
	}

	target := filepath.Join(filepath.Clean(sess.Cwd), filesAttachmentSubdir, filename)
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "image not found")
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(target))
	if ct == "" {
		ct = "application/octet-stream"
	}
	f, err := os.Open(target)
	if err != nil {
		writeErr(w, http.StatusNotFound, "image not found")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// ── small generic helper ─────────────────────────────────────────────────────

// nonNilSlice guarantees a JSON array (never null) for empty slices.
func nonNilSlice[T any](v []T) []T {
	if v == nil {
		return []T{}
	}
	return v
}
