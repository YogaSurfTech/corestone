package foundation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

func TestSave(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	r1 := create(t, f, model.KindEntry, `{"path":"reqs","type":"requirement","title":"R1","fields":{"priority":"low"}}`)
	r2 := create(t, f, model.KindEntry, `{"path":"reqs","type":"requirement","title":"R2","fields":{"priority":"low"}}`)
	tc := create(t, f, model.KindEntry, `{"path":"tests","type":"testcase","title":"TC"}`)
	l1, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	cur, _ := f.Get(ctx, r1.Meta.GUID)

	// One save, every kind of change, one commit.
	head := mustHead(t, f)
	v, err := f.Save(ctx, r1.Meta.GUID, cur.ETag, &SaveRequest{
		Patch:       obj(t, `{"title":"R1 saved"}`),
		Transitions: []SaveTransition{{"status", "submit"}},
		RemoveLinks: []string{l1.Meta.GUID},
		AddLinks:    []*ojson.Object{obj(t, `{"type":"related","source":"`+r1.Meta.GUID+`","target":"`+r2.Meta.GUID+`"}`)},
		AddComments: []*ojson.Object{obj(t, `{"author":"ann","text":"looks good"}`)},
		PutFiles:    []SaveFile{{"notes.txt", []byte("hello")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	log, _ := f.History(ctx, r1.Meta.GUID, 0)
	if log[0].Parents[0] != head {
		t.Fatalf("save made more than one commit: %+v", log[0])
	}
	if want := "Entry REQ-1 modified; status: Send to review (open -> review), 1 link added, 1 link removed, 1 comment added, 1 attachment stored"; log[0].Subject != want {
		t.Fatalf("subject %q, want %q", log[0].Subject, want)
	}
	if v.Data.String("title") != "R1 saved" || stateOf(v) != "review" {
		t.Fatalf("saved view: %s", ojson.MustEncode(v.Data, ojson.DefaultStyle))
	}
	if _, err := f.DB.Locate(ctx, l1.Meta.GUID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("removed link still there: %v", err)
	}
	rel, _ := f.Relationships(ctx, r1.Meta.GUID)
	if len(rel.Outgoing) != 1 || rel.Outgoing[0].Other.GUID != r2.Meta.GUID || len(rel.Incoming) != 0 {
		t.Fatalf("relationships: %+v", rel)
	}
	if cs, _ := f.Comments(ctx, r1.Meta.GUID); len(cs) != 1 {
		t.Fatalf("comments: %d", len(cs))
	}
	if data, _, err := f.Attachment(ctx, r1.Meta.GUID, "notes.txt"); err != nil || string(data) != "hello" {
		t.Fatalf("attachment: %q %v", data, err)
	}

	// A single change keeps its own commit subject.
	if _, err := f.Save(ctx, r1.Meta.GUID, v.ETag, &SaveRequest{RemoveFiles: []string{"notes.txt"}}); err != nil {
		t.Fatal(err)
	}
	if log, _ := f.History(ctx, r1.Meta.GUID, 1); !strings.HasPrefix(log[0].Subject, "Attachment notes.txt of REQ-1 removed") {
		t.Fatalf("single change subject %q", log[0].Subject)
	}

	// All or nothing: a bad part leaves everything unwritten.
	cur, _ = f.Get(ctx, r1.Meta.GUID)
	head = mustHead(t, f)
	_, err = f.Save(ctx, r1.Meta.GUID, cur.ETag, &SaveRequest{
		Patch:       obj(t, `{"title":"never"}`),
		AddComments: []*ojson.Object{obj(t, `{"author":"ann","text":"never"}`)},
		Transitions: []SaveTransition{{"status", "nowhere"}},
	})
	if !errors.Is(err, model.ErrValidation) || mustHead(t, f) != head {
		t.Fatalf("failed save: %v, head moved %v", err, mustHead(t, f) != head)
	}

	// A stale ETag is a precondition failure.
	if _, err := f.Save(ctx, r1.Meta.GUID, "stale", &SaveRequest{Patch: obj(t, `{"title":"x"}`)}); !errors.Is(err, model.ErrPrecondition) {
		t.Fatalf("stale etag: %v", err)
	}

	// Only the artifact's own links and comments.
	other, _ := f.CreateLink(ctx, obj(t, `{"type":"related","source":"`+r2.Meta.GUID+`","target":"`+tc.Meta.GUID+`"}`))
	cur, _ = f.Get(ctx, r1.Meta.GUID)
	if _, err := f.Save(ctx, r1.Meta.GUID, cur.ETag, &SaveRequest{RemoveLinks: []string{other.Meta.GUID}}); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("foreign link removed: %v", err)
	}
	if _, err := f.Save(ctx, r1.Meta.GUID, cur.ETag, &SaveRequest{AddLinks: []*ojson.Object{obj(t, `{"type":"related","source":"`+r2.Meta.GUID+`","target":"`+tc.Meta.GUID+`"}`)}}); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("foreign link added: %v", err)
	}

	// Re-pointing a many-to-one link counts the removal made in the same save.
	l2, _ := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`"}`))
	tcv, _ := f.Get(ctx, tc.Meta.GUID)
	repoint := obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r2.Meta.GUID+`"}`)
	if _, err := f.Save(ctx, tc.Meta.GUID, tcv.ETag, &SaveRequest{AddLinks: []*ojson.Object{repoint}}); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("cardinality without removal: %v", err)
	}
	if _, err := f.Save(ctx, tc.Meta.GUID, tcv.ETag, &SaveRequest{RemoveLinks: []string{l2.Meta.GUID}, AddLinks: []*ojson.Object{repoint}}); err != nil {
		t.Fatalf("re-point: %v", err)
	}
	// Removing a link and adding the same one again is allowed, adding it twice is not.
	l3, _ := f.DB.FindLink(ctx, "verifies", tc.Meta.GUID, r2.Meta.GUID)
	if _, err := f.Save(ctx, tc.Meta.GUID, tcv.ETag, &SaveRequest{RemoveLinks: []string{l3}, AddLinks: []*ojson.Object{repoint}}); err != nil {
		t.Fatalf("re-add: %v", err)
	}
	dup := obj(t, `{"type":"related","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`"}`)
	if _, err := f.Save(ctx, tc.Meta.GUID, tcv.ETag, &SaveRequest{AddLinks: []*ojson.Object{dup, dup}}); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("duplicate in one save: %v", err)
	}

	// Nothing changed: no commit.
	head = mustHead(t, f)
	if _, err := f.Save(ctx, tc.Meta.GUID, "", &SaveRequest{Patch: obj(t, `{"title":"TC"}`)}); err != nil || mustHead(t, f) != head {
		t.Fatalf("empty save: %v", err)
	}
}

