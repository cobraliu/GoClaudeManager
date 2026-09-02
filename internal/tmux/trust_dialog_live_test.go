package tmux

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Live check of the whole auto-accept path against a real `claude` boot in an
// untrusted directory: the dialog's layout is upstream's to change, and it has
// changed before (2.1.258 moved "No, exit" to the top, turning the old bare
// Enter into an exit). Skipped unless GOCM_TRUST_PROBE=1; needs tmux and the
// claude CLI on PATH.
func TestAutoAcceptTrustDialogLive(t *testing.T) {
	if os.Getenv("GOCM_TRUST_PROBE") != "1" {
		t.Skip("set GOCM_TRUST_PROBE=1 to run")
	}
	dir := t.TempDir()
	c := &Client{SocketName: "trustprobe-go", TmuxBin: "tmux"}
	_ = exec.Command("tmux", "-L", "trustprobe-go", "kill-server").Run()
	if _, err := c.run("new-session", "-d", "-s", "probe", "-x", "200", "-y", "50", "-c", dir, "claude"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	defer c.run("kill-session", "-t", "probe")

	var screen string
	for i := 0; i < 40; i++ {
		time.Sleep(300 * time.Millisecond)
		screen = c.CaptureVisibleScreen("probe")
		if looksLikeTrustDialog(screen) {
			break
		}
	}
	if !looksLikeTrustDialog(screen) {
		t.Fatalf("trust dialog never appeared; screen:\n%s", screen)
	}
	presses, ok := trustDialogYesPresses(screen)
	t.Logf("dialog detected: presses=%d ok=%v", presses, ok)

	c.autoAcceptTrustDialog("probe", 8*time.Second)

	for i := 0; i < 40; i++ {
		screen = c.CaptureVisibleScreen("probe")
		if !looksLikeTrustDialog(screen) {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if looksLikeTrustDialog(screen) {
		t.Fatalf("dialog still up after accept:\n%s", screen)
	}
	if strings.Contains(screen, "No, exit") {
		t.Fatalf("looks like the exit option was taken:\n%s", screen)
	}
	t.Logf("after accept, screen tail:\n%s", strings.TrimSpace(screen))
}
