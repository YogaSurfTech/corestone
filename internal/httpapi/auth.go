package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/thomdehoog/corestone/internal/accounts"
	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// Local accounts (-auth local): signing in and out, the own account, and
// account administration for admins. With -auth none only GET /api/auth
// answers, with mode "none".

const sessionCookie = "corestone_session"

func (s *Server) authRoutes() {
	m := s.mux
	m.HandleFunc("GET /api/auth", s.authState)
	m.HandleFunc("POST /api/auth/setup", s.withAccounts(s.setup))
	m.HandleFunc("POST /api/auth/login", s.withAccounts(s.login))
	m.HandleFunc("POST /api/auth/logout", s.withAccounts(s.logout))
	m.HandleFunc("GET /api/me", s.withAccounts(s.me))
	m.HandleFunc("PATCH /api/me", s.withAccounts(s.updateMe))
	m.HandleFunc("POST /api/me/password", s.withAccounts(s.myPassword))
	m.HandleFunc("GET /api/accounts", s.admin(s.listAccounts))
	m.HandleFunc("POST /api/accounts", s.admin(s.createAccount))
	m.HandleFunc("POST /api/accounts/{guid}/password", s.admin(s.resetPassword))
	m.HandleFunc("PUT /api/accounts/{guid}/role", s.admin(s.setRole))
}

// withAccounts answers 404 when the server runs without accounts.
func (s *Server) withAccounts(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Accounts == nil {
			writeError(w, http.StatusNotFound, "accounts are disabled (-auth none)")
			return
		}
		h(w, r)
	}
}

// admin also requires the admin role.
func (s *Server) admin(h http.HandlerFunc) http.HandlerFunc {
	return s.withAccounts(func(w http.ResponseWriter, r *http.Request) {
		if !accounts.FromContext(r.Context()).IsAdmin() {
			writeError(w, http.StatusForbidden, "only admins manage accounts")
			return
		}
		h(w, r)
	})
}

func sessionToken(r *http.Request) string {
	if c, err := r.Cookie(sessionCookie); err == nil {
		return c.Value
	}
	return ""
}

func setSession(w http.ResponseWriter, r *http.Request, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: r.TLS != nil, MaxAge: int(ttl.Seconds()), Expires: time.Now().Add(ttl)})
}

// authState tells the client how to start: the mode, whether the first
// account is still to be created, and the signed-in account.
func (s *Server) authState(w http.ResponseWriter, r *http.Request) {
	if s.Accounts == nil {
		writeJSON(w, http.StatusOK, map[string]any{"mode": "none"})
		return
	}
	n, err := s.Accounts.Count(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mode": "local", "setup": n == 0, "account": accounts.FromContext(r.Context())})
}

// setup creates the first account and makes it admin: the access file is
// committed first (by the new account), then the account is stored. Should
// storing fail, the access file merely names an account that does not exist.
func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	if n, err := s.Accounts.Count(r.Context()); err != nil || n > 0 {
		if err == nil {
			writeError(w, http.StatusConflict, "the first account exists already")
		} else {
			fail(w, err)
		}
		return
	}
	rec, err := s.Accounts.NewRecord(body.String("name"), body.String("email"), body.String("password"))
	if err != nil {
		fail(w, err)
		return
	}
	ctx := gitx.WithIdentity(r.Context(), rec.Name, rec.Email)
	if err := s.F.SetAdmin(ctx, rec.GUID, rec.Name, true); err != nil {
		fail(w, err)
		return
	}
	a, err := s.Accounts.Add(r.Context(), rec, true)
	if err != nil {
		fail(w, err)
		return
	}
	a.Role = accounts.RoleAdmin
	s.startSession(w, r, a, http.StatusCreated)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	a, token, err := s.Accounts.SignIn(r.Context(), body.String("email"), body.String("password"))
	if errors.Is(err, accounts.ErrSignIn) {
		writeError(w, http.StatusUnauthorized, "wrong email or password")
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	if a.Role, err = s.roles.of(r.Context(), a.GUID); err != nil {
		fail(w, err)
		return
	}
	setSession(w, r, token, accounts.SessionTTL)
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, a *accounts.Account, status int) {
	token, err := s.Accounts.NewSession(r.Context(), a.GUID)
	if err != nil {
		fail(w, err)
		return
	}
	setSession(w, r, token, accounts.SessionTTL)
	writeJSON(w, status, a)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if token := sessionToken(r); token != "" {
		if err := s.Accounts.EndSession(r.Context(), token); err != nil {
			fail(w, err)
			return
		}
	}
	setSession(w, r, "", -time.Second)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, accounts.FromContext(r.Context()))
}

