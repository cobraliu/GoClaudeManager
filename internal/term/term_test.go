package term

import (
	"testing"
	"time"
)

func TestRecordStates(t *testing.T) {
	r := &Record{}
	if r.IsNamed() {
		t.Fatal("empty name should not be named")
	}
	if r.IsImmortal() {
		t.Fatal("ephemeral, not kept → mortal")
	}
	if r.IsStandby() {
		t.Fatal("zero StandbyAt → not standby")
	}

	r.Name = "build"
	if !r.IsNamed() || !r.IsImmortal() {
		t.Fatal("named terminal should be named + immortal")
	}

	e := &Record{Kept: true, StandbyAt: time.Now()}
	if !e.IsImmortal() {
		t.Fatal("kept terminal should be immortal")
	}
	if !e.IsStandby() {
		t.Fatal("non-zero StandbyAt → standby")
	}
}

func TestPublicShape(t *testing.T) {
	r := &Record{
		TermID:    "abc",
		SessionID: "sess",
		Name:      "",
		Cwd:       "/tmp",
		CreatedAt: time.Unix(100, 0),
	}
	p := r.Public()
	if p["name"] != nil {
		t.Fatalf("ephemeral name should serialize as nil, got %v", p["name"])
	}
	if p["is_named"] != false {
		t.Fatal("is_named should be false")
	}
	if p["term_id"] != "abc" {
		t.Fatal("term_id mismatch")
	}
	if ca, ok := p["created_at"].(float64); !ok || ca != 100.0 {
		t.Fatalf("created_at should be epoch float seconds, got %v", p["created_at"])
	}

	r.Name = "named"
	if r.Public()["name"] != "named" {
		t.Fatal("named terminal should serialize its name")
	}
}

func TestTokenIDsAreURLSafe(t *testing.T) {
	id := newTermID()
	if id == "" {
		t.Fatal("empty term id")
	}
	for _, c := range id {
		if c == '-' || c == '=' {
			t.Fatalf("term id contains scrubbed char: %q", id)
		}
	}
	if tok := randToken(); len(tok) < 32 {
		t.Fatalf("token too short: %q", tok)
	}
}

func TestServiceTokenLifecycle(t *testing.T) {
	s := New(nil) // tmux unused for pure token/record bookkeeping
	rec := &Record{TermID: "t1", SessionID: "s1", UserID: "u1"}
	s.terms["t1"] = rec

	tok, err := s.IssueToken("t1")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if got := s.ConsumeToken(tok); got != "t1" {
		t.Fatalf("ConsumeToken = %q, want t1", got)
	}
	if got := s.ConsumeToken(tok); got != "" {
		t.Fatal("token should be one-shot")
	}
	if _, err := s.IssueToken("missing"); err != ErrNotFound {
		t.Fatalf("IssueToken(missing) err = %v, want ErrNotFound", err)
	}
}

func TestAttachRevivesStandby(t *testing.T) {
	s := New(nil)
	rec := &Record{TermID: "t1", StandbyAt: time.Now()}
	s.terms["t1"] = rec

	if n := s.OnAttach("t1"); n != 1 {
		t.Fatalf("attach count = %d, want 1", n)
	}
	if rec.IsStandby() {
		t.Fatal("attach should clear standby")
	}
	if !rec.Kept {
		t.Fatal("attach during standby should promote to kept")
	}
}

func TestListForHidesStandbyAndSorts(t *testing.T) {
	s := New(nil)
	s.terms["a"] = &Record{TermID: "a", SessionID: "s", UserID: "u", Name: "", CreatedAt: time.Unix(1, 0)}
	s.terms["b"] = &Record{TermID: "b", SessionID: "s", UserID: "u", Name: "named", CreatedAt: time.Unix(2, 0)}
	s.terms["c"] = &Record{TermID: "c", SessionID: "s", UserID: "u", Name: "", CreatedAt: time.Unix(3, 0), StandbyAt: time.Now()}

	out := s.ListFor("s", "u", false)
	if len(out) != 2 {
		t.Fatalf("standby should be hidden: got %d", len(out))
	}
	if out[0].TermID != "b" {
		t.Fatal("named terminal should sort first")
	}
}
