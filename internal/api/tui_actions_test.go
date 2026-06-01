package api

import (
	"strings"
	"testing"
)

// bypassMenu is the ExitPlanMode menu rendered when the session runs in
// --dangerously-skip-permissions (bypass) mode; option 1 is highlighted.
var bypassMenu = strings.Join([]string{
	"Claude has written up a plan and is ready to execute. Would you like to proceed?",
	"❯ 1. Yes, and bypass permissions",
	"  2. Yes, manually approve edits",
	"  3. No, refine with Ultraplan on Claude Code on the web",
	"  4. Tell Claude what to change",
	"Enter to select",
}, "\n")

// standardMenu is the ExitPlanMode menu in normal (non-bypass) mode.
var standardMenu = strings.Join([]string{
	"Would you like to proceed?",
	"❯ 1. Yes, and auto-accept edits",
	"  2. Yes, and manually approve edits",
	"  3. No, keep planning",
}, "\n")

func TestSelectPlanOption(t *testing.T) {
	tests := []struct {
		name         string
		screen       string
		decision     string
		wantOK       bool
		wantLabel    string
		wantDelta    int
		wantFollowup bool
	}{
		{
			name:      "bypass approve keeps bypass (delta 0)",
			screen:    bypassMenu,
			decision:  "approve",
			wantOK:    true,
			wantLabel: "Yes, and bypass permissions",
			wantDelta: 0,
		},
		{
			name:         "bypass reject picks tell-claude with followup",
			screen:       bypassMenu,
			decision:     "reject",
			wantOK:       true,
			wantLabel:    "Tell Claude what to change",
			wantDelta:    3,
			wantFollowup: true,
		},
		{
			name:      "standard approve picks auto-accept",
			screen:    standardMenu,
			decision:  "approve",
			wantOK:    true,
			wantLabel: "Yes, and auto-accept edits",
			wantDelta: 0,
		},
		{
			name:         "standard reject picks keep-planning, no followup",
			screen:       standardMenu,
			decision:     "reject",
			wantOK:       true,
			wantLabel:    "No, keep planning",
			wantDelta:    2,
			wantFollowup: false,
		},
		{
			name:     "non-plan screen is not recognized",
			screen:   "$ ls -la\ntotal 0\ndrwxr-xr-x  2 user user 4096 .\n",
			decision: "approve",
			wantOK:   false,
		},
		{
			name: "tool-approval Yes/No modal is not a plan menu",
			screen: strings.Join([]string{
				"Claude wants to use Bash",
				"❯ 1. Yes",
				"  2. No",
				"Esc to cancel",
			}, "\n"),
			decision: "approve",
			wantOK:   false,
		},
		{
			name:     "invalid decision is rejected",
			screen:   bypassMenu,
			decision: "maybe",
			wantOK:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sel, ok := selectPlanOption(tc.screen, tc.decision)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if sel.label != tc.wantLabel {
				t.Errorf("label = %q, want %q", sel.label, tc.wantLabel)
			}
			if sel.downDelta != tc.wantDelta {
				t.Errorf("downDelta = %d, want %d", sel.downDelta, tc.wantDelta)
			}
			if sel.needsFollowup != tc.wantFollowup {
				t.Errorf("needsFollowup = %v, want %v", sel.needsFollowup, tc.wantFollowup)
			}
		})
	}
}

// TestSelectPlanOption_HighlightDelta verifies delta is computed from the actual
// highlighted row, not assumed to be option 1.
func TestSelectPlanOption_HighlightDelta(t *testing.T) {
	// Highlight already on option 2; approving should move UP one row to bypass.
	screen := strings.Join([]string{
		"Would you like to proceed?",
		"  1. Yes, and bypass permissions",
		"❯ 2. Yes, manually approve edits",
		"  3. Tell Claude what to change",
	}, "\n")
	sel, ok := selectPlanOption(screen, "approve")
	if !ok {
		t.Fatal("expected plan menu to be recognized")
	}
	if sel.label != "Yes, and bypass permissions" {
		t.Errorf("label = %q, want bypass", sel.label)
	}
	if sel.downDelta != -1 {
		t.Errorf("downDelta = %d, want -1 (move up from option 2 to option 1)", sel.downDelta)
	}
}
