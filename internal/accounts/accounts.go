// Package accounts holds Corestone's local accounts and sign-in sessions.
//
// The accounts file next to the repository (File) is the source of truth:
// GUID, visible name, email and password hash of every account. PostgreSQL
// holds a copy for lookups, refreshed on start, on a reindex, after every
// change and whenever the file changed on disk (`corestone account add`).
// Roles are not stored here: the repository's access file lists the admins
// (model.AccessPath). Sessions are random tokens of which only a hash is
// stored, in PostgreSQL only: losing them just means signing in again.
package accounts

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thomdehoog/corestone/internal/model"
)

// Role of an account. Admins can also manage accounts and reset passwords;
// otherwise all accounts are equal.
type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

// Account is one local account; the password hash never leaves the package.
// Role is filled in from the repository's access file by the caller.
type Account struct {
	GUID    string    `json:"guid"`
	Name    string    `json:"name"`
	Email   string    `json:"email"`
	Role    Role      `json:"role"`
	Created time.Time `json:"created"`
}

// IsAdmin reports whether the account has the admin role.
func (a *Account) IsAdmin() bool { return a != nil && a.Role == RoleAdmin }

// ErrSignIn is returned for an unknown email or a wrong password alike.
var ErrSignIn = errors.New("accounts: wrong email or password")

// SessionTTL is how long a sign-in lasts.
const SessionTTL = 30 * 24 * time.Hour

// Iterations of PBKDF2-SHA256 for new password hashes; stored with each hash,
// so it can change without invalidating existing passwords.
const Iterations = 600_000

// Store is the accounts file, its PostgreSQL copy and the sessions.
type Store struct {
	db   *sql.DB
	file File
	// Iterations for new password hashes (0: the default); tests lower it.
	Iterations int

	mu     sync.Mutex
	loaded fileStamp // the file state last copied to PostgreSQL
}

type fileStamp struct {
	mod  time.Time
	size int64
	ok   bool
}

func stamp(path string) fileStamp {
	st, err := os.Stat(path)
	if err != nil {
		return fileStamp{ok: true} // missing: no accounts
	}
	return fileStamp{mod: st.ModTime(), size: st.Size(), ok: true}
}

var ddl = []string{
	`CREATE TABLE IF NOT EXISTS accounts (
		guid text PRIMARY KEY,
		name text NOT NULL,
		email text NOT NULL,
		password text NOT NULL,
		created timestamptz NOT NULL DEFAULT now())`,
	`ALTER TABLE accounts DROP COLUMN IF EXISTS role`,
	`ALTER TABLE accounts DROP COLUMN IF EXISTS updated`,
	`CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts (lower(email))`,
	`CREATE TABLE IF NOT EXISTS sessions (
		token text PRIMARY KEY,
		account text NOT NULL REFERENCES accounts(guid) ON DELETE CASCADE,
		created timestamptz NOT NULL DEFAULT now(),
		expires timestamptz NOT NULL)`,
}

