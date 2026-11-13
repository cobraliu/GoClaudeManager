package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/loki/goclaudemanager/internal/store"
)

const (
	// usageSampleEvery is the idle sampling cadence. While a page is open its
	// /api/usage polls refresh (and record) every usageCacheTTL instead.
	usageSampleEvery = 15 * time.Minute
	usageSampleKeep  = 14 * 24 * time.Hour
)

// usageFetchMu serializes real probes so concurrent callers share one.
var usageFetchMu sync.Mutex

// refreshUsage returns the cached rate-limit windows while fresh
// (usageCacheTTL); otherwise probes, updates the cache and records a sample.
// On a failed probe the stale cache is returned if there is one.
func refreshUsage(d Deps) (map[string]usageWindow, error) {
	usageFetchMu.Lock()
	defer usageFetchMu.Unlock()

	usageCacheMu.Lock()
	cached, ts := usageCache, usageCacheTS
	usageCacheMu.Unlock()
	if cached != nil && time.Since(ts) < usageCacheTTL {
		return cached, nil
	}

	data, err := fetchRateLimits(d.Cfg.Proxy())
	if err != nil {
		slog.Warn("usage probe failed", "err", err)
		if cached != nil {
			return cached, nil
		}
		return nil, err
	}
	now := time.Now()
	usageCacheMu.Lock()
	usageCache = data
	usageCacheTS = now
	usageCacheMu.Unlock()
	recordUsage(d, now, data)
	return data, nil
}

// RunUsageSampler calls refreshUsage every usageSampleEvery, so samples keep
// accruing (at least 4/hour) when nobody has the page open. A tick within
// usageCacheTTL of a page-driven probe is a no-op. Runs until ctx is done.
func RunUsageSampler(ctx context.Context, d Deps) {
	t := time.NewTicker(usageSampleEvery)
	defer t.Stop()
	for {
		_, _ = refreshUsage(d)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func recordUsage(d Deps, now time.Time, data map[string]usageWindow) {
	if len(data) == 0 || d.Store == nil {
		return // no OAuth credentials / no headers — nothing to record
	}
	u := store.UsageSample{TS: now.Unix()}
	if w, ok := data["five_hour"]; ok {
		v := w.Utilization
		u.FiveHour, u.FiveReset = &v, resetUnix(w.ResetsAt)
	}
	if w, ok := data["seven_day"]; ok {
		v := w.Utilization
		u.SevenDay, u.SevenReset = &v, resetUnix(w.ResetsAt)
	}
	if err := d.Store.AddUsageSample(u, now.Add(-usageSampleKeep).Unix()); err != nil {
		slog.Warn("usage sample store failed", "err", err)
	}
}

func resetUnix(iso *string) *int64 {
	if iso == nil {
		return nil
	}
	t, err := time.Parse(time.RFC3339, *iso)
	if err != nil {
		return nil
	}
	v := t.Unix()
	return &v
}

// getUsageHistory: GET /api/usage/history → all retained samples, oldest first.
func getUsageHistory(d Deps, w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.ListUsageSamples(time.Now().Add(-usageSampleKeep).Unix())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"samples": rows, "interval": int(usageSampleEvery.Seconds())})
}
