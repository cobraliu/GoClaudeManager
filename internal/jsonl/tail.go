package jsonl

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
)

// ReadRawMessagesTail reads the last `tail` JSONL entries of a (potentially huge)
// transcript without buffering the whole file into memory, then stable-sorts the
// windowed entries by effective timestamp. It returns the ordered window plus the
// total number of lines in the file.
//
// This is the performance-critical path for the live raw-messages view. The naive
// forward scan (ReadRawMessagesPage) parses+allocates every line on every poll —
// for a 100MB / 50k-line transcript that blocks for minutes and, because the
// session is actively growing, repeats on each poll. Here we instead:
//   - count newlines in a cheap chunked byte scan (no JSON parse, no per-line
//     allocation) to get `total`; and
//   - read only the trailing bytes needed to recover the last `tail` lines.
//
// Matches Python's mmap reverse-scan: the effective-timestamp reorder is applied
// to the windowed lines only (seed prevEff = 0), not the whole file.
//
// When tail <= 0 the caller wants everything; we fall back to ReadRawMessagesPage.
func ReadRawMessagesTail(path string, tail int) ([]json.RawMessage, int, error) {
	if tail <= 0 {
		page := ReadRawMessagesPage(path, 0)
		return page.Messages, page.Total, nil
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := fi.Size()
	if size == 0 {
		return []json.RawMessage{}, 0, nil
	}

	total, err := countLines(f, size)
	if err != nil {
		return nil, 0, err
	}

	lines, err := readLastLines(f, size, tail)
	if err != nil {
		return nil, 0, err
	}

	window := make([]json.RawMessage, 0, len(lines))
	for _, b := range lines {
		if len(bytes.TrimSpace(b)) == 0 {
			continue
		}
		if !json.Valid(b) {
			continue
		}
		window = append(window, append(json.RawMessage(nil), b...))
	}

	ordered := sortByEffectiveTS(window)
	if ordered == nil {
		ordered = []json.RawMessage{}
	}
	return ordered, total, nil
}

// countLines counts '\n'-delimited lines over the whole file using a chunked byte
// scan — no JSON parsing or per-line allocation. A trailing line without a final
// newline is counted too. Fast enough (~hundreds of MB/s) to run on every poll.
func countLines(f *os.File, size int64) (int, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	buf := make([]byte, 1<<20)
	count := 0
	var last byte
	for {
		n, err := f.Read(buf)
		if n > 0 {
			count += bytes.Count(buf[:n], []byte{'\n'})
			last = buf[n-1]
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
	}
	// Count the final line when the file does not end in a newline.
	if size > 0 && last != '\n' {
		count++
	}
	return count, nil
}

// readLastLines returns up to n complete trailing lines of f (in file order) by
// reading backwards in chunks until enough newlines are seen, so line size and
// file size are both irrelevant to memory use. Lines exclude their newline.
func readLastLines(f *os.File, size int64, n int) ([][]byte, error) {
	const chunk = 64 * 1024
	var buf []byte
	pos := size
	for pos > 0 {
		readSize := int64(chunk)
		if pos < readSize {
			readSize = pos
		}
		pos -= readSize
		tmp := make([]byte, readSize)
		if _, err := f.ReadAt(tmp, pos); err != nil && err != io.EOF {
			return nil, err
		}
		buf = append(tmp, buf...)
		// Stop once buf holds more than n newlines: the last n lines are then
		// fully contained (the leading, possibly-partial segment aside).
		if bytes.Count(buf, []byte{'\n'}) > n {
			break
		}
	}

	segments := bytes.Split(buf, []byte{'\n'})
	// When pos > 0 the first segment began mid-line (its start was cut off by the
	// reverse-read boundary), so it is not a complete line — drop it.
	if pos > 0 && len(segments) > 0 {
		segments = segments[1:]
	}
	// A trailing newline yields a final empty segment; drop empties at the tail.
	for len(segments) > 0 && len(bytes.TrimSpace(segments[len(segments)-1])) == 0 {
		segments = segments[:len(segments)-1]
	}

	if len(segments) > n {
		segments = segments[len(segments)-n:]
	}
	return segments, nil
}
