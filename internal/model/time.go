// Package model defines the domain types shared across the backend. Field names
// and JSON shapes mirror the Python pydantic models (app/models/*) so the React
// frontend and the existing data.db are byte-compatible.
package model

import (
	"database/sql/driver"
	"fmt"
	"strings"
	"time"
)

// isoLayouts are the formats we accept when parsing timestamps written by the
// Python backend (datetime.isoformat() — tz-aware, optional microseconds).
var isoLayouts = []string{
	"2006-01-02T15:04:05.999999-07:00",
	"2006-01-02T15:04:05-07:00",
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05.999999",
	"2006-01-02T15:04:05",
}

// ISOTime is a time.Time that (de)serializes to Python's datetime.isoformat()
// representation for both JSON (API contract) and SQLite TEXT columns (shared
// data.db). UTC times render with a "+00:00" offset, matching Python.
type ISOTime struct{ time.Time }

// NowUTC returns the current time in UTC as an ISOTime.
func NowUTC() ISOTime { return ISOTime{time.Now().UTC()} }

// String renders the Python isoformat-compatible string.
func (t ISOTime) String() string {
	// Match datetime.isoformat(): microsecond precision, drop trailing zeros to
	// "" when whole-second (Python omits the fractional part when it is zero).
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05-07:00")
	}
	return t.Format("2006-01-02T15:04:05.000000-07:00")
}

// MarshalJSON emits a quoted isoformat string.
func (t ISOTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.String() + `"`), nil
}

// UnmarshalJSON parses a quoted isoformat string.
func (t *ISOTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		return nil
	}
	return t.parse(s)
}

func (t *ISOTime) parse(s string) error {
	for _, layout := range isoLayouts {
		if parsed, err := time.Parse(layout, s); err == nil {
			t.Time = parsed
			return nil
		}
	}
	return fmt.Errorf("model: cannot parse time %q", s)
}

// Scan implements sql.Scanner for reading TEXT timestamps.
func (t *ISOTime) Scan(v any) error {
	switch s := v.(type) {
	case nil:
		return nil
	case string:
		return t.parse(s)
	case []byte:
		return t.parse(string(s))
	case time.Time:
		t.Time = s
		return nil
	}
	return fmt.Errorf("model: cannot scan %T into ISOTime", v)
}

// Value implements driver.Valuer for writing TEXT timestamps.
func (t ISOTime) Value() (driver.Value, error) {
	return t.String(), nil
}

// ParseISO parses a Python isoformat string into an ISOTime.
func ParseISO(s string) (ISOTime, error) {
	var t ISOTime
	err := t.parse(s)
	return t, err
}
