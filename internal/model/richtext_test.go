package model

import (
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/ojson"
)

func parse(t *testing.T, s string) any {
	t.Helper()
	v, err := ojson.Parse([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestValidateRichText(t *testing.T) {
	good := []string{
		`"plain\nlines"`,
		`[]`,
		`[{"text": ""}, {"text": "a\nb", "align": "right"}]`,
		`[{"text": [{"text": "x", "bold": true, "color": "#1565c0", "font": "Georgia", "size": 14}, {"text": "y", "sup": true}]}]`,
		`[{"list": "ol", "text": "one"}, {"list": "ol", "level": 2, "text": "one.one"}, {"list": "ul", "align": "center", "text": "b"}]`,
		`[{"text": [{"text": "spec", "href": "https://example.org/a?b=1"}, {"text": "mail", "href": "mailto:a@b.org"}, {"text": "REQ-1", "ref": "6f1c2a1e-5b7d-4c1a-9d3e-2a4b5c6d7e8f", "bold": true}]}]`,
	}
	for _, s := range good {
		if err := ValidateRichText("f", parse(t, s)); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	bad := map[string]string{
		`42`:                               "list of paragraphs",
		`["x"]`:                            "not an object",
		`[{"align": "left", "text": "x"}]`: "align",
		`[{"text": "x", "level": 2}]`:      "level without list",
		`[{"list": "ol", "level": 12, "text": "x"}]`:                 "level is 1",
		`[{"list": "dl", "text": "x"}]`:                              "list is ul or ol",
		`[{"type": "table", "text": "x"}]`:                           "unknown property",
		`[{"align": "center"}]`:                                      "has no text",
		`[{"text": [{"text": ""}]}]`:                                 "needs a text",
		`[{"text": [{"text": "x", "bold": false}]}]`:                 "true or absent",
		`[{"text": [{"text": "x", "color": "red"}]}]`:                "#rrggbb",
		`[{"text": [{"text": "x", "size": 200}]}]`:                   "6 to 96",
		`[{"text": [{"text": "x", "blink": true}]}]`:                 "unknown formatting",
		`[{"text": [{"text": "x", "sub": true, "sup": true}]}]`:      "at once",
		`[{"text": "bell\u0007"}]`:                                   "control",
		`[{"text": [{"text": "x", "href": "javascript:alert(1)"}]}]`: "href is a web address",
		`[{"text": [{"text": "x", "href": "example.org"}]}]`:         "href is a web address",
		`[{"text": [{"text": "x", "ref": "REQ-1"}]}]`:                "ref is an item id",
		`[{"text": [{"text": "x", "href": "https://a.org", "ref": "6f1c2a1e-5b7d-4c1a-9d3e-2a4b5c6d7e8f"}]}]`: "goes to one place",
	}
	for s, want := range bad {
		err := ValidateRichText("f", parse(t, s))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", s, err, want)
		}
	}
}

func TestRichTextPlain(t *testing.T) {
	v := parse(t, `[
		{"text": "Intro"},
		{"list": "ol", "text": "one"},
		{"list": "ol", "level": 2, "text": "one.one"},
		{"list": "ol", "level": 2, "text": [{"text": "one.", "bold": true}, {"text": "two"}]},
		{"list": "ol", "level": 3, "text": "one.two.one"},
		{"list": "ol", "text": "two"},
		{"list": "ul", "level": 2, "text": "bullet"},
		{"text": "after"},
		{"list": "ol", "text": "again one"}
	]`)
	want := "Intro\n1. one\n  1.1. one.one\n  1.2. one.two\n    1.2.1. one.two.one\n2. two\n  • bullet\nafter\n1. again one"
	if got := RichTextPlain(v); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	if got := RichTextPlain("just\ntext"); got != "just\ntext" {
		t.Errorf("plain string: %q", got)
	}
}

func TestRichTextRefs(t *testing.T) {
	g := "6f1c2a1e-5b7d-4c1a-9d3e-2a4b5c6d7e8f"
	v := parse(t, `[{"text": "plain"}, {"text": [{"text": "a", "href": "https://a.org"}, {"text": "b", "ref": "`+g+`"}]}]`)
	if got := RichTextRefs(v); len(got) != 1 || got[0] != g {
		t.Errorf("refs %v", got)
	}
	f := &Field{ID: "notes", Type: FieldRichText}
	if got := f.ReferencedGUIDs(v); len(got) != 1 || got[0] != g {
		t.Errorf("field refs %v", got)
	}
}

func TestRichTextTables(t *testing.T) {
	good := `[{"text": "before"}, {"stripes": "rows", "colors": ["#ffffff", "#e3f2fd"], "borders": "outside", "widths": [120, null], "table": [
		[{"content": "Name", "header": true}, "Value"],
		[[{"text": [{"text": "bold", "bold": true}]}, {"list": "ul", "text": "item"}], ""],
		[{"content": "both columns", "colspan": 2}]]}]`
	if err := ValidateRichText("f", parse(t, good)); err != nil {
		t.Fatal(err)
	}
	if !IsRichText(parse(t, good)) {
		t.Error("a value with a table is rich text")
	}
	bad := map[string]string{
		`[{"table": []}]`:   "list of rows",
		`[{"table": [[]]}]`: "list of cells",
		`[{"table": [[{"content": "a", "header": false}]]}]`:                   "header is true",
		`[{"table": [["a"]], "header": true}]`:                                 "unknown property",
		`[{"table": [["a"]], "stripes": "diagonal"}]`:                          "stripes is rows or columns",
		`[{"table": [["a"]], "colors": ["#ffffff"]}]`:                          "two stripe colors",
		`[{"table": [["a"]], "colors": ["#ffffff", "blue"]}]`:                  "#rrggbb",
		`[{"table": [["a"]], "borders": "thick"}]`:                             "borders is outside",
		`[{"table": [["a"]], "widths": [5]}]`:                                  "10 to 4000",
		`[{"table": [["a"]], "border": 1}]`:                                    "unknown property",
		`[{"table": [[{"content": "a", "colspan": 0}]]}]`:                      "colspan is 1",
		`[{"table": [[{"colspan": 2}]]}]`:                                      "has a content",
		`[{"table": [[42]]}]`:                                                  "a cell is text",
		`[{"table": [[[{"table": [["inner"]]}]]]}]`:                            "no tables in tables",
		`[{"table": [[[{"text": [{"text": "x", "href": "javascript:x"}]}]]]}]`: "href is a web address",
	}
	for s, want := range bad {
		err := ValidateRichText("f", parse(t, s))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", s, err, want)
		}
	}
	g := "6f1c2a1e-5b7d-4c1a-9d3e-2a4b5c6d7e8f"
	v := parse(t, `[{"text": "Intro"}, {"table": [
		["Name", [{"text": [{"text": "see "}, {"text": "it", "ref": "`+g+`"}]}]],
		[{"content": [{"text": "two"}, {"text": "lines"}], "colspan": 2}]]}, {"list": "ol", "text": "after"}]`)
	if got, want := RichTextPlain(v), "Intro\nName | see it\ntwo lines\n1. after"; got != want {
		t.Errorf("plain %q, want %q", got, want)
	}
	if got := RichTextRefs(v); len(got) != 1 || got[0] != g {
		t.Errorf("refs in cells %v", got)
	}
}

func TestRichTextImagesAndFileLinks(t *testing.T) {
	good := `[{"align": "center", "text": [{"image": "photo.png", "alt": "The pump", "width": 320}]},
		{"text": [{"text": "See "}, {"text": "the manual", "file": "manual.pdf"}, {"image": "icon.png"}]},
		{"table": [[[{"text": [{"image": "cell.png"}]}]]]}]`
	if err := ValidateRichText("f", parse(t, good)); err != nil {
		t.Fatal(err)
	}
	if got := RichTextPlain(parse(t, good)); got != "\nSee the manual\n" {
		t.Errorf("plain %q", got)
	}
	bad := map[string]string{
		`[{"text": [{"image": "../x.png"}]}]`:                                         "name of a file",
		`[{"text": [{"image": ".corestone.json"}]}]`:                                  "name of a file",
		`[{"text": [{"image": "a.png", "width": 5}]}]`:                                "16 to 4000",
		`[{"text": [{"image": "a.png", "bold": true}]}]`:                              "unknown image property",
		`[{"text": [{"text": "x", "file": "a/b.pdf"}]}]`:                              "name of a file",
		`[{"text": [{"text": "x", "file": "a.pdf", "href": "https://example.com"}]}]`: "goes to one place",
	}
	for s, want := range bad {
		err := ValidateRichText("f", parse(t, s))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", s, err, want)
		}
	}
}
