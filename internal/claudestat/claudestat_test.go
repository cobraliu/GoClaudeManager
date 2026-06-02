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
	if a, d := auqAnsweredInJSONLWindow(answered, auqID, 1<<20); !a || !d {
		t.Errorf("answered: got (%v,%v), want (true,true)", a, d)
	}

	// 2. id present WITHOUT a tool_result, whole file within window → pending.
	pending := write("pending.jsonl",
		`{"tool_use_id":"`+auqID+`","name":"AskUserQuestion"}`+"\n")
	if a, d := auqAnsweredInJSONLWindow(pending, auqID, 1<<20); a || d {
		t.Errorf("pending: got (%v,%v), want (false,false)", a, d)
	}

	// 3. id buried BEFORE a tiny window in a file larger than the window →
	//    treated as answered (the Claw repro). The id sits at the head; with a
	//    16-byte window only the tail is scanned, so it is absent from the scan
	//    yet size > window → (false, true).
	buried := write("buried.jsonl",
		`{"tool_use_id":"`+auqID+`"}`+"\n"+strings.Repeat("x", 4096)+"\n")
	if a, d := auqAnsweredInJSONLWindow(buried, auqID, 16); a || !d {
		t.Errorf("buried: got (%v,%v), want (false,true)", a, d)
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
