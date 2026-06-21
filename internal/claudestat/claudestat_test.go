package claudestat

import (
	"os"
	"strings"
	"testing"
)

func TestParseAUQFromScreen_SingleSelect(t *testing.T) {
	screen := strings.Join([]string{
		"  some preamble line",
		"  ☐ Pick a deployment target",
		"  Which environment should I deploy to?",
		"  ❯ 1. Production",
		"      Live customer traffic",
		"    2. Staging",
		"      Internal QA",
		"    3. Type something.",
		"  Enter to select",
	}, "\n")

	got, ok := ParseAUQFromScreen(screen)
	if !ok {
		t.Fatalf("expected AUQ to parse, got ok=false")
	}
	if got["header"] != "Pick a deployment target" {
		t.Errorf("header = %q", got["header"])
	}
	if got["question"] != "Which environment should I deploy to?" {
		t.Errorf("question = %q", got["question"])
	}
	if got["multiSelect"] != false {
		t.Errorf("multiSelect = %v, want false", got["multiSelect"])
	}
	if got["allowFreeform"] != true {
		t.Errorf("allowFreeform = %v, want true (Type something. present)", got["allowFreeform"])
	}
	opts, _ := got["options"].([]map[string]any)
	if len(opts) != 2 {
		t.Fatalf("expected 2 options, got %d: %+v", len(opts), opts)
	}
	if opts[0]["label"] != "Production" || opts[0]["description"] != "Live customer traffic" {
		t.Errorf("opt0 = %+v", opts[0])
	}
	if opts[1]["label"] != "Staging" || opts[1]["description"] != "Internal QA" {
		t.Errorf("opt1 = %+v", opts[1])
	}
}

func TestParseAUQFromScreen_MultiSelect(t *testing.T) {
	screen := strings.Join([]string{
		"  ☐ Choose features",
		"  Which features do you want enabled?",
		"  ❯ [x] Logging",
		"    [ ] Metrics",
		"    [ ] Type something.",
		"  Space to select, Enter to confirm",
	}, "\n")

	got, ok := ParseAUQFromScreen(screen)
	if !ok {
		t.Fatalf("expected AUQ to parse, got ok=false")
	}
	if got["multiSelect"] != true {
		t.Errorf("multiSelect = %v, want true", got["multiSelect"])
	}
	if got["allowFreeform"] != true {
		t.Errorf("allowFreeform = %v, want true", got["allowFreeform"])
	}
	opts, _ := got["options"].([]map[string]any)
	if len(opts) != 2 {
		t.Fatalf("expected 2 options, got %d: %+v", len(opts), opts)
	}
	if opts[0]["label"] != "Logging" || opts[0]["checked"] != true {
		t.Errorf("opt0 = %+v, want Logging checked", opts[0])
	}
	if opts[1]["label"] != "Metrics" || opts[1]["checked"] != false {
		t.Errorf("opt1 = %+v, want Metrics unchecked", opts[1])
	}
}

func TestParseAUQFromScreen_NotAnAUQ(t *testing.T) {
	screen := "just some normal terminal output\nwith no question widget at all\n"
	if got, ok := ParseAUQFromScreen(screen); ok {
		t.Errorf("expected no AUQ, got ok=true: %+v", got)
	}
}

func TestParseAUQFromScreen_StripsANSI(t *testing.T) {
	// Header line wrapped in color codes and a stray CR.
	screen := "\x1b[1m  ☐ Header here\x1b[0m\r\n  The question?\n  ❯ 1. Yes\n  Enter to select\n"
	got, ok := ParseAUQFromScreen(screen)
	if !ok {
		t.Fatalf("expected AUQ to parse after ANSI strip")
	}
	if got["header"] != "Header here" {
		t.Errorf("header = %q (ANSI not stripped?)", got["header"])
	}
}

func TestFormatTUIHint(t *testing.T) {
	cases := []struct {
		waitingFor string
		hintType   string
		want       string
	}{
		{"AskUserQuestion ...", "auq", auqHintText},
		{"approve Bash", "approve", "Claude needs approval to run a command — go to TUI"},
		{"approve Write", "approve", "Claude needs approval to write a file — go to TUI"},
		{"approve Edit", "approve", "Claude needs approval to edit a file — go to TUI"},
		{"approve WebFetch", "approve", "Claude needs approval to fetch a URL — go to TUI"},
		{"approve SomeCustomTool", "approve", "Claude needs approval to use SomeCustomTool — go to TUI"},
		{"approve ", "approve", "Claude needs approval to use action — go to TUI"},
	}
	for _, c := range cases {
		if got := FormatTUIHint(c.waitingFor, c.hintType); got != c.want {
			t.Errorf("FormatTUIHint(%q, %q) = %q, want %q", c.waitingFor, c.hintType, got, c.want)
		}
	}
}

