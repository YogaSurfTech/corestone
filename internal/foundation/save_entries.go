package foundation

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// SaveEntry is an entry made in a document and created with the document's
// save. Key is the name the document uses for it until it has a GUID
// ("new:…", in placements and cross-references); the server makes the GUID.
type SaveEntry struct {
	Key string
	// Request holds path (absent: the document's folder), type, title, hid
	// and fields, as for creating an entry.
	Request *ojson.Object
	Files   []SaveFile
}

var newEntryKey = regexp.MustCompile(`^new:[A-Za-z0-9_-]{1,40}$`)

// addEntries creates the new entries of a document's save, each checked as
// any new entry, and returns the document content with their keys replaced
// by their GUIDs (patch unchanged when there are none). Every new entry must
// be used by the content, and every key the content uses must be a new entry.
func (t *txn) addEntries(doc *loaded, req *SaveRequest, step func(*changeset, error) error) (*ojson.Object, map[string]string, error) {
	if len(req.AddEntries) == 0 {
		return req.Patch, nil, nil
	}
	if doc.Kind != model.KindDocument {
		return nil, nil, model.Invalid("new entries are saved with a document, not with %s", label(doc.Artifact))
	}
	var content []any
	if req.Patch != nil {
		content = req.Patch.Array("content")
	}
	used := map[string]bool{}
	walkKeys(content, func(key string) string { used[key] = true; return key })
	created := map[string]string{}
	for _, e := range req.AddEntries {
		if !newEntryKey.MatchString(e.Key) {
			return nil, nil, model.Invalid("new entry %q: its key must be new: and up to 40 letters, digits, - or _", e.Key)
		}
		if _, dup := created[e.Key]; dup {
			return nil, nil, model.Invalid("new entry %s is given twice", e.Key)
		}
		name := e.Key
		if e.Request != nil && strings.TrimSpace(e.Request.String("title")) != "" {
			name = fmt.Sprintf("%q", strings.TrimSpace(e.Request.String("title")))
		}
		if !used[e.Key] {
			return nil, nil, model.Invalid("new entry %s is not in the document", name)
		}
		r := ojson.NewObject()
		if e.Request != nil {
			r = e.Request.Clone()
		}
		if r.String("path") == "" && doc.Loc != nil {
			r.Set("path", doc.Loc.Folder)
		}
		cs, err := t.createArtifact(model.KindEntry, r)
		if err == nil {
			err = step(cs, nil)
		}
		if err != nil {
			return nil, nil, aboutEntry(name, err)
		}
		guid := cs.event.GUID
		created[e.Key] = guid
		for _, f := range e.Files {
			if err := step(t.putFile(guid, f.Name, f.Content)); err != nil {
				return nil, nil, aboutEntry(name, err)
			}
		}
	}
	for k := range used {
		if created[k] == "" {
			return nil, nil, model.Invalid("the document uses %s, which is not among its new entries", k)
		}
	}
	// the content with GUIDs (a copy: a retried save starts from the request again)
	patch := req.Patch.Clone()
	fixed := ojson.Clone(content).([]any)
	walkKeys(fixed, func(key string) string { return created[key] })
	patch.Set("content", fixed)
	return patch, created, nil
}

// walkKeys calls f for each new-entry key in document content (placements'
// entry, references' ref before "#") and puts what f returns in its place.
func walkKeys(v any, f func(key string) string) {
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			walkKeys(e, f)
		}
	case *ojson.Object:
		for _, k := range x.Keys() {
			val, _ := x.Get(k)
			if s, ok := val.(string); ok && strings.HasPrefix(s, "new:") && (k == "entry" || k == "ref") {
				key, rest, _ := strings.Cut(s, "#")
				if rest != "" {
					rest = "#" + rest
				}
				x.Set(k, f(key)+rest)
				continue
			}
			walkKeys(val, f)
		}
	}
}

// aboutEntry names the new entry in an error, after its kind (the API shows
// what follows the kind: "validation failed: new entry "X": …").
func aboutEntry(name string, err error) error {
	for _, kind := range []error{model.ErrValidation, model.ErrNotFound, model.ErrConflict} {
		if errors.Is(err, kind) {
			msg := err.Error()
			if i := strings.Index(msg, kind.Error()+": "); i >= 0 {
				msg = msg[i+len(kind.Error())+2:]
			}
			return fmt.Errorf("%w: new entry %s: %s", kind, name, msg)
		}
	}
	return fmt.Errorf("new entry %s: %w", name, err)
}
