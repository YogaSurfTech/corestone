package accounts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/model"
)

// Record is one account as stored in the accounts file: everything needed to
// sign in. Roles are not here but in the repository (model.AccessPath).
type Record struct {
	GUID     string    `json:"guid"`
	Name     string    `json:"name"`
	Email    string    `json:"email"`
	Password string    `json:"password"` // "pbkdf2-sha256$<iterations>$<salt>$<key>"
	Created  time.Time `json:"created"`
}

// fileDoc is the accounts file: {"accounts": [...]}.
type fileDoc struct {
	Accounts []Record `json:"accounts"`
}

// File is the accounts file next to the repository, the source of truth for
// accounts; PostgreSQL holds a copy. Changes take an exclusive lock (a
// separate .lock file) and replace the file atomically, so the server and
// the `corestone account` command can both write it.
type File struct{ Path string }

// Read returns the accounts; a missing file has none.
func (f File) Read() ([]Record, error) {
	data, err := os.ReadFile(f.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return []Record{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parseFile(data, f.Path)
}

func parseFile(data []byte, name string) ([]Record, error) {
	var doc fileDoc
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("accounts file %s: %w", name, err)
	}
	if doc.Accounts == nil {
		doc.Accounts = []Record{}
	}
	guids, emails := map[string]bool{}, map[string]bool{}
	for _, r := range doc.Accounts {
		if !model.IsGUID(r.GUID) || guids[r.GUID] {
			return nil, fmt.Errorf("accounts file %s: account id %q is invalid or repeated", name, r.GUID)
		}
		if _, _, err := clean(r.Name, r.Email); err != nil {
			return nil, fmt.Errorf("accounts file %s: account %s: %w", name, r.GUID, err)
		}
		if emails[strings.ToLower(r.Email)] {
			return nil, fmt.Errorf("accounts file %s: email %s is used twice", name, r.Email)
		}
		if !strings.HasPrefix(r.Password, "pbkdf2-sha256$") {
			return nil, fmt.Errorf("accounts file %s: account %s has no password hash", name, r.GUID)
		}
		guids[r.GUID], emails[strings.ToLower(r.Email)] = true, true
	}
	return doc.Accounts, nil
}

// Update changes the accounts under the lock: fn gets the current accounts
// and returns the new ones (or an error, which leaves the file unchanged).
func (f File) Update(fn func([]Record) ([]Record, error)) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	unlock, err := lockFile(f.Path + ".lock")
	if err != nil {
		return fmt.Errorf("lock accounts file: %w", err)
	}
	defer unlock()
	recs, err := f.Read()
	if err != nil {
		return err
	}
	if recs, err = fn(recs); err != nil {
		return err
	}
	data, err := json.MarshalIndent(fileDoc{Accounts: recs}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.Path), filepath.Base(f.Path)+".tmp*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // after the rename, there is nothing left to remove
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), f.Path)
}

// Add appends a record, refusing a second account with the same email.
func Add(recs []Record, r Record) ([]Record, error) {
	for _, o := range recs {
		if strings.EqualFold(o.Email, r.Email) {
			return nil, fmt.Errorf("%w: an account with this email exists already", model.ErrConflict)
		}
	}
	return append(recs, r), nil
}

// NewRecord validates a new account and hashes its password with the given
// number of PBKDF2 iterations (0: Iterations).
func NewRecord(name, email, password string, iterations int) (Record, error) {
	name, email, err := clean(name, email)
	if err != nil {
		return Record{}, err
	}
	hash, err := hashPassword(password, iterations)
	if err != nil {
		return Record{}, err
	}
	return Record{GUID: model.NewGUID(), Name: name, Email: email, Password: hash, Created: time.Now().UTC().Truncate(time.Second)}, nil
}
