package projection

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

const (
	maxSearchBytes = 256 * 1024
	maxFieldValue  = 1024
)

// record is a fully extracted artifact row ready for SQL.
type record struct {
	model.Summary
	BlobSHA string
	FieldsJ string // jsonb
	Search  string
	Valid   bool
	Error   string
	Index   []fieldKV
	Texts   []fieldKV // the whole text per field, for its word index
	Refs    []ref     // outgoing references held in fields and document content
}

type fieldKV struct{ Field, Value string }

// maxFieldText caps the text of one field that goes into its word index.
const maxFieldText = 100000

// ref is one outgoing reference: the target GUID and where it is held,
// "content" for a document's entry blocks or "field:<id>" for a field.
type ref struct{ Target, Via string }

// Ref sources stored in artifact_refs.
const RefContent = "content"

// RefText is the via of a link in a document's text (to an item, or to a
// section of a document).
const RefText = "text"

// extract turns a matched artifact file into a record. It never fails: a
// malformed file becomes a row with valid=false so the projection can
// always be rebuilt from whatever Git contains (direct pushes are supported).
func extract(m scanner.Match, sha string, content []byte) *record {
	r := &record{BlobSHA: sha, Valid: true, FieldsJ: "{}"}
	r.Path = m.Path
	r.Folder = m.Folder
	switch m.Category {
	case scanner.Artifact:
		r.GUID = m.GUID
		r.Kind = model.KindEntry
	case scanner.ConfigFile:
		k, _ := scanner.KindOf(m.ConfigKind)
		r.Kind = k
		if model.IsGUID(m.Name) {
			r.GUID = m.Name
		}
	}
	a, err := model.ParseArtifact(content, r.Kind)
	if err != nil {
		r.Valid, r.Error = false, err.Error()
		return r
	}
	if r.GUID != "" && a.GUID != r.GUID {
		r.Error = "guid in file differs from its location"
	}
	r.GUID = a.GUID
	if m.Category == scanner.Artifact && !a.Kind.IsFolderKind() {
		r.Valid, r.Error = false, "kind "+string(a.Kind)+" cannot live in an artifact directory"
		return r
	}
	if m.Category == scanner.ConfigFile && a.Kind != r.Kind {
		r.Valid, r.Error = false, "kind "+string(a.Kind)+" stored under "+m.ConfigKind
		return r
	}
	if verr := a.Validate(); verr != nil {
		r.Valid, r.Error = false, verr.Error()
	}
	r.Kind, r.Type, r.Title, r.HID = a.Kind, a.Type, clean(a.Title), a.HID
	r.Base, r.Source, r.Target, r.Subject, r.Parent = a.Base, a.Source, a.Target, a.Subject, a.Parent
	r.Author, r.Created = clean(a.Author), a.Created
	if a.Kind == model.KindComment {
		r.Excerpt = clean(model.Excerpt(a.Text))
	}
	if a.Fields != nil {
		plain := ojson.ToPlain(a.Fields)
		if b, err := json.Marshal(plain); err == nil {
			r.FieldsJ = clean(string(b))
		}
		if pm, ok := plain.(map[string]any); ok {
			r.Fields = pm
		}
		for _, k := range a.Fields.Keys() {
			v, _ := a.Fields.Get(k)
			// a workflow field is found by its state, like an enumeration; the
			// transition that led there and the state before it by <id>.transition
			// and <id>.previous
			if wv, ok := model.ParseWorkflowValue(v); ok {
				r.Index = append(r.Index, fieldKV{k, trunc(wv.State)})
				if wv.Transition != "" {
					r.Index = append(r.Index, fieldKV{k + ".transition", trunc(wv.Transition)})
				}
				if wv.Previous != "" {
					r.Index = append(r.Index, fieldKV{k + ".previous", trunc(wv.Previous)})
				}
				continue
			}
			for _, s := range scalarStrings(v) {
				r.Index = append(r.Index, fieldKV{k, trunc(s)})
			}
			if text := wholeText(v); text != "" {
				r.Texts = append(r.Texts, fieldKV{k, text})
			}
			for _, g := range guidsIn(v) {
				r.Refs = append(r.Refs, ref{g, "field:" + k})
			}
		}
	}
	if a.Kind == model.KindDocument {
		for _, g := range model.ContentRefs(a.Content) {
			if model.IsGUID(g) {
				r.Refs = append(r.Refs, ref{g, RefContent})
			}
		}
		for _, g := range model.ContentLinks(a.Content) {
			r.Refs = append(r.Refs, ref{g, RefText})
		}
	}
	r.Search = searchText(a)
	return r
}

