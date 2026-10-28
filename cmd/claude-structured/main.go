// claude-structured bridges a json-in FIFO and json-out file with the native
// Claude Code CLI's --input-format stream-json / --output-format stream-json.
//
// It runs inside a tmux pane (like the tmux transport), but instead of
// send-keys screen-scraping the Go server writes structured JSON to json-in
// and reads translated events from json-out.
//
// Claude is started with --permission-prompt-tool stdio, so every permission
// decision arrives on stdout as a control_request{subtype:"can_use_tool"}.
// AskUserQuestion and ExitPlanMode are surfaced to the server as
// ask_user_question / plan_review events and answered later from a json-in
// "respond" line; every other tool is allowed immediately. Server "control"
// lines (interrupt, set_model, set_permission_mode) become control_requests.
//
// The bridge translates Claude Code's native stream-json output events into
// the simplified event protocol that pump.go expects.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// pendingPrompt is a can_use_tool request waiting for the user's answer.
type pendingPrompt struct {
	requestID string
	toolName  string
	input     map[string]any
}

type bridge struct {
	stdinMu sync.Mutex
	stdin   io.Writer

	outMu sync.Mutex
	out   *os.File

	mu          sync.Mutex
	pending     map[string]*pendingPrompt // tool_use_id → request
	ctlSeq      int
	interrupted bool // an interrupt was sent during the current turn
}

func main() {
	jsonIn := flag.String("json-in", "", "path to input FIFO (Go server writes, we read)")
	jsonOut := flag.String("json-out", "", "path to output file (we append, Go server tails)")
	cwd := flag.String("cwd", "", "working directory for claude")
	model := flag.String("model", "", "model override")
	resume := flag.String("resume", "", "session id to resume")
	backend := flag.String("backend", "claude", "CLI binary name")
	_ = flag.Bool("auto-allow", false, "ignored (non-interactive tools are always allowed)")
	flag.Parse()

	if *jsonIn == "" || *jsonOut == "" {
		log.Fatal("--json-in and --json-out are required")
	}

	claudeBin := *backend
	if claudeBin == "" {
		claudeBin = "claude"
	}

	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-prompt-tool", "stdio",
		"--permission-mode", "bypassPermissions",
	}
	if *resume != "" {
		args = append(args, "--resume", *resume)
	}
	if *model != "" {
		args = append(args, "--model", *model)
	}

	cmd := exec.Command(claudeBin, args...)
	if *cwd != "" {
		cmd.Dir = *cwd
	}
	cmd.Stderr = os.Stderr

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		log.Fatalf("stdin pipe: %v", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("stdout pipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		log.Fatalf("start claude: %v", err)
	}
	log.Printf("claude started (pid %d)", cmd.Process.Pid)
	fmt.Fprintln(os.Stderr, "Stream JSON 模式：此终端没有 TUI，请在 Chat 视图中发送消息。")

	outFile, err := os.OpenFile(*jsonOut, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatalf("open json-out: %v", err)
	}
	defer outFile.Close()

	b := &bridge{stdin: stdinPipe, out: outFile, pending: map[string]*pendingPrompt{}}

	// Forward termination signals to the child. SIGINT from the pane (Ctrl-C)
	// becomes a protocol interrupt so the process survives like the TUI does.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		for sig := range sigCh {
			if sig == syscall.SIGINT {
				b.control("interrupt", nil)
				continue
			}
			_ = cmd.Process.Signal(sig)
		}
	}()

	go b.readInput(*jsonIn)

	// Main goroutine: read claude stdout → translate → append to json-out.
	scanner := bufio.NewScanner(stdoutPipe)
	scanner.Buffer(make([]byte, 16<<20), 16<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev map[string]any
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		for _, t := range b.handleEvent(ev) {
			b.emit(t)
		}
	}

	if err := cmd.Wait(); err != nil {
		log.Printf("claude exited: %v", err)
	}
	b.emit(map[string]any{"type": "turn_complete"})
}

func (b *bridge) emit(obj map[string]any) {
	data, _ := json.Marshal(obj)
	data = append(data, '\n')
	b.outMu.Lock()
	_, _ = b.out.Write(data)
	b.outMu.Unlock()
}

func (b *bridge) writeStdin(obj any) {
	data, _ := json.Marshal(obj)
	data = append(data, '\n')
	b.stdinMu.Lock()
	_, _ = b.stdin.Write(data)
	b.stdinMu.Unlock()
}

