// Package auth issues and verifies JWTs and provides HTTP middleware, mirroring
// app/security.py (HS256, 7-day expiry, sub/role/is_admin claims) so tokens are
// interchangeable with the Python backend (same jwt_secret from the configs table).
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/loki/goclaudemanager/internal/model"
)

type ctxKey int

const userCtxKey ctxKey = 0

// Identity is the authenticated principal extracted from a JWT.
type Identity struct {
	Username string
	Role     string
	IsAdmin  bool
}

// Auth holds the signing secret and rate limiters.
type Auth struct {
	secret        []byte
	rate          *rateLimiter
	loginRate     *rateLimiter
}

// New builds an Auth with the given JWT secret (from config.JWTSecret()).
func New(secret string) *Auth {
	return &Auth{
		secret:    []byte(secret),
		rate:      newRateLimiter(6000, time.Minute),
		loginRate: newRateLimiter(10, time.Minute),
	}
}

// CreateJWT mints a 7-day HS256 token (matches security.create_jwt).
func (a *Auth) CreateJWT(username string, role model.UserRole, isAdmin bool) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":      username,
		"role":     role,
		"is_admin": isAdmin,
		"iat":      now.Unix(),
		"exp":      now.Add(7 * 24 * time.Hour).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(a.secret)
}

func (a *Auth) decode(token string) (*Identity, error) {
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return a.secret, nil
	})
	if err != nil || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, errors.New("invalid token")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return nil, errors.New("invalid token")
	}
	role, _ := claims["role"].(string)
	isAdmin, _ := claims["is_admin"].(bool)
	return &Identity{Username: sub, Role: role, IsAdmin: isAdmin || role == model.RoleAdmin}, nil
}

// LoginRateCheck enforces the per-username login limiter (returns false if over).
func (a *Auth) LoginRateCheck(username string) bool { return a.loginRate.allow(username) }

// bearer extracts the token from an Authorization header.
func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}

// RequireUser is middleware that authenticates any valid user.
func (a *Auth) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := a.authenticate(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, err.Error())
			return
		}
		if !a.rate.allow(id.Username) {
			writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, id)))
	})
}

// RequireAdmin is middleware that requires an admin user.
func (a *Auth) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := a.authenticate(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, err.Error())
			return
		}
		if !id.IsAdmin && id.Role != model.RoleAdmin {
			writeErr(w, http.StatusForbidden, "admin required")
			return
		}
		if !a.rate.allow(id.Username) {
			writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, id)))
	})
}

func (a *Auth) authenticate(r *http.Request) (*Identity, error) {
	tok := bearer(r)
	if tok == "" {
		return nil, errors.New("missing token")
	}
	return a.decode(tok)
}

// FromContext returns the authenticated identity, or nil if unauthenticated.
func FromContext(ctx context.Context) *Identity {
	id, _ := ctx.Value(userCtxKey).(*Identity)
	return id
}

// VerifyToken decodes a token directly (for WebSocket query-param auth).
func (a *Auth) VerifyToken(token string) (*Identity, error) { return a.decode(token) }

func writeErr(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
}

// ---- rate limiter (sliding window, mirrors security.RateLimiter) ----------

type rateLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	events map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	return &rateLimiter{max: max, window: window, events: map[string][]time.Time{}}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	q := rl.events[key]
	cut := 0
	for cut < len(q) && now.Sub(q[cut]) > rl.window {
		cut++
	}
	q = q[cut:]
	if len(q) >= rl.max {
		rl.events[key] = q
		return false
	}
	rl.events[key] = append(q, now)
	return true
}