func searchText(a *model.Artifact) string {
	var b strings.Builder
	add := func(s string) {
		if s == "" || b.Len() > maxSearchBytes {
			return
		}
		b.WriteString(s)
		b.WriteByte('\n')
	}
	add(a.Title)
	add(a.HID)
	add(a.Type)
	add(a.Text)
	add(a.Author)
	if a.Fields != nil {
		var walk func(v any, depth int)
		walk = func(v any, depth int) {
			if depth > 8 || b.Len() > maxSearchBytes {
				return
			}
			if depth == 1 && model.IsRichText(v) {
				// the text as it reads, without formatting names or words split by formatting
				add(model.RichTextPlain(v))
				return
			}
			switch t := v.(type) {
			case string:
				add(t)
			case []any:
				for _, e := range t {
					walk(e, depth+1)
				}
			case *ojson.Object:
				for _, k := range t.Keys() {
					e, _ := t.Get(k)
					walk(e, depth+1)
				}
			}
		}
		walk(a.Fields, 0)
	}
	if a.Kind == model.KindDocument {
		add(model.ContentText(a.Content))
	}
	s := b.String()
	if len(s) > maxSearchBytes {
		s = s[:maxSearchBytes]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return clean(s)
}

func scalarStrings(v any) []string {
	if model.IsRichText(v) {
		return []string{model.RichTextPlain(v)} // filtered and sorted by its text, as for a plain text
	}
	switch t := v.(type) {
	case string:
		return []string{t}
	case bool:
		if t {
			return []string{"true"}
		}
		return []string{"false"}
	case json.Number:
		return []string{string(t)}
	case []any:
		var out []string
		for _, e := range t {
			switch s := e.(type) {
			case string:
				out = append(out, s)
			case json.Number:
				out = append(out, string(s))
			case bool:
				out = append(out, scalarStrings(s)...)
			}
		}
		return out
	}
	return nil
}

// wholeText is the whole text of a text value (several values one per
// line), for the field's word index. Numbers and booleans have none.
func wholeText(v any) string {
	var parts []string
	if model.IsRichText(v) {
		parts = []string{model.RichTextPlain(v)}
	} else {
		switch t := v.(type) {
		case string:
			parts = []string{t}
		case []any:
			for _, e := range t {
				if s, ok := e.(string); ok {
					parts = append(parts, s)
				}
			}
		}
	}
	text := clean(strings.TrimSpace(strings.Join(parts, "\n")))
	if len(text) > maxFieldText {
		text = strings.ToValidUTF8(text[:maxFieldText], "")
	}
	return text
}

func guidsIn(v any) []string {
	if model.IsRichText(v) {
		return model.RichTextRefs(v) // the items its links go to
	}
	switch t := v.(type) {
	case string:
		if model.IsGUID(t) {
			return []string{t}
		}
	case []any:
		var out []string
		for _, e := range t {
			if s, ok := e.(string); ok && model.IsGUID(s) {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// clean strips bytes PostgreSQL rejects in text/jsonb (NUL) and invalid UTF-8.
func clean(s string) string {
	if !strings.ContainsRune(s, 0) && utf8.ValidString(s) && !strings.Contains(s, `\u0000`) {
		return s
	}
	s = strings.ReplaceAll(s, "\x00", "")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	s = strings.ReplaceAll(s, `\u0000`, "")
	return s
}

func trunc(s string) string {
	s = clean(s)
	if len(s) > maxFieldValue {
		s = s[:maxFieldValue]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// ConfigRecord is a projected configuration or scanner file.
type ConfigRecord struct {
	Path     string `json:"path"`
	Scope    string `json:"scope"`
	Category string `json:"category"`
	Name     string `json:"name"`
	BlobSHA  string `json:"etag"`
	Data     []byte `json:"data,omitempty"`
	Valid    bool   `json:"valid"`
	Error    string `json:"error,omitempty"`
}

// extractConfig validates a configuration file for its category.
func extractConfig(m scanner.Match, sha string, content []byte) *ConfigRecord {
	c := &ConfigRecord{Path: m.Path, Scope: m.Folder, Category: m.ConfigKind, Name: m.Name, BlobSHA: sha, Valid: true}
	var err error
	switch m.ConfigKind {
	case scanner.ConfigConfig:
		_, _, err = model.ParseConfigFile(m.Name, content)
	case scanner.ConfigScanner:
		_, err = scanner.ParseConfig(content)
	case scanner.ConfigAccess:
		_, err = model.ParseAccess(content)
	}
	if err != nil {
		c.Valid, c.Error = false, err.Error()
	}
	if json.Valid(content) {
		c.Data = []byte(clean(string(content)))
	}
	return c
}