func TestCompactingFromScreen_Detected(t *testing.T) {
	// Synthetic screen with the title line, the bar-glyph + percentage line,
	// and the usual rendered rows below it.
	screen := strings.Join([]string{
		"assistant: working on it...",
		"",
		"· Compacting conversation… (12s)",
		"  ▰▰▰▰▱▱▱▱▱▱ 45%",
		"",
		"Tip: press esc to interrupt",
		"╭──────────────────────────────╮",
		"│ >                            │",
		"╰──────────────────────────────╯",
		" status line here",
	}, "\n")

	progress, ok := CompactingFromScreen(screen)
	if !ok {
		t.Fatalf("expected compaction detected, got ok=false")
	}
	if progress != "45%" {
		t.Errorf("progress = %q, want 45%%", progress)
	}
	if !screenShowsCompacting(screen) {
		t.Errorf("screenShowsCompacting returned false on a live compaction screen")
	}
}

func TestCompactingFromScreen_NoBarGlyphIsIgnored(t *testing.T) {
	// "Compacting conversation" text without a bar glyph must NOT trigger —
	// guards against quoted/typed chat text.
	screen := strings.Join([]string{
		"user: what does 'Compacting conversation' mean?",
		"assistant: it summarizes old turns. 30% of the time it kicks in.",
		"",
		"Tip: nothing",
	}, "\n")

	if progress, ok := CompactingFromScreen(screen); ok {
		t.Errorf("expected no compaction (no bar glyph), got ok=true progress=%q", progress)
	}
	if screenShowsCompacting(screen) {
		t.Errorf("screenShowsCompacting returned true without a bar glyph")
	}
}

func TestCompactingFromScreen_NoPercentage(t *testing.T) {
	// Title + bar glyph but no percentage rendered → compacting with empty pct.
	screen := strings.Join([]string{
		"· Compacting conversation…",
		"  ▰▰▰▱▱▱",
		"",
	}, "\n")
	progress, ok := CompactingFromScreen(screen)
	if !ok {
		t.Fatalf("expected compaction detected with bar glyph")
	}
	if progress != "" {
		t.Errorf("progress = %q, want empty", progress)
	}
}

func TestGetPIDWaitingState_ZeroPID(t *testing.T) {
	if _, _, ok := GetPIDWaitingState(0); ok {
		t.Errorf("GetPIDWaitingState(0) should be ok=false")
	}
}

func TestSplitBytesNL(t *testing.T) {
	got := splitBytesNL([]byte("a\nbb\nccc"))
	if len(got) != 3 || string(got[0]) != "a" || string(got[1]) != "bb" || string(got[2]) != "ccc" {
		t.Errorf("splitBytesNL = %q", got)
	}
}

func TestContainsBytes(t *testing.T) {
	if !containsBytes([]byte("hello tool_result world"), []byte("tool_result")) {
		t.Errorf("expected substring match")
	}
	if containsBytes([]byte("short"), []byte("longerneedle")) {
		t.Errorf("needle longer than haystack should not match")
	}
}

