package store

import "testing"

func TestLostMessages_RegisterDedupListDismiss(t *testing.T) {
	st := freshStore(t)
	const sid = "sess-1"

	// Empty session → nil.
	if got := st.ListLostMessages(sid); got != nil {
		t.Fatalf("expected nil for empty session, got %v", got)
	}

	// Register one.
	a := st.RegisterLostMessage(sid, "hello world", 100.0)
	if a.ID == "" || a.Text != "hello world" {
		t.Fatalf("unexpected registered message: %+v", a)
	}

	// Dedup: same trimmed text within the window returns the same entry.
	b := st.RegisterLostMessage(sid, "  hello world  ", 102.0)
	if b.ID != a.ID {
		t.Fatalf("expected dedup to return same id %q, got %q", a.ID, b.ID)
	}
	if got := st.ListLostMessages(sid); len(got) != 1 {
		t.Fatalf("expected 1 entry after dedup, got %d", len(got))
	}

	// Outside the window → distinct entry.
	c := st.RegisterLostMessage(sid, "hello world", 200.0)
	if c.ID == a.ID {
		t.Fatalf("expected distinct id outside dedup window")
	}
	// Different text → distinct entry.
	d := st.RegisterLostMessage(sid, "another", 100.0)
	if got := st.ListLostMessages(sid); len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(got))
	}

	// Dismiss one by id.
	st.DismissLostMessage(sid, c.ID)
	if got := st.ListLostMessages(sid); len(got) != 2 {
		t.Fatalf("expected 2 entries after dismiss, got %d", len(got))
	}

	// Clear-by-text removes the matching "hello world" (a), leaving only d.
	st.ClearLostMessagesByText(sid, "hello world")
	got := st.ListLostMessages(sid)
	if len(got) != 1 || got[0].ID != d.ID {
		t.Fatalf("expected only %q (another) to remain, got %+v", d.ID, got)
	}

	// Clear-by-text of the last one empties the session (key deleted → nil).
	st.ClearLostMessagesByText(sid, "another")
	if got := st.ListLostMessages(sid); got != nil {
		t.Fatalf("expected nil after clearing all, got %v", got)
	}
}

func TestLostMessages_Isolation(t *testing.T) {
	st := freshStore(t)
	st.RegisterLostMessage("a", "x", 1.0)
	st.RegisterLostMessage("b", "y", 1.0)
	if len(st.ListLostMessages("a")) != 1 || len(st.ListLostMessages("b")) != 1 {
		t.Fatalf("sessions should be isolated")
	}
	st.ClearLostMessagesByText("a", "x")
	if st.ListLostMessages("a") != nil {
		t.Fatalf("session a should be empty")
	}
	if len(st.ListLostMessages("b")) != 1 {
		t.Fatalf("session b should be untouched")
	}
}
