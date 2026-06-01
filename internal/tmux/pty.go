package tmux

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/creack/pty"
)

// PtyHandle is a PTY attached to a tmux session for raw terminal I/O.
// (Port of the Python PtyHandle dataclass.)
//
// Unlike the Python version, which forked tmux manually and tracked a raw fd
// and child pid, this uses github.com/creack/pty: Master is the PTY master
// *os.File and Cmd is the running `tmux attach-session` process. Read/Write
// operate directly on Master; Resize uses pty.Setsize; Close terminates and
// reaps the child.
type PtyHandle struct {
	Master *os.File
	Cmd    *exec.Cmd
}

// Read reads available data from the PTY into a fresh buffer, blocking until
// data arrives, the deadline elapses, or the PTY closes. It returns the bytes
// read (possibly empty on timeout). The Python version used select() with a
// timeout and returned b"" on timeout; here we set a read deadline.
func (h *PtyHandle) Read(timeout time.Duration) ([]byte, error) {
	if h.Master == nil {
		return nil, errors.New("pty: closed")
	}
	if timeout > 0 {
		_ = h.Master.SetReadDeadline(time.Now().Add(timeout))
		defer h.Master.SetReadDeadline(time.Time{})
	}
	buf := make([]byte, 65536)
	n, err := h.Master.Read(buf)
	if err != nil {
		if os.IsTimeout(err) {
			return buf[:n], nil // timeout → return whatever (likely empty), no error
		}
		return buf[:n], err
	}
	return buf[:n], nil
}

// Write writes all of data to the PTY (sends input to tmux), handling partial
// writes. The kernel PTY buffer is ~4096 bytes, so large pastes need multiple
// writes. (Port of PtyHandle.write.)
func (h *PtyHandle) Write(data []byte) error {
	if h.Master == nil {
		return errors.New("pty: closed")
	}
	for len(data) > 0 {
		n, err := h.Master.Write(data)
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

// Resize resizes the PTY window to cols×rows. (Port of PtyHandle.resize.)
func (h *PtyHandle) Resize(cols, rows int) error {
	if h.Master == nil {
		return errors.New("pty: closed")
	}
	return pty.Setsize(h.Master, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

// Close closes the PTY and reaps the child process. It mirrors the Python
// close(): close the master, signal the child, poll briefly for a clean exit,
// then escalate to SIGKILL and a blocking wait if it is still alive.
func (h *PtyHandle) Close() error {
	if h.Master != nil {
		_ = h.Master.Close()
		h.Master = nil
	}
	if h.Cmd == nil || h.Cmd.Process == nil {
		return nil
	}
	// Closing the master sends SIGHUP to the foreground process group; give the
	// child ~300ms to exit on its own, polling like the Python WNOHANG loop.
	done := make(chan struct{})
	go func() {
		_ = h.Cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
		h.Cmd = nil
		return nil
	case <-time.After(300 * time.Millisecond):
	}
	// Still alive — force-kill and reap (blocking).
	_ = h.Cmd.Process.Kill()
	<-done
	h.Cmd = nil
	return nil
}

// AttachPTY attaches to a tmux session via a PTY for raw terminal I/O.
// (Port of attach_pty.)
//
// It first polls (up to 5s) until the session exists to guard against
// create→attach races, then starts `tmux -L <socket> attach-session -t <name>`
// under a new PTY sized cols×rows.
func (c *Client) AttachPTY(sessionName string, cols, rows int) (*PtyHandle, error) {
	deadline := time.Now().Add(5 * time.Second)
	for !c.HasSession(sessionName) {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("%w: timed out waiting for session: %s", ErrTmux, sessionName)
		}
		time.Sleep(150 * time.Millisecond)
	}

	cmd := exec.Command(c.TmuxBin, "-L", c.SocketName, "attach-session", "-t", sessionName)
	master, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
	if err != nil {
		return nil, fmt.Errorf("%w: pty start: %v", ErrTmux, err)
	}
	return &PtyHandle{Master: master, Cmd: cmd}, nil
}

// SearchInitPTY enters copy-mode, goes to the top of history, searches forward
// for query, and centers the result. It drives the tmux copy-mode key bindings
// through the PTY exactly like the Python search_init_pty (with the same
// inter-key sleeps to let tmux process each key). The pane must be attached via
// this handle.
func (c *Client) SearchInitPTY(h *PtyHandle, query string) error {
	w := func(b []byte, d time.Duration) error {
		if err := h.Write(b); err != nil {
			return err
		}
		time.Sleep(d)
		return nil
	}
	// Exit any existing copy-mode.
	if err := w([]byte("q"), 150*time.Millisecond); err != nil {
		return err
	}
	// Ctrl-B [ → copy-mode.
	if err := w([]byte{0x02}, 50*time.Millisecond); err != nil {
		return err
	}
	if err := w([]byte("["), 200*time.Millisecond); err != nil {
		return err
	}
	// g → top of history.
	if err := w([]byte("g"), 150*time.Millisecond); err != nil {
		return err
	}
	// /query Enter → first match.
	if err := w([]byte("/"), 50*time.Millisecond); err != nil {
		return err
	}
	if err := h.Write([]byte(query)); err != nil {
		return err
	}
	if err := w([]byte("\r"), 150*time.Millisecond); err != nil {
		return err
	}
	// z → center.
	return h.Write([]byte("z"))
}

// SearchNextPTY jumps to the next search match. The pane must already be in
// copy-mode with an active search. (Port of search_next_pty.)
func (c *Client) SearchNextPTY(h *PtyHandle) error {
	if err := h.Write([]byte("n")); err != nil {
		return err
	}
	time.Sleep(100 * time.Millisecond)
	return h.Write([]byte("z"))
}
