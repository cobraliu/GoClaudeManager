package app

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/pprof"
	"strings"
	"sync"
	"time"
)

// Stall diagnostics. A request that is still running after stallDumpAfter gets
// a full goroutine dump written to <data>/debug/stall-*.txt (at most once per
// stallDumpEvery), so a server-side hang that only shows up in the browser as
// "pending for 20s" leaves evidence of what everything was blocked on.

const (
	slowRequestWarn = 2 * time.Second
	stallDumpAfter  = 5 * time.Second
	stallDumpEvery  = time.Minute
	stallDumpKeep   = 20
)

var (
	stallDumpDir  string
	stallDumpMu   sync.Mutex
	stallDumpLast time.Time

	accessMu   sync.Mutex
	accessFile *os.File
)

// accessLogMax caps debug/access.log; it is truncated and restarted past this.
const accessLogMax = 50 << 20

// accessLog appends one timestamped line to <data>/debug/access.log: every
// request's arrival and completion and every connection open/close, with the
// client's ip:port — enough to tell, for a request the browser shows pending,
// whether it ever reached the server and what each connection was busy with.
func accessLog(format string, args ...any) {
	if stallDumpDir == "" {
		return
	}
	line := time.Now().Format("15:04:05.000 ") + fmt.Sprintf(format, args...) + "\n"
	accessMu.Lock()
	defer accessMu.Unlock()
	if accessFile == nil {
		if err := os.MkdirAll(stallDumpDir, 0o755); err != nil {
			return
		}
		f, err := os.OpenFile(filepath.Join(stallDumpDir, "access.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return
		}
		accessFile = f
	}
	if fi, err := accessFile.Stat(); err == nil && fi.Size() > accessLogMax {
		_ = accessFile.Truncate(0)
		_, _ = accessFile.Seek(0, 0)
	}
	_, _ = accessFile.WriteString(line)
}

func dataDirOrDefault(dataDir string) string {
	if dataDir != "" {
		return dataDir
	}
	return "data"
}

// isStreamingPath reports long-lived requests (WebSockets, streams) that are
// expected to outlive the stall threshold.
func isStreamingPath(p string) bool {
	return strings.HasPrefix(p, "/ws/") || strings.Contains(p, "/stream") ||
		strings.Contains(p, "/events") || strings.Contains(p, "/proxy-tap")
}

func dumpStall(what string) {
	stallDumpMu.Lock()
	defer stallDumpMu.Unlock()
	if stallDumpDir == "" || time.Since(stallDumpLast) < stallDumpEvery {
		return
	}
	stallDumpLast = time.Now()
	if err := os.MkdirAll(stallDumpDir, 0o755); err != nil {
		return
	}
	name := filepath.Join(stallDumpDir, "stall-"+time.Now().Format("20060102-150405")+".txt")
	f, err := os.Create(name)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "request still running after %s: %s\n\n", stallDumpAfter, what)
	_ = pprof.Lookup("goroutine").WriteTo(f, 2)
	_ = f.Close()
	slog.Warn("http: stalled request, goroutine dump written", "req", what, "file", name)
	pruneStallDumps()
}

func pruneStallDumps() {
	m, _ := filepath.Glob(filepath.Join(stallDumpDir, "stall-*.txt"))
	for len(m) > stallDumpKeep {
		_ = os.Remove(m[0]) // names sort chronologically
		m = m[1:]
	}
}
