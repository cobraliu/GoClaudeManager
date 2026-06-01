package model

// UserRole mirrors the Python UserRole enum.
type UserRole = string

const (
	RoleAdmin UserRole = "admin"
	RoleUser  UserRole = "user"
)

// User mirrors pydantic User (persisted in the configs table as JSON under the
// "users" key in the Python backend).
type User struct {
	Username     string   `json:"username"`
	PasswordHash string   `json:"password_hash"`
	Role         UserRole `json:"role"`
	IsAdmin      bool     `json:"is_admin"`
	GoogleEmail  *string  `json:"google_email"`
}

// LoginResponse mirrors pydantic LoginResponse.
type LoginResponse struct {
	Token    string   `json:"token"`
	Username string   `json:"username"`
	Role     UserRole `json:"role"`
	IsAdmin  bool     `json:"is_admin"`
}

// UserInfo mirrors pydantic UserInfo.
type UserInfo struct {
	Username string   `json:"username"`
	Role     UserRole `json:"role"`
	IsAdmin  bool     `json:"is_admin"`
}

// FileAccessSpec mirrors pydantic FileAccessSpec.
type FileAccessSpec struct {
	Full  []string `json:"full"`
	Files []string `json:"files"`
}

// ShareRecord mirrors pydantic ShareRecord.
type ShareRecord struct {
	Hash          string          `json:"hash"`
	SessionID     string          `json:"session_id"`
	OwnerID       string          `json:"owner_id"`
	ShareType     string          `json:"share_type"`
	CutoffTs      *float64        `json:"cutoff_ts"`
	CutoffMsgUUID *string         `json:"cutoff_msg_uuid"`
	CutoffMsgText *string         `json:"cutoff_msg_text"`
	CreatedAt     float64         `json:"created_at"`
	ExpiresAt     float64         `json:"expires_at"`
	DefaultTheme  string          `json:"default_theme"`
	FileAccess    *FileAccessSpec `json:"file_access"`
}

// PermanentShareExpires is the sentinel for shares that never expire.
const PermanentShareExpires = 2147483647
