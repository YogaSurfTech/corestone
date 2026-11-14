package foundation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

// TestVersions covers TSK-22: an artifact version is its content blob viewed
// at a commit, with what surrounded it then, also across moves, and the
// history list comes in pages that carry each entry's version.
func TestVersions(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)

	r := create(t, f, model.KindEntry, `{"path":"specs/boot","type":"requirement","title":"Boot fast","fields":{"priority":"high"}}`)
	v1 := r.ETag
	tc := create(t, f, model.KindEntry, `{"path":"tests","type":"testcase","title":"Cold boot"}`)
	if err := f.PutAttachment(ctx, r.Meta.GUID, "notes.txt", []byte("first")); err != nil {
		t.Fatal(err)
	}
	upd, err := f.UpdateArtifact(ctx, r.Meta.GUID, "", obj(t, `{"title":"Boot in 2 s"}`))
	if err != nil {
		t.Fatal(err)
	}
	v2 := upd.ETag
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r.Meta.GUID+`","fields":{"coverage":"full"}}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.CreateComment(ctx, obj(t, `{"subject":"`+r.Meta.GUID+`","text":"really?"}`)); err != nil {
		t.Fatal(err)
	}
	if err := f.PutAttachment(ctx, r.Meta.GUID, "notes.txt", []byte("second")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.MoveArtifact(ctx, r.Meta.GUID, "archive"); err != nil {
		t.Fatal(err)
	}
	ov := create(t, f, model.KindEntry, `{"path":"archive/variants","type":"requirement","title":"Variant","base":"`+r.Meta.GUID+`","fields":{"priority":"low"}}`)
	last, err := f.UpdateArtifact(ctx, r.Meta.GUID, "", obj(t, `{"title":"Boot in 1 s"}`))
	if err != nil {
		t.Fatal(err)
	}

	check := func(label string) {
		t.Helper()
		page, err := f.HistoryPage(ctx, r.Meta.GUID, 0, "")
		if err != nil {
			t.Fatal(err)
		}
		// create, attachment, update, link, comment, attachment, move, update
		// (the overlay's creation is its own history, not its base's)
		if len(page.History) != 8 || page.More {
			t.Fatalf("%s: history %d entries", label, len(page.History))
		}
		h := page.History
		if h[0].Blob != last.ETag || h[len(h)-1].Blob != v1 || h[len(h)-2].Blob != v1 || h[len(h)-3].Blob != v2 {
			t.Fatalf("%s: blobs %+v", label, h)
		}

		// Paging walks the same list in batches.
		var walked []HistoryEntry
		before := ""
		for {
			p, err := f.HistoryPage(ctx, r.Meta.GUID, 3, before)
			if err != nil {
				t.Fatal(err)
			}
			walked = append(walked, p.History...)
			if !p.More {
				break
			}
			before = p.History[len(p.History)-1].SHA
		}
		if len(walked) != len(h) || walked[3].SHA != h[3].SHA || walked[7].SHA != h[7].SHA {
			t.Fatalf("%s: paged %d entries", label, len(walked))
		}

		// v2 when it was written: no link, no comment yet.
		ver, err := f.Version(ctx, r.Meta.GUID, v2, h[5].SHA)
		if err != nil || !ver.Exact || len(ver.Relationships.Incoming) != 0 || len(ver.Comments) != 0 {
			t.Fatalf("%s: v2 when written %+v %v", label, ver, err)
		}
		// v2 at the link's creation (before the move): old path, the link
		// present, no comment yet, first attachment content.
		linkCommit := h[4]
		if linkCommit.Blob != v2 || linkCommit.Trailers["Corestone-Kind"] != "link" {
			t.Fatalf("%s: link commit %+v", label, linkCommit)
		}
		ver, err = f.Version(ctx, r.Meta.GUID, v2, linkCommit.SHA)
		if err != nil {
			t.Fatal(err)
		}
		if !ver.Exact || !ver.Exists || ver.Meta.Title != "Boot in 2 s" || ver.Meta.Folder != "specs/boot" || ver.Commit.SHA != linkCommit.SHA {
			t.Fatalf("%s: version %+v exact=%v", label, ver.Meta, ver.Exact)
		}
		if len(ver.Relationships.Incoming) != 1 || ver.Relationships.Incoming[0].Role != "verified by" || len(ver.Comments) != 0 {
			t.Fatalf("%s: surroundings %+v %+v", label, ver.Relationships, ver.Comments)
		}
		if len(ver.Attachments) != 1 || ver.Attachments[0].Name != "notes.txt" {
			t.Fatalf("%s: attachments %+v", label, ver.Attachments)
		}
		data, _, err := f.VersionFile(ctx, r.Meta.GUID, v2, linkCommit.SHA, "notes.txt")
		if err != nil || string(data) != "first" {
			t.Fatalf("%s: attachment then %q %v", label, data, err)
		}
		if len(ver.Workflows) != 1 || ver.Workflows[0].State != "open" || len(ver.Workflows[0].Available) != 0 || ver.Schema == nil {
			t.Fatalf("%s: workflows %+v", label, ver.Workflows)
		}

		// The same blob after the move: new path, comment, second attachment.
		moveCommit := h[1]
		ver, err = f.Version(ctx, r.Meta.GUID, v2, moveCommit.SHA)
		if err != nil || ver.Meta.Folder != "archive" || len(ver.Comments) != 1 {
			t.Fatalf("%s: after move %+v %v", label, ver, err)
		}
		if data, _, _ := f.VersionFile(ctx, r.Meta.GUID, v2, moveCommit.SHA, "notes.txt"); string(data) != "second" {
			t.Fatalf("%s: attachment after move %q", label, data)
		}

		// An unknown or unrelated commit falls back to the blob's first commit.
		for _, c := range []string{"", "0123456789abcdef0123456789abcdef01234567", h[0].SHA} {
			ver, err = f.Version(ctx, r.Meta.GUID, v2, c)
			if err != nil || ver.Exact || ver.Commit.SHA != h[len(h)-3].SHA {
				t.Fatalf("%s: fallback for %q: %+v %v", label, c, ver, err)
			}
		}

		// Only blobs of the artifact's own history are served.
		for _, b := range []string{tc.ETag, "0123456789abcdef0123456789abcdef01234567", "../x"} {
			if _, err := f.Version(ctx, r.Meta.GUID, b, ""); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("%s: foreign blob %s: %v", label, b, err)
			}
		}
		if _, _, err := f.VersionFile(ctx, r.Meta.GUID, v2, linkCommit.SHA, ".corestone.json"); err == nil {
			t.Fatalf("%s: reserved file served", label)
		}

		// The overlay as it was: its base resolved at that time.
		oh, err := f.HistoryPage(ctx, ov.Meta.GUID, 0, "")
		if err != nil || len(oh.History) != 1 {
			t.Fatalf("%s: overlay history %+v %v", label, oh, err)
		}
		ovv, err := f.Version(ctx, ov.Meta.GUID, oh.History[0].Blob, oh.History[0].SHA)
		if err != nil || ovv.Overlay == nil || len(ovv.Overlay.Chain) != 2 || ovv.BaseOverlay == nil || ovv.BaseOverlay.Fields.String("priority") != "high" {
			t.Fatalf("%s: overlay version %+v %v", label, ovv, err)
		}
	}
	check("maintained")
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	check("rebuilt")

	// A deleted artifact keeps its versions.
	if err := f.DeleteArtifact(ctx, tc.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}
	th, err := f.HistoryPage(ctx, tc.Meta.GUID, 0, "")
	if err != nil || len(th.History) < 2 || th.History[0].Blob != "" {
		t.Fatalf("deleted history %+v %v", th, err)
	}
	// Its link went with it: that deletion is in the other endpoint's history.
	rh, err := f.HistoryPage(ctx, r.Meta.GUID, 1, "")
	if err != nil || len(rh.History) != 1 || rh.History[0].SHA != th.History[0].SHA || rh.History[0].Blob != last.ETag {
		t.Fatalf("link deletion missing from the endpoint's history %+v %v", rh, err)
	}
	tv, err := f.Version(ctx, tc.Meta.GUID, tc.ETag, "")
	if err != nil || tv.Exists || tv.Meta.Title != "Cold boot" {
		t.Fatalf("deleted version %+v %v", tv, err)
	}
}

// TestVersionRelations covers links and comments over history: a version
// shows those of its time, also when deleted or reassigned since, with what
// they pointed to as it was then, and every artifact a link or comment ever
// pointed to keeps that change in its history.
func TestVersionRelations(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)

	a := create(t, f, model.KindEntry, `{"path":"specs/a","type":"requirement","title":"Alpha","fields":{"priority":"high"}}`)
	b := create(t, f, model.KindEntry, `{"path":"tests","type":"testcase","title":"Beta"}`)
	c := create(t, f, model.KindEntry, `{"path":"specs/c","type":"requirement","title":"Gamma","fields":{"priority":"low"}}`)
	l, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+b.Meta.GUID+`","target":"`+a.Meta.GUID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	cm, err := f.CreateComment(ctx, obj(t, `{"subject":"`+a.Meta.GUID+`","text":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	ua, err := f.UpdateArtifact(ctx, a.Meta.GUID, "", obj(t, `{"title":"Alpha 2"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.UpdateArtifact(ctx, b.Meta.GUID, "", obj(t, `{"title":"Beta 2"}`)); err != nil {
		t.Fatal(err)
	}
	// An external push points the link at c instead of a.
	head := mustHead(t, f)
	raw, _, err := f.Repo.ReadPath(ctx, head, l.Meta.Path)
	if err != nil {
		t.Fatal(err)
	}
	moved := strings.Replace(string(raw), a.Meta.GUID, c.Meta.GUID, 1)
	commit, err := f.Repo.BuildCommit(ctx, head, "reassign", []gitx.Op{{Path: l.Meta.Path, Content: []byte(moved)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Repo.Publish(ctx, head, commit); err != nil {
		t.Fatal(err)
	}
	if err := f.DeleteArtifact(ctx, cm.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}

	check := func(label string) {
		t.Helper()
		page, err := f.HistoryPage(ctx, a.Meta.GUID, 0, "")
		if err != nil {
			t.Fatal(err)
		}
		// create, link, comment, update, reassignment away, comment deletion
		h := page.History
		if len(h) != 6 || h[0].Blob != ua.ETag || h[1].Subject != "reassign" || h[2].Blob != ua.ETag || h[3].Blob != a.ETag {
			t.Fatalf("%s: history of a %+v", label, h)
		}
		// When updated: the link and the comment, the other endpoint as it was.
		ver, err := f.Version(ctx, a.Meta.GUID, ua.ETag, h[2].SHA)
		if err != nil {
			t.Fatal(err)
		}
		if len(ver.Relationships.Incoming) != 1 || ver.Relationships.Incoming[0].Other.Title != "Beta" ||
			ver.Relationships.Incoming[0].Other.ETag != b.ETag || ver.Relationships.Incoming[0].Role != "verified by" {
			t.Fatalf("%s: links then %+v", label, ver.Relationships.Incoming)
		}
		if len(ver.Comments) != 1 || ver.Comments[0].Meta.GUID != cm.Meta.GUID {
			t.Fatalf("%s: comments then %+v", label, ver.Comments)
		}
		// Today: neither.
		ver, err = f.Version(ctx, a.Meta.GUID, ua.ETag, h[0].SHA)
		if err != nil || len(ver.Relationships.Incoming) != 0 || len(ver.Comments) != 0 {
			t.Fatalf("%s: surroundings now %+v %+v %v", label, ver.Relationships, ver.Comments, err)
		}

		// What each commit changed: the title, a link or comment added or removed, the creation.
		if ver.Change.RemovedComments != 1 || ver.Change.RemovedLinks != 0 || len(ver.Change.Changed) != 0 {
			t.Fatalf("%s: comment deletion %+v", label, ver.Change)
		}
		changes := map[int]func(c *VersionChange) bool{
			1: func(c *VersionChange) bool { return c.RemovedLinks == 1 && c.RemovedComments == 0 },
			2: func(c *VersionChange) bool {
				return len(c.Changed) == 1 && c.Changed[0] == "title" && len(c.Added) == 0 && !c.Created
			},
			3: func(c *VersionChange) bool {
				return len(c.Added) == 1 && c.Added[0] == cm.Meta.GUID && len(c.Changed) == 0
			},
			4: func(c *VersionChange) bool { return len(c.Added) == 1 && c.Added[0] == l.Meta.GUID },
			5: func(c *VersionChange) bool { return c.Created },
		}
		for i, ok := range changes {
			cv, err := f.Version(ctx, a.Meta.GUID, h[i].Blob, h[i].SHA)
			if err != nil || !ok(cv.Change) {
				t.Fatalf("%s: change of history entry %d %+v %v", label, i, cv.Change, err)
			}
		}

		// The new endpoint has the reassignment in its history and the link from then on.
		ch, err := f.HistoryPage(ctx, c.Meta.GUID, 0, "")
		if err != nil || len(ch.History) != 2 || ch.History[0].Subject != "reassign" {
			t.Fatalf("%s: history of c %+v %v", label, ch, err)
		}
		cv, err := f.Version(ctx, c.Meta.GUID, c.ETag, ch.History[0].SHA)
		if err != nil || len(cv.Relationships.Incoming) != 1 || cv.Relationships.Incoming[0].Other.Title != "Beta 2" {
			t.Fatalf("%s: c after reassignment %+v %v", label, cv, err)
		}
		if cv, err = f.Version(ctx, c.Meta.GUID, c.ETag, ch.History[1].SHA); err != nil || len(cv.Relationships.Incoming) != 0 {
			t.Fatalf("%s: c before reassignment %+v %v", label, cv, err)
		}

		// The link's version names its endpoints as they were.
		lv, err := f.Version(ctx, l.Meta.GUID, l.ETag, "")
		if err != nil || lv.Endpoints == nil || lv.Endpoints.Source.Title != "Beta" || lv.Endpoints.Target.Title != "Alpha" {
			t.Fatalf("%s: link version %+v %v", label, lv, err)
		}
		// The deleted comment's version: its subject then and its thread.
		cmv, err := f.Version(ctx, cm.Meta.GUID, cm.ETag, "")
		if err != nil || cmv.Exists || cmv.Subject == nil || cmv.Subject.Meta.Title != "Alpha" || len(cmv.Comments) != 1 {
			t.Fatalf("%s: comment version %+v %v", label, cmv, err)
		}
	}
	check("maintained")
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	check("rebuilt")
}
