package foundation

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// SaveRequest is everything the detail form of one artifact changed, to be
// published as one commit.
type SaveRequest struct {
	Patch       *ojson.Object
	Transitions []SaveTransition
	AddLinks    []*ojson.Object
	RemoveLinks []string
	AddComments []*ojson.Object
	PutFiles    []SaveFile
	RemoveFiles []string
	// RemoveLinkETags holds the version of each removed link the user saw;
	// a link changed since conflicts.
	RemoveLinkETags map[string]string
	// Overwrite is the ETag of a SaveConflict the user chose to overwrite.
	Overwrite string
}

type SaveTransition struct{ Workflow, To string }

type SaveFile struct {
	Name    string
	Content []byte
}

// Save applies a SaveRequest to an artifact in one commit: either every
// change is published or none is. ifMatch is the version the user started
// from; changes made since are kept unless they overlap with the user's
// (see merge).
func (f *Foundation) Save(ctx context.Context, guid, ifMatch string, req *SaveRequest) (*View, error) {
	if _, err := f.write(ctx, false, func(t *txn) (*changeset, error) { return t.save(guid, ifMatch, req) }); err != nil {
		return nil, err
	}
	return f.Get(ctx, guid)
}

func (t *txn) save(guid, ifMatch string, req *SaveRequest) (*changeset, error) {
	cur, err := t.load(guid)
	if err != nil {
		return nil, err
	}
	// Changes made by others since the user's version stay; only overlaps
	// are refused, unless the user saw them and chose to overwrite.
	var conflicts []ConflictItem
	if ifMatch != "" && ifMatch != "*" && ifMatch != cur.ETag {
		if conflicts, err = t.merge(guid, ifMatch, cur, req); err != nil {
			return nil, err
		}
	}
	// The links to remove, as they are now; one deleted meanwhile is gone
	// already, one changed since the user saw it overlaps.
	var links []string
	for _, lg := range req.RemoveLinks {
		l, err := t.load(lg)
		if errors.Is(err, model.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if l.Kind != model.KindLink || (l.Source != guid && l.Target != guid) {
			return nil, model.Invalid("%s is not a link of %s", lg, label(cur.Artifact))
		}
		if c, err := t.linkConflict(l, req.RemoveLinkETags[lg]); err != nil {
			return nil, err
		} else if c != nil {
			conflicts = append(conflicts, *c)
		}
		links = append(links, lg)
	}
	if len(conflicts) > 0 && req.Overwrite != cur.ETag {
		sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Key < conflicts[j].Key })
		return nil, &SaveConflict{ETag: cur.ETag, Conflicts: conflicts}
	}
	// Comments on a comment are replies in its subject's thread.
	subject := guid
	if cur.Kind == model.KindComment {
		subject = cur.Subject
	}
	var parts []*changeset
	step := func(cs *changeset, err error) error {
		if err != nil {
			return err
		}
		if len(cs.ops) == 0 {
			return nil
		}
		t.put(cs)
		parts = append(parts, cs)
		return nil
	}

	if req.Patch != nil && req.Patch.Len() > 0 {
		if err := step(t.update(guid, "", req.Patch)); err != nil {
			return nil, err
		}
	}
	for _, tr := range req.Transitions {
		if err := step(t.transition(guid, tr.Workflow, tr.To, "")); err != nil {
			return nil, err
		}
	}
	for _, lg := range links {
		if err := step(t.remove(lg, "")); err != nil {
			return nil, err
		}
	}
	for _, l := range req.AddLinks {
		if l.String("source") != guid && l.String("target") != guid {
			return nil, model.Invalid("a link added to %s must start or end there", label(cur.Artifact))
		}
		if err := step(t.createLink(l)); err != nil {
			return nil, err
		}
	}
	for _, c := range req.AddComments {
		c = c.Clone()
		if s := c.String("subject"); s != "" && s != subject {
			return nil, model.Invalid("a comment added to %s must be about it", label(cur.Artifact))
		}
		c.Set("subject", subject)
		if err := step(t.createComment(c)); err != nil {
			return nil, err
		}
	}
	for _, name := range req.RemoveFiles {
		if err := step(t.deleteFile(guid, name)); err != nil {
			return nil, err
		}
	}
	for _, fl := range req.PutFiles {
		if err := step(t.putFile(guid, fl.Name, fl.Content)); err != nil {
			return nil, err
		}
	}
	return combine(cur, parts)
}

// combine merges the changesets of a save into one commit. A single change
// keeps its own subject and trailers, so history reads as before.
func combine(cur *loaded, parts []*changeset) (*changeset, error) {
	if len(parts) == 0 {
		return &changeset{}, nil
	}
	if len(parts) == 1 {
		return parts[0], nil
	}
	cs := &changeset{}
	byPath := map[string]int{}
	var kinds []string
	seen := map[string]bool{}
	for _, p := range parts {
		for _, op := range p.ops {
			if i, ok := byPath[op.Path]; ok {
				cs.ops[i] = op
				continue
			}
			byPath[op.Path] = len(cs.ops)
			cs.ops = append(cs.ops, op)
		}
		if !seen[p.event.Op] {
			seen[p.event.Op] = true
			kinds = append(kinds, p.event.Op)
		}
		if p.event.Op == "update" {
			cs.subject = p.subject
		}
	}
	n := map[string]int{}
	var what []string
	for _, p := range parts {
		switch {
		case p.event.Op == "transition":
			what = append(what, p.note)
		case p.event.Op == "create":
			n[p.event.Kind+" added"]++
		case p.event.Op == "delete":
			n["link removed"]++
		case p.event.Op == "attachment" && p.ops[0].Delete:
			n["attachment removed"]++
		case p.event.Op == "attachment":
			n["attachment stored"]++
		}
	}
	for _, k := range []string{"link added", "link removed", "comment added", "attachment stored", "attachment removed"} {
		if n[k] == 1 {
			what = append(what, "1 "+k)
		} else if n[k] > 1 {
			w := strings.SplitN(k, " ", 2)
			what = append(what, fmt.Sprintf("%d %ss %s", n[k], w[0], w[1]))
		}
	}
	if cs.subject == "" {
		cs.subject = fmt.Sprintf("%s %s modified", kindName(cur.Kind), label(cur.Artifact))
	}
	if len(what) > 0 {
		cs.subject += "; " + strings.Join(what, ", ")
	}
	cs.trailer("Corestone-Op", "update")
	cs.trailer("Corestone-Guid", cur.GUID)
	cs.trailer("Corestone-Changes", strings.Join(kinds, ","))
	cs.event = Event{Op: "update", GUID: cur.GUID, Kind: string(cur.Kind), Subject: cur.Subject}
	return cs, nil
}
