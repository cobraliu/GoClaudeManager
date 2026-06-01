package store

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"

	"github.com/loki/goclaudemanager/internal/model"
)

// ErrUserExists is returned when creating a duplicate username.
var ErrUserExists = errors.New("user already exists")

// pbkdf2 parameters MUST match app/services/user_store._hash_password:
// PBKDF2-HMAC-SHA256, 260000 iterations, 32-byte output, salt used as UTF-8
// bytes (it is a hex string but Python calls salt.encode()).
const pbkdf2Iter = 260000

func hashPassword(password, salt string) string {
	dk, err := pbkdf2.Key(sha256.New, password, []byte(salt), pbkdf2Iter, 32)
	if err != nil {
		// pbkdf2.Key only errors on absurd key lengths; 32 is fine.
		panic(err)
	}
	return hex.EncodeToString(dk)
}

func userFromRow(sc interface{ Scan(...any) error }) (*model.User, error) {
	var (
		u       model.User
		isAdmin int64
		gemail  sql.NullString
		salt    string
	)
	if err := sc.Scan(&u.Username, &u.PasswordHash, &salt, &u.Role, &isAdmin, &gemail); err != nil {
		return nil, err
	}
	u.IsAdmin = isAdmin != 0
	u.GoogleEmail = nsToPtr(gemail)
	return &u, nil
}

// CreateUser inserts a password user. Returns ErrUserExists on conflict.
func (s *Store) CreateUser(username, password string, role model.UserRole) (*model.User, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	salt := tokenHex(16)
	pwHash := hashPassword(password, salt)
	_, err := s.DB.Exec(
		`INSERT INTO users (username, password_hash, salt, role, is_admin) VALUES (?,?,?,?,0)`,
		username, pwHash, salt, role)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return s.GetUser(username)
}

// CreateGoogleUser inserts a user linked to a Google email (no password).
func (s *Store) CreateGoogleUser(username, email string, role model.UserRole) (*model.User, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err := s.DB.Exec(
		`INSERT INTO users (username, password_hash, salt, role, is_admin, google_email) VALUES (?,?,?,?,0,?)`,
		username, "", "", role, email)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return s.GetUser(username)
}

// VerifyPassword returns the user if the password matches, else nil.
func (s *Store) VerifyPassword(username, password string) (*model.User, error) {
	var (
		u       model.User
		isAdmin int64
		gemail  sql.NullString
		salt    string
	)
	err := s.DB.QueryRow(`SELECT username, password_hash, salt, role, is_admin, google_email FROM users WHERE username = ?`, username).
		Scan(&u.Username, &u.PasswordHash, &salt, &u.Role, &isAdmin, &gemail)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	candidate := hashPassword(password, salt)
	if subtle.ConstantTimeCompare([]byte(candidate), []byte(u.PasswordHash)) != 1 {
		return nil, nil
	}
	u.IsAdmin = isAdmin != 0
	u.GoogleEmail = nsToPtr(gemail)
	return &u, nil
}

// ChangePassword resets a user's password; returns whether a row changed.
func (s *Store) ChangePassword(username, newPassword string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	salt := tokenHex(16)
	pwHash := hashPassword(newPassword, salt)
	res, err := s.DB.Exec(`UPDATE users SET password_hash = ?, salt = ? WHERE username = ?`, pwHash, salt, username)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// GetUser returns a user by username, or (nil, nil) if absent.
func (s *Store) GetUser(username string) (*model.User, error) {
	row := s.DB.QueryRow(`SELECT username, password_hash, salt, role, is_admin, google_email FROM users WHERE username = ?`, username)
	u, err := userFromRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// ListUsers returns all users.
func (s *Store) ListUsers() ([]*model.User, error) {
	rows, err := s.DB.Query(`SELECT username, password_hash, salt, role, is_admin, google_email FROM users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.User
	for rows.Next() {
		u, err := userFromRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// DeleteUser removes a user; returns whether a row changed.
func (s *Store) DeleteUser(username string) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	res, err := s.DB.Exec(`DELETE FROM users WHERE username = ?`, username)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetIsAdmin sets the admin flag; returns whether a row changed.
func (s *Store) SetIsAdmin(username string, isAdmin bool) (bool, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	v := 0
	if isAdmin {
		v = 1
	}
	res, err := s.DB.Exec(`UPDATE users SET is_admin = ? WHERE username = ?`, v, username)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// FindByGoogleEmail returns the user linked to a Google email, or (nil, nil).
func (s *Store) FindByGoogleEmail(email string) (*model.User, error) {
	row := s.DB.QueryRow(`SELECT username, password_hash, salt, role, is_admin, google_email FROM users WHERE google_email = ?`, email)
	u, err := userFromRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// UsersEmpty reports whether the users table is empty.
func (s *Store) UsersEmpty() (bool, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n == 0, err
}

func tokenHex(nBytes int) string {
	b := make([]byte, nBytes)
	cryptoRead(b)
	return hex.EncodeToString(b)
}
