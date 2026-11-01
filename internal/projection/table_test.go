package projection

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

func TestTableQueryOrder(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	e1, e2, e3, e4, e5, e6 := model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID()
	l1, l2, c1, c2 := model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID()
	name := map[string]string{e1: "e1", e2: "e2", e3: "e3", e4: "e4", e5: "e5", e6: "e6", l1: "l1", l2: "l2", c1: "c1", c2: "c2"}
	entry := func(dir, guid, typ, title, hid, extra string) gitx.Op {
		return gitx.Op{Path: dir + "/" + guid + "/.corestone.json", Content: entryJSON(guid, typ, title, hid, extra)}
	}
	commit(t, repo, "config",
		gitx.Op{Path: ".corestone/config/entries/types.json", Content: []byte(`{"types":[
			{"id":"req","displayName":"Requirement","fields":["prio","tags","n","stage"],"workflows":["dev"]},
			{"id":"zz","displayName":"Alpha"}]}`)},
		gitx.Op{Path: ".corestone/config/entries/fields.json", Content: []byte(`{"fields":[
			{"id":"prio","type":"enum","options":[{"value":"low"},{"value":"medium"},{"value":"high"}]},
			{"id":"tags","type":"enum","multiple":true,"options":[{"value":"a"},{"value":"b"},{"value":"c"}]},
			{"id":"n","type":"integer"},
			{"id":"stage","type":"workflow","workflow":"dev"}]}`)},
		gitx.Op{Path: ".corestone/config/entries/workflows/dev-workflow.json", Content: []byte(`{"states":["open","review","done"],"transitions":[{"from":"open","to":"review"}]}`)},
		gitx.Op{Path: ".corestone/config/links/types.json", Content: []byte(`{"types":[{"id":"refines","displayName":"Refines"}]}`)},
		gitx.Op{Path: ".corestone/config/comments/types.json", Content: []byte(`{"types":[{"id":"comment"}]}`)})
	commit(t, repo, "entries",
		entry("specs", e1, "req", "item 10", "REQ-10", `"fields":{"prio":"high","n":10,"tags":["a"],"stage":"done"},"workflows":{"dev":"done"}`),
		entry("specs", e2, "req", "Item 2", "REQ-2", `"fields":{"prio":"low","n":2,"tags":["c","a"],"stage":"open"},"workflows":{"dev":"open"}`),
		entry("specs", e3, "req", "", "TASKDOC", `"fields":{"prio":"weird","n":30},"workflows":{"dev":"review"}`),
		entry("specs", e4, "req", "zeta", "", ""),
		entry("specs", e5, "req", "beta", "REQ-9", `"fields":{"prio":""},"workflows":{"dev":"bogus"}`),
		entry("other", e6, "zz", "other", "", ""))
	commit(t, repo, "links and comments",
		gitx.Op{Path: "specs/.corestone/links/" + l1 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"link","type":"refines","source":%q,"target":%q}`, l1, e2, e1))},
		gitx.Op{Path: "specs/.corestone/links/" + l2 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"link","type":"refines","source":%q,"target":%q}`, l2, e1, e2))},
		gitx.Op{Path: "specs/.corestone/comments/" + c1 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":"x","author":"a"}`, c1, l1))},
		gitx.Op{Path: "specs/.corestone/comments/" + c2 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":"y","author":"b"}`, c2, e3))})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}

	entries := Query{Kinds: []model.Kind{model.KindEntry}, Folder: "specs", Subtree: true}
	check := func(label string, q Query, levels []SortLevel, want string) {
		t.Helper()
		res, err := p.QueryIDs(ctx, q, levels, 0)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		var got []string
		for _, id := range res.IDs {
			got = append(got, name[id])
		}
		if strings.Join(got, " ") != want || res.Total != len(got) || res.Truncated {
			t.Errorf("%s: got %v (total %d, truncated %v), want %s", label, got, res.Total, res.Truncated, want)
		}
	}
	asc := func(col string) SortLevel { return SortLevel{Col: col, Dir: "asc"} }
	desc := func(col string) SortLevel { return SortLevel{Col: col, Dir: "desc"} }
	hid := asc("$hid")

	check("hid natural", entries, []SortLevel{hid}, "e2 e5 e1 e3 e4")
	check("hid desc keeps missing last", entries, []SortLevel{desc("$hid")}, "e3 e1 e5 e2 e4")
	check("title natural", entries, []SortLevel{asc("$title")}, "e5 e3 e2 e1 e4")
	check("enum rank, unlisted then empty", entries, []SortLevel{asc("prio"), hid}, "e2 e1 e3 e5 e4")
	check("enum rank desc", entries, []SortLevel{desc("prio"), hid}, "e1 e2 e3 e5 e4")
	check("multi-valued enum by highest", entries, []SortLevel{asc("tags"), hid}, "e1 e2 e5 e3 e4")
	check("numbers", entries, []SortLevel{asc("n"), hid}, "e2 e1 e3 e5 e4")
	check("numbers desc", entries, []SortLevel{desc("n"), hid}, "e3 e1 e2 e5 e4")
	check("workflow field", entries, []SortLevel{asc("stage"), hid}, "e2 e1 e5 e3 e4")
	check("workflow states", entries, []SortLevel{asc("$state"), hid}, "e2 e3 e1 e5 e4")
	check("workflow states desc", entries, []SortLevel{desc("$state"), hid}, "e1 e3 e2 e5 e4")
	check("type display name", Query{Kinds: []model.Kind{model.KindEntry}, Subtree: true}, []SortLevel{asc("$type"), hid}, "e6 e2 e5 e1 e3 e4")
	check("link endpoints", Query{Kinds: []model.Kind{model.KindLink}, Subtree: true}, []SortLevel{asc("$source")}, "l1 l2")
	check("link endpoints desc", Query{Kinds: []model.Kind{model.KindLink}, Subtree: true}, []SortLevel{desc("$target")}, "l1 l2")
	comments := Query{Kinds: []model.Kind{model.KindComment}, Subtree: true}
	check("comment subject label", comments, []SortLevel{asc("$subject")}, "c1 c2")
	check("comment subject kind", comments, []SortLevel{asc("$kind")}, "c2 c1")
	check("comment author", comments, []SortLevel{desc("$author")}, "c2 c1")

	res, err := p.QueryIDs(ctx, entries, []SortLevel{hid}, 2)
	if err != nil || res.Total != 5 || len(res.IDs) != 2 || !res.Truncated {
		t.Fatalf("limit: %+v, %v", res, err)
	}
	for _, bad := range [][]SortLevel{{asc("$nope")}, {asc("")}, {{Col: "$hid", Dir: "up"}}, {hid, hid, hid, hid}} {
		if _, err := p.QueryIDs(ctx, entries, bad, 0); err == nil || !strings.Contains(err.Error(), "validation") {
			t.Errorf("sort %+v: err = %v, want validation error", bad, err)
		}
	}

	rows, err := p.Details(ctx, []string{e3, "missing", model.NewGUID(), e1, e3})
	if err != nil || len(rows) != 2 || rows[0].GUID != e3 || rows[1].GUID != e1 {
		t.Fatalf("details: %+v, %v", rows, err)
	}
}
