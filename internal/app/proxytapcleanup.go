package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Cleanup for ~/.claude/cached_messages/ written by the anthropic proxy tap.
// Port of app/services/proxy_tap_cleanup.py. Three rules:
//
//  1. JSONL-caught-up: delete snapshots whose ts_ns ≤ max(timestamp) in the
//     matching Claude JSONL — once the CLI has flushed past them they are
//     redundant duplicates of what the JSONL reader already serves.
//  2. Session-gone: delete whole directories whose claude_session_id no longer
//     appears in the SessionStore AND has no JSONL on disk.
//  3. 7-day fallback: delete any file older than 7 days that escaped rules 1/2.
const (
	proxyTapFirstDelay   = 15 * time.Second
	proxyTapInterval     = 30 * time.Second
	proxyTapTailBytes    = 8192
	proxyTapFallbackAgeS = 7 * 24 * 3600
)

// runProxyTapCleanup runs the snapshot-cleanup sweep on an interval until ctx is
// cancelled, mirroring claudemanager._proxy_tap_cleanup_loop (15s warm-up, 30s
// cadence).
func (a *App) runProxyTapCleanup(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(proxyTapFirstDelay):
	}
	a.proxyTapCleanupOnce()
	ticker := time.NewTicker(proxyTapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.proxyTapCleanupOnce()
		}
	}
}

func cachedMessagesRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "cached_messages")
}

func claudeProjectsRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// findJSONLByCSID returns the path of <projects>/*/<csid>.jsonl, or "".
func findJSONLByCSID(csid string) string {
	root := claudeProjectsRoot()
	if root == "" {
		return ""
	}
	matches, err := filepath.Glob(filepath.Join(root, "*", csid+".jsonl"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	return matches[0]
}

// lastJSONLTsNs best-effort parses the latest `timestamp` field from the last
// few KB of a JSONL file, returning it as ns since epoch (0 if none found).
func lastJSONLTsNs(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0
	}
	size := fi.Size()
	start := size - proxyTapTailBytes
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err.Error() != "EOF" {
		return 0
	}
	lines := strings.Split(string(buf), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var obj struct {
			Timestamp string `json:"timestamp"`
		}
		if json.Unmarshal([]byte(line), &obj) != nil || obj.Timestamp == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339Nano, obj.Timestamp); err == nil {
			return t.UnixNano()
		}
	}
	return 0
}

// deleteCaughtUp removes snapshot files in sessionDir whose embedded ts_ns is
// ≤ maxJSONLTsNs. Returns the count removed.
func deleteCaughtUp(sessionDir string, maxJSONLTsNs int64) int {
	if maxJSONLTsNs <= 0 {
		return 0
	}
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, de := range entries {
		name := de.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		tsNs, err := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64)
		if err != nil {
			continue
		}
		if tsNs <= maxJSONLTsNs {
			if os.Remove(filepath.Join(sessionDir, name)) == nil {
				removed++
			}
		}
	}
	return removed
}

// sweepOldSnapshots is the 7-day fallback: delete files whose filename ts is
// older than the cutoff.
func sweepOldSnapshots(root string, nowNs int64) int {
	cutoff := nowNs - int64(proxyTapFallbackAgeS)*1_000_000_000
	dirs, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	removed := 0
	for _, sd := range dirs {
		if !sd.IsDir() {
			continue
		}
		sessionDir := filepath.Join(root, sd.Name())
		entries, err := os.ReadDir(sessionDir)
		if err != nil {
			continue
		}
		for _, de := range entries {
			name := de.Name()
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			tsNs, err := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64)
			if err != nil {
				continue
			}
			if tsNs < cutoff {
				if os.Remove(filepath.Join(sessionDir, name)) == nil {
					removed++
				}
			}
		}
	}
	return removed
}

// proxyTapCleanupOnce runs one pass of all three cleanup rules.
func (a *App) proxyTapCleanupOnce() {
	root := cachedMessagesRoot()
	if root == "" {
		return
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		return
	}

	liveCSIDs, err := a.Store.GetAllAgentSessionIDs("")
	if err != nil {
		liveCSIDs = map[string]bool{}
	}

	dirs, err := os.ReadDir(root)
	if err != nil {
		return
	}

	caughtUp, orphanDirs := 0, 0
	for _, sd := range dirs {
		if !sd.IsDir() {
			continue
		}
		csid := sd.Name()
		sessionDir := filepath.Join(root, csid)
		jsonlPath := findJSONLByCSID(csid)

		// Rule 2: orphan directory — not tracked AND no JSONL to link back to.
		if !liveCSIDs[csid] && jsonlPath == "" {
			if os.RemoveAll(sessionDir) == nil {
				orphanDirs++
			}
			continue
		}

		// Rule 1: JSONL caught up.
		if jsonlPath != "" {
			caughtUp += deleteCaughtUp(sessionDir, lastJSONLTsNs(jsonlPath))
		}
	}

	// Rule 3: time-based fallback.
	fallback := sweepOldSnapshots(root, time.Now().UnixNano())

	if caughtUp != 0 || orphanDirs != 0 || fallback != 0 {
		slog.Info("proxy_tap cleanup",
			"caught_up", caughtUp, "orphan_dirs", orphanDirs, "fallback", fallback)
	}
}