// TestAuqAnsweredInJSONLWindow exercises the three verdicts of the tail-scan,
// using a small injected window so the buried-before-window branch (the Claw
// phantom-AUQ bug) is reachable without a multi-MB fixture.
func TestAuqAnsweredInJSONLWindow(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := dir + "/" + name
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	const auqID = "toolu_TARGET"

	// 1. id present WITH a tool_result on the same line → answered, decided.
	answered := write("answered.jsonl",
		`{"tool_use_id":"`+auqID+`","type":"tool_result"}`+"\n")
	if a, d := auqAnsweredInJSONLWindow(answered, auqID, 1<<20, false); !a || !d {
		t.Errorf("answered: got (%v,%v), want (true,true)", a, d)
	}

	// 2. id present WITHOUT a tool_result, whole file within window → pending.
	pending := write("pending.jsonl",
		`{"tool_use_id":"`+auqID+`","name":"AskUserQuestion"}`+"\n")
	if a, d := auqAnsweredInJSONLWindow(pending, auqID, 1<<20, false); a || d {
		t.Errorf("pending: got (%v,%v), want (false,false)", a, d)
	}

	// 3. id buried BEFORE a tiny window in a file larger than the window, process
	//    NOT waiting → cheap shortcut treats it as answered (the Claw repro). The
	//    id sits at the head; with a 16-byte window only the tail is scanned, so
	//    it is absent from the scan yet size > window → (false, true).
	buried := write("buried.jsonl",
		`{"tool_use_id":"`+auqID+`"}`+"\n"+strings.Repeat("x", 4096)+"\n")
	if a, d := auqAnsweredInJSONLWindow(buried, auqID, 16, false); a || !d {
		t.Errorf("buried (not waiting): got (%v,%v), want (false,true)", a, d)
	}

	// 4. Process IS waiting and the id is absent from the whole transcript (a
	//    just-shown AUQ not yet flushed). The buried shortcut must NOT fire: scan
	//    finds no tool_result → genuinely pending (false, false). This is the
	//    capcut / post-restart bug the hardening fixes.
	freshWaiting := write("fresh_waiting.jsonl",
		strings.Repeat("x", 4096)+"\n") // large file, id appears nowhere
	if a, d := auqAnsweredInJSONLWindow(freshWaiting, auqID, 16, true); a || d {
		t.Errorf("fresh while waiting: got (%v,%v), want (false,false)", a, d)
	}

	// 5. Process IS waiting but the AUQ really was answered earlier (a real
	//    tool_result for the id sits before the window). The deeper scan must
	//    find it → answered (true, true), so a genuinely-resolved AUQ is not
	//    resurrected as a phantom while the process waits on something else.
	answeredWaiting := write("answered_waiting.jsonl",
		`{"tool_use_id":"`+auqID+`","type":"tool_result"}`+"\n"+strings.Repeat("x", 4096)+"\n")
	if a, d := auqAnsweredInJSONLWindow(answeredWaiting, auqID, 16, true); !a || !d {
		t.Errorf("answered while waiting: got (%v,%v), want (true,true)", a, d)
	}
}

// TestParsePlanMenu_RecognizesPlanNotToolApprove guards the discriminator that
// status.go relies on after dropping the brittle "Claude has written up a plan"
// header gate: a real ExitPlanMode menu must be recognized via its
// plan-specific option phrasing (independent of header wording), while a
// tool-use approval prompt must NOT be misclassified as a plan.
func TestParsePlanMenu_RecognizesPlanNotToolApprove(t *testing.T) {
	// A plan menu whose header is NOT the old literal string, exercising the
	// version-robust structural recognition.
	planScreen := strings.Join([]string{
		"  Ready to code?",
		"  ❯ 1. Yes, and auto-accept edits",
		"    2. Yes, and manually approve edits",
		"    3. No, keep planning",
	}, "\n")
	opts, hi, ok := ParsePlanMenu(planScreen)
	if !ok {
		t.Fatalf("expected plan menu to be recognized, got ok=false")
	}
	if len(opts) != 3 {
		t.Fatalf("expected 3 options, got %d", len(opts))
	}
	if hi != 0 {
		t.Fatalf("expected highlighted index 0, got %d", hi)
	}

	// A tool-use approval prompt: numbered options but NO plan phrasing and no
	// "Would you like to proceed" → must not be treated as a plan.
	approveScreen := strings.Join([]string{
		"  Claude wants to use Bash",
		"  ❯ 1. Yes",
		"    2. Yes, and don't ask again for Bash commands",
		"    3. No, and tell Claude what to do differently (Esc to cancel)",
	}, "\n")
	if _, _, ok := ParsePlanMenu(approveScreen); ok {
		t.Fatalf("tool-approval prompt was misclassified as a plan menu")
	}
}

