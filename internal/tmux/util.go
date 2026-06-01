package tmux

import (
	"os"
	"sort"
	"strings"
)

// shellQuote returns a POSIX shell-safe single-quoted representation of s,
// equivalent to Python's shlex.quote. Empty strings become ''. Strings made up
// only of safe characters are returned unquoted.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, shellUnsafe) {
		return s
	}
	// Wrap in single quotes, escaping embedded single quotes as '"'"'.
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// shellUnsafe is the complement of shlex's _find_unsafe regex
// ([^\w@%+=:,./-]). Any character outside that safe set forces quoting.
const shellUnsafe = " \t\n\r\f\v!\"#$&'()*;<>?[\\]^`{|}~"

// shellQuoteJoin quotes each part and joins with spaces (for error messages),
// matching the Python `" ".join(shlex.quote(p) for p in cmd)`.
func shellQuoteJoin(parts []string) string {
	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = shellQuote(p)
	}
	return strings.Join(quoted, " ")
}

// sortedKeys returns the keys of m in sorted order.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// pathContains reports whether dir is an element of a PATH-style list.
func pathContains(pathVar, dir string) bool {
	if pathVar == "" {
		return false
	}
	for _, p := range strings.Split(pathVar, string(os.PathListSeparator)) {
		if p == dir {
			return true
		}
	}
	return false
}

// joinNonEmpty joins the non-empty elements of parts with sep
// (port of Python's `sep.join(filter(None, parts))`).
func joinNonEmpty(parts []string, sep string) string {
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}
