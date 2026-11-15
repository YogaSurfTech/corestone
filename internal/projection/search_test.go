package projection

import (
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// Rich text is indexed as it reads: words split by formatting are whole,
// formatting names and colours are not words of the text.
func TestSearchTextOfRichText(t *testing.T) {
	fields, err := ojson.ParseObject([]byte(`{"notes": [
		{"align": "center", "text": [{"text": "Hou"}, {"text": "sing", "bold": true, "color": "#1565c0"}]},
		{"list": "ol", "text": "seal"}], "tags": ["alpha"]}`))
	if err != nil {
		t.Fatal(err)
	}
	s := searchText(&model.Artifact{Title: "T", Fields: fields})
	for _, want := range []string{"Housing", "1. seal", "alpha"} {
		if !strings.Contains(s, want) {
			t.Errorf("%q missing in %q", want, s)
		}
	}
	for _, not := range []string{"center", "#1565c0", "ol"} {
		if strings.Contains(s, not) {
			t.Errorf("%q indexed in %q", not, s)
		}
	}
}
