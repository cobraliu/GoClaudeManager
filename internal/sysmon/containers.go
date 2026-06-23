package sysmon

// Per-container network sampling via `docker stats`.
//
// Containers run in their own network namespace, so the host-side `ss` (see
// netmon.go) never sees their sockets — host per-process attribution misses them
// entirely. `docker stats` reads the daemon's own cgroup/interface accounting,
// which works for EVERY running container regardless of what's in the image
// (distroless containers with no shell included), making it the only robust
// source. We read the cumulative NetIO column and delta it across samples for a
// rate, exactly like the /proc-based counters.
//
// Requires the manager's user to be able to talk to the docker daemon. When the
// `docker` binary is absent (dockerPath == ""), container sampling is silently
// disabled and the rest of monitoring is unaffected.

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// dockerStatsTimeout bounds the `docker stats` call. --no-stream still makes the
// daemon collect a one-shot sample (~1–1.5s), so the budget is generous.
const dockerStatsTimeout = 6 * time.Second

// containerBytes is a container's cumulative net rx/tx (carry between samples).
type containerBytes struct{ rx, tx uint64 }

// readContainerNet runs `docker stats` once and returns container-name →
// cumulative {rx,tx} bytes. ok is false when docker is unavailable or the call
// fails, in which case the caller leaves container rates untouched.
func readContainerNet(ctx context.Context, dockerPath string) (map[string]containerBytes, bool) {
	if dockerPath == "" {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, dockerStatsTimeout)
	defer cancel()
	// --no-stream: single snapshot, --no-trunc: full names. NetIO is the
	// cumulative "rx / tx" pair in SI-unit human form.
	out, err := exec.CommandContext(ctx, dockerPath, "stats", "--no-stream", "--no-trunc",
		"--format", "{{.Name}}\t{{.NetIO}}").Output()
	if err != nil {
		return nil, false
	}
	return parseDockerStats(string(out)), true
}

// parseDockerStats parses lines of "<name>\t<rx> / <tx>" (the format string in
// readContainerNet). Malformed lines are skipped. Bytes are cumulative since
// container start.
func parseDockerStats(s string) map[string]containerBytes {
	res := map[string]containerBytes{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		tab := strings.IndexByte(line, '\t')
		if tab < 0 {
			continue
		}
		name := strings.TrimSpace(line[:tab])
		// NetIO looks like "3.7GB / 2.96GB" (rx is first, tx second).
		parts := strings.SplitN(line[tab+1:], "/", 2)
		if name == "" || len(parts) != 2 {
			continue
		}
		rx, ok1 := parseHumanBytes(strings.TrimSpace(parts[0]))
		tx, ok2 := parseHumanBytes(strings.TrimSpace(parts[1]))
		if !ok1 || !ok2 {
			continue
		}
		res[name] = containerBytes{rx: rx, tx: tx}
	}
	return res
}

// siUnit maps docker's NetIO unit suffixes to their byte multiplier. Docker
// uses decimal (SI) units, e.g. 1kB == 1000 B.
var siUnit = []struct {
	suffix string
	mult   float64
}{
	// Order matters: check the longer suffixes ("kB") before the bare "B".
	{"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"KB", 1e3}, {"B", 1},
}

// parseHumanBytes converts a docker NetIO value like "3.7GB", "256kB" or "0B"
// to bytes. ok is false when the value can't be parsed.
func parseHumanBytes(v string) (uint64, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	for _, u := range siUnit {
		if strings.HasSuffix(v, u.suffix) {
			num := strings.TrimSpace(strings.TrimSuffix(v, u.suffix))
			f, err := strconv.ParseFloat(num, 64)
			if err != nil || f < 0 {
				return 0, false
			}
			return uint64(f * u.mult), true
		}
	}
	return 0, false
}
