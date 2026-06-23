package sysmon

import "testing"

func TestParseNetDev(t *testing.T) {
	// Two header rows (no "iface:" colon), loopback (excluded), and two real
	// interfaces. rx is column 1, tx is column 9 after the colon.
	sample := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
 wlan0: 200 2 0 0 0 0 0 0 300 3 0 0 0 0 0 0
`
	rx, tx, ok := parseNetDev(sample)
	if !ok {
		t.Fatal("parseNetDev ok=false, want true")
	}
	if rx != 5200 { // 5000 + 200, lo excluded
		t.Errorf("rx = %d, want 5200", rx)
	}
	if tx != 7300 { // 7000 + 300
		t.Errorf("tx = %d, want 7300", tx)
	}
}

func TestParseNetDevEmpty(t *testing.T) {
	if _, _, ok := parseNetDev("garbage\nno colons here\n"); ok {
		t.Error("parseNetDev on junk should report ok=false")
	}
}

func TestParseSS(t *testing.T) {
	// Mirrors `ss -tinHp`: a socket header line (with users:(...)) followed by a
	// whitespace-indented info line carrying the byte counters. The middle
	// socket has no process field → its bytes are unattributed.
	sample := "ESTAB 0 0 10.0.0.1:44978 1.2.3.4:443 users:((\"curl\",pid=111,fd=5))\n" +
		"\t cubic bytes_sent:53330 bytes_acked:51343 bytes_received:55205 segs_out:1\n" +
		"ESTAB 0 0 10.0.0.1:59890 5.6.7.8:443 \n" +
		"\t cubic bytes_acked:234875 bytes_received:258646 segs_out:2\n" +
		"ESTAB 0 0 127.0.0.1:53618 127.0.0.1:8138 users:((\"curl\",pid=111,fd=8))\n" +
		"\t cubic bytes_acked:1000 bytes_received:2000 segs_out:3\n"
	m := parseSS(sample)
	// pid 111 has two sockets: tx = 51343+1000, rx = 55205+2000.
	got, ok := m[111]
	if !ok {
		t.Fatal("pid 111 missing from parseSS result")
	}
	if got.tx != 52343 {
		t.Errorf("pid 111 tx = %d, want 52343", got.tx)
	}
	if got.rx != 57205 {
		t.Errorf("pid 111 rx = %d, want 57205", got.rx)
	}
	// The process-less socket must not invent a pid.
	if len(m) != 1 {
		t.Errorf("parseSS produced %d pids, want 1 (unattributed socket ignored)", len(m))
	}
}

func TestExtractUint(t *testing.T) {
	line := "cubic bytes_sent:53330 bytes_acked:51343 bytes_received:55205 segs_out:1402"
	if got := extractUint(line, "bytes_acked:"); got != 51343 {
		t.Errorf("bytes_acked = %d, want 51343", got)
	}
	if got := extractUint(line, "bytes_received:"); got != 55205 {
		t.Errorf("bytes_received = %d, want 55205", got)
	}
	if got := extractUint(line, "absent:"); got != 0 {
		t.Errorf("absent key = %d, want 0", got)
	}
}

func TestRatePerSec(t *testing.T) {
	if got := ratePerSec(2000, 1000, 2); got != 500 {
		t.Errorf("rate = %v, want 500", got)
	}
	// counter went backwards (socket closed) → 0, not a negative/huge spike
	if got := ratePerSec(500, 1000, 2); got != 0 {
		t.Errorf("backward counter rate = %v, want 0", got)
	}
	// non-positive dt → 0
	if got := ratePerSec(2000, 1000, 0); got != 0 {
		t.Errorf("dt=0 rate = %v, want 0", got)
	}
}

func TestFirstPID(t *testing.T) {
	if pid, ok := firstPID(`users:(("curl",pid=12345,fd=5))`); !ok || pid != 12345 {
		t.Errorf("firstPID = %d,%v, want 12345,true", pid, ok)
	}
	// multiple processes share the socket → first pid wins
	if pid, ok := firstPID(`users:(("a",pid=7,fd=1),("b",pid=9,fd=2))`); !ok || pid != 7 {
		t.Errorf("firstPID multi = %d,%v, want 7,true", pid, ok)
	}
	if _, ok := firstPID("ESTAB 0 0 a:1 b:2"); ok {
		t.Error("firstPID on a process-less line should be ok=false")
	}
}
