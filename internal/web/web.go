// Package web serves the React SPA built by Vite.
//
// It reproduces the Python backend's static-serving semantics exactly
// (app/claudemanager.py: _ImmutableStaticFiles + serve_spa):
//
//   - /assets/* are content-hashed by Vite → Cache-Control: immutable, 1 year.
//   - index.html is never cached (it pins which hashed bundle the client loads).
//   - Any path that is not an existing non-HTML file falls back to index.html
//     (client-side routing).
//
// Source of the bundle, in priority order:
//  1. FRONTEND_DIST env points at a real directory → serve from disk (dev / hot
//     rebuild without recompiling Go). Mirrors the Python FRONTEND_DIST override.
//  2. Otherwise the dist/ directory embedded at build time → single static
//     binary (the Go analogue of the PyInstaller _MEIPASS bundle).
package web

import (
	"embed"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
)

// embeddedDist holds the production bundle compiled into the binary. The
// build script copies frontend/dist here before `go build` (see build.sh).
// `all:` ensures dotfiles are embedded too.
//
//go:embed all:dist
var embeddedDist embed.FS

// Handler returns an http.Handler that serves the SPA. frontendDist, when a
// real directory, takes precedence over the embedded bundle.
func Handler(frontendDist string) http.Handler {
	root := resolveFS(frontendDist)
	return &spaHandler{fsys: root}
}

func resolveFS(frontendDist string) fs.FS {
	if frontendDist != "" {
		if info, err := os.Stat(frontendDist); err == nil && info.IsDir() {
			slog.Info("serving frontend from disk", "dir", frontendDist)
			return os.DirFS(frontendDist)
		}
		slog.Warn("FRONTEND_DIST not a directory, falling back to embedded bundle", "value", frontendDist)
	}
	sub, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		// Should never happen: dist is embedded above.
		panic("web: embedded dist missing: " + err.Error())
	}
	slog.Info("serving frontend from embedded bundle")
	return sub
}

type spaHandler struct {
	fsys fs.FS
}

const (
	immutableCache = "public, max-age=31536000, immutable"
	noCache        = "no-cache, no-store, must-revalidate"
)

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if upath == "" {
		h.serveIndex(w, r)
		return
	}

	f, err := h.fsys.Open(upath)
	if err != nil {
		// Not a real file → SPA fallback to index.html (client-side routing).
		h.serveIndex(w, r)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() || strings.HasSuffix(strings.ToLower(upath), ".html") {
		h.serveIndex(w, r)
		return
	}

	// Content-hashed assets can be cached forever; everything else short-lived.
	if strings.HasPrefix(upath, "assets/") {
		w.Header().Set("Cache-Control", immutableCache)
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		// fs.File from embed/os always implements ReadSeeker for regular files;
		// fall back to a plain copy if not.
		w.Header().Set("Content-Type", contentTypeFor(upath))
		_, _ = io.Copy(w, f)
		return
	}
	http.ServeContent(w, r, path.Base(upath), info.ModTime(), rs)
}

func (h *spaHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	f, err := h.fsys.Open("index.html")
	if err != nil {
		http.Error(w, "frontend not built", http.StatusNotFound)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "read index.html", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", noCache)
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func contentTypeFor(p string) string {
	switch {
	case strings.HasSuffix(p, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(p, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(p, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(p, ".json"):
		return "application/json"
	default:
		return "application/octet-stream"
	}
}
