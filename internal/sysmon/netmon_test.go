package sysmon

import "testing"

func TestParseNetDev(t *testing.T) {
	// Two header rows (no "iface:" colon), then loopback + two physical NICs +
	// virtual interfaces (docker0, a bridge, a veth) that must NOT be summed —
	// otherwise bridged container traffic double-counts. rx is column 1, tx is
	// column 9 after the colon.
	sample := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
 wlan0: 200 2 0 0 0 0 0 0 300 3 0 0 0 0 0 0
 docker0: 9000 90 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
 br-abc: 9000 90 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
 vethX: 9000 90 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
`
	// keep only the two "physical" NICs in this test (hermetic — no real /sys).
	phys := func(n string) bool { return n == "eth0" || n == "wlan0" }
	rx, tx, ok := parseNetDev(sample, phys)
	if !ok {
		t.Fatal("parseNetDev ok=false, want true")
	}
	if rx != 5200 { // 5000 + 200; lo + docker0 + br-* + veth excluded
		t.Errorf("rx = %d, want 5200", rx)
	}
	if tx != 7300 { // 7000 + 300
		t.Errorf("tx = %d, want 7300", tx)
	}
}

func TestParseNetDevEmpty(t *testing.T) {
	keepAll := func(string) bool { return true }
	if _, _, ok := parseNetDev("garbage\nno colons here\n", keepAll); ok {
		t.Error("parseNetDev on junk should report ok=false")
	}
}

func TestParseSS(t *testing.T) {
	// Mirrors `ss -tinHp`: a socket header line (with users:(...)) followed by a
	// whitespace-indented info line carrying the byte counters. Three sockets for
	// pid 111: an external one (counted), a loopback-peer one (excluded — never
	// hits the NIC), plus a process-less external socket (unattributed). A second
	// external socket for pid 111 confirms accumulation.
	sample := "ESTAB 0 0 10.0.0.1:44978 1.2.3.4:443 users:((\"curl\",pid=111,fd=5))\n" +
		"\t cubic bytes_sent:53330 bytes_acked:51343 bytes_received:55205 segs_out:1\n" +
		"ESTAB 0 0 10.0.0.1:59890 5.6.7.8:443 \n" +
		"\t cubic bytes_acked:234875 bytes_received:258646 segs_out:2\n" +
		"ESTAB 0 0 127.0.0.1:53618 127.0.0.1:8138 users:((\"curl\",pid=111,fd=8))\n" +
		"\t cubic bytes_acked:9999 bytes_received:9999 segs_out:3\n" +
		"ESTAB 0 0 10.0.0.1:40001 8.8.8.8:443 users:((\"curl\",pid=111,fd=9))\n" +
		"\t cubic bytes_acked:1000 bytes_received:2000 segs_out:4\n"
	m := parseSS(sample)
	// pid 111: external sockets only → tx = 51343+1000, rx = 55205+2000. The
	// loopback-peer socket (9999/9999) is excluded.
	got, ok := m[111]
	if !ok {
		t.Fatal("pid 111 missing from parseSS result")
	}
	if got.tx != 52343 {
		t.Errorf("pid 111 tx = %d, want 52343 (loopback socket must be excluded)", got.tx)
	}
	if got.rx != 57205 {
		t.Errorf("pid 111 rx = %d, want 57205 (loopback socket must be excluded)", got.rx)
	}
	// The process-less socket must not invent a pid.
	if len(m) != 1 {
		t.Errorf("parseSS produced %d pids, want 1 (unattributed socket ignored)", len(m))
	}
}

func TestPeerIsLoopback(t *testing.T) {
	yes := []string{
		"ESTAB 0 0 127.0.0.1:45322 127.0.0.1:8138 users:((\"curl\",pid=1,fd=5))",
		"ESTAB 0 0 10.0.0.1:5 127.0.0.5:80 users:((\"x\",pid=2,fd=1))",
		"ESTAB 0 0 [::1]:5 [::1]:80 users:((\"x\",pid=3,fd=1))",
	}
	no := []string{
		"ESTAB 0 0 10.0.0.1:44978 1.2.3.4:443 users:((\"curl\",pid=1,fd=5))",
		"ESTAB 0 0 10.0.0.1:5 192.168.1.9:80 users:((\"x\",pid=2,fd=1))",
	}
	for _, l := range yes {
		if !peerIsLoopback(l) {
			t.Errorf("peerIsLoopback(%q) = false, want true", l)
		}
	}
	for _, l := range no {
		if peerIsLoopback(l) {
			t.Errorf("peerIsLoopback(%q) = true, want false", l)
		}
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

func TestParseHumanBytes(t *testing.T) {
	cases := []struct {
		in   string
		want uint64
		ok   bool
	}{
		{"0B", 0, true},
		{"512B", 512, true},
		{"256kB", 256000, true},
		{"3.7GB", 3700000000, true},
		{"2.96GB", 2960000000, true},
		{"1.5MB", 1500000, true},
		{"4TB", 4000000000000, true},
		{"", 0, false},
		{"GB", 0, false},
		{"12 widgets", 0, false},
	}
	for _, c := range cases {
		got, ok := parseHumanBytes(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseHumanBytes(%q) = %d,%v want %d,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseDockerStats(t *testing.T) {
	// Format is "<name>\t<rx> / <tx>"; one malformed line (no tab) is skipped.
	sample := "proxy-sg\t663MB / 669MB\n" +
		"redis-1\t2.94GB / 3.69GB\n" +
		"idle\t0B / 0B\n" +
		"garbage-no-tab line\n"
	m := parseDockerStats(sample)
	if len(m) != 3 {
		t.Fatalf("parseDockerStats produced %d entries, want 3", len(m))
	}
	if m["proxy-sg"].rx != 663000000 || m["proxy-sg"].tx != 669000000 {
		t.Errorf("proxy-sg = %+v, want rx=663000000 tx=669000000", m["proxy-sg"])
	}
	if m["redis-1"].rx != 2940000000 || m["redis-1"].tx != 3690000000 {
		t.Errorf("redis-1 = %+v", m["redis-1"])
	}
	if c, ok := m["idle"]; !ok || c.rx != 0 || c.tx != 0 {
		t.Errorf("idle = %+v,%v, want zero,true", c, ok)
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
