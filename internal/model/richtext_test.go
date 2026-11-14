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
		`[{"list": "ol", "level": 12, "text": "x"}]`:            "level is 1",
		`[{"list": "dl", "text": "x"}]`:                         "list is ul or ol",
		`[{"type": "table", "text": "x"}]`:                      "unknown property",
		`[{"align": "center"}]`:                                 "has no text",
		`[{"text": [{"text": ""}]}]`:                            "needs a text",
		`[{"text": [{"text": "x", "bold": false}]}]`:            "true or absent",
		`[{"text": [{"text": "x", "color": "red"}]}]`:           "#rrggbb",
		`[{"text": [{"text": "x", "size": 200}]}]`:              "6 to 96",
		`[{"text": [{"text": "x", "blink": true}]}]`:            "unknown formatting",
		`[{"text": [{"text": "x", "sub": true, "sup": true}]}]`: "at once",
		`[{"text": "bell\u0007"}]`:                              "control",
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