// updateMe changes the own name and email: {"name": ..., "email": ...}.
func (s *Server) updateMe(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	a := accounts.FromContext(r.Context())
	name, email := a.Name, a.Email
	if has(body, "name") {
		name = body.String("name")
	}
	if has(body, "email") {
		email = body.String("email")
	}
	updated, err := s.Accounts.Update(r.Context(), a.GUID, name, email)
	if err != nil {
		fail(w, err)
		return
	}
	updated.Role = a.Role
	writeJSON(w, http.StatusOK, updated)
}

// myPassword changes the own password: {"current": ..., "password": ...}.
// Other sessions end; this one continues with a new token.
func (s *Server) myPassword(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	a := accounts.FromContext(r.Context())
	if ok, err := s.Accounts.CheckPassword(r.Context(), a.GUID, body.String("current")); err != nil {
		fail(w, err)
		return
	} else if !ok {
		writeError(w, http.StatusBadRequest, "the current password is wrong")
		return
	}
	if err := s.Accounts.SetPassword(r.Context(), a.GUID, body.String("password")); err != nil {
		fail(w, err)
		return
	}
	s.startSession(w, r, a, http.StatusOK)
}

// listAccounts lists the accounts with their roles, and the admins named by
// the access file that have no account (unknownAdmins).
func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	list, err := s.Accounts.List(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	access, err := s.roles.get(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	known := map[string]bool{}
	for _, a := range list {
		known[a.GUID] = true
		if access.IsAdmin(a.GUID) {
			a.Role = accounts.RoleAdmin
		}
	}
	unknown := []string{}
	for _, g := range access.Admins {
		if !known[g] {
			unknown = append(unknown, g)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": list, "unknownAdmins": unknown})
}

// createAccount: {"name", "email", "password", "role"}; the role defaults to
// user. An admin is stored first and then committed to the access file.
func (s *Server) createAccount(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	role := accounts.Role(body.String("role"))
	if role == "" {
		role = accounts.RoleUser
	}
	if role != accounts.RoleUser && role != accounts.RoleAdmin {
		writeError(w, http.StatusBadRequest, "role must be user or admin")
		return
	}
	rec, err := s.Accounts.NewRecord(body.String("name"), body.String("email"), body.String("password"))
	if err != nil {
		fail(w, err)
		return
	}
	a, err := s.Accounts.Add(r.Context(), rec, false)
	if err != nil {
		fail(w, err)
		return
	}
	if role == accounts.RoleAdmin {
		if err := s.F.SetAdmin(r.Context(), a.GUID, a.Name, true); err != nil {
			fail(w, err)
			return
		}
		a.Role = accounts.RoleAdmin
	}
	writeJSON(w, http.StatusCreated, a)
}

// setRole makes an account admin or user: {"role": "admin"|"user"}. It is a
// commit to the access file; the last admin cannot be removed.
func (s *Server) setRole(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	role := accounts.Role(body.String("role"))
	if role != accounts.RoleUser && role != accounts.RoleAdmin {
		writeError(w, http.StatusBadRequest, "role must be user or admin")
		return
	}
	a, err := s.Accounts.Get(r.Context(), r.PathValue("guid"))
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.F.SetAdmin(r.Context(), a.GUID, a.Name, role == accounts.RoleAdmin); err != nil {
		fail(w, err)
		return
	}
	a.Role = role
	writeJSON(w, http.StatusOK, a)
}

// resetPassword sets another account's password: {"password": ...}; its sessions end.
func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	guid := r.PathValue("guid")
	if !model.IsGUID(guid) {
		writeError(w, http.StatusBadRequest, "invalid account id")
		return
	}
	if err := s.Accounts.SetPassword(r.Context(), guid, body.String("password")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func has(o *ojson.Object, key string) bool { _, ok := o.Get(key); return ok }
