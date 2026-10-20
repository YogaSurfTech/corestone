package model

import (
	"strings"
	"testing"
)

// files builds config files from "scope|path" keys.
func files(m map[string]string) []ConfigFile {
	var out []ConfigFile
	for k, v := range m {
		scope, rel, _ := strings.Cut(k, "|")
		out = append(out, ConfigFile{Scope: scope, Path: rel, Data: []byte(v)})
	}
	return out
}

func mustIndex(t *testing.T, m map[string]string) *ConfigIndex {
	t.Helper()
	idx, problems := NewConfigIndex(files(m))
	if len(problems) > 0 {
		t.Fatalf("file problems: %+v", problems)
	}
	return idx
}

func typeIDs(list []*Schema) string {
	var ids []string
	for _, s := range list {
		ids = append(ids, s.Type)
	}
	return strings.Join(ids, ",")
}

func options(f *Field) string {
	var v []string
	for _, o := range f.Options {
		v = append(v, o.Value)
	}
	return strings.Join(v, ",")
}

func TestClassifyConfig(t *testing.T) {
	for rel, want := range map[string]ConfigName{
		"entries/types.json":                          {KindEntry, RoleTypes, ""},
		"documents/fields.json":                       {KindDocument, RoleFields, ""},
		"entries/task-fields.json":                    {KindEntry, RoleFields, "task"},
		"links/enums/priority-enum.json":              {KindLink, RoleEnum, "priority"},
		"entries/enums/task-priority-enum.json":       {KindEntry, RoleEnum, "task-priority"},
		"comments/workflows/review-workflow.json":     {KindComment, RoleWorkflow, "review"},
		"entries/workflows/task-dev-workflow.json":    {KindEntry, RoleWorkflow, "task-dev"},
		"entries/workflows/my-task-dev-workflow.json": {KindEntry, RoleWorkflow, "my-task-dev"},
	} {
		if got, ok := ClassifyConfig(rel); !ok || got != want {
			t.Errorf("%s: %+v %v", rel, got, ok)
		}
	}
	for _, rel := range []string{"docs/types.json", "entries/schema.json", "entries/-fields.json", "entries/enums/priority.json",
		"entries/enums/-enum.json", "entries/workflows/dev.json", "entries/x/types.json", "types.json"} {
		if n, ok := ClassifyConfig(rel); ok {
			t.Errorf("%s classified as %+v", rel, n)
		}
	}
}

