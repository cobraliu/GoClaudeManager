package sysmon

// Network throughput sampling. Two parts:
//
//   - Machine-wide totals (in/out bytes/sec) from /proc/net/dev — covers every
//     protocol and every user, the authoritative total.
//   - Per-process in/out from `ss -tinHp`, which exposes each TCP socket's
//     cumulative bytes_received (in) / bytes_acked (out) plus the owning pid.
//     We sum per pid and delta across samples to get a rate.
//
// Per-process attribution is TCP-only and limited to processes the manager can
// see (its own user when not root); short-lived connections that open and close
// between samples are missed. The totals card is exact; the per-process numbers
// are a best-effort breakdown and will not sum to the total. All rates are
// bytes/sec, computed against the wall-clock gap between samples (see refresh).

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// NetTotals is the real off-box network throughput, split into inbound (rx) and
// outbound (tx) bytes/sec. Sourced from /proc/net/dev but summed over PHYSICAL
// interfaces only (those with a backing device under /sys/class/net) — bridges,
// veth pairs, docker0 and lo are excluded so bridged container traffic isn't
// double/triple-counted across the NIC + bridge + veth it traverses.
type NetTotals struct {
	RxBytesPerSec float64 `json:"rx_bps"` // inbound / download
	TxBytesPerSec float64 `json:"tx_bps"` // outbound / upload
}

// procNetBytes is a pid's cumulative TCP byte counters (carry between samples).
type procNetBytes struct{ rx, tx uint64 }

// ssTimeout bounds the `ss` invocation so a wedged netlink call can't stall the
// sampler loop.
const ssTimeout = 4 * time.Second

// readNetDevTotals sums rx/tx bytes across the physical interfaces only.
func readNetDevTotals() (rx, tx uint64, ok bool) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0, false
	}
	return parseNetDev(string(b), isPhysicalIface)
}

// isPhysicalIface reports whether name is a real NIC rather than a virtual
// interface (bridge, veth, docker0, lo, tun, …). A physical interface has a
// backing device symlink at /sys/class/net/<name>/device; virtual ones don't.
func isPhysicalIface(name string) bool {
	_, err := os.Lstat("/sys/class/net/" + name + "/device")
	return err == nil
}

// parseNetDev parses /proc/net/dev. Each data line is "iface: rxbytes rxpkts
// ... txbytes txpkts ..." with 8 receive then 8 transmit columns. Only
// interfaces for which keep(name) returns true are summed, so the totals reflect
// real off-box traffic without double-counting it across virtual interfaces.
func parseNetDev(s string, keep func(string) bool) (rx, tx uint64, ok bool) {
	for _, line := range strings.Split(s, "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue // the two header rows have no "iface:" colon
		}
		name := strings.TrimSpace(line[:i])
		if name == "" || !keep(name) {
			continue
		}
		f := strings.Fields(line[i+1:])
		if len(f) < 16 {
			continue
		}
		r, e1 := strconv.ParseUint(f[0], 10, 64) // receive bytes
		t, e2 := strconv.ParseUint(f[8], 10, 64) // transmit bytes
		if e1 != nil || e2 != nil {
			continue
		}
		rx += r
		tx += t
		ok = true
	}
	return rx, tx, ok
}

// readProcNetBytes runs `ss -tinHp` and returns pid → cumulative {rx,tx} bytes
// (rx = Σ bytes_received, tx = Σ bytes_acked over that pid's TCP sockets). ok is
// false when ss is unavailable or fails, in which case the caller leaves all
// per-process net rates at zero (the totals card is unaffected).
func readProcNetBytes(ctx context.Context, ssPath string) (map[int]procNetBytes, bool) {
	if ssPath == "" {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, ssTimeout)
	defer cancel()
	// -t TCP, -i tcp_info (carries the byte counters), -n numeric, -H no header,
	// -p process info (users:(("comm",pid=N,fd=M))).
	out, err := exec.CommandContext(ctx, ssPath, "-tinHp").Output()
	if err != nil {
		return nil, false
	}
	return parseSS(string(out)), true
}

// parseSS parses `ss -tinHp` output. Records come in pairs: a socket header line
// (carrying the users:(...) process field) followed by a whitespace-indented
// info line (carrying bytes_received: / bytes_acked:). Bytes are attributed to
// the first pid listed on the preceding header.
//
// Loopback sockets (peer 127.0.0.0/8 or ::1) are skipped: that traffic never
// crosses a physical NIC, and on hosts with a local proxy (here curl→127.0.0.1:
// proxy) it would otherwise dwarf the real off-box total and make the per-process
// breakdown un-reconcilable with it. The proxy's own upstream (external peer) is
// still counted, which is where the NIC bytes actually go.
func parseSS(s string) map[int]procNetBytes {
	res := map[int]procNetBytes{}
	curPID := 0
	have := false
	for _, line := range strings.Split(s, "\n") {
		if line == "" {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			// Continuation (info) line for the socket header just seen.
			if !have {
				continue
			}
			b := res[curPID]
			b.rx += extractUint(line, "bytes_received:")
			b.tx += extractUint(line, "bytes_acked:")
			res[curPID] = b
			have = false
			continue
		}
		// Socket header line. Attribute to the first pid= it lists, unless the
		// peer is loopback (intra-host, not real network bandwidth).
		have = false
		if pid, ok := firstPID(line); ok && !peerIsLoopback(line) {
			curPID = pid
			have = true
		}
	}
	return res
}

// peerIsLoopback reports whether the remote end of an `ss` header line is a
// loopback address. The peer "addr:port" is the last whitespace field before the
// users:(…) column (or the last field when there is none).
func peerIsLoopback(line string) bool {
	seg := line
	if u := strings.Index(line, "users:("); u >= 0 {
		seg = line[:u]
	}
	f := strings.Fields(seg)
	if len(f) < 2 {
		return false
	}
	peer := f[len(f)-1]
	host := peer
	if c := strings.LastIndexByte(peer, ':'); c >= 0 { // strip :port
		host = peer[:c]
	}
	return strings.HasPrefix(host, "127.") || host == "::1" || host == "[::1]"
}

// firstPID extracts the first pid=<n> from a users:(...) field.
func firstPID(line string) (int, bool) {
	i := strings.Index(line, "pid=")
	if i < 0 {
		return 0, false
	}
	j := i + len("pid=")
	k := j
	for k < len(line) && line[k] >= '0' && line[k] <= '9' {
		k++
	}
	if k == j {
		return 0, false
	}
	n, err := strconv.Atoi(line[j:k])
	if err != nil {
		return 0, false
	}
	return n, true
}

// extractUint reads the unsigned integer immediately following `key` in line,
// e.g. extractUint("… bytes_acked:51343 …", "bytes_acked:") == 51343.
func extractUint(line, key string) uint64 {
	i := strings.Index(line, key)
	if i < 0 {
		return 0
	}
	j := i + len(key)
	k := j
	for k < len(line) && line[k] >= '0' && line[k] <= '9' {
		k++
	}
	if k == j {
		return 0
	}
	v, _ := strconv.ParseUint(line[j:k], 10, 64)
	return v
}

// ratePerSec returns (cur-prev)/dt as a non-negative bytes/sec. A counter that
// went backwards (a socket closed and dropped out of the pid's sum, or a
// per-interface wrap) yields 0 rather than a bogus spike.
func ratePerSec(cur, prev uint64, dt float64) float64 {
	if dt <= 0 || cur < prev {
		return 0
	}
	return float64(cur-prev) / dt
}
