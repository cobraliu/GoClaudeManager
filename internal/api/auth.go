package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"google.golang.org/api/idtoken"

	"github.com/loki/goclaudemanager/internal/auth"
	"github.com/loki/goclaudemanager/internal/model"
)

// authRouter mirrors app/api/auth.py (mounted at /api/auth).
func authRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	r.Get("/autologin", func(w http.ResponseWriter, r *http.Request) { autologin(d, w, r) })
	r.Get("/google-client-id", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"client_id": d.Cfg.GoogleClientID()})
	})
	r.Post("/google", func(w http.ResponseWriter, r *http.Request) { googleLogin(d, w, r) })
	r.Post("/login", func(w http.ResponseWriter, r *http.Request) { login(d, w, r) })

	// Current identity as the middleware sees it (is_admin here already ORs
	// role=="admin"). The SPA calls this on load to refresh a stale token's
	// claims — e.g. a JWT minted before the user became admin, or by the legacy
	// Python service — without forcing a re-login.
	r.With(d.Auth.RequireUser).Get("/me", func(w http.ResponseWriter, r *http.Request) {
		id := auth.FromContext(r.Context())
		writeJSON(w, http.StatusOK, model.UserInfo{Username: id.Username, Role: id.Role, IsAdmin: id.IsAdmin})
	})

	// Admin-only user management.
	r.With(d.Auth.RequireAdmin).Post("/users", func(w http.ResponseWriter, r *http.Request) { createUser(d, w, r) })
	r.With(d.Auth.RequireAdmin).Get("/users", func(w http.ResponseWriter, r *http.Request) { listUsers(d, w, r) })
	r.With(d.Auth.RequireAdmin).Put("/users/{username}/is_admin", func(w http.ResponseWriter, r *http.Request) { setIsAdmin(d, w, r) })
	r.With(d.Auth.RequireAdmin).Delete("/users/{username}", func(w http.ResponseWriter, r *http.Request) { deleteUser(d, w, r) })
	// Any authenticated user (self-or-admin check inside).
	r.With(d.Auth.RequireUser).Put("/users/{username}/password", func(w http.ResponseWriter, r *http.Request) { changePassword(d, w, r) })

	return r
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func login(d Deps, w http.ResponseWriter, r *http.Request) {
	var body loginReq
	if !readJSON(w, r, &body) {
		return
	}
	if !d.Auth.LoginRateCheck(body.Username) {
		writeErr(w, http.StatusTooManyRequests, "rate limit exceeded")
		return
	}
	user, err := d.Store.VerifyPassword(body.Username, body.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if user == nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	issueLogin(d, w, user)
}

type createUserReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

func createUser(d Deps, w http.ResponseWriter, r *http.Request) {
	var body createUserReq
	if !readJSON(w, r, &body) {
		return
	}
	role := model.RoleUser
	if body.Role == model.RoleAdmin {
		role = model.RoleAdmin
	}
	user, err := d.Store.CreateUser(body.Username, body.Password, role)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	writeJSONStatus(w, http.StatusCreated, model.UserInfo{Username: user.Username, Role: user.Role, IsAdmin: user.IsAdmin})
}

func listUsers(d Deps, w http.ResponseWriter, _ *http.Request) {
	users, err := d.Store.ListUsers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	out := make([]model.UserInfo, 0, len(users))
	for _, u := range users {
		out = append(out, model.UserInfo{Username: u.Username, Role: u.Role, IsAdmin: u.IsAdmin})
	}
	writeJSON(w, http.StatusOK, out)
}

type setIsAdminReq struct {
	IsAdmin bool `json:"is_admin"`
}

func setIsAdmin(d Deps, w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	var body setIsAdminReq
	if !readJSON(w, r, &body) {
		return
	}
	ok, err := d.Store.SetIsAdmin(username, body.IsAdmin)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	user, _ := d.Store.GetUser(username)
	writeJSON(w, http.StatusOK, model.UserInfo{Username: user.Username, Role: user.Role, IsAdmin: user.IsAdmin})
}

type changePasswordReq struct {
	Password string `json:"password"`
}

func changePassword(d Deps, w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	id := auth.FromContext(r.Context())
	var body changePasswordReq
	if !readJSON(w, r, &body) {
		return
	}
	cur, err := d.Store.GetUser(id.Username)
	if err != nil || cur == nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if id.Username != username && cur.Role != model.RoleAdmin {
		writeErr(w, http.StatusForbidden, "not allowed")
		return
	}
	ok, err := d.Store.ChangePassword(username, body.Password)
	if err != nil || !ok {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteUser(d Deps, w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	id := auth.FromContext(r.Context())
	if username == id.Username {
		writeErr(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}
	ok, err := d.Store.DeleteUser(username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type googleLoginReq struct {
	Credential string `json:"credential"`
}

func googleLogin(d Deps, w http.ResponseWriter, r *http.Request) {
	clientID := d.Cfg.GoogleClientID()
	if clientID == "" {
		writeErr(w, http.StatusNotImplemented, "Google login not configured")
		return
	}
	var body googleLoginReq
	if !readJSON(w, r, &body) {
		return
	}
	payload, err := idtoken.Validate(r.Context(), body.Credential, clientID)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "Invalid Google token: "+err.Error())
		return
	}
	email, _ := payload.Claims["email"].(string)
	if email == "" {
		writeErr(w, http.StatusUnauthorized, "No email in Google token")
		return
	}
	user, err := d.Store.FindByGoogleEmail(email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if user == nil {
		username := strings.NewReplacer(".", "_", "+", "_").Replace(strings.Split(email, "@")[0])
		base := username
		for i := 2; ; i++ {
			existing, _ := d.Store.GetUser(username)
			if existing == nil {
				break
			}
			username = base + strconv.Itoa(i)
		}
		empty, _ := d.Store.UsersEmpty()
		role := model.RoleUser
		if empty {
			role = model.RoleAdmin
		}
		user, err = d.Store.CreateGoogleUser(username, email, role)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}
		if empty {
			_, _ = d.Store.SetIsAdmin(username, true)
			user.IsAdmin = true
		}
	}
	issueLogin(d, w, user)
}

// autologin mirrors the CLI one-time-token exchange (data-dir mode only).
func autologin(d Deps, w http.ResponseWriter, r *http.Request) {
	if d.Env.DataDir == "" {
		writeErr(w, http.StatusForbidden, "autologin not available in dev mode")
		return
	}
	token := r.URL.Query().Get("token")
	tokenFile := filepath.Join(d.Env.DataDir, "autologin.token")
	raw, err := os.ReadFile(tokenFile)
	if err != nil {
		writeErr(w, http.StatusForbidden, "autologin token not found or already used")
		return
	}
	content := strings.TrimSpace(string(raw))
	parts := strings.SplitN(content, ":", 2)
	stored := parts[0]
	var writtenAt float64
	if len(parts) > 1 {
		writtenAt, _ = strconv.ParseFloat(parts[1], 64)
	}
	if token != stored {
		writeErr(w, http.StatusForbidden, "invalid autologin token")
		return
	}
	if float64(time.Now().Unix())-writtenAt > 300 {
		_ = os.Remove(tokenFile)
		writeErr(w, http.StatusForbidden, "autologin token expired")
		return
	}
	_ = os.Remove(tokenFile) // one-time use
	localUser := os.Getenv("USER")
	if localUser == "" {
		localUser = os.Getenv("USERNAME")
	}
	if localUser == "" {
		localUser = "local"
	}
	user, _ := d.Store.GetUser(localUser)
	if user == nil {
		user, _ = d.Store.CreateUser(localUser, randomSecret(), model.RoleAdmin)
		_, _ = d.Store.SetIsAdmin(localUser, true)
		if user != nil {
			user.IsAdmin = true
		}
	}
	if user == nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	tok, _ := d.Auth.CreateJWT(user.Username, user.Role, true)
	writeJSON(w, http.StatusOK, model.LoginResponse{Token: tok, Username: user.Username, Role: user.Role, IsAdmin: true})
}

func issueLogin(d Deps, w http.ResponseWriter, user *model.User) {
	// Mirror the middleware (auth.decode): a "admin" role is admin even if the
	// is_admin column was never set — e.g. a pre-existing/migrated DB whose users
	// table wasn't empty at first boot, so the SetIsAdmin(true) seed was skipped.
	// Without this the frontend (which gates the Admin entry on the JWT is_admin
	// claim) would hide the panel from a working admin.
	isAdmin := user.IsAdmin || user.Role == model.RoleAdmin
	tok, err := d.Auth.CreateJWT(user.Username, user.Role, isAdmin)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, model.LoginResponse{
		Token: tok, Username: user.Username, Role: user.Role, IsAdmin: isAdmin,
	})
}
