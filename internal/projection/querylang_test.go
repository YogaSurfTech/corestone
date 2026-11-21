package projection

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

func TestQueryLanguage(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	guids := map[string]string{}
	for _, n := range []string{"t1", "t2", "t3", "t4", "n1", "d1", "l1", "l2", "l3"} {
		guids[n] = model.NewGUID()
	}
	name := map[string]string{}
	for n, g := range guids {
		name[g] = n
	}
	entry := func(dir, n, typ, title, hid, fields string) gitx.Op {
		return gitx.Op{Path: dir + "/" + guids[n] + "/.corestone.json", Content: entryJSON(guids[n], typ, title, hid, `"fields":{`+fields+`}`)}
	}
	commit(t, repo, "config",
		gitx.Op{Path: ".corestone/config/entries/types.json", Content: []byte(`{"types":[
			{"id":"task","fields":["priority","tags","effort","due","done","description","status","review","product"]},
			{"id":"note","fields":["description"]},{"id":"product"}]}`)},
		gitx.Op{Path: ".corestone/config/entries/fields.json", Content: []byte(`{"fields":[
			{"id":"priority","type":"enum","options":[{"value":"low"},{"value":"medium"},{"value":"high"}]},
			{"id":"tags","type":"enum","multiple":true,"extendable":true,"options":[{"value":"server"},{"value":"docs"}]},
			{"id":"effort","type":"integer"},{"id":"due","type":"date"},{"id":"done","type":"boolean"},
			{"id":"description","type":"multiline"},
			{"id":"status","type":"workflow","workflow":"dev"},{"id":"review","type":"workflow","workflow":"dev"},
			{"id":"product","type":"enum","source":{"kind":"entry","types":["product"]}}]}`)},
		gitx.Op{Path: ".corestone/config/entries/workflows/dev-workflow.json", Content: []byte(`{"states":["open","review",{"id":"done","final":true},{"id":"dropped","final":true}],
			"transitions":[{"id":"submit","from":"open","to":"review"},{"id":"approve","from":"review","to":"done"}]}`)})
	long := strings.Repeat("filler ", 400) + "needle at the end"
	commit(t, repo, "entries",
		entry("specs", "d1", "product", "Drive", "PRD-1", ``),
		entry("specs", "t1", "task", "Table view", "TSK-9", `"priority":"high","tags":["server","docs"],"effort":3,"due":"2026-11-17","done":true,
			"description":"The table view of Corestone","status":{"state":"done","transition":"approve","previous":"review"},"review":{"state":"dropped"},"product":"`+guids["d1"]+`"`),
		entry("specs/brakes", "t2", "task", "Query language", "TSK-10", `"priority":"low","tags":["docs","extra"],"effort":10,"due":"2026-12-01",
			"description":"`+long+`","status":{"state":"review","transition":"submit","previous":"open"},"review":{"state":"done"}`),
		entry("specs/brakes/front", "t3", "task", "view of tables", "TSK-100", `"priority":"medium","effort":-1,"status":{"state":"open"},"review":{"state":"open"}`),
		entry("other", "t4", "task", "", "", `"status":{"state":"done"},"review":{"state":"done"}`),
		entry("other", "n1", "note", "A note on Corestone", "", `"description":"claude wrote this"`))
	// t1 depends on t2, t2 on t3, the note on t1; the note verifies nothing
	link := func(n, typ, source, target string) gitx.Op {
		return gitx.Op{Path: ".corestone/links/" + guids[n] + ".json", Content: []byte(`{"guid":"` + guids[n] + `","kind":"link","type":"` + typ + `","source":"` + guids[source] + `","target":"` + guids[target] + `"}`)}
	}
	commit(t, repo, "links",
		gitx.Op{Path: ".corestone/config/links/types.json", Content: []byte(`{"types":[{"id":"depends_on","reverseName":"blocks"},{"id":"verifies"}]}`)},
		link("l1", "depends_on", "t1", "t2"), link("l2", "depends_on", "t2", "t3"), link("l3", "depends_on", "n1", "t1"))
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}

	run := func(q string) (string, []Warning) {
		t.Helper()
		// the view's own filter: entries, unless the query asks for links
		view := Query{Lang: q, Subtree: true, Kinds: []model.Kind{model.KindEntry}}
		if strings.Contains(q, "kind:link") {
			view.Kinds = nil
		}
		res, err := p.QueryIDs(ctx, view, nil, 0)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		var got []string
		for _, id := range res.IDs {
			got = append(got, name[id])
		}
		sort.Strings(got)
		return strings.Join(got, " "), res.Warnings
	}
	all := "d1 n1 t1 t2 t3 t4"
	for _, c := range []struct{ q, want string }{
		{"", all},
		// values without a field: all words; fields side by side: either
		{"corestone", "n1 t1"}, {"table view", "t1"}, {"table corestone", "t1"}, {`view "of tables"`, "t3"}, {"TSK-1", "t2 t3"}, {"view TSK-1", ""}, {"TSK-10", "t2 t3"}, {`"view of"`, "t1 t3"},
		{"type:note priority:high", "n1 t1"}, {"type:task AND priority:high", "t1"},
		// text: a word, a phrase, the whole text of a field; case is ignored
		{"description:corestone", "t1"}, {"description:(corestone claude)", "n1 t1"}, {"description:NEEDLE", "t2"},
		{`description:"table view"`, "t1"}, {`description:"view table"`, ""}, {"title:view", "t1 t3"}, {`title:"query language"`, "t2"},
		{"title:NULL", "t4"}, {"NOT title:NULL", "d1 n1 t1 t2 t3"},
		// enumerations: the id; several values: any; order of the options
		{"priority:high", "t1"}, {"priority:(low medium)", "t2 t3"}, {"tags:docs", "t1 t2"}, {"tags:(server AND NOT docs)", ""},
		{"tags:(docs AND NOT server)", "t2"}, {"tags:extra", "t2"}, {"priority:>=medium", "t1 t3"}, {"priority:<high", "t2 t3"},
		{"priority:NULL", "d1 n1 t4"}, {"type:task AND priority:NULL", "t4"}, {"NOT priority:NULL", "t1 t2 t3"},
		// numbers and booleans
		{"effort:3", "t1"}, {"effort:>3", "t2"}, {"effort:<=3", "t1 t3"}, {"effort:<0", "t3"}, {"done:true", "t1"}, {"NOT done:true", "d1 n1 t2 t3 t4"},
		// dates: a day, a month, a year; comparisons cover the whole period
		{"due:2026-11-17", "t1"}, {"due:2026-11", "t1"}, {"due:2026", "t1 t2"}, {"due:<2026-12-01", "t1"}, {"due:<=2026-12-01", "t1 t2"},
		{"due:>2026-11", "t2"}, {"due:>=2026-11", "t1 t2"}, {"created:>=2020", all}, {"created:<2020", ""}, {"modified:2019", ""},
		// workflows: the state, how it was reached, the order of the states
		{"status:done", "t1 t4"}, {"status:(open review)", "t2 t3"}, {"status.transition:approve", "t1"}, {"status.previous:open", "t2"},
		{"status:<done", "t2 t3"}, {"status:done AND review:done", "t4"},
		// finished: every workflow field in a final state; never without a workflow field
		{"finished:true", "t1 t4"}, {"finished:True", "t1 t4"}, {"NOT finished:FALSE", "t1 t4"}, {"done:TRUE", "t1"}, {"NOT finished:true", "d1 n1 t2 t3"}, {"finished:false", "d1 n1 t2 t3"}, {"type:task AND NOT finished:true", "t2 t3"},
		// a dynamic enumeration: the chosen artifact's HID or GUID
		{"product:PRD-1", "t1"}, {"product:prd-1", "t1"}, {"product:" + guids["d1"], "t1"}, {"product:PRD-2", ""},
		// built-in fields
		{"kind:entry", all}, {"kind:document", ""}, {"type:(note product)", "d1 n1"}, {"hid:tsk-9", "t1"}, {"hid:>TSK-9", "t2 t3"}, {"hid:<=TSK-10", "d1 t1 t2"},
		{"hid:NULL", "n1 t4"}, {"guid:" + guids["n1"], "n1"}, {"valid:true", "d1 n1 t1 t2 t3"}, {"valid:false", "t4"}, // an entry without a title is invalid,
		{"folder:specs", "d1 t1"}, {"folder:specs/brakes", "t2"}, {"folder:specs/*", "d1 t1 t2 t3"}, {"folder:specs/brakes/*", "t2 t3"},
		{"folder~1:specs", "t2"}, {"folder~2:specs", "t3"}, {"folder~1:specs/brakes", "t3"}, {`folder~1:""`, "d1 n1 t1 t4"},
		// links: the artifact is the source, the query applies to the target; ~ turns it around
		{"kind:entry AND has_link:(depends_on)", "n1 t1 t2"}, {"has_link:(~depends_on)", "t1 t2 t3"}, {"kind:entry AND NOT has_link:(~depends_on)", "d1 n1 t4"},
		{"has_link:(depends_on, priority:low)", "t1"}, {"has_link:(~depends_on, type:note)", "t1"}, {"has_link:(depends_on, hid:>TSK-9 AND status:open)", "t2"},
		{"has_link:(depends_on, has_link:(depends_on, title:tables))", "t1"}, {"has_link:(depends_on, has_link:(~depends_on, type:note))", "n1"},
		{"has_link:(verifies)", ""}, {"type:task AND has_link:(depends_on) AND has_link:(~depends_on)", "t1 t2"},
		{"kind:link", "l1 l2 l3"}, {"kind:link AND type:depends_on", "l1 l2 l3"},
		// operators
		{"priority:high XOR tags:docs", "t2"}, {"NOT (type:task OR type:note)", "d1"}, {"type:task AND NOT (priority:high OR priority:low)", "t3 t4"},
	} {
		got, warnings := run(c.q)
		if got != c.want || len(warnings) != 0 {
			t.Errorf("%s: got %q %v, want %q", c.q, got, warnings, c.want)
		}
	}

	// forgiving: what cannot match is false, with a warning at its position
	for _, c := range []struct {
		q, want, warning string
		pos              int
	}{
		{"priorty:high", "", `unknown field "priorty"`, 0},
		{"type:note AND NOT priorty:high", "n1", `unknown field "priorty"`, 18},
		{"priority:urgent", "", `priority has no value "urgent"`, 0},
		{"effort:many", "", `"many" is no number`, 0},
		{"done:yes", "", "done is true or false", 0},
		{"due:soon", "", `"soon" is no date`, 0},
		{"created:yesterday", "", `"yesterday" is no date`, 0},
		{"finished:maybe", "", "finished is true or false", 0},
		{"status.owner:x", "", `unknown field "status.owner"`, 0},
		{"priority.previous:low", "", `unknown field "priority.previous"`, 0},
		{"title~1:x", "", "~1 is for folder only", 0},
		{"done:>true", "", "done is true or false", 0},
		{"type:note OR has_link:(nope)", "n1", `unknown link type "nope"`, 13},
	} {
		got, warnings := run(c.q)
		if got != c.want || len(warnings) != 1 || !strings.Contains(warnings[0].Message, c.warning) || warnings[0].Pos != c.pos {
			t.Errorf("%s: got %q %+v, want %q with %q at %d", c.q, got, warnings, c.want, c.warning, c.pos)
		}
	}
	// strict: a warning refuses the query; a query that cannot be parsed is refused always
	if _, err := p.QueryIDs(ctx, Query{Lang: "priorty:high", Strict: true, Subtree: true}, nil, 0); !errors.Is(err, model.ErrValidation) || !strings.Contains(err.Error(), "position 1") {
		t.Errorf("strict: %v", err)
	}
	if _, err := p.QueryIDs(ctx, Query{Lang: "priority:high", Strict: true, Subtree: true}, nil, 0); err != nil {
		t.Errorf("strict without warnings: %v", err)
	}
	if _, err := p.QueryIDs(ctx, Query{Lang: "(priority:high", Subtree: true}, nil, 0); !errors.Is(err, model.ErrValidation) {
		t.Errorf("unparsable: %v", err)
	}
	// the query is combined with the view's own filter, and the search takes it too
	res, err := p.QueryIDs(ctx, Query{Lang: "type:task", Folder: "specs/brakes", Subtree: true}, []string{"~hid"}, 0)
	if err != nil || len(res.IDs) != 2 || name[res.IDs[0]] != "t3" {
		t.Errorf("with a folder and a sort: %+v %v", res, err)
	}
	var warnings []Warning
	found, total, err := p.Search(ctx, Query{Lang: "status:done nope:1", Subtree: true, Warnings: &warnings})
	if err != nil || total != 2 || len(found) != 2 || len(warnings) != 1 {
		t.Errorf("search: %d %v %v", total, warnings, err)
	}
	// values are bound, never part of the statement
	if got, _ := run(`title:"'; DROP TABLE artifacts; --" x:"$1"`); got != "" {
		t.Errorf("hostile values: %q", got)
	}
}

