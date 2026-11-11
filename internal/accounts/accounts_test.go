package accounts

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	_ "github.com/lib/pq"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/testutil"
)

func newStore(t *testing.T) (*Store, *sql.DB, string) {
	t.Helper()
	db, err := sql.Open("postgres", testutil.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	path := filepath.Join(t.TempDir(), "accounts.json")
	s, err := Open(context.Background(), db, path)
	if err != nil {
		t.Fatal(err)
	}
	s.Iterations = 1000
	return s, db, path
}

func add(t *testing.T, s *Store, name, email, pw string, first bool) (*Account, error) {
	t.Helper()
	r, err := s.NewRecord(name, email, pw)
	if err != nil {
		return nil, err
	}
	return s.Add(context.Background(), r, first)
}

func TestPasswordHash(t *testing.T) {
	h, err := hashPassword("secret", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$1000$") {
		t.Fatalf("hash %q", h)
	}
	if !verifyPassword("secret", h) || verifyPassword("Secret", h) || verifyPassword("secret", "garbage") {
		t.Fatal("verification is wrong")
	}
	if h2, _ := hashPassword("secret", 1000); h == h2 {
		t.Fatal("hashes are not salted")
	}
	if _, err := hashPassword("", 1000); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("empty password: %v", err)
	}
}

func TestAccounts(t *testing.T) {
	ctx := context.Background()
	s, db, path := newStore(t)

	if n, _ := s.Count(ctx); n != 0 {
		t.Fatalf("count %d", n)
	}
	ada, err := add(t, s, "Ada", "ada@example.org", "pw1", true)
	if err != nil || !model.IsGUID(ada.GUID) || ada.Role != RoleUser {
		t.Fatalf("first account %+v %v", ada, err)
	}
	if _, err := add(t, s, "Eve", "eve@example.org", "pw", true); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("second first account: %v", err)
	}
	bob, err := add(t, s, "Bob", "bob@example.org", "pw2", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := add(t, s, "Bob 2", "BOB@example.org", "pw", false); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("duplicate email (case-insensitive): %v", err)
	}
	for _, bad := range [][2]string{{"", "x@example.org"}, {"X", "no-at"}, {"X", "a b@example.org"}} {
		if _, err := add(t, s, bad[0], bad[1], "pw", false); !errors.Is(err, model.ErrValidation) {
			t.Fatalf("create %q %q: %v", bad[0], bad[1], err)
		}
	}

	// the file holds the accounts, hashed, readable by the owner only
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("file %v %v", st, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "bob@example.org") || strings.Contains(string(data), "pw2") {
		t.Fatalf("file content %s", data)
	}

	// sign in by email, case-insensitively; wrong passwords and unknown emails look alike
	a, token, err := s.SignIn(ctx, "Bob@Example.org", "pw2")
	if err != nil || a.GUID != bob.GUID || token == "" {
		t.Fatalf("sign in %+v %v", a, err)
	}
	if _, _, err := s.SignIn(ctx, "bob@example.org", "nope"); !errors.Is(err, ErrSignIn) {
		t.Fatalf("wrong password: %v", err)
	}
	if _, _, err := s.SignIn(ctx, "nobody@example.org", "pw2"); !errors.Is(err, ErrSignIn) {
		t.Fatalf("unknown email: %v", err)
	}
	if got, _ := s.Session(ctx, "forged"); got != nil {
		t.Fatal("forged token accepted")
	}

	// name and email change, also in the file; the session follows the account
	if u, err := s.Update(ctx, bob.GUID, "Robert", "robert@example.org"); err != nil || u.Name != "Robert" {
		t.Fatalf("update %+v %v", u, err)
	}
	if _, err := s.Update(ctx, bob.GUID, "Robert", "ada@example.org"); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("update to a taken email: %v", err)
	}
	if got, _ := s.Session(ctx, token); got == nil || got.Name != "Robert" {
		t.Fatalf("session after update %+v", got)
	}
	if recs, _ := (File{path}).Read(); len(recs) != 2 || recs[1].Email != "robert@example.org" {
		t.Fatalf("file after update %+v", recs)
	}

	// a new password ends the sessions
	if err := s.SetPassword(ctx, bob.GUID, "pw3"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, token); got != nil {
		t.Fatal("session survived a password reset")
	}
	if _, _, err := s.SignIn(ctx, "robert@example.org", "pw3"); err != nil {
		t.Fatalf("sign in with the new password: %v", err)
	}
	if err := s.SetPassword(ctx, model.NewGUID(), "x"); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}

	// signing out ends the session
	_, token, _ = s.SignIn(ctx, "ada@example.org", "pw1")
	if err := s.EndSession(ctx, token); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, token); got != nil {
		t.Fatal("session survived signing out")
	}

	// PostgreSQL is only a copy: a lost table is rebuilt from the file
	if _, err := db.Exec(`DELETE FROM accounts`); err != nil {
		t.Fatal(err)
	}
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if list, err := s.List(ctx); err != nil || len(list) != 2 {
		t.Fatalf("list after reload %v %v", list, err)
	}

	// an account added to the file by another process is picked up
	r, _ := NewRecord("Cy", "cy@example.org", "pw5", 1000)
	if err := (File{path}).Update(func(recs []Record) ([]Record, error) { return Add(recs, r) }); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.SignIn(ctx, "cy@example.org", "pw5"); err != nil {
		t.Fatalf("sign in after an outside change: %v", err)
	}

	// deleting removes the account from the file and ends its sessions
	cy, _, _ := s.SignIn(ctx, "cy@example.org", "pw5")
	_, cyToken, _ := s.SignIn(ctx, "cy@example.org", "pw5")
	if err := s.Delete(ctx, cy.GUID); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, cyToken); got != nil {
		t.Fatal("session survived deletion")
	}
	if err := s.Delete(ctx, cy.GUID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	if recs, _ := (File{path}).Read(); len(recs) != 2 {
		t.Fatalf("file after delete %+v", recs)
	}

	// a store opened on the same file and an empty database sees everything
	db2, _ := sql.Open("postgres", testutil.DSN(t))
	defer db2.Close()
	s2, err := Open(ctx, db2, path)
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := s2.Count(ctx); n != 2 {
		t.Fatalf("count in a fresh database %d", n)
	}
}

func TestFileConcurrentWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, _ := NewRecord("N", "n"+string(rune('a'+i))+"@example.org", "pw", 1000)
			if err := (File{path}).Update(func(recs []Record) ([]Record, error) { return Add(recs, r) }); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if recs, err := (File{path}).Read(); err != nil || len(recs) != 20 {
		t.Fatalf("%d accounts, %v", len(recs), err)
	}
}

func TestFileRejectsBrokenContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	for _, bad := range []string{
		`{"accounts":[{"guid":"x","name":"A","email":"a@b","password":"pbkdf2-sha256$1$a$b"}]}`,
		`{"accounts":[{"guid":"` + model.NewGUID() + `","name":"A","email":"a@b","password":"plain"}]}`,
		`{"users":[]}`,
		`not json`,
	} {
		os.WriteFile(path, []byte(bad), 0o600)
		if _, err := (File{path}).Read(); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
