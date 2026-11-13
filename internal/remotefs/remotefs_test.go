package remotefs

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSSH puts an `ssh` on PATH that ignores its arguments and runs the local
// sftp-server, so the pool can be exercised without a reachable host.
func fakeSSH(t *testing.T) {
	t.Helper()
	server := ""
	for _, p := range []string{"/usr/lib/openssh/sftp-server", "/usr/lib/sftp-server", "/usr/libexec/sftp-server"} {
		if _, err := os.Stat(p); err == nil {
			server = p
			break
		}
	}
	if server == "" {
		t.Skip("no sftp-server binary")
	}
	bin := t.TempDir()
	script := "#!/bin/sh\nexec " + server + "\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestListAndRead(t *testing.T) {
	fakeSSH(t)
	dir := t.TempDir()
	must(t, os.Mkdir(filepath.Join(dir, "sub"), 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "b.txt"), []byte("hello\nworld\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "A.go"), []byte("package a\n"), 0o644))
	must(t, os.Symlink(filepath.Join(dir, "sub"), filepath.Join(dir, "link")))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := NewPool(ctx)

	abs, entries, err := p.List("myhost", dir)
	if err != nil {
		t.Fatal(err)
	}
	if abs != dir {
		t.Errorf("abs = %q, want %q", abs, dir)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Type+":"+e.Name)
	}
	want := "dir:link,dir:sub,file:A.go,file:b.txt"
	if strings.Join(got, ",") != want {
		t.Errorf("entries = %v, want %s", got, want)
	}

	data, info, err := p.ReadFile("myhost", filepath.Join(dir, "b.txt"), 1<<20)
	if err != nil || string(data) != "hello\nworld\n" || info.Truncated {
		t.Fatalf("ReadFile = %q %+v %v", data, info, err)
	}
	data, info, err = p.ReadFile("myhost", filepath.Join(dir, "b.txt"), 3)
	if err != nil || string(data) != "hel" || !info.Truncated || info.Size != 12 {
		t.Fatalf("capped ReadFile = %q %+v %v", data, info, err)
	}
	if _, _, err := p.ReadFile("myhost", filepath.Join(dir, "nope"), 10); !IsNotExist(err) {
		t.Errorf("missing file err = %v", err)
	}
	if _, _, err := p.ReadFile("myhost", filepath.Join(dir, "sub"), 10); err != ErrIsDir {
		t.Errorf("dir read err = %v", err)
	}

	// Streaming: seek + chunked reads return the right bytes.
	big := make([]byte, 3*streamChunk+123)
	for i := range big {
		big[i] = byte(i % 251)
	}
	must(t, os.WriteFile(filepath.Join(dir, "big.bin"), big, 0o644))
	st, err := p.OpenStream("myhost", filepath.Join(dir, "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Seek(streamChunk-10, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	got2, err := io.ReadAll(st)
	if err != nil || !bytes.Equal(got2, big[streamChunk-10:]) {
		t.Fatalf("stream read mismatch: len=%d err=%v", len(got2), err)
	}
	if end, _ := st.Seek(0, io.SeekEnd); end != int64(len(big)) {
		t.Fatalf("SeekEnd = %d", end)
	}
	p.mu.Lock()
	active := p.conns["myhost"].active
	p.mu.Unlock()
	if active != 1 {
		t.Fatalf("active = %d, want 1", active)
	}
	must(t, st.Close())
	p.mu.Lock()
	active = p.conns["myhost"].active
	p.mu.Unlock()
	if active != 0 {
		t.Fatalf("active after close = %d", active)
	}

	// Kill the ssh process: the next call must reconnect transparently.
	p.mu.Lock()
	c := p.conns["myhost"]
	p.mu.Unlock()
	_ = c.cmd.Process.Kill()
	_ = c.cmd.Wait()
	if _, _, err := p.List("myhost", dir); err != nil {
		t.Fatalf("after kill: %v", err)
	}
}

func TestValidHost(t *testing.T) {
	for _, h := range []string{"flab2", "user@host.example", "a_b-c.d"} {
		if !ValidHost(h) {
			t.Errorf("%q should be valid", h)
		}
	}
	for _, h := range []string{"", "-oProxyCommand=x", "a b", "a;b", "$(x)"} {
		if ValidHost(h) {
			t.Errorf("%q should be invalid", h)
		}
	}
}

func TestHostsParsesConfigAndIncludes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	must(t, os.MkdirAll(filepath.Join(home, ".ssh", "conf.d"), 0o700))
	must(t, os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte(
		"Include conf.d/*\nHost *\n  User x\nHost a b\n  HostName 1.2.3.4\n# Host commented\nHost !neg c?\n"), 0o600))
	must(t, os.WriteFile(filepath.Join(home, ".ssh", "conf.d", "x"), []byte("Host inc\n"), 0o600))
	if got := strings.Join(Hosts(), ","); got != "inc,a,b" {
		t.Errorf("Hosts() = %s", got)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
