package projection

import (
	"context"
	"fmt"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

func TestLinkCreationAuthors(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	a, b, link, comment := model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID()
	commit(t, repo, "entries",
		gitx.Op{Path: a + "/.corestone.json", Content: entryJSON(a, "req", "A", "", "")},
		gitx.Op{Path: b + "/.corestone.json", Content: entryJSON(b, "req", "B", "", "")})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	path := ".corestone/links/" + link + ".json"
	content := []byte(fmt.Sprintf(`{"guid":%q,"kind":"link","type":"related","source":%q,"target":%q}`, link, a, b))
	repo.Author = "Alice"
	commit(t, repo, "link and comment", gitx.Op{Path: path, Content: content},
		gitx.Op{Path: ".corestone/comments/" + comment + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":"Hi","author":"Explicit author"}`, comment, a))})
	check := func() {
		t.Helper()
		s, err := p.Get(ctx, link)
		if err != nil {
			t.Fatal(err)
		}
		if s.Author != "Alice" {
			t.Fatalf("link author = %q, want Alice", s.Author)
		}
		rows, _, err := p.Search(ctx, Query{Kinds: []model.Kind{model.KindLink}, Subtree: true})
		if err != nil || len(rows) != 1 || rows[0].Author != "Alice" {
			t.Fatalf("link search = %+v, %v", rows, err)
		}
		_, out, err := p.LinksOf(ctx, a)
		if err != nil || len(out) != 1 || out[0].Author != "Alice" {
			t.Fatalf("outgoing links = %+v, %v", out, err)
		}
		s, err = p.Get(ctx, comment)
		if err != nil || s.Author != "Explicit author" {
			t.Fatalf("comment author = %+v, %v", s, err)
		}
	}
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	check()
	repo.Author = "Bob"
	commit(t, repo, "edit link", gitx.Op{Path: path, Content: append(content, '\n')})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	check()
	commit(t, repo, "move link", gitx.Op{Path: path, Delete: true},
		gitx.Op{Path: "archive/" + path, Content: content})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	check()
	// Simulate an existing projection from before creator metadata existed.
	if _, err := p.sql.ExecContext(ctx, `ALTER TABLE artifacts DROP COLUMN created_author`); err != nil {
		t.Fatal(err)
	}
	if err := p.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	check()
	if err := p.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	check()
}