func TestSaveMerge(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	r := create(t, f, model.KindEntry, `{"path":"reqs","type":"requirement","title":"R","fields":{"priority":"low"}}`)
	tc := create(t, f, model.KindEntry, `{"path":"tests","type":"testcase","title":"TC"}`)
	l, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r.Meta.GUID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	base := r.ETag
	conflictOf := func(err error) *SaveConflict {
		t.Helper()
		var c *SaveConflict
		if !errors.As(err, &c) || !errors.Is(err, model.ErrPrecondition) {
			t.Fatalf("want a conflict, got %v", err)
		}
		return c
	}

	// Someone else prioritises and stores a file meanwhile.
	if _, err := f.UpdateArtifact(ctx, r.Meta.GUID, "", obj(t, `{"fields":{"priority":"high"}}`)); err != nil {
		t.Fatal(err)
	}
	if err := f.PutAttachment(ctx, r.Meta.GUID, "notes.txt", []byte("theirs")); err != nil {
		t.Fatal(err)
	}

	// Estimating from the old version merges silently and keeps their changes.
	v, err := f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"fields":{"effort":5}}`), PutFiles: []SaveFile{{"other.txt", []byte("mine")}}})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if fs := v.Data.Object("fields"); fs.String("priority") != "high" || func() bool { _, ok := fs.Get("effort"); return !ok }() {
		t.Fatalf("merged fields %s", ojson.MustEncode(fs, ojson.DefaultStyle))
	}
	if data, _, _ := f.Attachment(ctx, r.Meta.GUID, "notes.txt"); string(data) != "theirs" {
		t.Fatalf("their file %q", data)
	}
	// The same value as theirs loses nothing either.
	if _, err := f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"fields":{"priority":"high"}}`)}); err != nil {
		t.Fatalf("same value: %v", err)
	}

	// Changing what they changed is a conflict, named with their author and values.
	_, err = f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"title":"Mine","fields":{"priority":"low"}}`), PutFiles: []SaveFile{{"notes.txt", []byte("mine")}}})
	c := conflictOf(err)
	if len(c.Conflicts) != 2 || c.Conflicts[0].Key != "fields.priority" || c.Conflicts[1].Key != "files.notes.txt" {
		t.Fatalf("conflicts %+v", c.Conflicts)
	}
	p := c.Conflicts[0]
	if p.Base != "low" || p.Theirs != "high" || p.Mine != "low" || p.Author == "" || p.Time.IsZero() {
		t.Fatalf("priority conflict %+v", p)
	}
	// Nothing was written; overwriting exactly the version shown saves all of it.
	if cur, _ := f.Get(ctx, r.Meta.GUID); cur.Data.String("title") != "R" {
		t.Fatalf("conflicting save wrote %s", cur.Data.String("title"))
	}
	v, err = f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"title":"Mine","fields":{"priority":"low"}}`),
		PutFiles: []SaveFile{{"notes.txt", []byte("mine")}}, Overwrite: c.ETag})
	if err != nil || v.Data.String("title") != "Mine" || v.Data.Object("fields").String("priority") != "low" {
		t.Fatalf("overwrite: %v", err)
	}
	if data, _, _ := f.Attachment(ctx, r.Meta.GUID, "notes.txt"); string(data) != "mine" {
		t.Fatalf("overwritten file %q", data)
	}
	// An overwrite of an older conflict does not cover changes made after it.
	if _, err := f.UpdateArtifact(ctx, r.Meta.GUID, "", obj(t, `{"title":"Third"}`)); err != nil {
		t.Fatal(err)
	}
	_ = conflictOf(func() error {
		_, err := f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"title":"Mine again"}`), Overwrite: c.ETag})
		return err
	}())

	// Transitions overlap per workflow field.
	cur, _ := f.Get(ctx, r.Meta.GUID)
	if _, err := f.Transition(ctx, r.Meta.GUID, "status", "submit", ""); err != nil {
		t.Fatal(err)
	}
	_, err = f.Save(ctx, r.Meta.GUID, cur.ETag, &SaveRequest{Transitions: []SaveTransition{{"status", "submit"}}})
	if c := conflictOf(err); c.Conflicts[0].Key != "fields.status" || model.WorkflowStateOf(c.Conflicts[0].Theirs) != "review" || c.Conflicts[0].Mine != "submit" {
		t.Fatalf("transition conflict %+v", c.Conflicts)
	}

	// Removing a link someone changed since is a conflict; one deleted since is simply gone.
	cur, _ = f.Get(ctx, r.Meta.GUID)
	if _, err := f.UpdateArtifact(ctx, l.Meta.GUID, "", obj(t, `{"fields":{"coverage":"full"}}`)); err != nil {
		t.Fatal(err)
	}
	_, err = f.Save(ctx, r.Meta.GUID, cur.ETag, &SaveRequest{RemoveLinks: []string{l.Meta.GUID}, RemoveLinkETags: map[string]string{l.Meta.GUID: l.ETag}})
	if c := conflictOf(err); len(c.Conflicts) != 1 || c.Conflicts[0].Key != "links."+l.Meta.GUID || c.Conflicts[0].Author == "" {
		t.Fatalf("link conflict %+v", c.Conflicts)
	}
	if err := f.DeleteArtifact(ctx, l.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Save(ctx, r.Meta.GUID, cur.ETag, &SaveRequest{RemoveLinks: []string{l.Meta.GUID}, RemoveLinkETags: map[string]string{l.Meta.GUID: l.ETag}}); err != nil {
		t.Fatalf("link deleted meanwhile: %v", err)
	}

	// The artifact deleted meanwhile: nothing to merge into.
	if err := f.DeleteArtifact(ctx, r.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Save(ctx, r.Meta.GUID, base, &SaveRequest{Patch: obj(t, `{"title":"Late"}`)}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted meanwhile: %v", err)
	}
}
