package httpapi

import (
	"context"
	"errors"
	"log"
	"sync"

	"github.com/thomdehoog/corestone/internal/accounts"
	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/model"
)

// roles caches the repository's access file (model.AccessPath), which lists
// the admins. Every published commit may have changed it, so each one drops
// the cache; the next request reads the file at head again.
type roles struct {
	f      *foundation.Foundation
	mu     sync.Mutex
	access *model.Access
	gen    int // counts invalidations, so a read racing a commit is not cached
}

func newRoles(f *foundation.Foundation) *roles {
	r := &roles{f: f}
	f.Subscribe(func(e foundation.Event) {
		if e.Type == "commit" {
			r.mu.Lock()
			r.access = nil
			r.gen++
			r.mu.Unlock()
		}
	})
	return r
}

func (r *roles) get(ctx context.Context) (*model.Access, error) {
	r.mu.Lock()
	a, gen := r.access, r.gen
	r.mu.Unlock()
	if a != nil {
		return a, nil
	}
	a, err := r.f.Access(ctx)
	if errors.Is(err, model.ErrValidation) {
		// A broken file (pushed directly) grants nobody admin, but must not
		// lock everyone out; validation reports it as invalid configuration.
		log.Printf("httpapi: %v", err)
		a, err = &model.Access{Admins: []string{}}, nil
	}
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	if r.gen == gen {
		r.access = a
	}
	r.mu.Unlock()
	return a, nil
}

// of returns an account's role.
func (r *roles) of(ctx context.Context, guid string) (accounts.Role, error) {
	a, err := r.get(ctx)
	if err != nil {
		return "", err
	}
	if a.IsAdmin(guid) {
		return accounts.RoleAdmin, nil
	}
	return accounts.RoleUser, nil
}
