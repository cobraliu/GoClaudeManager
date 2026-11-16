package api

// /api/remote — read-only browsing of directories on other machines over SSH
// (the file panel's "Remote" tool). Admin-only: it reads anything the server's
// OS user can reach with its ssh keys, on any host in ~/.ssh/config.

import (
	"net/url"
	"context"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/fsutil"
	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/remotefs"
)

// remoteReadCap bounds how much of one remote file is transferred.
const remoteReadCap = 16 << 20

var (
	remotePoolOnce sync.Once
	remotePool     *remotefs.Pool
)

func getRemotePool() *remotefs.Pool {
	remotePoolOnce.Do(func() { remotePool = remotefs.NewPool(context.Background()) })
	return remotePool
}

// RemoteFilesRouter builds the /api/remote sub-router.
func RemoteFilesRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	// <video>/<audio>/<img> can't send an Authorization header, so media is
	// authenticated by the ?token= query param (as fs/media does).
	r.Get("/media", func(w http.ResponseWriter, r *http.Request) { remoteMedia(d, w, r) })
	r.Group(func(r chi.Router) {
		r.Use(d.Auth.RequireAdmin)
		r.Get("/hosts", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"hosts": remotefs.Hosts()})
		})
		r.Get("/list", remoteList)
		r.Get("/file", func(w http.ResponseWriter, r *http.Request) { remoteFile(d, w, r) })
		// Close the SSH connection to ?host= (all hosts when omitted). Called
		// when the Remote view is left, so no ssh process lingers.
		r.Post("/close", func(w http.ResponseWriter, r *http.Request) {
			host := r.URL.Query().Get("host")
			if host != "" && !remotefs.ValidHost(host) {
				writeErr(w, http.StatusBadRequest, "invalid host")
				return
			}
			getRemotePool().Close(host)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connected": getRemotePool().Connected()})
		})
	})
	return r
}

func remoteHostParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	if !remotefs.ValidHost(host) {
		writeErr(w, http.StatusBadRequest, "invalid host")
		return "", false
	}
	return host, true
}

// remoteErr maps a remotefs error to a response.
func remoteErr(w http.ResponseWriter, err error) {
	switch {
	case remotefs.IsNotExist(err):
		writeErr(w, http.StatusNotFound, "path not found")
	case strings.HasPrefix(err.Error(), "ssh "):
		writeErr(w, http.StatusBadGateway, err.Error())
	default:
		writeErr(w, http.StatusBadRequest, err.Error())
	}
}

// GET /api/remote/list?host=&path= — path empty = the remote home directory.
func remoteList(w http.ResponseWriter, r *http.Request) {
	host, ok := remoteHostParam(w, r)
	if !ok {
		return
	}
	abs, entries, err := getRemotePool().List(host, r.URL.Query().Get("path"))
	if err != nil {
		remoteErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"host": host, "path": abs, "entries": entries})
}

// GET /api/remote/file?host=&path=<absolute> — same shape as /code/file
// (without diff information), so the frontend's viewers can render it.
func remoteFile(d Deps, w http.ResponseWriter, r *http.Request) {
	host, ok := remoteHostParam(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if !strings.HasPrefix(p, "/") {
		writeErr(w, http.StatusBadRequest, "path must be absolute")
		return
	}
	p = path.Clean(p)

	mode := d.Cfg.FileViewerMode()
	readCap := int64(remoteReadCap)
	if mode == fsutil.FileViewerModeBytes {
		if mb := int64(d.Cfg.FileViewerMaxBytes()); mb > 0 && mb < readCap {
			readCap = mb
		}
	}
	raw, info, err := getRemotePool().ReadFile(host, p, readCap)
	if err != nil {
		if err == remotefs.ErrIsDir {
			writeErr(w, http.StatusBadRequest, "Not a file")
			return
		}
		remoteErr(w, err)
		return
	}

	resp := map[string]any{
		"path":          p,
		"size":          info.Size,
		"mtime":         info.Mtime,
		"added_lines":   []int{},
		"removed_lines": []int{},
		"diff_raw":      "",
		"truncated":     false,
		"truncated_by":  nil,
	}
	head := raw
	if len(head) > 8192 {
		head = head[:8192]
	}
	if bytesContainsNull(head) {
		resp["is_binary"] = true
		resp["content"] = ""
		resp["language"] = "binary"
		writeJSON(w, http.StatusOK, resp)
		return
	}

	content := decodeReplaceBytes(raw)
	lines := splitLinesPy(content)
	totalLines := len(lines)
	truncated, truncatedBy := info.Truncated, ""
	if truncated {
		truncatedBy = "bytes"
	}
	if mode == fsutil.FileViewerModeLines {
		if maxLines := d.Cfg.FileViewerMaxLines(); totalLines > maxLines {
			truncated, truncatedBy = true, "lines"
			lines = lines[:maxLines]
			content = strings.Join(lines, "\n")
		}
	}

	language := codeExtLang[strings.ToLower(path.Ext(p))]
	if language == "" {
		language = "plaintext"
	}
	resp["is_binary"] = false
	resp["content"] = content
	resp["language"] = language
	resp["displayed_lines"] = len(lines)
	resp["total_lines"] = totalLines
	resp["truncated"] = truncated
	if truncated {
		resp["truncated_by"] = truncatedBy
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /api/remote/media?host=&path=<absolute>&token=[&download=1] — streams a
// remote file (video / audio / image) with HTTP Range support so players can
// seek; download=1 serves it as an attachment (the remote-file download relay).
func remoteMedia(d Deps, w http.ResponseWriter, r *http.Request) {
	id, err := d.Auth.VerifyToken(r.URL.Query().Get("token"))
	if err != nil || id == nil || id.Username == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !id.IsAdmin && id.Role != model.RoleAdmin {
		writeErr(w, http.StatusForbidden, "admin required")
		return
	}
	host, ok := remoteHostParam(w, r)
	if !ok {
		return
	}
	p := r.URL.Query().Get("path")
	if !strings.HasPrefix(p, "/") {
		writeErr(w, http.StatusBadRequest, "path must be absolute")
		return
	}
	p = path.Clean(p)
	st, err := getRemotePool().OpenStream(host, p)
	if err != nil {
		if err == remotefs.ErrIsDir {
			writeErr(w, http.StatusBadRequest, "Not a file")
			return
		}
		remoteErr(w, err)
		return
	}
	defer st.Close()
	w.Header().Set("Cache-Control", "private, max-age=300")
	if r.URL.Query().Get("download") == "1" {
		// Relay as a download: the browser saves the file the server streams
		// from the remote host over SFTP (Range still works, so resumable).
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(path.Base(p)))
	}
	http.ServeContent(w, r, path.Base(p), st.Info.ModTime(), st)
}
