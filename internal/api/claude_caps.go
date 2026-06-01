// Port of app/api/claude_caps_api.py (prefix /api/claude-caps).
//
// Exposes the Claude "capabilities" file browser/editor: list the editable
// CLAUDE.md / settings / commands / skills / agents files for the global
// (~/.claude) or project (cwd) scope, read/write/delete individual files, keep a
// rolling .cm_history of versions on every mutating op, and roll back. Also
// serves plan-file bodies from ~/.claude/plans for the chat-mode plan-approval
// UI.
//
// JSON shapes match the Python Pydantic models exactly so the React frontend
// needs no changes. All routes require an authenticated user (RequireUser),
// matching the CurrentUser dependency on every Python endpoint.
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	capHistoryDir = ".cm_history"
	capMaxVers    = 30
)

// capItem mirrors CapItem. Description/Size are always present in JSON.
type capItem struct {
	Relpath     string `json:"relpath"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Exists      bool   `json:"exists"`
	Size        int64  `json:"size"`
}

// capSection mirrors CapSection. NewTemplate/NewDir are nullable.
type capSection struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Items       []capItem `json:"items"`
	NewTemplate *string   `json:"new_template"`
	NewDir      *string   `json:"new_dir"`
}

type capListResponse struct {
	ScopeRoot string       `json:"scope_root"`
	Sections  []capSection `json:"sections"`
}

type capVersion struct {
	VersionID string `json:"version_id"`
	SavedAt   string `json:"saved_at"`
	Size      int64  `json:"size"`
	Preview   string `json:"preview"`
}

type capVersionsResponse struct {
	Versions []capVersion `json:"versions"`
}

type capWriteRequest struct {
	Scope   string  `json:"scope"`
	Relpath string  `json:"relpath"`
	Content string  `json:"content"`
	Cwd     *string `json:"cwd"`
}

type capRollbackRequest struct {
	Scope     string  `json:"scope"`
	Relpath   string  `json:"relpath"`
	VersionID string  `json:"version_id"`
	Cwd       *string `json:"cwd"`
}

// ClaudeCapsRouter builds the /api/claude-caps sub-router (mounted by the lead).
func ClaudeCapsRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(d.Auth.RequireUser)

	r.Get("/list", capListCaps)
	r.Get("/file", capReadFile)
	r.Put("/file", capWriteFile)
	r.Delete("/file", capDeleteFile)
	r.Get("/versions", capListVersions)
	r.Get("/version-content", capVersionContent)
	r.Get("/plan", capReadPlan)
	r.Post("/rollback", capRollback)

	return r
}

// ── path helpers ────────────────────────────────────────────────────────────

func capGlobalRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// capScopeRoot mirrors _scope_root: returns the root dir and an http error
// detail (empty when ok) plus status.
func capScopeRoot(scope string, cwd *string) (string, int, string) {
	switch scope {
	case "global":
		return capGlobalRoot(), 0, ""
	case "project":
		if cwd == nil || *cwd == "" {
			return "", http.StatusBadRequest, "cwd required for project scope"
		}
		return *cwd, 0, ""
	default:
		return "", http.StatusBadRequest, "Unknown scope: " + scope
	}
}

// capResolve mirrors _resolve: join relpath under the scope root, reject
// absolute relpaths and traversal. Returns the resolved path, status, detail.
func capResolve(scope, relpath string, cwd *string) (string, int, string) {
	root, st, detail := capScopeRoot(scope, cwd)
	if detail != "" {
		return "", st, detail
	}
	if filepath.IsAbs(relpath) {
		return "", http.StatusBadRequest, "relpath must be relative"
	}
	rootResolved := capRealpath(root)
	resolved := capRealpath(filepath.Join(root, relpath))
	if resolved != rootResolved && !strings.HasPrefix(resolved, rootResolved+string(os.PathSeparator)) {
		return "", http.StatusForbidden, "Path traversal detected"
	}
	return resolved, 0, ""
}

// capRealpath resolves symlinks where possible, else cleans the path. (Python's
// Path.resolve() collapses .. without requiring existence.)
func capRealpath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// capHistoryDirFor mirrors _history_dir: <root>/.cm_history/<relpath with / → __>.
func capHistoryDirFor(scope string, cwd *string, relpath string) (string, int, string) {
	root, st, detail := capScopeRoot(scope, cwd)
	if detail != "" {
		return "", st, detail
	}
	safe := strings.ReplaceAll(relpath, "/", "__")
	return filepath.Join(root, capHistoryDir, safe), 0, ""
}

// capSaveVersion backs up the current content of filePath before overwriting,
// trimming to capMaxVers most-recent backups. Mirrors _save_version.
func capSaveVersion(scope string, cwd *string, relpath, filePath string) {
	if _, err := os.Stat(filePath); err != nil {
		return // nothing to back up
	}
	hist, _, detail := capHistoryDirFor(scope, cwd, relpath)
	if detail != "" {
		return
	}
	if err := os.MkdirAll(hist, 0o755); err != nil {
		return
	}
	ts := time.Now().UTC().Format("20060102T150405_") + capMicros()
	backup := filepath.Join(hist, ts+".bak")
	if data, err := os.ReadFile(filePath); err == nil {
		_ = os.WriteFile(backup, data, 0o644)
	}
	// Trim oldest versions beyond the cap.
	baks := capListBaks(hist)
	if len(baks) > capMaxVers {
		for _, old := range baks[:len(baks)-capMaxVers] {
			_ = os.Remove(filepath.Join(hist, old))
		}
	}
}

// capMicros returns a 6-digit microsecond field matching Python's %f.
func capMicros() string {
	us := time.Now().UTC().Nanosecond() / 1000
	s := make([]byte, 6)
	for i := 5; i >= 0; i-- {
		s[i] = byte('0' + us%10)
		us /= 10
	}
	return string(s)
}

// capListBaks returns sorted *.bak filenames (ascending) in dir.
func capListBaks(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".bak") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// ── description extraction ──────────────────────────────────────────────────

var capDescKeyRe = regexp.MustCompile(`^\s*description\s*:`)

// capExtractFrontmatterDesc mirrors _extract_frontmatter_desc.
func capExtractFrontmatterDesc(text string) string {
	lines := strings.Split(text, "\n")
	// Normalize trailing \r from splitlines-style behavior.
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], "\r")
	}
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return ""
	}
	var descLines []string
	capturing := false
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		if capturing {
			if strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t") {
				descLines = append(descLines, strings.TrimSpace(line))
			} else {
				break
			}
		} else if capDescKeyRe.MatchString(line) {
			rest := capDescKeyRe.ReplaceAllString(line, "")
			rest = strings.TrimSpace(rest)
			rest = strings.Trim(rest, "\"'")
			switch rest {
			case ">-", ">", "|", "|-":
				capturing = true
			default:
				if rest != "" {
					return capTrunc(rest, 120)
				}
			}
		}
	}
	if len(descLines) > 0 {
		return capTrunc(strings.Join(descLines, " "), 120)
	}
	return ""
}

// capExtractDesc mirrors _extract_desc.
func capExtractDesc(p string) string {
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		return ""
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	text := string(data)
	if strings.HasSuffix(p, ".json") {
		var m map[string]json.RawMessage
		if json.Unmarshal(data, &m) == nil {
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			n := len(keys)
			if n > 5 {
				keys = keys[:5]
			}
			return capItoa(len(m)) + " keys: " + strings.Join(keys, ", ")
		}
		return strings.ReplaceAll(capTrunc(text, 80), "\n", " ")
	}
	if fm := capExtractFrontmatterDesc(text); fm != "" {
		return fm
	}
	for _, line := range strings.Split(text, "\n") {
		s := strings.TrimSpace(line)
		if s != "" && !strings.HasPrefix(s, "#") && !strings.HasPrefix(s, "---") {
			return capTrunc(s, 120)
		}
	}
	return ""
}

func capItoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// capTrunc truncates to at most n runes (Python slices by code point).
func capTrunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// capMakeItem mirrors _cap_item.
func capMakeItem(root, relpath, name string) capItem {
	p := filepath.Join(root, relpath)
	info, err := os.Stat(p)
	exists := err == nil
	it := capItem{Relpath: relpath, Name: name, Exists: exists}
	if exists {
		it.Description = capExtractDesc(p)
		it.Size = info.Size()
	}
	return it
}

var capPkgPrimaries = []string{"SKILL.md", "AGENT.md", "COMMAND.md", "README.md"}

// capPrimaryFile mirrors _primary_file: find the primary editable file in a
// package dir. Returns "" if none.
func capPrimaryFile(pkgDir string) string {
	for _, name := range capPkgPrimaries {
		p := filepath.Join(pkgDir, name)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	ents, err := os.ReadDir(pkgDir)
	if err != nil {
		return ""
	}
	var mds []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			mds = append(mds, e.Name())
		}
	}
	if len(mds) == 0 {
		return ""
	}
	sort.Strings(mds)
	return filepath.Join(pkgDir, mds[0])
}

// capDirItems mirrors _dir_items: global-scope capability dir listing with
// package-subdir support.
func capDirItems(root, dirName string) []capItem {
	d := filepath.Join(root, dirName)
	info, err := os.Stat(d)
	if err != nil || !info.IsDir() {
		return []capItem{}
	}
	ents, err := os.ReadDir(d)
	if err != nil {
		return []capItem{}
	}
	sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
	items := []capItem{}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if e.IsDir() {
			pkg := filepath.Join(d, e.Name())
			primary := capPrimaryFile(pkg)
			if primary != "" {
				st, _ := os.Stat(primary)
				items = append(items, capItem{
					Relpath:     dirName + "/" + e.Name() + "/" + filepath.Base(primary),
					Name:        e.Name(),
					Description: capExtractDesc(primary),
					Exists:      true,
					Size:        sizeOrZero(st),
				})
			} else {
				items = append(items, capItem{
					Relpath:     dirName + "/" + e.Name(),
					Name:        e.Name(),
					Description: "(directory, no .md file)",
					Exists:      true,
					Size:        0,
				})
			}
		} else {
			full := filepath.Join(d, e.Name())
			st, _ := os.Stat(full)
			items = append(items, capItem{
				Relpath:     dirName + "/" + e.Name(),
				Name:        capStemName(e.Name()),
				Description: capExtractDesc(full),
				Exists:      true,
				Size:        sizeOrZero(st),
			})
		}
	}
	return items
}

// capStemName returns the name without a .md/.json extension, mirroring Python's
// `entry.stem if entry.suffix in (".md",".json") else entry.name`.
func capStemName(name string) string {
	ext := filepath.Ext(name)
	if ext == ".md" || ext == ".json" {
		return strings.TrimSuffix(name, ext)
	}
	return name
}

func sizeOrZero(info os.FileInfo) int64 {
	if info == nil {
		return 0
	}
	return info.Size()
}

func capStr(s string) *string { return &s }

// ── endpoints ───────────────────────────────────────────────────────────────

func capListCaps(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	cwd := capQueryPtr(r, "cwd")

	switch scope {
	case "global":
		root := capGlobalRoot()
		sections := []capSection{
			{ID: "instructions", Title: "Instructions",
				Items:       []capItem{capMakeItem(root, "CLAUDE.md", "CLAUDE.md")},
				NewTemplate: capStr("md")},
			{ID: "settings", Title: "Settings",
				Items: []capItem{capMakeItem(root, "settings.json", "settings.json")}},
			{ID: "commands", Title: "Commands",
				Items: capDirItems(root, "commands"), NewTemplate: capStr("md"), NewDir: capStr("commands")},
			{ID: "skills", Title: "Skills",
				Items: capDirItems(root, "skills"), NewTemplate: capStr("md"), NewDir: capStr("skills")},
			{ID: "agents", Title: "Agents",
				Items: capDirItems(root, "agents"), NewTemplate: capStr("md"), NewDir: capStr("agents")},
		}
		writeJSON(w, http.StatusOK, capListResponse{ScopeRoot: root, Sections: sections})
		return

	case "project":
		if cwd == nil || *cwd == "" {
			writeErr(w, http.StatusBadRequest, "cwd required for project scope")
			return
		}
		projRoot := *cwd

		pitem := func(relpath, name string) capItem {
			p := filepath.Join(projRoot, relpath)
			info, err := os.Stat(p)
			it := capItem{Relpath: relpath, Name: name, Description: capExtractDesc(p), Exists: err == nil}
			if err == nil {
				it.Size = info.Size()
			}
			return it
		}
		pdir := func(dirPrefix string) []capItem {
			d := filepath.Join(projRoot, dirPrefix)
			info, err := os.Stat(d)
			if err != nil || !info.IsDir() {
				return []capItem{}
			}
			ents, err := os.ReadDir(d)
			if err != nil {
				return []capItem{}
			}
			sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
			items := []capItem{}
			for _, e := range ents {
				if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				full := filepath.Join(d, e.Name())
				st, _ := os.Stat(full)
				items = append(items, capItem{
					Relpath:     dirPrefix + "/" + e.Name(),
					Name:        capStemName(e.Name()),
					Description: capExtractDesc(full),
					Exists:      true,
					Size:        sizeOrZero(st),
				})
			}
			return items
		}

		mcpPath := filepath.Join(projRoot, ".mcp.json")
		mcpClPath := filepath.Join(projRoot, ".claude", ".mcp.json")
		mcpSrc := mcpClPath
		if _, err := os.Stat(mcpPath); err == nil {
			mcpSrc = mcpPath
		}
		mcpInfo, mcpErr := os.Stat(mcpSrc)
		mcpItem := capItem{
			Relpath: ".mcp.json", Name: ".mcp.json",
			Description: capExtractDesc(mcpSrc),
			Exists:      mcpErr == nil,
			Size:        sizeOrZero(mcpInfo),
		}

		sections := []capSection{
			{ID: "instructions", Title: "Instructions",
				Items: []capItem{pitem(".claude/CLAUDE.md", "CLAUDE.md")}, NewTemplate: capStr("md")},
			{ID: "settings", Title: "Settings",
				Items: []capItem{pitem(".claude/settings.json", "settings.json"),
					pitem(".claude/settings.local.json", "settings.local.json")}},
			{ID: "mcp", Title: "MCP Servers", Items: []capItem{mcpItem}},
			{ID: "commands", Title: "Commands", Items: pdir(".claude/commands"),
				NewTemplate: capStr("md"), NewDir: capStr(".claude/commands")},
			{ID: "skills", Title: "Skills", Items: pdir(".claude/skills"),
				NewTemplate: capStr("md"), NewDir: capStr(".claude/skills")},
			{ID: "agents", Title: "Agents", Items: pdir(".claude/agents"),
				NewTemplate: capStr("md"), NewDir: capStr(".claude/agents")},
		}
		writeJSON(w, http.StatusOK, capListResponse{ScopeRoot: projRoot, Sections: sections})
		return
	}

	writeErr(w, http.StatusBadRequest, "Unknown scope: "+scope)
}

func capReadFile(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	relpath := r.URL.Query().Get("relpath")
	cwd := capQueryPtr(r, "cwd")
	p, st, detail := capResolve(scope, relpath, cwd)
	if detail != "" {
		writeErr(w, st, detail)
		return
	}
	if _, err := os.Stat(p); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"content": "", "exists": false})
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": string(data), "exists": true})
}

func capWriteFile(w http.ResponseWriter, r *http.Request) {
	var body capWriteRequest
	if !readJSON(w, r, &body) {
		return
	}
	p, st, detail := capResolve(body.Scope, body.Relpath, body.Cwd)
	if detail != "" {
		writeErr(w, st, detail)
		return
	}
	capSaveVersion(body.Scope, body.Cwd, body.Relpath, p)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(p, []byte(body.Content), 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func capDeleteFile(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	relpath := r.URL.Query().Get("relpath")
	cwd := capQueryPtr(r, "cwd")
	p, st, detail := capResolve(scope, relpath, cwd)
	if detail != "" {
		writeErr(w, st, detail)
		return
	}
	if _, err := os.Stat(p); err != nil {
		writeErr(w, http.StatusNotFound, "File not found")
		return
	}
	capSaveVersion(scope, cwd, relpath, p)
	if err := os.Remove(p); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func capListVersions(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	relpath := r.URL.Query().Get("relpath")
	cwd := capQueryPtr(r, "cwd")
	hist, _, detail := capHistoryDirFor(scope, cwd, relpath)
	if detail != "" {
		writeErr(w, http.StatusBadRequest, detail)
		return
	}
	info, err := os.Stat(hist)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusOK, capVersionsResponse{Versions: []capVersion{}})
		return
	}
	baks := capListBaks(hist) // ascending
	// Iterate reverse (newest first), matching Python sorted(..., reverse=True).
	versions := []capVersion{}
	for i := len(baks) - 1; i >= 0; i-- {
		bak := baks[i]
		full := filepath.Join(hist, bak)
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		fi, err := os.Stat(full)
		if err != nil {
			continue
		}
		stem := strings.TrimSuffix(bak, ".bak")
		savedAt := stem
		if t, perr := time.Parse("20060102T150405_999999", stem); perr == nil {
			savedAt = t.UTC().Format("2006-01-02T15:04:05.999999-07:00")
		}
		versions = append(versions, capVersion{
			VersionID: stem,
			SavedAt:   savedAt,
			Size:      fi.Size(),
			Preview:   strings.ReplaceAll(capTrunc(string(data), 120), "\n", " "),
		})
	}
	writeJSON(w, http.StatusOK, capVersionsResponse{Versions: versions})
}

func capVersionContent(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	relpath := r.URL.Query().Get("relpath")
	versionID := r.URL.Query().Get("version_id")
	cwd := capQueryPtr(r, "cwd")
	hist, _, detail := capHistoryDirFor(scope, cwd, relpath)
	if detail != "" {
		writeErr(w, http.StatusBadRequest, detail)
		return
	}
	bak := filepath.Join(hist, versionID+".bak")
	if _, err := os.Stat(bak); err != nil {
		writeErr(w, http.StatusNotFound, "Version not found")
		return
	}
	data, err := os.ReadFile(bak)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": string(data)})
}

func capReadPlan(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if len(path) > 512 {
		writeErr(w, http.StatusUnprocessableEntity, "path too long")
		return
	}
	plansRoot := capRealpath(filepath.Join(capGlobalRoot(), "plans"))
	target := capRealpath(path)
	if target != plansRoot && !strings.HasPrefix(target, plansRoot+string(os.PathSeparator)) {
		writeErr(w, http.StatusForbidden, "path outside plans directory")
		return
	}
	if filepath.Ext(target) != ".md" {
		writeErr(w, http.StatusUnsupportedMediaType, "must be a .md file")
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "plan file not found")
		return
	}
	if info.Size() > 512*1024 {
		writeErr(w, http.StatusRequestEntityTooLarge, "plan file too large (>512KB)")
		return
	}
	data, err := os.ReadFile(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": target, "content": string(data)})
}

func capRollback(w http.ResponseWriter, r *http.Request) {
	var body capRollbackRequest
	if !readJSON(w, r, &body) {
		return
	}
	hist, _, detail := capHistoryDirFor(body.Scope, body.Cwd, body.Relpath)
	if detail != "" {
		writeErr(w, http.StatusBadRequest, detail)
		return
	}
	bak := filepath.Join(hist, body.VersionID+".bak")
	if _, err := os.Stat(bak); err != nil {
		writeErr(w, http.StatusNotFound, "Version not found")
		return
	}
	target, st, detail := capResolve(body.Scope, body.Relpath, body.Cwd)
	if detail != "" {
		writeErr(w, st, detail)
		return
	}
	// Back up current file before restoring.
	capSaveVersion(body.Scope, body.Cwd, body.Relpath, target)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	data, err := os.ReadFile(bak)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// capQueryPtr returns a *string for an optional query param: nil when absent so
// the "cwd required" checks fire exactly like Python's Optional default=None.
func capQueryPtr(r *http.Request, key string) *string {
	if !r.URL.Query().Has(key) {
		return nil
	}
	v := r.URL.Query().Get(key)
	return &v
}
