package ojson

import (
	"bytes"
	"strings"
	"testing"
)

func TestRoundTripPreservesBytes(t *testing.T) {
	cases := []string{
		"{\n  \"z\": 1,\n  \"a\": {\n    \"y\": [\n      1,\n      \"x\"\n    ],\n    \"b\": null\n  },\n  \"n\": 1.10,\n  \"big\": 9007199254740993\n}\n",
		"{\r\n\t\"a\": true,\r\n\t\"b\": []\r\n}",
		"{\"a\":1,\"b\":[1,2,{\"c\":\"<&>\"}]}",
		"{\n    \"deep\": {\n        \"x\": {}\n    }\n}\n",
	}
	for _, c := range cases {
		v, err := Parse([]byte(c))
		if err != nil {
			t.Fatal(err)
		}
		st := DetectStyle([]byte(c))
		out, _ := Encode(v, st)
		if !bytes.Equal(out, []byte(c)) {
			t.Errorf("round trip changed bytes:\n%q\n%q", c, out)
		}
	}
}

func TestUnchangedSubtreesAreVerbatim(t *testing.T) {
	src := "{\n  \"a\": {\"inline\": [1,   2], \"s\":\"\\u00e9\"},\n  \"b\": 1,\n  \"c\": [ 1, 2 ]\n}\n"
	// untouched: identical
	o, _ := ParseObject([]byte(src))
	if out, _ := Encode(o, DetectStyle([]byte(src))); string(out) != src {
		t.Fatalf("untouched file changed:\n%s", out)
	}
	// touching one property keeps the odd formatting of the others
	o.Set("b", Number("2"))
	out, _ := Encode(o, DetectStyle([]byte(src)))
	want := "{\n  \"a\": {\"inline\": [1,   2], \"s\":\"\\u00e9\"},\n  \"b\": 2,\n  \"c\": [\n    1,\n    2\n  ]\n}\n"
	if string(out) != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
	// editing a nested object re-formats only that object
	o.Object("a").Set("inline", Number("3"))
	out, _ = Encode(o, DetectStyle([]byte(src)))
	if !strings.Contains(string(out), "\"a\": {\n    \"inline\": 3,\n    \"s\": \"é\"\n  }") {
		t.Fatalf("nested edit:\n%s", out)
	}
}

func TestEditKeepsPositionsAndAppends(t *testing.T) {
	src := "{\n  \"guid\": \"g\",\n  \"title\": \"old\",\n  \"x-ext\": {\"k\": 1}\n}\n"
	o, err := ParseObject([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	o.Set("title", "new")
	o.Set("hid", "REQ-1")
	o.Delete("guid")
	out, _ := Encode(o, DetectStyle([]byte(src)))
	want := "{\n  \"title\": \"new\",\n  \"x-ext\": {\"k\": 1},\n  \"hid\": \"REQ-1\"\n}\n"
	if string(out) != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
	if o.String("title") != "new" || o.Object("x-ext") == nil || o.Object("nope") != nil {
		t.Fatal("accessors")
	}
}

func TestMarshalJSONKeepsOrder(t *testing.T) {
	o := NewObject()
	o.Set("z", Number("1"))
	o.Set("a", []any{"x"})
	b, _ := o.MarshalJSON()
	if string(b) != `{"z":1,"a":["x"]}` {
		t.Fatalf("%s", b)
	}
	var back Object
	if err := back.UnmarshalJSON(b); err != nil || back.Keys()[0] != "z" {
		t.Fatalf("unmarshal %v %v", err, back.Keys())
	}
	if !Equal(o, &back) || Equal(o, NewObject()) {
		t.Fatal("Equal")
	}
	c := o.Clone()
	c.Set("z", Number("2"))
	if o.String("z") == "2" || Equal(o, c) {
		t.Fatal("clone aliasing")
	}
}

func TestPlainConversion(t *testing.T) {
	v := FromPlain(map[string]any{"b": 1.5, "a": []any{map[string]any{"x": true}}})
	out, _ := Encode(v, Style{})
	if string(out) != `{"a":[{"x":true}],"b":1.5}` {
		t.Fatalf("%s", out)
	}
	p := ToPlain(v).(map[string]any)
	if _, ok := p["a"].([]any)[0].(map[string]any); !ok {
		t.Fatal("ToPlain")
	}
}

func TestRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"", "{", "{} x", "[1,]", "nope"} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if _, err := ParseObject([]byte("[1]")); err == nil {
		t.Error("array accepted as object")
	}
	deep := strings.Repeat("[", 300) + strings.Repeat("]", 300)
	if _, err := Parse([]byte(deep)); err == nil {
		t.Error("over-deep nesting accepted")
	}
	if _, err := Parse([]byte(strings.Repeat("[", 200) + strings.Repeat("]", 200))); err != nil {
		t.Errorf("reasonable nesting rejected: %v", err)
	}
}

func TestRowsWritesOneElementPerLine(t *testing.T) {
	doc, err := ParseObject([]byte(`{"a": {"rows": [{"x": 1, "y": [2, 3]}, {"x": 4}], "other": [{"x": 5}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	doc.Object("a").Set("touched", true) // re-encode, not the source text
	st := DefaultStyle
	st.Rows = func(path []string, _ []any) bool { return len(path) == 2 && path[1] == "rows" }
	got := string(MustEncode(doc, st))
	want := `{
  "a": {
    "rows": [
      {"x": 1, "y": [2, 3]},
      {"x": 4}
    ],
    "other": [
      {"x": 5}
    ],
    "touched": true
  }
}
`
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}
