package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/jsonl"
)

// registerToolsRoutes wires the standalone (non-session) utility endpoints onto
// the root /api router. They require an authenticated user but are NOT tied to
// any session — they operate on uploaded data, not a session's workspace.
func registerToolsRoutes(r chi.Router, d Deps) {
	r.With(d.Auth.RequireUser).Post("/tools/jsonl-parse", func(w http.ResponseWriter, req *http.Request) {
		toolsParseJSONL(d, w, req)
	})
}

// toolsParseJSONL accepts an uploaded JSONL transcript (multipart "file") and
// returns it parsed into the same {messages, total} shape the session
// /raw-messages endpoint produces, so the frontend can render it with the
// existing Chat renderer. The upload is written to a throwaway temp file (the
// canonical parser is path-based), parsed, and deleted — nothing is persisted.
func toolsParseJSONL(d Deps, w http.ResponseWriter, r *http.Request) {
	// 100 MB cap, matching fs/raw — transcripts can be large.
	if err := r.ParseMultipartForm(filesRawMaxSize + 1<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	content, err := io.ReadAll(io.LimitReader(file, filesRawMaxSize+1))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(content) > filesRawMaxSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large (>100MB)")
		return
	}

	tmp, err := os.CreateTemp("", "gocm-jsonl-*.jsonl")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := tmp.Close(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	// tail<=0 → read & order the whole file exactly like a live session does.
	messages, total, err := jsonl.ReadRawMessagesTail(tmpPath, 0)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "could not parse JSONL: "+err.Error())
		return
	}
	if messages == nil {
		messages = []json.RawMessage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages, "total": total})
}