// readInput reads json-in lines and forwards them to claude. The FIFO is
// reopened in a loop so that multiple Go-server open/write/close cycles (one
// per message) don't terminate the reader.
func (b *bridge) readInput(path string) {
	for {
		f, err := os.Open(path)
		if err != nil {
			log.Printf("open json-in: %v (retrying)", err)
			time.Sleep(time.Second)
			continue
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 16<<20), 16<<20)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			var msg map[string]any
			if json.Unmarshal(line, &msg) != nil {
				continue
			}
			switch msg["type"] {
			case "user":
				// Forward as-is — sdktransport.Send's format matches Claude's input.
				b.stdinMu.Lock()
				_, _ = b.stdin.Write(append(append([]byte{}, line...), '\n'))
				b.stdinMu.Unlock()
			case "respond":
				toolUseID, _ := msg["toolUseId"].(string)
				b.respond(toolUseID, msg["payload"])
			case "control":
				action, _ := msg["action"].(string)
				b.control(action, msg)
			}
		}
		f.Close()
	}
}

// control sends a control_request for a server control action.
func (b *bridge) control(action string, msg map[string]any) {
	var req map[string]any
	switch action {
	case "interrupt":
		req = map[string]any{"subtype": "interrupt"}
	case "set_model":
		req = map[string]any{"subtype": "set_model", "model": msg["model"]}
	case "set_permission_mode":
		req = map[string]any{"subtype": "set_permission_mode", "mode": msg["mode"]}
	default:
		log.Printf("unknown control action %q", action)
		return
	}
	b.mu.Lock()
	b.ctlSeq++
	id := fmt.Sprintf("bridge-%d", b.ctlSeq)
	if action == "interrupt" {
		b.interrupted = true
	}
	b.mu.Unlock()
	b.writeStdin(map[string]any{"type": "control_request", "request_id": id, "request": req})
}

// allow answers a can_use_tool request with the (possibly updated) input.
func (b *bridge) allow(requestID string, input map[string]any) {
	b.writeStdin(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": requestID,
		"response": map[string]any{"behavior": "allow", "updatedInput": input},
	}})
}

func (b *bridge) deny(requestID, message string) {
	b.writeStdin(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": requestID,
		"response": map[string]any{"behavior": "deny", "message": message},
	}})
}

// respond resolves a pending AskUserQuestion / ExitPlanMode prompt from a
// json-in "respond" line. Payload shapes (see api/tui_actions_sdk.go):
//
//	AUQ:  [{header, selected: string | []string}, ...] — one per question
//	plan: {approve: bool, permissionMode?: string, reason?: string}
func (b *bridge) respond(toolUseID string, payload any) {
	b.mu.Lock()
	p := b.pending[toolUseID]
	delete(b.pending, toolUseID)
	b.mu.Unlock()
	if p == nil {
		log.Printf("respond: no pending prompt for %s", toolUseID)
		return
	}

	switch p.toolName {
	case "AskUserQuestion":
		input := cloneMap(p.input)
		input["answers"] = auqAnswers(p.input, payload)
		b.allow(p.requestID, input)
		b.emit(map[string]any{"type": "interaction_resolved", "kind": "ask", "toolUseId": toolUseID})

	case "ExitPlanMode":
		d, _ := payload.(map[string]any)
		if approve, _ := d["approve"].(bool); approve {
			b.allow(p.requestID, p.input)
			if mode, _ := d["permissionMode"].(string); mode != "" {
				// No permission UI exists in Stream JSON mode, so "manually
				// approve edits" maps back to the startup mode instead of
				// "default" (which would only add auto-allowed prompts).
				if mode == "default" {
					mode = "bypassPermissions"
				}
				b.control("set_permission_mode", map[string]any{"mode": mode})
			}
		} else {
			reason, _ := d["reason"].(string)
			if reason == "" {
				reason = "The user rejected the plan and wants to keep planning. Do not start implementing yet."
			}
			b.deny(p.requestID, reason)
		}
		b.emit(map[string]any{"type": "interaction_resolved", "kind": "plan", "toolUseId": toolUseID})
	}
}

