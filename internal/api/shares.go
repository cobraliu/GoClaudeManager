package api

import (
	"bufio"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// registerShareRoutes registers the authenticated, session-scoped share CRUD
// endpoints on r (paths relative to the /api/sessions mount). The caller already
// applies d.Auth.RequireUser, so resolveOwned gives us the owning user/session.
//
// Mirrors the share routes in app/api/sessions.py (POST/GET/DELETE
// /{session_id}/shares).
func registerShareRoutes(r chi.Router, d Deps) {
	r.Post("/{id}/shares", func(w http.ResponseWriter, req *http.Request) { createShare(d, w, req) })
	r.Get("/{id}/shares", func(w http.ResponseWriter, req *http.Request) { listSessionShares(d, w, req) })
	r.Delete("/{id}/shares/{hash}", func(w http.ResponseWriter, req *http.Request) { deleteSessionShare(d, w, req) })
}

// shareCreateReq mirrors pydantic ShareCreateRequest.
type shareCreateReq struct {
	ShareType       string                `json:"share_type"`
	ExpiresAt       *float64              `json:"expires_at"`
	Permanent       bool                  `json:"permanent"`
	CutoffAfterUUID *string               `json:"cutoff_after_uuid"`
	DefaultTheme    string                `json:"default_theme"`
	FileAccess      *model.FileAccessSpec `json:"file_access"`
}

// shareToView mirrors _share_to_view: the owner-facing JSON for a share record.
func shareToView(d Deps, rec *model.ShareRecord) map[string]any {
	return map[string]any{
		"hash":            rec.Hash,
		"share_type":      rec.ShareType,
		"url":             d.Env.PublicPath(fmt.Sprintf("/share/%s/%s.html", rec.ShareType, rec.Hash)),
		"created_at":      rec.CreatedAt,
		"expires_at":      rec.ExpiresAt,
		"cutoff_ts":       rec.CutoffTs,
		"cutoff_msg_text": rec.CutoffMsgText,
		"default_theme":   rec.DefaultTheme,
		"has_files":       rec.FileAccess != nil && (len(rec.FileAccess.Full) > 0 || len(rec.FileAccess.Files) > 0),
	}
}

func createShare(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	var body shareCreateReq
	if !readJSON(w, r, &body) {
		return
	}
	if body.ShareType == "" {
		body.ShareType = "full"
	}
	if body.DefaultTheme == "" {
		body.DefaultTheme = "light"
	}

	var expiresAt float64
	switch {
	case body.Permanent:
		expiresAt = float64(model.PermanentShareExpires)
	case body.ExpiresAt != nil:
		expiresAt = *body.ExpiresAt
	default:
		writeErr(w, http.StatusUnprocessableEntity, "expires_at or permanent required")
		return
	}
	if expiresAt <= nowUnix() {
		writeErr(w, http.StatusUnprocessableEntity, "expiry must be in the future")
		return
	}
	due := int64(expiresAt)

	var (
		cutoffTs   *float64
		cutoffUUID *string
		cutoffText *string
		h          string
	)
	switch body.ShareType {
	case "limited":
		if body.CutoffAfterUUID == nil || *body.CutoffAfterUUID == "" {
			writeErr(w, http.StatusUnprocessableEntity, "cutoff_after_uuid required for limited share")
			return
		}
		jsonlPath := resolveSessionJSONL(s)
		if jsonlPath == "" {
			writeErr(w, http.StatusNotFound, "conversation not found")
			return
		}
		res := computeShareCutoff(jsonlPath, *body.CutoffAfterUUID)
		if res == nil {
			writeErr(w, http.StatusNotFound, "cutoff message not found")
			return
		}
		cutoffTs = &res.cutoffTs
		cutoffUUID = body.CutoffAfterUUID
		txt := res.cutoffMsgText
		cutoffText = &txt
		h = md5Hex(fmt.Sprintf("%s_%d_%d", s.ID, int64(res.cutoffTs), due))
	case "chat":
		// Distinct namespace so a chat share never collides with a full share
		// of the same session/expiry (both are cutoff-less).
		h = md5Hex(fmt.Sprintf("%s_chat_%d", s.ID, due))
	default:
		h = md5Hex(fmt.Sprintf("%s_%d", s.ID, due))
	}

	who := s.OwnerID
	rec := &model.ShareRecord{
		Hash:          h,
		SessionID:     s.ID,
		OwnerID:       who,
		ShareType:     body.ShareType,
		CutoffTs:      cutoffTs,
		CutoffMsgUUID: cutoffUUID,
		CutoffMsgText: cutoffText,
		CreatedAt:     nowUnix(),
		ExpiresAt:     expiresAt,
		DefaultTheme:  body.DefaultTheme,
	}
	// chat shares always expose the whole project read-only (full=[""]); the
	// client-supplied spec is ignored for them.
	switch {
	case body.ShareType == "chat":
		rec.FileAccess = &model.FileAccessSpec{Full: []string{""}}
	case body.FileAccess != nil && (len(body.FileAccess.Full) > 0 || len(body.FileAccess.Files) > 0):
		rec.FileAccess = body.FileAccess
	}

	if err := d.Store.CreateShare(rec); err != nil {
		writeErr(w, http.StatusInternalServerError, "create share failed")
		return
	}
	sharedShareCache(d).Put(rec)
	writeJSON(w, http.StatusOK, shareToView(d, rec))
}

func listSessionShares(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	recs, err := d.Store.ListShares(s.ID, s.OwnerID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list shares failed")
		return
	}
	out := make([]map[string]any, 0, len(recs))
	for _, rec := range recs {
		out = append(out, shareToView(d, rec))
	}
	writeJSON(w, http.StatusOK, out)
}

func deleteSessionShare(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	hash := chi.URLParam(r, "hash")
	if _, err := d.Store.DeleteShare(hash, s.OwnerID); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete share failed")
		return
	}
	sharedShareCache(d).Remove(hash)
	w.WriteHeader(http.StatusNoContent)
}

