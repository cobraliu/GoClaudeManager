package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/loki/goclaudemanager/internal/git"
	"github.com/loki/goclaudemanager/internal/jsonl"
	"github.com/loki/goclaudemanager/internal/model"
)

// Shadow-backup loop. On each completed turn (turn_duration) of an active
// session whose cwd is a git repo, it snapshots the working tree into a separate
// shadow git-dir under the data dir (never touching the real .git). See
// internal/git/shadow.go for the repo mechanics.

const shadowBackupInterval = 12 * time.Second

// shadowRoot is the root holding all per-project shadow repos (mirrors termsPath).
func shadowRoot(dataDir string) string {
	if dataDir != "" {
		return filepath.Join(dataDir, "shadow")
	}
	return filepath.Join("data", "shadow")
}

// shadowBackupEnabled is the global on/off (default on; set CLAUDEMANAGER_SHADOW_BACKUP=0/false to disable).
func shadowBackupEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CLAUDEMANAGER_SHADOW_BACKUP"))) {
	case "0", "false", "off", "no":
		return false
	}
	return true
}

// shadowMeta tracks the last backed-up turn timestamp per real branch, so each
// completed turn is snapshotted at most once. Stored as meta.json in the
// project's shadow dir.
type shadowMeta struct {
	Workdir    string             `json:"workdir"`
	LastBackup map[string]float64 `json:"last_backup"` // realBranch → turnTs
}

func loadShadowMeta(projectDir string) shadowMeta {
	m := shadowMeta{LastBackup: map[string]float64{}}
	b, err := os.ReadFile(filepath.Join(projectDir, "meta.json"))
	if err != nil {
		return m
	}
	_ = json.Unmarshal(b, &m)
	if m.LastBackup == nil {
		m.LastBackup = map[string]float64{}
	}
	return m
}

func saveShadowMeta(projectDir string, m shadowMeta) {
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		return
	}
	if b, err := json.MarshalIndent(m, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(projectDir, "meta.json"), b, 0o644)
	}
}

// runShadowBackup is the background loop (wired in App.Start alongside the others).
func (a *App) runShadowBackup(ctx context.Context) {
	if !shadowBackupEnabled() {
		slog.Info("shadow-backup: disabled via CLAUDEMANAGER_SHADOW_BACKUP")
		return
	}
	ticker := time.NewTicker(shadowBackupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.shadowBackupTick(ctx)
		}
	}
}

func (a *App) shadowBackupTick(ctx context.Context) {
	sessions, err := a.Store.All()
	if err != nil {
		return
	}
	root := shadowRoot(a.Env.DataDir)
	for _, s := range sessions {
		a.shadowBackupSession(ctx, root, s)
	}
}

func (a *App) shadowBackupSession(ctx context.Context, root string, s *model.Session) {
	if s.Status != model.StatusRunning && s.Status != model.StatusDetached {
		return
	}
	if s.Tool == "codex" && s.CodexTransport == "app_server" {
		return // no turn_duration markers
	}
	if s.AgentSessionID == nil || *s.AgentSessionID == "" {
		return
	}
	cwd := s.Cwd
	if cwd == "" {
		return
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return
	}
	// Only back up actual git projects (avoids tracking arbitrary/huge trees).
	if !a.Git.IsRepo(cwd) {
		return
	}

	projectDir := git.ShadowProjectDir(root, cwd)
	gitDir := git.ShadowGitDir(root, cwd)
	branch := a.Git.RealBranch(ctx, cwd)

	meta := loadShadowMeta(projectDir)
	last := meta.LastBackup[branch]

	// prompts since `last`; TurnTs is the global max turn timestamp.
	info, err := jsonl.GetLatestTurnInfo(*s.AgentSessionID, cwd, last)
	if err != nil || info.TurnTs <= last {
		return // no newly-completed turn since last backup
	}

	prompts := make([]git.PromptEntry, 0, len(info.PromptsSince))
	for _, p := range info.PromptsSince {
		prompts = append(prompts, git.PromptEntry{Text: p.Text, TS: p.Ts, TimeStr: p.TimeStr})
	}
	msg := git.MakeCommitMessage(prompts, info.LastSummary) +
		fmt.Sprintf("\n\nTurn-Ts: %d\nSession: %s\nReal-Branch: %s", int64(info.TurnTs), s.ID, branch)

	if _, committed, err := a.Git.ShadowSnapshot(ctx, gitDir, cwd, branch, msg, "claude"); err != nil {
		slog.Warn("shadow-backup: snapshot failed", "session", s.ID, "cwd", cwd, "err", err)
		return
	} else if committed {
		slog.Debug("shadow-backup: snapshot", "session", s.ID, "branch", branch)
	}
	// Advance the watermark even when nothing changed on disk, so we don't retry
	// the same turn every tick.
	meta.Workdir = cwd
	meta.LastBackup[branch] = info.TurnTs
	saveShadowMeta(projectDir, meta)
}