// Open creates the tables when they do not exist and copies the accounts
// file at path into them.
func Open(ctx context.Context, db *sql.DB, path string) (*Store, error) {
	for _, q := range ddl {
		if _, err := db.ExecContext(ctx, q); err != nil {
			return nil, fmt.Errorf("accounts schema: %w", err)
		}
	}
	s := &Store{db: db, file: File{Path: path}}
	if err := s.Load(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Path is the accounts file.
func (s *Store) Path() string { return s.file.Path }

// Load copies the accounts file into PostgreSQL: accounts missing from the
// file are removed (with their sessions), the others inserted or updated.
func (s *Store) Load(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load(ctx)
}

func (s *Store) load(ctx context.Context) error {
	st := stamp(s.file.Path)
	recs, err := s.file.Read()
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	guids := make([]string, len(recs))
	for i, r := range recs {
		guids[i] = r.GUID
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE NOT (guid = ANY($1))`, pqArray(guids)); err != nil {
		return err
	}
	// Emails may move between accounts: clear them first so the unique index holds.
	if _, err := tx.ExecContext(ctx, `UPDATE accounts SET email = guid`); err != nil {
		return err
	}
	for _, r := range recs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO accounts (guid, name, email, password, created) VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (guid) DO UPDATE SET name = $2, email = $3, password = $4, created = $5`,
			r.GUID, r.Name, r.Email, r.Password, r.Created); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.loaded = st
	return nil
}

// refresh reloads the copy when the file changed on disk since the last load.
func (s *Store) refresh(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := stamp(s.file.Path); s.loaded.ok && st == s.loaded {
		return nil
	}
	return s.load(ctx)
}

// change updates the file under its lock and copies the result to PostgreSQL.
func (s *Store) change(ctx context.Context, fn func([]Record) ([]Record, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.file.Update(fn); err != nil {
		return err
	}
	return s.load(ctx)
}

// Count is the number of accounts; zero means the first account is still to be created.
func (s *Store) Count(ctx context.Context) (int, error) {
	if err := s.refresh(ctx); err != nil {
		return 0, err
	}
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM accounts`).Scan(&n)
	return n, err
}

// NewRecord validates a new account and hashes its password.
func (s *Store) NewRecord(name, email, password string) (Record, error) {
	return NewRecord(name, email, password, s.Iterations)
}

// Add stores a new account. With first, it fails once any account exists
// (creating the first account on a new server).
func (s *Store) Add(ctx context.Context, r Record, first bool) (*Account, error) {
	err := s.change(ctx, func(recs []Record) ([]Record, error) {
		if first && len(recs) > 0 {
			return nil, fmt.Errorf("%w: the first account exists already", model.ErrConflict)
		}
		return Add(recs, r)
	})
	if err != nil {
		return nil, err
	}
	return s.Get(ctx, r.GUID)
}

// Get returns an account by GUID.
func (s *Store) Get(ctx context.Context, guid string) (*Account, error) {
	return s.one(ctx, `WHERE guid = $1`, guid)
}

// List returns all accounts by name.
func (s *Store) List(ctx context.Context) ([]*Account, error) {
	if err := s.refresh(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT guid, name, email, created FROM accounts ORDER BY lower(name), lower(email)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Account{}
	for rows.Next() {
		a := &Account{Role: RoleUser}
		if err := rows.Scan(&a.GUID, &a.Name, &a.Email, &a.Created); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// edit changes one record of the file.
func (s *Store) edit(ctx context.Context, guid string, fn func(*Record, []Record) error) error {
	return s.change(ctx, func(recs []Record) ([]Record, error) {
		for i := range recs {
			if recs[i].GUID == guid {
				if err := fn(&recs[i], recs); err != nil {
					return nil, err
				}
				return recs, nil
			}
		}
		return nil, model.ErrNotFound
	})
}

// Update changes the visible name and email of an account.
func (s *Store) Update(ctx context.Context, guid, name, email string) (*Account, error) {
	name, email, err := clean(name, email)
	if err != nil {
		return nil, err
	}
	err = s.edit(ctx, guid, func(r *Record, all []Record) error {
		for _, o := range all {
			if o.GUID != guid && strings.EqualFold(o.Email, email) {
				return fmt.Errorf("%w: an account with this email exists already", model.ErrConflict)
			}
		}
		r.Name, r.Email = name, email
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.Get(ctx, guid)
}

// SetPassword replaces an account's password and ends its sessions.
func (s *Store) SetPassword(ctx context.Context, guid, password string) error {
	hash, err := hashPassword(password, s.Iterations)
	if err != nil {
		return err
	}
	if err := s.edit(ctx, guid, func(r *Record, _ []Record) error { r.Password = hash; return nil }); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE account = $1`, guid)
	return err
}

// Delete removes an account from the file; its sessions end with it.
func (s *Store) Delete(ctx context.Context, guid string) error {
	return s.change(ctx, func(recs []Record) ([]Record, error) {
		for i, r := range recs {
			if r.GUID == guid {
				return append(recs[:i:i], recs[i+1:]...), nil
			}
		}
		return nil, model.ErrNotFound
	})
}

// CheckPassword reports whether password is the account's password.
func (s *Store) CheckPassword(ctx context.Context, guid, password string) (bool, error) {
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT password FROM accounts WHERE guid = $1`, guid).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return false, model.ErrNotFound
	}
	if err != nil {
		return false, err
	}
	return verifyPassword(password, hash), nil
}

// SignIn checks an email and password and starts a session. It returns the
// account and the session token for the cookie.
func (s *Store) SignIn(ctx context.Context, email, password string) (*Account, string, error) {
	if err := s.refresh(ctx); err != nil {
		return nil, "", err
	}
	var guid, hash string
	err := s.db.QueryRowContext(ctx, `SELECT guid, password FROM accounts WHERE lower(email) = lower($1)`, strings.TrimSpace(email)).Scan(&guid, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrSignIn
	}
	if err != nil {
		return nil, "", err
	}
	if !verifyPassword(password, hash) {
		return nil, "", ErrSignIn
	}
	token, err := s.NewSession(ctx, guid)
	if err != nil {
		return nil, "", err
	}
	a, err := s.Get(ctx, guid)
	return a, token, err
}

// NewSession starts a session for an account and returns its token.
func (s *Store) NewSession(ctx context.Context, guid string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions (token, account, expires) VALUES ($1, $2, $3)`,
		tokenHash(token), guid, time.Now().Add(SessionTTL))
	return token, err
}

// Session returns the account of a valid session token, or nil.
func (s *Store) Session(ctx context.Context, token string) (*Account, error) {
	if token == "" {
		return nil, nil
	}
	a, err := s.one(ctx, `JOIN sessions s ON s.account = a.guid WHERE s.token = $1 AND s.expires > now()`, tokenHash(token))
	if errors.Is(err, model.ErrNotFound) {
		return nil, nil
	}
	return a, err
}

// EndSession signs a session out.
func (s *Store) EndSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = $1 OR expires < now()`, tokenHash(token))
	return err
}

func (s *Store) one(ctx context.Context, where string, arg any) (*Account, error) {
	a := &Account{Role: RoleUser}
	err := s.db.QueryRowContext(ctx, `SELECT a.guid, a.name, a.email, a.created FROM accounts a `+where, arg).
		Scan(&a.GUID, &a.Name, &a.Email, &a.Created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

func clean(name, email string) (string, string, error) {
	name, email = strings.TrimSpace(name), strings.TrimSpace(email)
	if name == "" || len(name) > 100 {
		return "", "", model.Invalid("the name must have 1 to 100 characters")
	}
	if len(email) > 200 || !strings.Contains(email, "@") || strings.ContainsAny(email, " <>") {
		return "", "", model.Invalid("%q is no email address", email)
	}
	return name, email, nil
}

// pqArray formats a text[] parameter.
func pqArray(ss []string) string {
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = `"` + s + `"` // GUIDs: no quotes or backslashes to escape
	}
	return "{" + strings.Join(q, ",") + "}"
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// hashPassword stores "pbkdf2-sha256$<iterations>$<salt>$<key>".
func hashPassword(password string, iterations int) (string, error) {
	if iterations <= 0 {
		iterations = Iterations
	}
	if password == "" {
		return "", model.Invalid("the password must not be empty")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iterations, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[2])
	want, err2 := enc.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

type ctxKey struct{}

// WithAccount returns a context carrying the signed-in account.
func WithAccount(ctx context.Context, a *Account) context.Context {
	return context.WithValue(ctx, ctxKey{}, a)
}

// FromContext returns the signed-in account, or nil.
func FromContext(ctx context.Context) *Account {
	a, _ := ctx.Value(ctxKey{}).(*Account)
	return a
}