// TestParsePlanMenu_IgnoresPlanBodyNumberedLists guards against absorbing the
// plan CONTENT into the option list: the plan body renders directly above the
// menu and routinely contains numbered lists of its own. Only the last run of
// consecutively-numbered rows (the real 1..N menu at the bottom) may be
// returned — extra "options" would corrupt both the rendered card and the
// index-delta arrow-key navigation.
func TestParsePlanMenu_IgnoresPlanBodyNumberedLists(t *testing.T) {
	screen := strings.Join([]string{
		"  Plan: refactor the loader",
		"  Steps:",
		"  1. Extract the parser into its own package",
		"  2. Add unit tests for edge cases",
		"  3. Wire the new package into main",
		"",
		"  Would you like to proceed?",
		"",
		"  ❯ 1. Yes, and bypass permissions",
		"    2. Yes, and auto-accept edits",
		"    3. Yes, and manually approve edits",
		"    4. No, keep planning",
	}, "\n")
	opts, hi, ok := ParsePlanMenu(screen)
	if !ok {
		t.Fatalf("expected plan menu to be recognized, got ok=false")
	}
	if len(opts) != 4 {
		t.Fatalf("expected exactly the 4 menu options, got %d: %+v", len(opts), opts)
	}
	if opts[0].Label != "Yes, and bypass permissions" || opts[3].Label != "No, keep planning" {
		t.Fatalf("wrong options captured: %+v", opts)
	}
	if hi != 0 || !opts[0].Highlighted {
		t.Fatalf("expected highlight on index 0, got hi=%d opts=%+v", hi, opts)
	}

	// Same screen but WITHOUT the proceed prompt (older/newer wording): the
	// last-1..N-run anchor alone must still exclude the plan body.
	noPrompt := strings.ReplaceAll(screen, "  Would you like to proceed?", "  Ready to code?")
	opts, _, ok = ParsePlanMenu(noPrompt)
	if !ok {
		t.Fatalf("expected plan menu to be recognized without proceed prompt")
	}
	if len(opts) != 4 {
		t.Fatalf("no-prompt: expected 4 options, got %d: %+v", len(opts), opts)
	}
}

// ── PendingAUQFromHooks lifecycle-event tests ───────────────────────────────

