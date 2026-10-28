package status

import (
	"testing"
	"time"
)

func TestAUQMatchesSubmitted(t *testing.T) {
	submitted := []string{normAUQText("你最喜欢的颜色是什么?"), normAUQText("Which **pet** do you\nprefer?")}
	cases := []struct {
		name string
		auq  map[string]any
		want bool
	}{
		{"screen flat, second question", map[string]any{"question": "Which pet do you prefer?"}, true},
		{"screen first line only", map[string]any{"question": "Which pet do"}, true},
		{"hook shape", map[string]any{"questions": []any{map[string]any{"question": "你最喜欢的颜色是什么?"}}}, true},
		{"new question", map[string]any{"question": "Deploy now?"}, false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := auqMatchesSubmitted(c.auq, submitted); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestAUQSuppressionLifecycle(t *testing.T) {
	m := &Manager{snap: map[string]Computed{"s": {TuiAuqData: map[string]any{"question": "Q1?"}}},
		lastAUQSubmit: map[string]time.Time{}, auqSubmits: map[string]*auqSubmitState{}}
	m.BeginAUQSubmit("s", nil)
	if c, _ := m.Get("s"); c.TuiAuqData != nil {
		t.Fatal("stale cached AUQ served during submit")
	}
	if in, recent := m.auqSuppression("s"); !in || len(recent) != 1 || recent[0] != "Q1?" {
		t.Fatalf("in-flight=%v recent=%v", in, recent)
	}
	m.NoteAUQSubmitted("s")
	if in, recent := m.auqSuppression("s"); !in || len(recent) != 1 {
		t.Fatalf("grace: in-flight=%v recent=%v", in, recent)
	}
}
