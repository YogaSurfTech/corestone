package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/accounts"
	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/testutil"
)

// browserClient is one browser: its own cookie jar against the shared server.
type browserClient struct {
	t   *testing.T
	url string
	c   *http.Client
}

func (c *browserClient) do(method, path, body string) (int, string) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.url+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.c.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func (c *browserClient) ok(method, path, body string, want int) string {
	c.t.Helper()
	code, raw := c.do(method, path, body)
	if code != want {
		c.t.Fatalf("%s %s: got %d want %d: %s", method, path, code, want, raw)
	}
	return raw
}

func newAuthServer(t *testing.T) (*Server, func() *browserClient) {
	t.Helper()
	ctx := context.Background()
	f, err := foundation.Open(ctx, t.TempDir()+"/repo.git", "main", testutil.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	s := New(f)
	if s.Accounts, err = accounts.Open(ctx, f.DB.SQL(), t.TempDir()+"/accounts.json"); err != nil {
		t.Fatal(err)
	}
	s.Accounts.Iterations = 1000
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return s, func() *browserClient {
		jar, _ := cookiejar.New(nil)
		return &browserClient{t: t, url: srv.URL, c: &http.Client{Jar: jar}}
	}
}

func TestAuthLocal(t *testing.T) {
	s, browser := newAuthServer(t)
	anon, ada, bob := browser(), browser(), browser()

	// nothing but health and signing in without a session
	anon.ok("GET", "/api/repository", "", 401)
	anon.ok("PUT", "/api/config?path=entries/types.json", `{"types":[]}`, 401)
	anon.ok("GET", "/api/health", "", 200)
	if raw := anon.ok("GET", "/api/auth", "", 200); !strings.Contains(raw, `"mode":"local"`) || !strings.Contains(raw, `"setup":true`) {
		t.Fatalf("auth state %s", raw)
	}

	// the first account is an admin and is signed in right away; setup works once
	if raw := ada.ok("POST", "/api/auth/setup", `{"name":"Ada","email":"ada@example.org","password":"pw1"}`, 201); !strings.Contains(raw, `"role":"admin"`) {
		t.Fatalf("setup %s", raw)
	}
	anon.ok("POST", "/api/auth/setup", `{"name":"Eve","email":"eve@example.org","password":"x"}`, 409)
	if raw := ada.ok("GET", "/api/auth", "", 200); !strings.Contains(raw, `"setup":false`) || !strings.Contains(raw, `"name":"Ada"`) {
		t.Fatalf("auth state after setup %s", raw)
	}
	ada.ok("GET", "/api/repository", "", 200)

	// the role is in the repository: setup committed the access file, by Ada
	access, err := s.F.Access(context.Background())
	if err != nil || len(access.Admins) != 1 {
		t.Fatalf("access %+v %v", access, err)
	}
	log, _ := s.F.Repo.Log(context.Background(), "main", []string{".corestone/access.json"}, 5)
	if len(log) != 1 || log[0].Author != "Ada" || !strings.Contains(log[0].Subject, "Ada made admin") {
		t.Fatalf("access history %+v", log)
	}
	// it is no configuration file: the config API cannot change it
	ada.ok("PUT", "/api/config?path=../access.json", `{"admins":[]}`, 400)

	// commits carry the account as author
	ada.ok("PUT", "/api/config?path=entries/types.json", `{"types":[{"id":"note"}]}`, 200)
	log, err = s.F.Repo.Log(context.Background(), "main", nil, 1)
	if err != nil || len(log) != 1 || log[0].Author != "Ada" || log[0].Email != "ada@example.org" {
		t.Fatalf("author %+v %v", log, err)
	}

	// admins create accounts and reset passwords; users do neither
	ada.ok("POST", "/api/accounts", `{"name":"Bob","email":"bob@example.org","password":"pw2"}`, 201)
	ada.ok("POST", "/api/accounts", `{"name":"Bob","email":"BOB@example.org","password":"pw2"}`, 409)
	anon.ok("POST", "/api/auth/login", `{"email":"bob@example.org","password":"wrong"}`, 401)
	if raw := bob.ok("POST", "/api/auth/login", `{"email":"bob@example.org","password":"pw2"}`, 200); !strings.Contains(raw, `"role":"user"`) {
		t.Fatalf("login %s", raw)
	}
	bob.ok("GET", "/api/accounts", "", 403)
	bob.ok("POST", "/api/accounts", `{"name":"Mallory","email":"m@example.org","password":"x","role":"admin"}`, 403)
	raw := ada.ok("GET", "/api/accounts", "", 200)
	if strings.Count(raw, `"guid"`) != 2 || strings.Contains(raw, "pbkdf2") || strings.Count(raw, `"role":"admin"`) != 1 {
		t.Fatalf("accounts %s", raw)
	}
	i := strings.Index(raw, `"guid":"`) // accounts are listed by name: Ada first, then Bob
	j := strings.LastIndex(raw, `"guid":"`)
	adaGUID, bobGUID := raw[i+8:i+44], raw[j+8:j+44]
	bob.ok("POST", "/api/accounts/"+adaGUID+"/password", `{"password":"x"}`, 403)
	bob.ok("PUT", "/api/accounts/"+bobGUID+"/role", `{"role":"admin"}`, 403)

	// admins grant and withdraw the admin role; the last admin stays
	ada.ok("PUT", "/api/accounts/"+adaGUID+"/role", `{"role":"user"}`, 409)
	ada.ok("PUT", "/api/accounts/"+bobGUID+"/role", `{"role":"root"}`, 400)
	ada.ok("PUT", "/api/accounts/"+bobGUID+"/role", `{"role":"admin"}`, 200)
	bob.ok("GET", "/api/accounts", "", 200) // effective right away
	bob.ok("PUT", "/api/accounts/"+adaGUID+"/role", `{"role":"user"}`, 200)
	ada.ok("GET", "/api/accounts", "", 403)
	bob.ok("PUT", "/api/accounts/"+adaGUID+"/role", `{"role":"admin"}`, 200)
	bob.ok("PUT", "/api/accounts/"+bobGUID+"/role", `{"role":"user"}`, 200)
	if raw := ada.ok("POST", "/api/accounts", `{"name":"Cy","email":"cy@example.org","password":"x","role":"admin"}`, 201); !strings.Contains(raw, `"role":"admin"`) {
		t.Fatalf("create admin %s", raw)
	}
	if raw := ada.ok("GET", "/api/accounts", "", 200); strings.Count(raw, `"role":"admin"`) != 2 || !strings.Contains(raw, `"unknownAdmins":[]`) {
		t.Fatalf("roles %s", raw)
	}

	// own name, email and password
	if raw := bob.ok("PATCH", "/api/me", `{"name":"Robert"}`, 200); !strings.Contains(raw, `"name":"Robert"`) || !strings.Contains(raw, "bob@example.org") {
		t.Fatalf("rename %s", raw)
	}
	bob.ok("PATCH", "/api/me", `{"email":"ada@example.org"}`, 409)
	bob.ok("PATCH", "/api/me", `{"name":""}`, 400)
	bob.ok("POST", "/api/me/password", `{"current":"nope","password":"pw3"}`, 400)
	bob.ok("POST", "/api/me/password", `{"current":"pw2","password":"pw3"}`, 200)
	bob.ok("GET", "/api/me", "", 200) // this session continues with a new token

	// a reset ends the account's sessions
	ada.ok("POST", "/api/accounts/"+bobGUID+"/password", `{"password":"pw4"}`, 204)
	bob.ok("GET", "/api/me", "", 401)
	bob.ok("POST", "/api/auth/login", `{"email":"bob@example.org","password":"pw4"}`, 200)

	// signing out ends the session
	ada.ok("POST", "/api/auth/logout", "", 204)
	ada.ok("GET", "/api/repository", "", 401)
	bob.ok("GET", "/api/repository", "", 200)
}

func TestAuthNone(t *testing.T) {
	a := newAPI(t)
	if r := a.ok("GET", "/api/auth", "", 200); r.body["mode"] != "none" {
		t.Fatalf("auth state %s", r.raw)
	}
	a.ok("GET", "/api/repository", "", 200)
	a.ok("POST", "/api/auth/login", `{"email":"a@b","password":"x"}`, 404)
	a.ok("GET", "/api/accounts", "", 404)
}
