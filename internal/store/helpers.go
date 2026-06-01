package store

import (
	"crypto/rand"
	"strings"
)

func cryptoRead(b []byte) {
	_, _ = rand.Read(b)
}

// isUniqueViolation detects SQLite UNIQUE/PRIMARY KEY constraint errors.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique constraint") || strings.Contains(msg, "primary key")
}
