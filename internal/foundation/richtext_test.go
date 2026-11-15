package foundation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// TestRichTextFile: a rich-text field is validated, and written into the
// entry's file with one line per paragraph, so Git diffs show text lines.
func TestRichTextFile(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	putConfig(t, f, "", "entries/fields.json", `{"fields":[{"id":"notes","type":"richtext"}]}`)
	putConfig(t, f, "", "entries/types.json", `{"types":[{"id":"note","fields":["notes"]}]}`)

	if _, err := f.CreateArtifact(ctx, model.KindEntry, obj(t,
		`{"path":"n","type":"note","title":"bad","fields":{"notes":[{"text":"x","align":"left"}]}}`)); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("invalid rich text accepted: %v", err)
	}

	// as the HTTP API reads a request: the values, not the sender's layout
	req, err := ojson.ParseBody([]byte(`{"path":"n","type":"note","title":"Housing","fields":{"notes":[
		{"text":"Intro"},
		{"align":"center","text":[{"text":"Housing","bold":true,"color":"#1565c0"}]},
		{"list":"ol","level":2,"text":"one.one"}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	v, err := f.CreateArtifact(ctx, model.KindEntry, req)
	if err != nil {
		t.Fatal(err)
	}
	file := func() string {
		raw, _, err := f.Repo.ReadPath(ctx, mustHead(t, f), v.Meta.Path)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	want := `  "fields": {
    "notes": [
      {"text": "Intro"},
      {"align": "center", "text": [{"text": "Housing", "bold": true, "color": "#1565c0"}]},
      {"list": "ol", "level": 2, "text": "one.one"}
    ]
  }`
	if got := file(); !strings.Contains(got, want) {
		t.Fatalf("file:\n%s\nwant it to contain:\n%s", got, want)
	}

	// an edit keeps the layout; plain text stays a string
	if _, err := f.UpdateArtifact(ctx, v.Meta.GUID, "", obj(t, `{"fields":{"notes":"line one\nline two"}}`)); err != nil {
		t.Fatal(err)
	}
	if got := file(); !strings.Contains(got, `"notes": "line one\nline two"`) {
		t.Fatalf("plain text file:\n%s", got)
	}
}

// TestRichTextItemLinks: a link to an item must point to an existing item
// when it is added; once the item is deleted the text stays editable.
func TestRichTextItemLinks(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	putConfig(t, f, "", "entries/fields.json", `{"fields":[{"id":"notes","type":"richtext"},{"id":"other","type":"text"}]}`)
	putConfig(t, f, "", "entries/types.json", `{"types":[{"id":"note","fields":["notes","other"]}]}`)
	target := create(t, f, model.KindEntry, `{"path":"n","type":"note","title":"Target"}`)
	link := func(g string) string {
		return `{"path":"n","type":"note","title":"Links","fields":{"notes":[{"text":[{"text":"see ","bold":true},{"text":"it","ref":"` + g + `"}]}]}}`
	}
	if _, err := f.CreateArtifact(ctx, model.KindEntry, obj(t, link(model.NewGUID()))); err == nil {
		t.Fatal("link to a missing item accepted")
	}
	v := create(t, f, model.KindEntry, link(target.Meta.GUID))
	if err := f.DeleteArtifact(ctx, target.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.UpdateArtifact(ctx, v.Meta.GUID, "", obj(t, `{"fields":{"other":"edited later"}}`)); err != nil {
		t.Fatalf("text linking to a deleted item could not be edited: %v", err)
	}
}

// TestRichTextTableFile: a table is written with one line per row.
func TestRichTextTableFile(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	putConfig(t, f, "", "entries/fields.json", `{"fields":[{"id":"notes","type":"richtext"}]}`)
	putConfig(t, f, "", "entries/types.json", `{"types":[{"id":"note","fields":["notes"]}]}`)
	req, err := ojson.ParseBody([]byte(`{"path":"n","type":"note","title":"Table","fields":{"notes":[
		{"text":"Intro"},
		{"stripes":"rows","widths":[120,null],"table":[[{"content":"Name","header":true},"Value"],["Pressure",[{"text":[{"text":"16","bold":true}]}]]]}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	v, err := f.CreateArtifact(ctx, model.KindEntry, req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _, err := f.Repo.ReadPath(ctx, mustHead(t, f), v.Meta.Path)
	if err != nil {
		t.Fatal(err)
	}
	want := `    "notes": [
      {"text": "Intro"},
      {"stripes": "rows", "widths": [120, null], "table": [
        [{"content": "Name", "header": true}, "Value"],
        ["Pressure", [{"text": [{"text": "16", "bold": true}]}]]
      ]}
    ]`
	if !strings.Contains(string(raw), want) {
		t.Fatalf("file:\n%s\nwant it to contain:\n%s", raw, want)
	}
}
