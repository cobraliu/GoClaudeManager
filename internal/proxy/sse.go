package proxy

import (
	"encoding/json"
	"strings"
)

// parseSSEChunk extracts complete SSE events from buf and returns them along
// with any leftover (incomplete trailing event). SSE allows "\n\n" or
// "\r\n\r\n" separators; we normalise CRLF to LF so a single split handles
// both upstream conventions, mirroring the Python _parse_sse_chunk.
func parseSSEChunk(buf string) (events []sseEvent, leftover string) {
	buf = strings.ReplaceAll(buf, "\r\n", "\n")
	for {
		sep := strings.Index(buf, "\n\n")
		if sep < 0 {
			return events, buf
		}
		raw := buf[:sep]
		buf = buf[sep+2:]

		var eventName string
		var dataParts []string
		for _, line := range strings.Split(raw, "\n") {
			switch {
			case strings.HasPrefix(line, "event:"):
				eventName = strings.TrimSpace(line[len("event:"):])
			case strings.HasPrefix(line, "data:"):
				dataParts = append(dataParts, strings.TrimLeft(line[len("data:"):], " "))
			}
		}
		if eventName == "" {
			continue
		}
		dataStr := strings.Join(dataParts, "\n")
		data := map[string]any{}
		if dataStr != "" {
			if err := json.Unmarshal([]byte(dataStr), &data); err != nil {
				data = map[string]any{}
			}
		}
		events = append(events, sseEvent{name: eventName, data: data})
	}
}
