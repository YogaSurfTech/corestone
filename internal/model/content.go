package model

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// Document content (docs/design/Corestone documents.md) is the list of the
// root's children: the document is the root of a tree of sections, its title
// the root's heading, its own content the introduction. A node is one of:
//
//	{"text": …}                                a paragraph, as in rich-text fields
//	{"table": …}                               a table, as in rich-text fields
//	{"entry": "<guid>", "view": "card", "pin": "<commit>"}   an entry placed here
//	{"toc": "sections", "depth": 3}           a generated list (sections, figures, tables)
//	{"section": "<id>", "title": "Scope", "children": [ … ]}  a section
//
// A section's id is 8 characters a-z0-9, unique in the document and
// permanent; its title is one line of plain text. A list holds its content
// first, then its sections. An entry is placed at most once per document.
const (
	maxSectionDepth = 16
	maxNodes        = 20000
	maxTitleLen     = 500
	// MaxDocumentText is the longest text a document holds, in bytes.
	MaxDocumentText = 16 * MaxTextLen
)

var (
	sectionID = regexp.MustCompile(`^[a-z0-9]{8}$`)
	viewID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	commitID  = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// IsSectionID reports whether s has the form of a section id.
func IsSectionID(s string) bool { return sectionID.MatchString(s) }

// ValidateContent checks a document's content.
func ValidateContent(nodes []any) error {
	v := contentCheck{ids: map[string]bool{}, entries: map[string]bool{}}
	if err := v.list("document", nodes, 0); err != nil {
		return err
	}
	if v.text > MaxDocumentText {
		return Invalid("document text longer than %d bytes", MaxDocumentText)
	}
	return nil
}

type contentCheck struct {
	ids     map[string]bool
	entries map[string]bool
	nodes   int
	text    int
}

func (v *contentCheck) list(at string, nodes []any, depth int) error {
	inSections := false
	for i, raw := range nodes {
		v.nodes++
		if v.nodes > maxNodes {
			return Invalid("document has more than %d parts", maxNodes)
		}
		o, ok := raw.(*ojson.Object)
		if !ok {
			return Invalid("%s, part %d is not an object", at, i+1)
		}
		where := at + ", part " + strconv.Itoa(i+1)
		if _, old := o.Get("type"); old {
			return Invalid("%s uses the old document format (\"type\"); documents are written in the new format now", where)
		}
		if _, isSection := o.Get("section"); isSection {
			inSections = true
			if err := v.section(where, o, depth); err != nil {
				return err
			}
			continue
		}
		if inSections {
			return Invalid("%s: content follows a section; a section's content comes before its subsections", where)
		}
		var err error
		switch {
		case has(o, "entry"):
			err = v.entry(where, o)
		case has(o, "toc"):
			err = toc(where, o)
		default: // a paragraph or a table, as in rich-text fields
			var n int
			n, err = validateRichBlocks(where, []any{o}, false)
			v.text += n
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (v *contentCheck) section(at string, o *ojson.Object, depth int) error {
	if depth >= maxSectionDepth {
		return Invalid("%s: sections nested deeper than %d", at, maxSectionDepth)
	}
	id := o.String("section")
	if !IsSectionID(id) {
		return Invalid("%s: a section id is 8 characters a-z and 0-9", at)
	}
	if v.ids[id] {
		return Invalid("%s: section id %s is used twice", at, id)
	}
	v.ids[id] = true
	for _, k := range o.Keys() {
		val, _ := o.Get(k)
		switch k {
		case "section":
		case "title":
			s, ok := val.(string)
			if !ok || strings.ContainsAny(s, "\n\r") || len(s) > maxTitleLen {
				return Invalid("%s: a section title is one line of text, at most %d bytes", at, maxTitleLen)
			}
			v.text += len(s)
		case "children":
			if _, ok := val.([]any); !ok {
				return Invalid("%s: children is a list", at)
			}
		default:
			return Invalid("%s: unknown property %q", at, k)
		}
	}
	return v.list("section "+id, o.Array("children"), depth+1)
}

func (v *contentCheck) entry(at string, o *ojson.Object) error {
	g := o.String("entry")
	if !IsGUID(g) {
		return Invalid("%s: entry is an entry id (GUID)", at)
	}
	if v.entries[g] {
		return Invalid("%s: entry %s is placed more than once; an entry is in a document at most once", at, g)
	}
	v.entries[g] = true
	for _, k := range o.Keys() {
		val, _ := o.Get(k)
		switch k {
		case "entry":
		case "view":
			if s, _ := val.(string); !viewID.MatchString(s) {
				return Invalid("%s: view is the id of an entry view", at)
			}
		case "pin":
			if s, _ := val.(string); !commitID.MatchString(s) {
				return Invalid("%s: pin is a commit id", at)
			}
		default:
			return Invalid("%s: unknown property %q", at, k)
		}
	}
	return nil
}

func toc(at string, o *ojson.Object) error {
	for _, k := range o.Keys() {
		val, _ := o.Get(k)
		switch k {
		case "toc":
			if s, _ := val.(string); s != "sections" && s != "figures" && s != "tables" {
				return Invalid("%s: toc is sections, figures or tables", at)
			}
		case "depth":
			if d, ok := integer(val); !ok || d < 1 || d > maxSectionDepth {
				return Invalid("%s: depth is a whole number from 1 to %d", at, maxSectionDepth)
			}
		default:
			return Invalid("%s: unknown property %q", at, k)
		}
	}
	return nil
}

func has(o *ojson.Object, k string) bool { _, ok := o.Get(k); return ok }

// walkContent calls fn for every node of a document's content, depth first in
// document order; a section before its children.
func walkContent(nodes []any, fn func(o *ojson.Object)) {
	for _, raw := range nodes {
		o, ok := raw.(*ojson.Object)
		if !ok {
			continue
		}
		fn(o)
		if has(o, "section") {
			walkContent(o.Array("children"), fn)
		}
	}
}

// ContentRefs collects the GUIDs of the entries placed in a document.
func ContentRefs(nodes []any) []string {
	var out []string
	walkContent(nodes, func(o *ojson.Object) {
		if g := o.String("entry"); g != "" {
			out = append(out, g)
		}
	})
	return out
}

// ContentLinks collects the items the document's text links to, each once
// (GUIDs; a link to a section counts as one to its document).
func ContentLinks(nodes []any) []string {
	var blocks []any
	walkContent(nodes, func(o *ojson.Object) {
		if has(o, "text") || has(o, "table") {
			blocks = append(blocks, o)
		}
	})
	var out []string
	seen := map[string]bool{}
	for _, g := range RichTextRefs(blocks) {
		if !seen[g] {
			seen[g] = true
			out = append(out, g)
		}
	}
	return out
}

// ContentText extracts the readable text of a document for search: section
// titles and paragraphs, one per line (lists numbered as they read).
func ContentText(nodes []any) string {
	var lines []string
	var walk func([]any)
	walk = func(list []any) {
		var run []any // consecutive paragraphs and tables, read together
		flush := func() {
			if len(run) > 0 {
				lines = append(lines, RichTextPlain(run))
				run = nil
			}
		}
		for _, raw := range list {
			o, ok := raw.(*ojson.Object)
			if !ok {
				continue
			}
			switch {
			case has(o, "text") || has(o, "table"):
				run = append(run, o)
			case has(o, "section"):
				flush()
				lines = append(lines, o.String("title"))
				walk(o.Array("children"))
			default:
				flush()
			}
		}
		flush()
	}
	walk(nodes)
	return strings.Join(lines, "\n")
}
