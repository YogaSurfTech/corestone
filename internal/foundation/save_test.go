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
		Transitions: []SaveTransition{{"dev", "submit"}},
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
	if want := "Entry REQ-1 modified; dev open -> review, 1 link added, 1 link removed, 1 comment added, 1 attachment stored"; log[0].Subject != want {
		t.Fatalf("subject %q, want %q", log[0].Subject, want)
	}
	if v.Data.String("title") != "R1 saved" || v.Data.Object("workflows").String("dev") != "review" {
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
		Transitions: []SaveTransition{{"dev", "nowhere"}},
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