// ── helpers ──────────────────────────────────────────────────────────────────

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

// resolveSessionJSONL locates the session's transcript JSONL, preferring the
// recorded agent_session_id and falling back to the newest session under cwd
// (mirrors the adapter resolution in the Python share routes). Returns "" for
// cursor/codex tools whose transcripts are not line-based Claude JSONL.
func resolveSessionJSONL(s *model.Session) string {
	if s.Tool != "claude" && s.Tool != "" {
		return ""
	}
	chatSID := ""
	if s.AgentSessionID != nil {
		chatSID = *s.AgentSessionID
	}
	if chatSID == "" {
		chatSID = jsonl.FindNewestClaudeSessionID(s.Cwd)
	}
	if chatSID == "" {
		return ""
	}
	return jsonl.FindSessionJSONL(chatSID, s.Cwd)
}

// shareCutoffResult is the output of computeShareCutoff.
type shareCutoffResult struct {
	cutoffTs      float64
	cutoffMsgText string
}

// computeShareCutoff ports compute_share_cutoff from claude_session_reader.py.
//
// It finds the JSONL entry with uuid == afterUUID, then the FIRST turn_duration
// system entry after it (in effective-timestamp order); the cutoff is that
// marker's effective timestamp, so the chosen turn's full output is included.
// If no turn_duration follows yet (turn still in progress) it falls back to the
// latest entry's timestamp so everything currently present is included.
//
// Returns nil if the uuid was not found or the file could not be read.
func computeShareCutoff(jsonlPath, afterUUID string) *shareCutoffResult {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	type cutoffEntry struct {
		UUID      string          `json:"uuid"`
		Type      string          `json:"type"`
		Subtype   string          `json:"subtype"`
		Timestamp string          `json:"timestamp"`
		Message   json.RawMessage `json:"message"`
	}
	var entries []cutoffEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e cutoffEntry
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		entries = append(entries, e)
	}
	if len(entries) == 0 {
		return nil
	}

	// Effective timestamp per entry; entries without a parseable timestamp keep
	// their file position via the stable secondary sort key.
	eff := make([]float64, len(entries))
	for i, e := range entries {
		eff[i] = parseShareTs(e.Timestamp)
	}
	order := make([]int, len(entries))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if eff[ia] != eff[ib] {
			return eff[ia] < eff[ib]
		}
		return ia < ib
	})

	selPos := -1
	for pos, idx := range order {
		if entries[idx].UUID == afterUUID {
			selPos = pos
			break
		}
	}
	if selPos < 0 {
		return nil
	}

	// Text of the selected message (for the owner-facing preview).
	cutoffText := extractShareMsgText(entries[order[selPos]].Message)

	// First turn_duration system marker after the selected entry.
	for pos := selPos + 1; pos < len(order); pos++ {
		idx := order[pos]
		if entries[idx].Type == "system" && entries[idx].Subtype == "turn_duration" {
			return &shareCutoffResult{cutoffTs: eff[idx], cutoffMsgText: cutoffText}
		}
	}
	// No turn_duration yet: include everything currently present.
	lastIdx := order[len(order)-1]
	return &shareCutoffResult{cutoffTs: eff[lastIdx], cutoffMsgText: cutoffText}
}

// extractShareMsgText pulls a short text preview from a JSONL message field,
// which may be a string or a list of content blocks.
func extractShareMsgText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil || len(msg.Content) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(msg.Content, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(msg.Content, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				return b.Text
			}
		}
	}
	return ""
}

// parseShareTs parses an ISO-8601 timestamp into a Unix float, returning 0 on
// failure. Numeric strings are accepted as already-epoch values.
func parseShareTs(ts string) float64 {
	if ts == "" {
		return 0
	}
	if f, err := strconv.ParseFloat(ts, 64); err == nil {
		return f
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999999Z07:00"} {
		if t, err := time.Parse(layout, ts); err == nil {
			return float64(t.UnixNano()) / 1e9
		}
	}
	return 0
}
