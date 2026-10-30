package projection

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

func TestCommentExcerpts(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	a, c := model.NewGUID(), model.NewGUID()
	long := strings.Repeat("word ", 60)
	commit(t, repo, "entry and comment",
		gitx.Op{Path: a + "/.corestone.json", Content: entryJSON(a, "req", "A", "", "")},
		gitx.Op{Path: ".corestone/comments/" + c + ".json", Content: []byte(fmt.Sprintf(
			`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":"\n  First line  \nsecond line","author":"x"}`, c, a))})
	check := func(want string) {
		t.Helper()
		s, err := p.Get(ctx, c)
		if err != nil || s.Excerpt != want {
			t.Fatalf("comment excerpt = %q, %v; want %q", s.Excerpt, err, want)
		}
		rows, _, err := p.Search(ctx, Query{Kinds: []model.Kind{model.KindComment}, Subtree: true})
		if err != nil || len(rows) != 1 || rows[0].Excerpt != want {
			t.Fatalf("comment search = %+v, %v", rows, err)
		}
		if s, _ := p.Get(ctx, a); s.Excerpt != "" {
			t.Fatalf("entry excerpt = %q", s.Excerpt)
		}
	}
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	check("First line")
	// Simulate a projection from before the column existed.
	if _, err := p.sql.ExecContext(ctx, `ALTER TABLE artifacts DROP COLUMN excerpt`); err != nil {
		t.Fatal(err)
	}
	if err := p.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	check("First line")
	commit(t, repo, "edit comment", gitx.Op{Path: ".corestone/comments/" + c + ".json", Content: []byte(fmt.Sprintf(
		`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":%q,"author":"x"}`, c, a, long))})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	want := model.Excerpt(long)
	if r := []rune(want); len(r) != model.MaxExcerptRunes || r[len(r)-1] != '…' {
		t.Fatalf("long excerpt %q has %d runes", want, len(r))
	}
	check(want)
	if err := p.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	check(want)
}
