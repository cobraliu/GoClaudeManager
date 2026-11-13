package jsonl

import (
	"bufio"
	"io"
	"os"
	"sync"
)

// The /external browse lists every transcript on the machine (thousands of
// files, GBs). It only needs a title and the first/last prompt, so it keeps a
// tiny per-file index keyed by (size, mtime) instead of going through Cache:
// routing it through Cache parsed every file in full and, with far more files
// than cacheMaxEntries, evicted (and re-parsed) everything on every browse —
// including the hot entries of live sessions.

type browseItem struct {
	size, mtime int64
	res         EnrichResult
	cwd         string // cwd recorded inside the transcript, if any
}

var (
	browseMu  sync.Mutex
	browseIdx = map[string]browseItem{}
)

const (
	browseWholeLimit = 4 << 20 // parse files up to this size in full
	browseTailStart  = 1 << 20 // first tail window when looking for the last prompt
	browseTailMax    = 8 << 20
)

// browseEnrich returns the title/prompts summary and the transcript's own cwd
// for jsonlPath, rereading only when the file's size or mtime changed.
func browseEnrich(jsonlPath string, fi os.FileInfo) (EnrichResult, string) {
	size, mtime := fi.Size(), fi.ModTime().UnixNano()
	browseMu.Lock()
	it, ok := browseIdx[jsonlPath]
	browseMu.Unlock()
	if ok && it.size == size && it.mtime == mtime {
		return it.res, it.cwd
	}
	res := summarizeTranscript(jsonlPath, size)
	cwd := readSessionCwd(jsonlPath)
	browseMu.Lock()
	browseIdx[jsonlPath] = browseItem{size: size, mtime: mtime, res: res, cwd: cwd}
	browseMu.Unlock()
	return res, cwd
}

// pruneBrowse drops index entries for files not seen in the latest scan.
func pruneBrowse(seen map[string]bool) {
	browseMu.Lock()
	defer browseMu.Unlock()
	for p := range browseIdx {
		if !seen[p] {
			delete(browseIdx, p)
		}
	}
}

func summarizeTranscript(jsonlPath string, size int64) EnrichResult {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return emptyEnrich()
	}
	defer f.Close()

	e := newCacheEntry()
	if size <= browseWholeLimit {
		r := bufio.NewReaderSize(f, 256<<10)
		for {
			line, err := r.ReadBytes('\n')
			if t := trimEOL(line); len(t) > 0 {
				e.feedLine(t)
			}
			if err != nil {
				break
			}
		}
		return e.enrichLocked()
	}

	// Large file: first prompt from the head, last prompt from the tail.
	first := firstUserMsg(f)
	if first == "" {
		return emptyEnrich()
	}
	e.userMsgs = append(e.userMsgs, first)
	if last, ts := lastUserMsg(f, size); last != "" {
		e.userMsgs = append(e.userMsgs, last)
		if ts != "" {
			e.userTimestamps = append(e.userTimestamps, ts)
		}
	}
	return e.enrichLocked()
}

// lastUserMsg scans growing tail windows of f for the last user prompt.
func lastUserMsg(f *os.File, size int64) (string, string) {
	for win := int64(browseTailStart); ; win *= 2 {
		start := size - win
		if start < 0 {
			start = 0
		}
		if _, err := f.Seek(start, io.SeekStart); err != nil {
			return "", ""
		}
		r := bufio.NewReaderSize(io.LimitReader(f, size-start), 256<<10)
		if start > 0 {
			_, _ = r.ReadBytes('\n') // partial first line
		}
		t := newCacheEntry()
		for {
			line, err := r.ReadBytes('\n')
			if l := trimEOL(line); len(l) > 0 {
				t.feedLine(l)
			}
			if err != nil {
				break
			}
		}
		if n := len(t.userMsgs); n > 0 {
			ts := ""
			if k := len(t.userTimestamps); k > 0 {
				ts = t.userTimestamps[k-1]
			}
			return t.userMsgs[n-1], ts
		}
		if start == 0 || win >= browseTailMax {
			return "", ""
		}
	}
}
