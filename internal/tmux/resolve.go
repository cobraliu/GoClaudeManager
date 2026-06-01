package tmux

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// getDescendants returns all descendant PIDs of a process by reading /proc
// on Linux. (Port of TmuxService._get_descendants.)
//
// It builds a parent→children map from every /proc/<pid>/stat, then does a BFS
// from pid. The ppid is the second field after the closing ")" of the comm
// field — splitting on ")" and taking the last segment avoids being fooled by
// process names that themselves contain spaces or parentheses.
func getDescendants(pid int) ([]int, error) {
	childrenMap, err := buildChildrenMap()
	if err != nil {
		return nil, err
	}
	var result []int
	queue := append([]int(nil), childrenMap[pid]...)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)
		queue = append(queue, childrenMap[current]...)
	}
	return result, nil
}

// buildChildrenMap scans /proc and returns a parent-pid → child-pids map.
func buildChildrenMap() (map[int][]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	childrenMap := make(map[int][]int)
	for _, entry := range entries {
		name := entry.Name()
		child, err := strconv.Atoi(name)
		if err != nil {
			continue // not a pid directory
		}
		ppid, ok := readPPID(filepath.Join("/proc", name, "stat"))
		if !ok {
			continue
		}
		childrenMap[ppid] = append(childrenMap[ppid], child)
	}
	return childrenMap, nil
}

// readPPID parses the parent PID out of a /proc/<pid>/stat file.
// Format: "PID (comm) STATE PPID ...". The comm field may contain spaces and
// parens, so we split on the LAST ')' and read field index 1 of the remainder.
func readPPID(statPath string) (int, bool) {
	data, err := os.ReadFile(statPath)
	if err != nil {
		return 0, false
	}
	s := string(data)
	idx := strings.LastIndex(s, ")")
	if idx < 0 {
		return 0, false
	}
	parts := strings.Fields(s[idx+1:])
	// parts[0] = state, parts[1] = ppid (mirrors the Python parts[1]).
	if len(parts) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, false
	}
	return ppid, true
}

// claudeSessionsDir returns ~/.claude/sessions.
func claudeSessionsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "sessions")
}

// readSessionID reads sessionId from a ~/.claude/sessions/<pid>.json file.
// Returns ("", false) if the file is missing, malformed, or has no sessionId.
func readSessionID(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var obj struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return "", false
	}
	if obj.SessionID == "" {
		return "", false
	}
	return obj.SessionID, true
}

// sessionFileInfo is the subset of ~/.claude/sessions/<pid>.json the resolver
// needs to pick the RIGHT, freshest session for a tmux pane.
type sessionFileInfo struct {
	sessionID string
	cwd       string
	updatedAt int64 // epoch ms; 0 if absent
}

// readSessionInfo reads sessionId + cwd + updatedAt from a session file.
// Returns ok=false when the file is missing, malformed, or has no sessionId.
func readSessionInfo(path string) (sessionFileInfo, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return sessionFileInfo{}, false
	}
	var obj struct {
		SessionID string `json:"sessionId"`
		Cwd       string `json:"cwd"`
		UpdatedAt int64  `json:"updatedAt"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return sessionFileInfo{}, false
	}
	if obj.SessionID == "" {
		return sessionFileInfo{}, false
	}
	return sessionFileInfo{obj.SessionID, obj.Cwd, obj.UpdatedAt}, true
}

// sameCwd reports whether two working-directory paths refer to the same place,
// tolerating trailing-slash / "." differences (a managed session's stored cwd
// may carry a trailing slash while Claude records the cleaned path).
func sameCwd(a, b string) bool {
	if a == "" || b == "" {
		return true // can't disprove a match → don't reject on missing data
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// ResolveAgentSessionID waits for the Claude CLI to start and write its session
// file, then reads the Claude session id from ~/.claude/sessions/{pid}.json.
//
// Strategy: poll the pane PID and all its descendants, reading every session
// file that exists for them. Among those, it keeps ONLY files whose recorded
// cwd matches this session's cwd and returns the one with the newest updatedAt.
//
// Why the cwd + newest filter (this is the fix for stale/wrong agent_session_id
// capture): session files in ~/.claude/sessions are keyed by pid and are NOT
// removed when Claude exits, so a recycled pid among the pane's descendants can
// carry a STALE file from a Claude that ran in a different directory. Returning
// the first file found (the old behavior) could therefore record an id whose
// transcript belongs to another session — or no transcript at all — which then
// breaks `claude --resume`. Matching cwd rejects the foreign files; newest
// updatedAt prefers the live process when several legitimately share the cwd.
//
// cwd may be "" (caller doesn't know it), in which case the cwd filter is a
// no-op and behavior falls back to newest-updatedAt across all candidates.
// Returns (sessionID, pid, true) on success, or ("", 0, false) on timeout.
func (c *Client) ResolveAgentSessionID(sessionName, cwd string, timeout time.Duration) (string, int, bool) {
	dir := claudeSessionsDir()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if panePID, ok := c.GetPanePID(sessionName); ok {
			candidates := []int{panePID}
			if desc, err := getDescendants(panePID); err == nil {
				candidates = append(candidates, desc...)
			}
			bestSID, bestPID := "", 0
			bestUpdated := int64(-1)
			for _, dpid := range candidates {
				info, ok := readSessionInfo(filepath.Join(dir, strconv.Itoa(dpid)+".json"))
				if !ok || !sameCwd(cwd, info.cwd) {
					continue
				}
				if info.updatedAt > bestUpdated {
					bestUpdated, bestSID, bestPID = info.updatedAt, info.sessionID, dpid
				}
			}
			if bestSID != "" {
				return bestSID, bestPID, true
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return "", 0, false
}

// ResolveAgentSessionIDByInnerID resolves the Claude session id for a new
// session using the PID file written by the wrapper sh
// (/tmp/claude-inner-<innerID>.pid). Returns (sessionID, pid, true) on success.
// On failure the returned pid may still be non-zero (the wrapper wrote it but
// the session file never appeared) with ok=false, mirroring the Python tuple
// (None, found_pid). (Port of resolve_agent_session_id_by_inner_id.)
func (c *Client) ResolveAgentSessionIDByInnerID(innerID, cwd string, timeout time.Duration) (string, int, bool) {
	pidFile := "/tmp/claude-inner-" + innerID + ".pid"
	dir := claudeSessionsDir()
	deadline := time.Now().Add(timeout)
	foundPID := 0

	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
				foundPID = pid
				sessionFile := filepath.Join(dir, strconv.Itoa(pid)+".json")
				// Require the session file's cwd to match: a recycled pid may
				// still carry a stale file from a Claude that ran elsewhere; keep
				// polling until our freshly-spawned Claude overwrites it.
				if info, ok := readSessionInfo(sessionFile); ok && sameCwd(cwd, info.cwd) {
					_ = os.Remove(pidFile)
					return info.sessionID, foundPID, true
				}
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	_ = os.Remove(pidFile)
	return "", foundPID, false
}