// base: an entry is based on another (it overlays it); ~base reads it the
// other way round.
func TestQueryLanguageBase(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	guids, name := map[string]string{}, map[string]string{}
	for _, n := range []string{"root", "mid", "leaf", "other"} {
		guids[n] = model.NewGUID()
		name[guids[n]] = n
	}
	entry := func(n, hid, extra string) gitx.Op {
		return gitx.Op{Path: "specs/" + guids[n] + "/.corestone.json", Content: entryJSON(guids[n], "part", n, hid, extra)}
	}
	commit(t, repo, "entries",
		gitx.Op{Path: ".corestone/config/entries/types.json", Content: []byte(`{"types":[{"id":"part"}]}`)},
		entry("root", "P-1", ""), entry("mid", "P-2", `"base":"`+guids["root"]+`"`),
		entry("leaf", "P-3", `"base":"`+guids["mid"]+`"`), entry("other", "", ""))
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ q, want string }{
		{"base:P-1", "mid"}, {"base:p-2", "leaf"}, {"base:" + guids["root"], "mid"}, {"base:P-3", ""},
		{"~base:P-3", "mid"}, {"~base:P-2", "root"}, {"~base:" + guids["mid"], "root"}, {"~base:P-1", ""},
		{"base:NULL", "other root"}, {"NOT base:NULL", "leaf mid"}, // with a base: the overlays
		{"~base:NULL", "leaf other"}, {"NOT ~base:NULL", "mid root"}, // the bases
		{"base:(P-1 P-2)", "leaf mid"}, {"NOT base:NULL AND NOT ~base:NULL", "mid"},
	} {
		res, err := p.QueryIDs(ctx, Query{Lang: c.q, Subtree: true}, nil, 0)
		if err != nil {
			t.Fatalf("%s: %v", c.q, err)
		}
		var got []string
		for _, id := range res.IDs {
			got = append(got, name[id])
		}
		sort.Strings(got)
		if strings.Join(got, " ") != c.want || len(res.Warnings) != 0 {
			t.Errorf("%s: got %q %v, want %q", c.q, got, res.Warnings, c.want)
		}
	}
	// no workflow here marks a final state: finished says so instead of silently finding nothing
	for q, want := range map[string]string{"~title:x": "~ in front is for base only", "base:>P-1": "base cannot be compared", "finished:true": "no workflow marks a state as final"} {
		res, err := p.QueryIDs(ctx, Query{Lang: q, Subtree: true}, nil, 0)
		if err != nil || len(res.IDs) != 0 || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0].Message, want) {
			t.Errorf("%s: %+v %v", q, res, err)
		}
	}
}
