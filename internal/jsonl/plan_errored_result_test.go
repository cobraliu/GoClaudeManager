package jsonl

import "testing"

// TestPlanPending_ErroredToolResultClosesPlan guards the regression where an
// ExitPlanMode that returned an ERROR tool_result was left "pending" forever,
// surfacing as a phantom "Approve Plan" attention. The error entry's top-level
// toolUseResult is a STRING (not the usual object); a rigid struct type made
// decodeLine reject the whole line, so feedPlanLine never saw the closing
// tool_result.
func TestPlanPending_ErroredToolResultClosesPlan(t *testing.T) {
	use := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","id":"toolu_X","input":{"plan":"do things"}}]}}`
	// Errored result: toolUseResult is a STRING, content block carries is_error.
	errResult := `{"type":"user","toolUseResult":"Error: You are not in plan mode.","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_X","is_error":true,"content":"<tool_use_error>not in plan mode</tool_use_error>"}]}}`

	outstanding := map[string]struct{}{}
	feedPlanLine([]byte(use), outstanding)
	if len(outstanding) != 1 {
		t.Fatalf("expected ExitPlanMode to be outstanding after tool_use, got %v", outstanding)
	}
	feedPlanLine([]byte(errResult), outstanding)
	if len(outstanding) != 0 {
		t.Fatalf("errored tool_result must close the plan; still outstanding: %v", outstanding)
	}

	// Sanity: a normal object-valued toolUseResult still closes it too.
	out2 := map[string]struct{}{}
	okResult := `{"type":"user","toolUseResult":{"plan":"do things","isAgent":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_X","content":"User has approved your plan."}]}}`
	feedPlanLine([]byte(use), out2)
	feedPlanLine([]byte(okResult), out2)
	if len(out2) != 0 {
		t.Fatalf("approved tool_result must close the plan; still outstanding: %v", out2)
	}
}
