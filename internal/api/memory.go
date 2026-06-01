// Port of app/api/memory.py (prefix /api/sessions).
//
// Per-project memory file browser. Memory files live at
// ~/.claude/projects/<encoded-cwd>/memory/, beside the session JSONLs the Claude
// CLI writes. Each session's cwd maps to one project dir via the same encoding
// the CLI uses ("/" → "-", plus a "_" → "-" variant for fallback). Dot-prefixed
// files are filtered out.
//
// registerMemoryRoutes wires the two GET endpoints onto the sessions sub-router
// (already guarded by RequireUser at the mount). Access is admin-or-owner,
// mirroring _check_session_access. JSON shapes match the Python Pydantic models.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/auth"
)

// memoryFileEntry mirrors MemoryFileEntry.
type memoryFileEntry struct {
	Name  string  `json:"name"`
	Size  int64   `json:"size"`
	Mtime float64 `json:"mtime"`
}

// registerMemoryRoutes mounts the memory endpoints on the sessions router.
func registerMemoryRoutes(r chi.Router, d Deps) {
	r.Get("/{session_id}/memory/list", func(w http.ResponseWriter, r *http.Request) { memoryList(d, w, r) })
	r.Get("/{session_id}/memory/read", func(w http.ResponseWriter, r *http.Request) { memoryRead(d, w, r) })
}

// memoryCheckAccess returns the session cwd if the caller may see it (admin or
// owner), else writes a 404 and returns ("", false). Mirrors
// _check_session_access.
func memoryCheckAccess(d Deps, w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "session_id")
	s, err := d.Store.GetSession(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return "", false
	}
	who := auth.FromContext(r.Context())
	if s == nil || who == nil || (!who.IsAdmin && s.OwnerID != who.Username) {
		writeErr(w, http.StatusNotFound, "session not found")
		return "", false
	}
	return s.Cwd, true
}

// memoryResolveDir mirrors _resolve_memory_dir: returns the memory dir for a cwd
// or "" if none exists.
func memoryResolveDir(cwd string) string {
	if cwd == "" {
		return ""
	}
	home, _ := os.UserHomeDir()
	projects := filepath.Join(home, ".claude", "projects")
	if info, err := os.Stat(projects); err != nil || !info.IsDir() {
		return ""
	}
	cwd = strings.TrimRight(cwd, "/")
	rep := strings.NewReplacer("/", "-", "_", "-")
	candidates := []string{rep.Replace(cwd), strings.ReplaceAll(cwd, "/", "-")}
	for _, enc := range candidates {
		candidate := filepath.Join(projects, enc, "memory")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

func memoryList(d Deps, w http.ResponseWriter, r *http.Request) {
	cwd, ok := memoryCheckAccess(d, w, r)
	if !ok {
		return
	}
	memDir := memoryResolveDir(cwd)
	if memDir == "" {
		writeJSON(w, http.StatusOK, map[string]any{"dir": nil, "files": []memoryFileEntry{}})
		return
	}
	ents, err := os.ReadDir(memDir)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"dir": memDir, "files": []memoryFileEntry{}})
		return
	}
	entries := []memoryFileEntry{}
	for _, e := range ents {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		entries = append(entries, memoryFileEntry{
			Name:  e.Name(),
			Size:  info.Size(),
			Mtime: float64(info.ModTime().UnixNano()) / 1e9,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"dir": memDir, "files": entries})
}

func memoryRead(d Deps, w http.ResponseWriter, r *http.Request) {
	cwd, ok := memoryCheckAccess(d, w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	if len(name) < 1 || len(name) > 255 {
		writeErr(w, http.StatusUnprocessableEntity, "invalid name length")
		return
	}
	// Fail fast on obviously-bad names; the prefix check below is the real guard.
	if strings.Contains(name, "/") || strings.Contains(name, "\\") ||
		strings.HasPrefix(name, ".") || name == "." || name == ".." {
		writeErr(w, http.StatusBadRequest, "invalid file name")
		return
	}
	memDir := memoryResolveDir(cwd)
	if memDir == "" {
		writeErr(w, http.StatusNotFound, "memory dir not found")
		return
	}
	memResolved := memoryRealpath(memDir)
	target := memoryRealpath(filepath.Join(memDir, name))
	if target != memResolved && !strings.HasPrefix(target, memResolved+string(os.PathSeparator)) {
		writeErr(w, http.StatusBadRequest, "path traversal")
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	data, err := os.ReadFile(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":    name,
		"content": string(data),
		"size":    info.Size(),
		"mtime":   float64(info.ModTime().UnixNano()) / 1e9,
	})
}

// memoryRealpath resolves symlinks where possible, else cleans the path.
func memoryRealpath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}
