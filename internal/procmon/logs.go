package procmon

import (
	"bytes"
	"io"
	"os"
	"strconv"
)

// tailByteCap bounds how far back tailFile reads, so one giant line (or a tail
// request against a huge file) can't blow memory.
const tailByteCap = 256 * 1024

// maxLineLen caps an individual returned line; an over-long line keeps its tail
// (most recent bytes) behind a "…" marker so the JSON payload stays bounded.
const maxLineLen = 8192

// attachLogs resolves the process's stdout/stderr file descriptors and, when
// either points at a regular file, fills in the path + a tail of recent lines.
// Shell redirections (`> out.log`) never appear in cmdline — they live on the
// fd itself — so reading the fd symlink is the only robust way to find them.
func attachLogs(info *ProcessInfo, pid, tailLines int) {
	outPath, outOK := resolveFdFile(pid, 1)
	errPath, errOK := resolveFdFile(pid, 2)

	if outOK {
		info.StdoutFile = outPath
		info.StdoutTail = tailFile(outPath, tailLines)
	}
	if errOK {
		// `> out 2>&1` points both fds at the same file — report it once.
		if outOK && errPath == outPath {
			return
		}
		info.StderrFile = errPath
		info.StderrTail = tailFile(errPath, tailLines)
	}
}

// resolveFdFile returns the target of /proc/<pid>/fd/<fd> when it is a regular
// file. Non-file targets (pipe:[…], socket:[…], anon_inode:…, /dev/null,
// /dev/pts/N char devices) and unreadable/rotated targets return ok=false.
func resolveFdFile(pid, fd int) (string, bool) {
	link := "/proc/" + strconv.Itoa(pid) + "/fd/" + strconv.Itoa(fd)
	target, err := os.Readlink(link)
	if err != nil || target == "" || target[0] != '/' {
		// A leading '/' rules out "pipe:[…]" / "socket:[…]" / "anon_inode:…".
		return "", false
	}
	st, err := os.Stat(target)
	if err != nil || !st.Mode().IsRegular() {
		return "", false
	}
	return target, true
}

// tailFile returns up to n complete trailing lines of the file (in file order),
// reading backwards in chunks so file size is irrelevant to memory use. Returns
// nil on any read error (permission denied, deleted, etc.).
func tailFile(path string, n int) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() == 0 {
		return nil
	}
	lines := readLastLines(f, fi.Size(), n)
	if len(lines) == 0 {
		return nil
	}
	out := make([]string, len(lines))
	for i, b := range lines {
		out[i] = string(b)
	}
	return out
}

// readLastLines returns up to n complete trailing lines of f (in file order) by
// reading backwards in 64KB chunks until enough newlines are seen or the byte
// cap is hit. Lines exclude their newline and are individually length-capped.
// (Mirrors jsonl.readLastLines, which is unexported and JSONL-specific.)
func readLastLines(f *os.File, size int64, n int) [][]byte {
	const chunk = 64 * 1024
	var buf []byte
	pos := size
	scanned := int64(0)
	for pos > 0 && scanned < tailByteCap {
		readSize := int64(chunk)
		if pos < readSize {
			readSize = pos
		}
		pos -= readSize
		scanned += readSize
		tmp := make([]byte, readSize)
		if _, err := f.ReadAt(tmp, pos); err != nil && err != io.EOF {
			return nil
		}
		buf = append(tmp, buf...)
		if bytes.Count(buf, []byte{'\n'}) > n {
			break
		}
	}

	segments := bytes.Split(buf, []byte{'\n'})
	// A trailing newline yields a final empty segment; drop trailing empties
	// first so they don't mask a sole real (over-long) line below.
	for len(segments) > 0 && len(bytes.TrimSpace(segments[len(segments)-1])) == 0 {
		segments = segments[:len(segments)-1]
	}
	// When we stopped before BOF the first segment began mid-line. Drop it only
	// if a complete line follows; if it's the sole segment (a single line longer
	// than the byte cap), keep it — its capped tail is the best we can show.
	if pos > 0 && len(segments) > 1 {
		segments = segments[1:]
	}
	if len(segments) > n {
		segments = segments[len(segments)-n:]
	}
	for i, seg := range segments {
		if len(seg) > maxLineLen {
			segments[i] = append([]byte("…"), seg[len(seg)-maxLineLen:]...)
		}
	}
	return segments
}
