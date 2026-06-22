package api

import (
	"net/http"
	"time"

	"github.com/loki/goclaudemanager/internal/model"
	"github.com/loki/goclaudemanager/internal/procmon"
)

// listProcesses returns the live process tree rooted at the session's Claude
// process (pane PID) — every descendant, subagent-spawned children included —
// with CPU%, memory, uptime, full command line, and a tail of any redirected
// stdout/stderr log. The frontend polls this for the active session only,
// ~every 3s, so the sampler runs synchronously here (no background goroutine)
// and keeps a per-session jiffy snapshot to make CPU% a delta across polls.
func listProcesses(d Deps, w http.ResponseWriter, r *http.Request) {
	s := resolveOwned(d, w, r)
	if s == nil {
		return
	}
	if d.Procmon == nil {
		writeErr(w, http.StatusServiceUnavailable, "process monitoring unavailable")
		return
	}

	// A session with no live pane process has nothing to enumerate.
	running := s.Status == model.StatusRunning || s.Status == model.StatusDetached
	if !running || s.ClaudeProcPID == nil {
		writeJSON(w, http.StatusOK, procmon.Snapshot{
			RootPID:   s.ClaudeProcPID,
			Processes: []procmon.ProcessInfo{},
			Timestamp: time.Now(),
		})
		return
	}

	snap := d.Procmon.Sample(s.ID, *s.ClaudeProcPID, queryInt(r, "tail", 30))
	writeJSON(w, http.StatusOK, snap)
}
