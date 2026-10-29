package sdktransport

import "testing"

// A replayed ask_user_question with no interaction_resolved stays pending
// until Resolve clears it; Resolve ignores a different tool_use id.
func TestResolveClearsPending(t *testing.T) {
	m := New(nil, t.TempDir())
	p := newPump("s1", "", nil)
	p.replay = true
	m.pumps["s1"] = p
	p.handleLine([]byte(`{"type":"ask_user_question","toolUseId":"toolu_A","questions":[{"question":"Q?","header":"H","options":[{"label":"a"}]}]}`))
	p.handleLine([]byte(`{"type":"plan_review","toolUseId":"toolu_P","plan":"do it"}`))

	if st, _ := m.State("s1"); st.PendingAUQ == nil || st.PendingPlan == nil {
		t.Fatalf("want pending AUQ and plan, got %+v", st)
	}
	m.Resolve("s1", "toolu_other")
	if st, _ := m.State("s1"); st.PendingAUQ == nil {
		t.Fatal("Resolve with another id must not clear the AUQ")
	}
	m.Resolve("s1", "toolu_A")
	st, _ := m.State("s1")
	if st.PendingAUQ != nil {
		t.Fatal("AUQ still pending after Resolve")
	}
	if st.PendingPlan == nil {
		t.Fatal("Resolve of the AUQ must not clear the plan")
	}
	m.Resolve("s1", "toolu_P")
	if st, _ := m.State("s1"); st.PendingPlan != nil {
		t.Fatal("plan still pending after Resolve")
	}
	m.Resolve("missing", "toolu_A") // unknown session: no-op
}