// writeHookFile installs a fake HOME and writes the given lines as the
// per-session hook file for sid. Returns nothing; claudestat reads via $HOME.
func writeHookFile(t *testing.T, sid string, lines ...string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := home + "/.claude_manager/hooks"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(dir+"/"+sid+".jsonl", []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const (
	hookPreAUQ = `{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_AUQ1","tool_input":{"questions":[{"question":"选择下一步要做什么?","options":[{"label":"A"}]}]}}`
	hookPost   = `{"hook_event_name":"PostToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_AUQ1"}`
	hookPrompt = `{"hook_event_name":"UserPromptSubmit","session_id":"s1"}`
)

func TestPendingAUQFromHooks_LifecycleEvents(t *testing.T) {
	const sid = "lifecycle-sid"

	// 1. Pre only + pid waiting → pending (the live-AUQ case; no transcript
	//    exists under the fake HOME so the layer-3 scan is skipped).
	writeHookFile(t, sid, hookPreAUQ)
	if got, ok := PendingAUQFromHooks(sid, "/tmp", true, true); !ok || got == nil {
		t.Errorf("pre-only while waiting: want pending, got ok=%v", ok)
	}

	// 2. Pre + matching PostToolUse → answered, even while the process waits
	//    on something else (e.g. the next tool's permission prompt).
	writeHookFile(t, sid, hookPreAUQ, hookPost)
	if _, ok := PendingAUQFromHooks(sid, "/tmp", true, true); ok {
		t.Errorf("post event: want resolved, got pending")
	}

	// 3. Pre + later UserPromptSubmit (Esc-cancel then new prompt) → resolved.
	writeHookFile(t, sid, hookPreAUQ, hookPrompt)
	if _, ok := PendingAUQFromHooks(sid, "/tmp", true, true); ok {
		t.Errorf("prompt-submit event: want resolved, got pending")
	}

	// 4. Pre only, pid known and NOT waiting → the process is running, so the
	//    AUQ cannot be pending (kills the post-answer flush-gap re-show).
	writeHookFile(t, sid, hookPreAUQ)
	if _, ok := PendingAUQFromHooks(sid, "/tmp", true, false); ok {
		t.Errorf("pid running: want resolved, got pending")
	}

	// 5. Pre only, pid state unobservable → legacy behavior keeps it pending
	//    (no transcript to consult under the fake HOME).
	writeHookFile(t, sid, hookPreAUQ)
	if _, ok := PendingAUQFromHooks(sid, "/tmp", false, false); !ok {
		t.Errorf("pid unknown: want pending (legacy), got resolved")
	}

	// 6. A Post for an OLDER AUQ must not resolve a NEWER question asked after
	//    it (id-matched resolution).
	pre2 := strings.ReplaceAll(hookPreAUQ, "toolu_AUQ1", "toolu_AUQ2")
	writeHookFile(t, sid, hookPreAUQ, hookPost, pre2)
	if got, ok := PendingAUQFromHooks(sid, "/tmp", true, true); !ok || got == nil {
		t.Errorf("newer AUQ after old post: want pending, got ok=%v", ok)
	}
}

// TestReadSessionHooks_IgnoresLifecycleEvents guards against a PostToolUse
// line (which carries tool_name=AskUserQuestion) being misread as a fresh AUQ
// payload by the screen-path hook reader.
func TestReadSessionHooks_IgnoresLifecycleEvents(t *testing.T) {
	const sid = "filter-sid"
	writeHookFile(t, sid, hookPreAUQ, hookPost, hookPrompt)
	auq, approve := ReadSessionHooks(sid)
	if auq == nil {
		t.Fatalf("want the PreToolUse AUQ payload, got nil")
	}
	if approve != nil {
		t.Errorf("lifecycle events must not produce an approval payload, got %v", approve)
	}
}

func TestAUQScreenMatchesHook(t *testing.T) {
	hook := map[string]any{
		"questions": []any{map[string]any{
			"question": "**重要**:选择下一步要做什么?这个问题很长会在终端里折行显示后面还有更多内容",
		}},
	}
	// Screen shows only the first rendered line, markdown stripped.
	screen := map[string]any{"question": "重要:选择下一步要做什么?这个问题很长会在终端里折行"}
	if !AUQScreenMatchesHook(screen, hook) {
		t.Errorf("truncated+markdown-stripped screen text should match hook payload")
	}
	other := map[string]any{"question": "完全不同的另一个问题"}
	if AUQScreenMatchesHook(other, hook) {
		t.Errorf("unrelated question must not match")
	}
	if AUQScreenMatchesHook(map[string]any{"question": ""}, hook) {
		t.Errorf("empty screen question must not match")
	}
}

func TestIsModelSwitchDialog(t *testing.T) {
	// Verbatim shape of the live dialog captured from a stuck session
	// (claude-loki-pgBackup, Claude Code 2.1.170).
	switchDialog := `  - max_wal_senders >= 2 → ✅ 不用动
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens

   This conversation is cached for the current model. Switching to Fable 5 means the full history gets re-read on your next message.

   ❯ 1. Yes, switch to Fable 5
     2. No, go back
`
	if !IsModelSwitchDialog(switchDialog) {
		t.Errorf("live Switch model? dialog must be detected")
	}

	defaultDialog := `   Set model to Fable 5?

   ❯ 1. Yes, for this session only
     2. Yes, and save as your default for new sessions
`
	if !IsModelSwitchDialog(defaultDialog) {
		t.Errorf("Set model to… default-scope dialog must be detected")
	}

	effortDialog := "   Change effort level?\n\n   ❯ 1. Yes, switch to high\n     2. No, go back\n"
	if !IsModelSwitchDialog(effortDialog) {
		t.Errorf("Change effort level? dialog must be detected")
	}

	// Cursor moved off option 1 → someone is interacting; keep hands off.
	navigated := "   Switch model?\n\n     1. Yes, switch to Fable 5\n   ❯ 2. No, go back\n"
	if IsModelSwitchDialog(navigated) {
		t.Errorf("dialog with cursor on option 2 must NOT auto-confirm")
	}

	// Genuine tool approval with a highlighted Yes but no model header.
	approval := `  Claude wants to use Bash

  rm -rf build/

  ❯ 1. Yes
    2. Yes, and don't ask again
    3. No (esc)
`
	if IsModelSwitchDialog(approval) {
		t.Errorf("tool approval prompt must NOT be detected as model dialog")
	}

	// Stale "Set model to" chat text far above an unrelated menu at the bottom.
	stale := "  Set model to Fable 5 succeeded earlier\n" + strings.Repeat("  …chat…\n", 20) +
		"  Claude wants to use Bash\n  ❯ 1. Yes\n    2. No\n"
	if IsModelSwitchDialog(stale) {
		t.Errorf("model text far from the menu must NOT combine into a false positive")
	}

	if IsModelSwitchDialog("") {
		t.Errorf("empty screen must not match")
	}

	// Regression: an AskUserQuestion whose first option renders as "❯ 1. …" must
	// NOT be mistaken for a model dialog even when a model-header substring sits
	// within 12 lines above it (model-themed question, or residual /model text).
	// Otherwise the status loop auto-presses Enter and pre-answers the AUQ with
	// option 1, destroying the user's custom answer.
	auqNearModelText := "  Set model to Fable 5 (done)\n" +
		"  ☐ Pick deployment target\n  Which environment should I deploy to?\n\n" +
		"  ❯ 1. Production\n    2. Staging\n    3. Type something.\n\n  Enter to select\n"
	if IsModelSwitchDialog(auqNearModelText) {
		t.Errorf("AUQ widget must NOT be detected as a model-switch dialog")
	}
}
