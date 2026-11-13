package store

// UsageSample is one periodic reading of the account's rate-limit windows.
// Utilization is the 0–1 fraction from the anthropic-ratelimit-unified-*
// headers; resets are unix seconds. A nil field means the window was absent.
type UsageSample struct {
	TS         int64    `json:"ts"`
	FiveHour   *float64 `json:"five_hour"`
	FiveReset  *int64   `json:"five_reset"`
	SevenDay   *float64 `json:"seven_day"`
	SevenReset *int64   `json:"seven_reset"`
}

// AddUsageSample stores a sample and drops rows older than keepBefore (unix s).
func (s *Store) AddUsageSample(u UsageSample, keepBefore int64) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.DB.Exec(`INSERT INTO usage_samples (ts, five_hour, five_reset, seven_day, seven_reset) VALUES (?, ?, ?, ?, ?)`,
		u.TS, u.FiveHour, u.FiveReset, u.SevenDay, u.SevenReset); err != nil {
		return err
	}
	_, err := s.DB.Exec(`DELETE FROM usage_samples WHERE ts < ?`, keepBefore)
	return err
}

// ListUsageSamples returns samples with ts >= since, oldest first.
func (s *Store) ListUsageSamples(since int64) ([]UsageSample, error) {
	rows, err := s.DB.Query(`SELECT ts, five_hour, five_reset, seven_day, seven_reset FROM usage_samples WHERE ts >= ? ORDER BY ts`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageSample{}
	for rows.Next() {
		var u UsageSample
		if err := rows.Scan(&u.TS, &u.FiveHour, &u.FiveReset, &u.SevenDay, &u.SevenReset); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
