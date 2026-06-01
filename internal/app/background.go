package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/loki/goclaudemanager/internal/model"
)

func newUUID() string { return uuid.NewString() }

// reconcileOnStartup syncs persisted session state against live tmux sessions
// (port of the startup portion of claudemanager._sync_session_states): any
// RUNNING/CREATING/DETACHED session whose tmux session is gone is marked
// TERMINATED. Codex app-server sessions are skipped (Phase 3).
func (a *App) reconcileOnStartup() {
	sessions, err := a.Store.All()
	if err != nil {
		slog.Warn("startup reconcile: store.All failed", "err", err)
		return
	}
	n := 0
	for _, s := range sessions {
		switch s.Status {
		case model.StatusRunning, model.StatusCreating, model.StatusDetached:
			if s.Tool == "codex" && s.CodexTransport == "app_server" {
				continue // managed separately (Phase 3)
			}
			if !a.Tmux.HasSession(s.TmuxSessionName) {
				_ = a.Store.ForceStatus(s.ID, model.StatusTerminated)
				n++
			}
		}
	}
	if n > 0 {
		slog.Info("startup reconcile: terminated stale sessions", "count", n)
	}
}

// runTaskScheduler fires scheduled tasks whose run_at has passed (port of
// claudemanager._fire_due_tasks + its 2s loop).
func (a *App) runTaskScheduler(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.fireDueTasks()
		}
	}
}

func (a *App) fireDueTasks() {
	due, err := a.Store.ListDueTasks()
	if err != nil {
		return
	}
	for _, task := range due {
		session, _ := a.Store.GetSession(task.SessionID)
		if session == nil || session.Status == model.StatusTerminated {
			_ = a.Store.UpdateTaskStatus(task.ID, "failed", strp("session not running"))
			continue
		}
		if !a.Tmux.HasSession(session.TmuxSessionName) {
			_ = a.Store.UpdateTaskStatus(task.ID, "failed", strp("tmux session gone"))
			continue
		}
		if err := a.Tmux.SendKeys(session.TmuxSessionName, task.Command); err != nil {
			_ = a.Store.UpdateTaskStatus(task.ID, "failed", strp(err.Error()))
			continue
		}
		_ = a.Store.UpdateTaskStatus(task.ID, "sent", nil)
		// Repeating task: anchor the next run on now, not run_at, so a missed
		// tick won't pile up.
		if task.LoopSeconds != nil && *task.LoopSeconds > 0 {
			next := &model.ScheduledTask{
				ID:          newUUID(),
				SessionID:   task.SessionID,
				OwnerID:     task.OwnerID,
				Command:     task.Command,
				RunAt:       model.ISOTime{Time: time.Now().UTC().Add(time.Duration(*task.LoopSeconds) * time.Second)},
				Status:      "pending",
				CreatedAt:   model.NowUTC(),
				LoopSeconds: task.LoopSeconds,
			}
			_ = a.Store.CreateTask(next)
		}
	}
}

func strp(s string) *string { return &s }