func TestParseConfigFiles(t *testing.T) {
	tf, err := ParseTypesFile([]byte(`{"inheritance":"off","types":[{"id":"task","displayName":"Task","hid":{"prefix":"TSK"},
		"fields":["effort",{"id":"priority","required":true}],"x-app":1}]}`), KindEntry)
	if err != nil {
		t.Fatal(err)
	}
	td := tf.Types[0]
	if tf.Inheritance != "off" || td.Schema.Type != "task" || td.Schema.Kind != KindEntry || td.Schema.HID.Prefix != "TSK" ||
		len(td.Fields) != 2 || td.Fields[0].ID != "effort" || !*td.Fields[1].Required || td.Schema.Extra["x-app"] == nil {
		t.Fatalf("types file %+v / %+v", tf, td.Schema)
	}
	for _, bad := range []string{
		`{"types":[{"id":"a"},{"id":"a"}]}`,              // duplicate type
		`{"types":[{"id":"a","kind":"link"}]}`,           // kind comes from the directory
		`{"types":[{"id":"a","inheritance":"off"}]}`,     // inheritance is per file
		`{"types":[{"id":"a","type":"b"}]}`,              // "id", not "type"
		`{"types":[{"id":"a","fields":["x","x"]}]}`,      // field listed twice
		`{"types":[{"id":"a","fields":["a.b"]}]}`,        // invalid field id
		`{"types":[{"id":""}]}`,                          // missing id
		`{"inheritance":"maybe","types":[]}`,             // bad switch
		`{"types":[{"id":"a"}`,                           // not JSON
		`{"types":[{"id":"a","cardinality":"several"}]}`, // schema validation applies
	} {
		if _, err := ParseTypesFile([]byte(bad), KindEntry); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := ParseFieldsFile([]byte(`{"fields":[{"id":"p","type":"enum","enum":"priority"}]}`)); err != nil {
		t.Fatalf("enum field by reference: %v", err)
	}
	for _, bad := range []string{
		`{"fields":[{"id":"p","type":"text","enum":"priority"}]}`, // only enum fields reference enums
		`{"fields":[{"id":"p","type":"enum"}]}`,                   // no options, no reference
		`{"fields":[{"id":"p","type":"text"},{"id":"p","type":"text"}]}`,
	} {
		if _, err := ParseFieldsFile([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := ParseEnum([]byte(`{"extendable":true,"options":[]}`)); err != nil {
		t.Fatalf("extendable enum without options: %v", err)
	}
	for _, bad := range []string{`{"options":[]}`, `{"options":[{"value":"a"},{"value":"a"}]}`, `{"options":[{"value":""}]}`} {
		if _, err := ParseEnum([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	w, err := ParseWorkflowFile([]byte(`{"states":["open","done"],"transitions":[{"from":"open","to":"done"}]}`), "task-dev")
	if err != nil || w.ID != "" || w.Initial != "open" {
		t.Fatalf("workflow without id: %+v %v", w, err)
	}
	if _, _, err := ParseConfigFile("entries/schemas/task.json", []byte(`{}`)); err == nil {
		t.Fatal("unknown file name accepted")
	}
}

// The dogfooding layout: a root domain, and a task tracker whose entry
// types are cut off from the root while links and comments still inherit.
var trackerConfig = map[string]string{
	"|entries/types.json": `{"types":[
		{"id":"requirement","displayName":"Requirement","hid":{"prefix":"REQ"},"workflows":["dev"],
		 "fields":[{"id":"priority","required":true},"rationale"]},
		{"id":"component","fields":["priority"]}]}`,
	"|entries/fields.json":                 `{"fields":[{"id":"priority","name":"Priority","type":"enum","enum":"priority"}]}`,
	"|entries/requirement-fields.json":     `{"fields":[{"id":"rationale","type":"multiline"},{"id":"verified","type":"boolean"}]}`,
	"|entries/enums/priority-enum.json":    `{"options":[{"value":"low"},{"value":"high"}]}`,
	"|entries/workflows/dev-workflow.json": `{"states":["open","done"],"transitions":[{"from":"open","to":"done"}]}`,
	"|links/types.json":                    `{"types":[{"id":"related","sourceTypes":["*"],"targetTypes":["*"]}]}`,
	"|comments/types.json":                 `{"types":[{"id":"comment"}]}`,
	"tasks|entries/types.json": `{"inheritance":"off","types":[
		{"id":"task","displayName":"Task","hid":{"prefix":"TSK"},"workflows":["task"],
		 "fields":[{"id":"priority","required":true},"effort","tags"]}]}`,
	"tasks|entries/fields.json": `{"fields":[{"id":"priority","name":"Priority","type":"enum","enum":"priority"},
		{"id":"effort","type":"integer"},{"id":"tags","type":"enum","enum":"tags","multiple":true}]}`,
	"tasks|entries/enums/priority-enum.json":      `{"options":[{"value":"low"},{"value":"medium"}]}`,
	"tasks|entries/enums/task-priority-enum.json": `{"options":[{"value":"low"},{"value":"medium"},{"value":"urgent"}]}`,
	"tasks|entries/enums/tags-enum.json":          `{"extendable":true,"options":[{"value":"ux"}]}`,
	"tasks|entries/workflows/task-workflow.json":  `{"states":["open","done"],"transitions":[{"from":"open","to":"done"}]}`,
}

func TestConfigResolution(t *testing.T) {
	idx := mustIndex(t, trackerConfig)
	if p := idx.Problems(); len(p) > 0 {
		t.Fatalf("problems: %+v", p)
	}

	// Root: the root types of every kind.
	if got := typeIDs(idx.TypesVisible("specs")); got != "comment,component,related,requirement" {
		t.Fatalf("root types %s", got)
	}
	// The task folder cuts off the root's entry types only.
	if got := typeIDs(idx.TypesVisible("tasks/sprint-1")); got != "comment,related,task" {
		t.Fatalf("task folder types %s", got)
	}
	if idx.Effective("requirement", "tasks") != nil || idx.Effective("task", "specs") != nil {
		t.Fatal("a type leaked across the cut-off")
	}

	req := idx.Effective("requirement", "specs/boot")
	if req.Kind != KindEntry || req.HID.Prefix != "REQ" || fieldIDs(req) != "priority,rationale,verified" {
		t.Fatalf("requirement %+v fields %s", req, fieldIDs(req))
	}
	if f := req.Field("priority"); !f.Required || options(f) != "low,high" {
		t.Fatalf("requirement priority %+v", f)
	}
	if comp := idx.Effective("component", ""); comp.Field("priority").Required {
		t.Fatal("required is per type: component lists priority as optional")
	}

	task := idx.Effective("task", "tasks/sprint-1")
	if fieldIDs(task) != "priority,effort,tags" || task.Sources[0] != "tasks" {
		t.Fatalf("task %s sources %v", fieldIDs(task), task.Sources)
	}
	// The type-specific enumeration wins over the shared one in the same folder.
	if f := task.Field("priority"); !f.Required || options(f) != "low,medium,urgent" {
		t.Fatalf("task priority %+v", f)
	}
	if f := task.Field("tags"); !f.Multiple || !f.Extendable || options(f) != "ux" {
		t.Fatalf("task tags %+v", f)
	}

	if w := idx.Workflow("task", "task", "tasks/sprint-1"); w == nil || w.ID != "task" || w.Scope != "tasks" {
		t.Fatalf("task workflow %+v", w)
	}
	if idx.Workflow("requirement", "dev", "tasks") != nil || idx.Workflow("task", "dev", "tasks") != nil {
		t.Fatal("root workflow visible below the cut-off")
	}
	if w := idx.Workflow("requirement", "dev", "specs"); w == nil || w.Scope != "" {
		t.Fatalf("dev workflow %+v", w)
	}

	// Links are still inherited in the task folder.
	if src, tgt := idx.LinkTypesFor("task", "tasks"); len(src) != 1 || len(tgt) != 1 || src[0].Type != "related" {
		t.Fatalf("link types for task: %v %v", typeIDs(src), typeIDs(tgt))
	}
}

func TestConfigPrecedence(t *testing.T) {
	idx := mustIndex(t, map[string]string{
		"|entries/types.json":                    `{"types":[{"id":"task","fields":["priority","size"]}]}`,
		"|entries/fields.json":                   `{"fields":[{"id":"priority","type":"enum","enum":"priority"},{"id":"size","type":"integer"}]}`,
		"|entries/enums/task-priority-enum.json": `{"options":[{"value":"root-task"}]}`,
		"|entries/enums/priority-enum.json":      `{"options":[{"value":"root"}]}`,
		// A nearer folder wins even with a shared definition over a farther type-specific one.
		"team|entries/enums/priority-enum.json": `{"options":[{"value":"team"}]}`,
		// A nearer folder refines the type: adds a field and redefines another.
		"team|entries/types.json":       `{"types":[{"id":"task","displayName":"Team task","fields":[{"id":"size","required":true},"owner"]}]}`,
		"team|entries/task-fields.json": `{"fields":[{"id":"size","type":"float"},{"id":"owner","type":"text"}]}`,
	})
	if f := idx.Effective("task", "").Field("priority"); options(f) != "root-task" {
		t.Fatalf("root: type-specific before shared: %s", options(f))
	}
	team := idx.Effective("task", "team/x")
	if options(team.Field("priority")) != "team" {
		t.Fatalf("nearest folder first: %s", options(team.Field("priority")))
	}
	if fieldIDs(team) != "priority,size,owner" || team.Field("size").Type != FieldFloat || !team.Field("size").Required || team.DisplayName != "Team task" {
		t.Fatalf("refined type %s %+v %q", fieldIDs(team), team.Field("size"), team.DisplayName)
	}
	if root := idx.Effective("task", ""); root.Field("size").Type != FieldInteger || root.Field("size").Required || fieldIDs(root) != "priority,size" {
		t.Fatal("refinement leaked to the root")
	}
}

func TestConfigDeclaredIdentity(t *testing.T) {
	idx := mustIndex(t, map[string]string{
		"|entries/types.json":  `{"types":[{"id":"task","fields":["priority"]},{"id":"bug","fields":["priority"]}]}`,
		"|entries/fields.json": `{"fields":[{"id":"priority","type":"enum","enum":"priority"}]}`,
		// A shared enumeration that merely happens to be called task-priority.
		"|entries/enums/task-priority-enum.json": `{"id":"task-priority","options":[{"value":"other"}]}`,
		"|entries/enums/priority-enum.json":      `{"options":[{"value":"shared"}]}`,
		// A file declaring its type only serves that type.
		"|entries/workflows/flow-workflow.json": `{"type":"bug","states":["open"],"transitions":[]}`,
	})
	if got := options(idx.Effective("task", "").Field("priority")); got != "shared" {
		t.Fatalf("declared id must stop the name match: %s", got)
	}
	if idx.Workflow("bug", "flow", "") == nil || idx.Workflow("task", "flow", "") != nil {
		t.Fatal("declared type must restrict the workflow")
	}
}

func TestConfigProblems(t *testing.T) {
	idx, fileProblems := NewConfigIndex(files(map[string]string{
		"|entries/types.json":             `{"types":[{"id":"task","workflows":["missing"],"fields":["nope","priority","flow"]},{"id":"related"}]}`,
		"|entries/fields.json":            `{"fields":[{"id":"priority","type":"enum","enum":"absent"},{"id":"flow","type":"workflow","workflow":"gone"}]}`,
		"|entries/ghost-fields.json":      `{"fields":[{"id":"x","type":"text"}]}`,
		"|links/types.json":               `{"types":[{"id":"related"}]}`,
		"|entries/enums/broken-enum.json": `{"options":[`,
		"|entries/schemas/old.json":       `{}`,
		"sub|entries/types.json":          `{"types":[{"id":"sub"}]}`,
	}))
	paths := map[string]bool{}
	for _, p := range fileProblems {
		paths[p.Path] = true
	}
	if len(fileProblems) != 2 || !paths[".corestone/config/entries/enums/broken-enum.json"] || !paths[".corestone/config/entries/schemas/old.json"] {
		t.Fatalf("file problems %+v", fileProblems)
	}
	var msgs []string
	for _, p := range idx.Problems() {
		msgs = append(msgs, p.Path+": "+p.Message)
	}
	all := strings.Join(msgs, "\n")
	for _, want := range []string{
		`entries/types.json: type "task" uses field "nope", which is not defined`,
		`entries/types.json: field "priority" of type "task" uses enumeration "absent", which is not defined`,
		`entries/types.json: field "flow" of type "task" uses workflow "gone", which is not defined`,
		`entries/types.json: type "task" uses workflow "missing", which is not defined`,
		`entries/ghost-fields.json: fields for type "ghost", which is not defined here`,
		`type "related" is defined for several kinds (entries, links)`,
	} {
		if !strings.Contains(all, want) {
			t.Errorf("missing problem %q in\n%s", want, all)
		}
	}
	// Reported where introduced, not again for the subfolder that inherits them.
	if strings.Contains(all, "sub/") {
		t.Fatalf("inherited problems repeated in a subfolder:\n%s", all)
	}
}
