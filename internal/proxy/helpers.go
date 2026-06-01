package proxy

import (
	"math"
	"strings"
)

// singleJoiningSlash joins two URL path segments with exactly one slash,
// mirroring the helper used by httputil.ReverseProxy.
func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		if a == "" {
			return b
		}
		return a + "/" + b
	}
	return a + b
}

// lowerASCII lowercases an ASCII string without allocating for the common case
// where it is already lowercase.
func lowerASCII(s string) string {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			return strings.ToLower(s)
		}
	}
	return s
}

// containsCI reports whether s contains substr, case-insensitively.
func containsCI(s, substr string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(substr))
}

// dash returns "-" for an empty string, for tidy log lines.
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// round1 rounds to one decimal place for the health uptime field.
func round1(f float64) float64 {
	return math.Round(f*10) / 10
}
