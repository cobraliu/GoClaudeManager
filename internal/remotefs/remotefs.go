// Package remotefs gives read-only access to directories on other machines over
// SSH, for the file panel's "Remote" browser.
//
// It does not implement SSH itself: each host gets one long-lived
// `ssh -s <host> sftp` child process and an SFTP client speaking over its
// stdio. Using the system ssh means everything in ~/.ssh/config (HostName,
// User, IdentityFile, ProxyJump / ProxyCommand, agent) works exactly as it does
// in a terminal. BatchMode=yes makes a host that would prompt for a password
// or an unknown host key fail fast instead of hanging.
package remotefs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
)

// idleTimeout closes a host's connection after this long without a request.
const idleTimeout = 10 * time.Minute

// hostRe is the set of host aliases we will pass to ssh. Refusing a leading
// '-' (and anything outside this set) keeps a host value from being read as an
// ssh option.
var hostRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._@-]*$`)

// ValidHost reports whether host is safe to hand to ssh as a destination.
func ValidHost(host string) bool { return len(host) <= 255 && hostRe.MatchString(host) }

type conn struct {
	cmd      *exec.Cmd
	client   *sftp.Client
	stderr   *tailBuffer
	lastUsed time.Time
	active   int // open streams (OpenStream); never reaped while > 0
}

func (c *conn) close() {
	_ = c.client.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	_ = c.cmd.Wait()
}

// Pool keeps one SFTP connection per host.
type Pool struct {
	mu    sync.Mutex
	conns map[string]*conn
	// dialing serializes connection setup per host so concurrent first
	// requests share one ssh process.
	dialing map[string]*sync.Mutex
}

// NewPool starts a pool and its idle reaper (stops when ctx is done).
func NewPool(ctx context.Context) *Pool {
	p := &Pool{conns: map[string]*conn{}, dialing: map[string]*sync.Mutex{}}
	go p.reap(ctx)
	return p
}

func (p *Pool) reap(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			p.mu.Lock()
			for h, c := range p.conns {
				c.close()
				delete(p.conns, h)
			}
			p.mu.Unlock()
			return
		case <-t.C:
			p.mu.Lock()
			for h, c := range p.conns {
				if c.active == 0 && time.Since(c.lastUsed) > idleTimeout {
					c.close()
					delete(p.conns, h)
				}
			}
			p.mu.Unlock()
		}
	}
}

func (p *Pool) get(host string) (*sftp.Client, error) {
	if !ValidHost(host) {
		return nil, fmt.Errorf("invalid host %q", host)
	}
	p.mu.Lock()
	if c := p.conns[host]; c != nil {
		c.lastUsed = time.Now()
		p.mu.Unlock()
		return c.client, nil
	}
	dm := p.dialing[host]
	if dm == nil {
		dm = &sync.Mutex{}
		p.dialing[host] = dm
	}
	p.mu.Unlock()

	dm.Lock()
	defer dm.Unlock()
	p.mu.Lock()
	if c := p.conns[host]; c != nil { // another request connected meanwhile
		c.lastUsed = time.Now()
		p.mu.Unlock()
		return c.client, nil
	}
	p.mu.Unlock()

	c, err := dial(host)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.conns[host] = c
	p.mu.Unlock()
	return c.client, nil
}

// drop discards a host's connection (after an I/O error) so the next request
// reconnects.
func (p *Pool) drop(host string, client *sftp.Client) {
	p.mu.Lock()
	c := p.conns[host]
	if c != nil && c.client == client {
		delete(p.conns, host)
	} else {
		c = nil
	}
	p.mu.Unlock()
	if c != nil {
		c.close()
	}
}

func dial(host string) (*conn, error) {
	cmd := exec.Command("ssh",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
		"-s", "--", host, "sftp")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start ssh: %w", err)
	}

	type res struct {
		c   *sftp.Client
		err error
	}
	ch := make(chan res, 1)
	go func() {
		c, err := sftp.NewClientPipe(stdout, stdin)
		ch <- res{c, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return nil, sshError(host, r.err, stderr)
		}
		return &conn{cmd: cmd, client: r.c, stderr: stderr, lastUsed: time.Now()}, nil
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, sshError(host, errors.New("timed out"), stderr)
	}
}

func sshError(host string, err error, stderr *tailBuffer) error {
	msg := strings.TrimSpace(stderr.String())
	if msg == "" {
		return fmt.Errorf("ssh %s: %v", host, err)
	}
	return fmt.Errorf("ssh %s: %s", host, msg)
}

// isConnErr reports whether err means the SFTP session itself is broken (as
// opposed to a per-file error like "no such file").
func isConnErr(err error) bool {
	if err == nil {
		return false
	}
	var se *sftp.StatusError
	if errors.As(err, &se) {
		return false
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
		return false
	}
	return true
}

// with runs fn against the host's client, reconnecting once if the existing
// connection turned out to be dead.
func (p *Pool) with(host string, fn func(*sftp.Client) error) error {
	for attempt := 0; ; attempt++ {
		c, err := p.get(host)
		if err != nil {
			return err
		}
		err = fn(c)
		if isConnErr(err) {
			p.drop(host, c)
			if attempt == 0 {
				continue
			}
		}
		return err
	}
}

// Entry is one directory entry.
type Entry struct {
	Name  string  `json:"name"`
	Type  string  `json:"type"` // "dir" | "file"
	Size  int64   `json:"size"`
	Mtime float64 `json:"mtime"`
	Link  bool    `json:"link,omitempty"`
}

// List returns the absolute path of dir (empty = remote home) and its entries,
// directories first, then case-insensitive by name. Symlinks are reported as
// what they point to.
func (p *Pool) List(host, dir string) (string, []Entry, error) {
	var abs string
	var out []Entry
	err := p.with(host, func(c *sftp.Client) error {
		d := dir
		if d == "" {
			d = "."
		}
		rp, err := c.RealPath(d)
		if err != nil {
			return err
		}
		infos, err := c.ReadDir(rp)
		if err != nil {
			return err
		}
		abs = rp
		out = make([]Entry, 0, len(infos))
		for _, fi := range infos {
			e := Entry{Name: fi.Name(), Size: fi.Size(), Mtime: float64(fi.ModTime().Unix())}
			mode := fi.Mode()
			if mode&os.ModeSymlink != 0 {
				e.Link = true
				if ti, err := c.Stat(rp + "/" + fi.Name()); err == nil {
					mode = ti.Mode()
					e.Size = ti.Size()
				}
			}
			if mode.IsDir() {
				e.Type = "dir"
			} else {
				e.Type = "file"
			}
			out = append(out, e)
		}
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		di, dj := out[i].Type == "dir", out[j].Type == "dir"
		if di != dj {
			return di
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return abs, out, nil
}

// FileInfo describes a file read by ReadFile.
type FileInfo struct {
	Size      int64
	Mtime     float64
	Truncated bool // only the first maxBytes were read
}

// ReadFile reads up to maxBytes of an absolute remote path.
func (p *Pool) ReadFile(host, path string, maxBytes int64) ([]byte, FileInfo, error) {
	var data []byte
	var info FileInfo
	err := p.with(host, func(c *sftp.Client) error {
		fi, err := c.Stat(path)
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return ErrIsDir
		}
		f, err := c.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, maxBytes))
		if err != nil {
			return err
		}
		info = FileInfo{Size: fi.Size(), Mtime: float64(fi.ModTime().Unix()), Truncated: fi.Size() > int64(len(data))}
		return nil
	})
	return data, info, err
}

// Stream is an open remote file for http.ServeContent: an io.ReadSeeker that
// reads in large chunks (one SFTP ReadAt per chunk, which pkg/sftp splits into
// concurrent requests) so throughput isn't bound by one round trip per 32 KB.
type Stream struct {
	f      *sftp.File
	Info   os.FileInfo
	off    int64
	buf    []byte // buffered data starting at bufOff
	bufOff int64
	done   func()
}

const streamChunk = 1 << 20

func (s *Stream) Read(p []byte) (int, error) {
	if s.off >= s.bufOff && s.off < s.bufOff+int64(len(s.buf)) {
		n := copy(p, s.buf[s.off-s.bufOff:])
		s.off += int64(n)
		return n, nil
	}
	if s.off >= s.Info.Size() {
		return 0, io.EOF
	}
	if cap(s.buf) < streamChunk {
		s.buf = make([]byte, streamChunk)
	}
	n, err := s.f.ReadAt(s.buf[:streamChunk], s.off)
	s.buf, s.bufOff = s.buf[:n], s.off
	if n == 0 {
		if err == nil {
			err = io.EOF
		}
		return 0, err
	}
	m := copy(p, s.buf)
	s.off += int64(m)
	return m, nil
}

func (s *Stream) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = s.off + offset
	case io.SeekEnd:
		abs = s.Info.Size() + offset
	default:
		return 0, errors.New("invalid whence")
	}
	if abs < 0 {
		return 0, errors.New("negative position")
	}
	s.off = abs
	return abs, nil
}

// Close closes the remote file and releases the connection for reaping.
func (s *Stream) Close() error {
	err := s.f.Close()
	if s.done != nil {
		s.done()
		s.done = nil
	}
	return err
}

// OpenStream opens an absolute remote path for streaming. The caller must
// Close it.
func (p *Pool) OpenStream(host, path string) (*Stream, error) {
	var st *Stream
	err := p.with(host, func(c *sftp.Client) error {
		fi, err := c.Stat(path)
		if err != nil {
			return err
		}
		if fi.IsDir() {
			return ErrIsDir
		}
		f, err := c.Open(path)
		if err != nil {
			return err
		}
		st = &Stream{f: f, Info: fi}
		return nil
	})
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	if cn := p.conns[host]; cn != nil {
		cn.active++
		cn.lastUsed = time.Now()
		st.done = func() {
			p.mu.Lock()
			cn.active--
			cn.lastUsed = time.Now()
			p.mu.Unlock()
		}
	}
	p.mu.Unlock()
	return st, nil
}

// ErrIsDir is returned by ReadFile for a directory.
var ErrIsDir = &sftp.StatusError{Code: 4} // SSH_FX_FAILURE; a StatusError so it isn't treated as a dead connection

// IsNotExist reports a missing remote path.
func IsNotExist(err error) bool {
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var se *sftp.StatusError
	return errors.As(err, &se) && se.Code == 2 // SSH_FX_NO_SUCH_FILE
}

// Hosts lists the concrete Host aliases in ~/.ssh/config (and files it
// Includes), skipping wildcard patterns.
func Hosts() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}
	}
	seen := map[string]bool{}
	out := []string{}
	visited := map[string]bool{}
	var walk func(path string, depth int)
	walk = func(path string, depth int) {
		if depth > 5 || visited[path] {
			return
		}
		visited[path] = true
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			fields := strings.Fields(strings.TrimSpace(sc.Text()))
			if len(fields) < 2 || strings.HasPrefix(fields[0], "#") {
				continue
			}
			key := strings.ToLower(strings.TrimSuffix(fields[0], "="))
			switch key {
			case "host":
				for _, h := range fields[1:] {
					if strings.ContainsAny(h, "*?!") || !ValidHost(h) || seen[h] {
						continue
					}
					seen[h] = true
					out = append(out, h)
				}
			case "include":
				for _, pat := range fields[1:] {
					if strings.HasPrefix(pat, "~/") {
						pat = filepath.Join(home, pat[2:])
					} else if !filepath.IsAbs(pat) {
						pat = filepath.Join(home, ".ssh", pat)
					}
					matches, _ := filepath.Glob(pat)
					for _, m := range matches {
						walk(m, depth+1)
					}
				}
			}
		}
	}
	walk(filepath.Join(home, ".ssh", "config"), 0)
	return out
}

// tailBuffer keeps the last max bytes written (ssh's stderr).
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, b...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(b), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
