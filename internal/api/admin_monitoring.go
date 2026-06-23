// Admin-scoped, read-only server monitoring (prefix /api/admin/monitoring).
//
// A "top-like" view of the host the manager runs on: overall CPU/memory/load
// plus the top processes by CPU. The numbers come from a background sysmon
// sampler (internal/sysmon) that reads /proc on a 2s cadence; this handler just
// returns the latest cached snapshot, so it is cheap and never blocks. There
// are no mutating endpoints — the panel is observe-only (no process kill).
package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/loki/goclaudemanager/internal/sysmon"
)

// AdminMonitoringRouter builds the /api/admin/monitoring sub-router (admin-only).
func AdminMonitoringRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(d.Auth.RequireAdmin)

	r.Get("/stats", func(w http.ResponseWriter, r *http.Request) { adminMonitoringStats(d, w, r) })

	return r
}

func adminMonitoringStats(d Deps, w http.ResponseWriter, r *http.Request) {
	if d.Sysmon == nil {
		writeErr(w, http.StatusServiceUnavailable, "monitoring unavailable")
		return
	}
	s := d.Sysmon.Latest()

	// View parameters: sort=cpu|mem|net (default cpu), limit (default 20, clamped
	// to [1, MaxTopN] inside sysmon.Top). The sampler holds every process;
	// ranking and truncation happen here so the client can switch without a
	// re-sample.
	sortBy := r.URL.Query().Get("sort")
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	procs := sysmon.Top(s.Processes, sortBy, limit)

	// "Other" = real NIC total minus the host-process traffic we could attribute.
	// It covers everything the per-process pass can't map to a visible host
	// process: other users' sockets (non-root), UDP/QUIC, short-lived connections,
	// kernel, and any container's off-box egress. Summed over the FULL process
	// slice (not the truncated Top view), clamped at 0 to absorb sampling skew.
	//
	// Containers are deliberately NOT subtracted: `docker stats` measures all of a
	// container's traffic (incl. intra-host / cached) on a different plane than the
	// physical NIC, so a container's number isn't a clean subset of the NIC total —
	// subtracting it could wrongly zero out real unattributed traffic. The
	// container table is a separate breakdown, reconciled only loosely.
	var accRx, accTx float64
	for _, p := range s.Processes {
		accRx += p.NetRxBytesPerSec
		accTx += p.NetTxBytesPerSec
	}
	other := map[string]float64{
		"rx_bps": max(0, s.Net.RxBytesPerSec-accRx),
		"tx_bps": max(0, s.Net.TxBytesPerSec-accTx),
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"overall":    s.Overall,
		"net":        s.Net,
		"processes":  procs,
		"containers": s.Containers,
		"other":      other,
		"timestamp":  s.Timestamp,
		"ready":      s.Ready,
	})
}