// auqAnswers maps QuestionAnswer[] to AskUserQuestion's answers map, keyed
// by question text. Answers match questions by header, falling back to order.
func auqAnswers(input map[string]any, payload any) map[string]any {
	questions, _ := input["questions"].([]any)
	items, _ := payload.([]any)
	answers := map[string]any{}
	for i, it := range items {
		a, _ := it.(map[string]any)
		header, _ := a["header"].(string)
		var q map[string]any
		for _, qq := range questions {
			if qm, _ := qq.(map[string]any); qm != nil && header != "" && qm["header"] == header {
				q = qm
				break
			}
		}
		if q == nil && i < len(questions) {
			q, _ = questions[i].(map[string]any)
		}
		if q == nil {
			continue
		}
		text, _ := q["question"].(string)
		var value string
		switch sel := a["selected"].(type) {
		case string:
			value = sel
		case []any:
			parts := make([]string, 0, len(sel))
			for _, s := range sel {
				if str, ok := s.(string); ok && str != "" {
					parts = append(parts, str)
				}
			}
			value = strings.Join(parts, ", ")
		}
		answers[text] = value
	}
	return answers
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// handleEvent converts a Claude Code native stream-json event into zero or
// more events in the pump.go protocol, answering control requests as needed.
func (b *bridge) handleEvent(ev map[string]any) []map[string]any {
	typ, _ := ev["type"].(string)

	switch typ {
	case "system":
		if ev["subtype"] == "init" {
			sessionID, _ := ev["session_id"].(string)
			return []map[string]any{{"type": "session_start", "sessionId": sessionID}}
		}
		return nil

	case "control_request":
		return b.handleControlRequest(ev)

	case "control_cancel_request":
		// Claude withdrew a prompt (e.g. interrupted): drop it from the UI.
		reqID, _ := ev["request_id"].(string)
		b.mu.Lock()
		defer b.mu.Unlock()
		for id, p := range b.pending {
			if p.requestID == reqID {
				delete(b.pending, id)
				kind := "ask"
				if p.toolName == "ExitPlanMode" {
					kind = "plan"
				}
				return []map[string]any{{"type": "interaction_resolved", "kind": kind, "toolUseId": id}}
			}
		}
		return nil

	case "stream_event":
		// --include-partial-messages: live deltas feed the streaming preview.
		se, _ := ev["event"].(map[string]any)
		if se == nil || se["type"] != "content_block_delta" {
			return nil
		}
		delta, _ := se["delta"].(map[string]any)
		switch delta["type"] {
		case "text_delta":
			text, _ := delta["text"].(string)
			return []map[string]any{{"type": "text", "text": text, "partial": true}}
		case "thinking_delta":
			text, _ := delta["thinking"].(string)
			return []map[string]any{{"type": "thinking", "text": text, "partial": true}}
		}
		return nil

	case "assistant":
		// Complete content blocks (one per event): authoritative, partial=false.
		msg, _ := ev["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		var results []map[string]any
		for _, c := range content {
			block, _ := c.(map[string]any)
			switch block["type"] {
			case "text":
				text, _ := block["text"].(string)
				results = append(results, map[string]any{"type": "text", "text": text, "partial": false})
			case "thinking":
				text, _ := block["thinking"].(string)
				results = append(results, map[string]any{"type": "thinking", "text": text, "partial": false})
			case "tool_use":
				results = append(results, map[string]any{
					"type": "tool_use", "toolUseId": block["id"], "name": block["name"], "input": block["input"],
				})
			}
		}
		return results

	case "user":
		msg, _ := ev["message"].(map[string]any)
		content, _ := msg["content"].([]any)
		var results []map[string]any
		for _, c := range content {
			if block, _ := c.(map[string]any); block["type"] == "tool_result" {
				results = append(results, map[string]any{"type": "tool_result", "toolUseId": block["tool_use_id"]})
			}
		}
		return results

	case "result":
		sessionID, _ := ev["session_id"].(string)
		b.mu.Lock()
		interrupted := b.interrupted
		b.interrupted = false
		b.mu.Unlock()
		// A user interrupt ends the turn with is_error and a diagnostic
		// string; that is an expected stop, not an error worth surfacing.
		if isError, _ := ev["is_error"].(bool); isError && !interrupted {
			text, _ := ev["result"].(string)
			if text == "" {
				text = fmt.Sprintf("%v", ev["errors"])
			}
			return []map[string]any{{"type": "error", "text": text, "sessionId": sessionID}}
		}
		return []map[string]any{{"type": "turn_complete", "sessionId": sessionID}}
	}
	return nil
}

func (b *bridge) handleControlRequest(ev map[string]any) []map[string]any {
	reqID, _ := ev["request_id"].(string)
	req, _ := ev["request"].(map[string]any)
	if req["subtype"] != "can_use_tool" {
		// Unknown request kinds: acknowledge so claude doesn't block.
		b.writeStdin(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": reqID, "error": "unsupported by claude-structured",
		}})
		return nil
	}
	toolName, _ := req["tool_name"].(string)
	toolUseID, _ := req["tool_use_id"].(string)
	input, _ := req["input"].(map[string]any)
	if input == nil {
		input = map[string]any{}
	}

	switch toolName {
	case "AskUserQuestion":
		b.mu.Lock()
		b.pending[toolUseID] = &pendingPrompt{requestID: reqID, toolName: toolName, input: input}
		b.mu.Unlock()
		return []map[string]any{{"type": "ask_user_question", "toolUseId": toolUseID, "questions": input["questions"]}}
	case "ExitPlanMode":
		b.mu.Lock()
		b.pending[toolUseID] = &pendingPrompt{requestID: reqID, toolName: toolName, input: input}
		b.mu.Unlock()
		plan, _ := input["plan"].(string)
		return []map[string]any{{"type": "plan_review", "toolUseId": toolUseID, "plan": plan}}
	}
	b.allow(reqID, input)
	return nil
}

func init() {
	log.SetPrefix("claude-structured: ")
	log.SetFlags(log.Ltime)
}
