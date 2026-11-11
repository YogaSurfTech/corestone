package foundation

import (
	"context"
	"errors"
	"fmt"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// Access reads the roles file (model.AccessPath) at head; a missing file
// lists no admins.
func (f *Foundation) Access(ctx context.Context) (*model.Access, error) {
	head, err := f.Repo.Head(ctx)
	if err != nil || head == "" {
		return &model.Access{Admins: []string{}}, err
	}
	data, _, err := f.Repo.ReadPath(ctx, head, model.AccessPath)
	if errors.Is(err, gitx.ErrNotFound) {
		return &model.Access{Admins: []string{}}, nil
	}
	if err != nil {
		return nil, err
	}
	return model.ParseAccess(data)
}

// SetAdmin adds an account to the admins of the roles file, or removes it,
// in one commit. label names the account in the commit message. Removing
// the last admin is refused.
func (f *Foundation) SetAdmin(ctx context.Context, guid, label string, admin bool) error {
	if !model.IsGUID(guid) {
		return model.Invalid("%q is no account id", guid)
	}
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		style := ojson.DefaultStyle
		doc := ojson.NewObject()
		old, _, err := t.f.Repo.ReadPath(t.ctx, t.head, model.AccessPath)
		switch {
		case err == nil:
			if _, err := model.ParseAccess(old); err != nil {
				return nil, err
			}
			if doc, err = ojson.ParseObject(old); err != nil {
				return nil, model.Invalid("access file: %v", err)
			}
			style = ojson.DetectStyle(old)
		case !errors.Is(err, gitx.ErrNotFound):
			return nil, err
		}
		admins := []any{}
		found := false
		for _, g := range doc.Array("admins") {
			if g == guid {
				found = true
				if !admin {
					continue
				}
			}
			admins = append(admins, g)
		}
		if found == admin {
			return &changeset{}, nil // nothing to change
		}
		if admin {
			admins = append(admins, guid)
		} else if len(admins) == 0 {
			return nil, fmt.Errorf("%w: %s is the last admin", model.ErrConflict, label)
		}
		doc.Set("admins", admins)
		verb := "is no longer admin"
		if admin {
			verb = "made admin"
		}
		cs := &changeset{subject: fmt.Sprintf("Account %s %s", label, verb)}
		cs.trailer("Corestone-Op", "access")
		cs.trailer("Corestone-Account", guid)
		cs.ops = []gitx.Op{{Path: model.AccessPath, Content: encode(doc, style)}}
		cs.event = Event{Op: "access", Subject: model.AccessPath}
		return cs, nil
	})
	return err
}
