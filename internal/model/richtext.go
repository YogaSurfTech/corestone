package model

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// Rich text (field type "richtext") is stored either as a plain string,
// lines separated by "\n", or as a list of blocks, one per paragraph:
//
//	{"text": "plain line"}
//	{"align": "center", "text": [{"text": "Housing", "bold": true, "color": "#1565c0"}]}
//	{"list": "ol", "level": 2, "text": "one.one"}
//
// text is a string or a list of runs (text with its formatting); "\n"
// inside a text is a line break within the paragraph. list makes the
// paragraph a list item (ul bulleted, ol numbered) at level (1 when absent).
// The editor (web/packages/editor) writes this form; see its model.ts.

const maxListLevel = 9

var hexColor = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// ValidateRichText checks a rich-text value.
func ValidateRichText(what string, v any) error {
	if s, ok := v.(string); ok {
		return ValidateText(what, s, MaxTextLen)
	}
	blocks, ok := v.([]any)
	if !ok {
		return Invalid("%s expects text or a list of paragraphs", what)
	}
	total := 0
	for i, b := range blocks {
		at := what + " paragraph " + strconv.Itoa(i+1)
		o, ok := b.(*ojson.Object)
		if !ok {
			return Invalid("%s is not an object", at)
		}
		n, err := validateBlock(at, o)
		if err != nil {
			return err
		}
		total += n
	}
	if total > MaxTextLen {
		return Invalid("%s longer than %d bytes", what, MaxTextLen)
	}
	return nil
}

// validateBlock checks one paragraph and returns the length of its text.
func validateBlock(at string, o *ojson.Object) (int, error) {
	n := 0
	for _, k := range o.Keys() {
		v, _ := o.Get(k)
		switch k {
		case "text":
			l, err := validateInline(at, v)
			if err != nil {
				return 0, err
			}
			n = l
		case "align":
			if s, _ := v.(string); s != "center" && s != "right" && s != "justify" {
				return 0, Invalid("%s: align is center, right or justify", at)
			}
		case "list":
			if s, _ := v.(string); s != "ul" && s != "ol" {
				return 0, Invalid("%s: list is ul or ol", at)
			}
		case "level":
			if _, ok := o.Get("list"); !ok {
				return 0, Invalid("%s: level without list", at)
			}
			if l, ok := integer(v); !ok || l < 1 || l > maxListLevel {
				return 0, Invalid("%s: level is 1 to %d", at, maxListLevel)
			}
		default:
			return 0, Invalid("%s: unknown property %q", at, k)
		}
	}
	if _, ok := o.Get("text"); !ok {
		return 0, Invalid("%s has no text", at)
	}
	return n, nil
}

func validateInline(at string, v any) (int, error) {
	if s, ok := v.(string); ok {
		return len(s), ValidateText(at, s, MaxTextLen)
	}
	runs, ok := v.([]any)
	if !ok {
		return 0, Invalid("%s: text is a string or a list of runs", at)
	}
	n := 0
	for _, r := range runs {
		o, ok := r.(*ojson.Object)
		if !ok {
			return 0, Invalid("%s: a run is not an object", at)
		}
		s, ok := o.Get("text")
		text, isStr := s.(string)
		if !ok || !isStr || text == "" {
			return 0, Invalid("%s: a run needs a text", at)
		}
		if err := ValidateText(at, text, MaxTextLen); err != nil {
			return 0, err
		}
		n += len(text)
		for _, k := range o.Keys() {
			v, _ := o.Get(k)
			switch k {
			case "text":
			case "bold", "italic", "underline", "strike", "sub", "sup":
				if v != true {
					return 0, Invalid("%s: %s is true or absent", at, k)
				}
			case "color", "bg":
				if s, _ := v.(string); !hexColor.MatchString(s) {
					return 0, Invalid("%s: %s is a colour #rrggbb", at, k)
				}
			case "font":
				if s, _ := v.(string); s == "" || len(s) > 100 || strings.ContainsAny(s, "\n;{}") {
					return 0, Invalid("%s: font is a font name", at)
				}
			case "size":
				if f, ok := number(v); !ok || f < 6 || f > 96 {
					return 0, Invalid("%s: size is 6 to 96 points", at)
				}
			default:
				return 0, Invalid("%s: unknown formatting %q", at, k)
			}
		}
		if _, sub := o.Get("sub"); sub {
			if _, sup := o.Get("sup"); sup {
				return 0, Invalid("%s: a run is not subscript and superscript at once", at)
			}
		}
	}
	return n, nil
}

func number(v any) (float64, bool) {
	switch t := v.(type) {
	case ojson.Number:
		f, err := t.Float64()
		return f, err == nil
	case float64:
		return t, true
	case int:
		return float64(t), true
	}
	return 0, false
}

func integer(v any) (int, bool) {
	f, ok := number(v)
	if !ok || f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

// IsRichText reports whether a value has the shape of rich text in
// paragraphs: a non-empty list of objects that all have "text". Rich text
// is the only field type with that shape, so a value can be recognised
// without its field definition (search, file layout).
func IsRichText(v any) bool {
	blocks, ok := v.([]any)
	if !ok || len(blocks) == 0 {
		return false
	}
	for _, b := range blocks {
		o, ok := b.(*ojson.Object)
		if !ok {
			return false
		}
		if _, ok := o.Get("text"); !ok {
			return false
		}
	}
	return true
}

// RichTextPlain is the plain text of a rich-text value, for search and
// previews: one line per paragraph, list items with their marker, numbered
// lists numbered across levels as the editor shows them (1.2.1.).
func RichTextPlain(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	blocks, _ := v.([]any)
	var lines []string
	type level struct {
		kind  string
		count int
	}
	var stack []level // the open lists, outermost first
	for _, b := range blocks {
		o, _ := b.(*ojson.Object)
		if o == nil {
			continue
		}
		text := inlinePlain(o)
		kind := o.String("list")
		if kind == "" {
			stack = stack[:0]
			lines = append(lines, text)
			continue
		}
		lv, _ := o.Get("level")
		lvl, ok := integer(lv)
		if !ok || lvl < 1 {
			lvl = 1
		}
		if lvl > len(stack)+1 {
			lvl = len(stack) + 1 // a level cannot be skipped
		}
		if lvl < len(stack) {
			stack = stack[:lvl] // deeper lists end
		}
		if lvl > len(stack) {
			stack = append(stack, level{kind: kind})
		} else if stack[lvl-1].kind != kind {
			stack[lvl-1] = level{kind: kind} // another kind of list starts, counting from 1
		}
		stack[lvl-1].count++
		marker := "• "
		if kind == "ol" {
			var nums []string
			for _, l := range stack {
				if l.kind == "ol" {
					nums = append(nums, strconv.Itoa(l.count))
				}
			}
			marker = strings.Join(nums, ".") + ". "
		}
		lines = append(lines, strings.Repeat("  ", lvl-1)+marker+text)
	}
	return strings.Join(lines, "\n")
}

func inlinePlain(o *ojson.Object) string {
	v, _ := o.Get("text")
	if s, ok := v.(string); ok {
		return s
	}
	var b strings.Builder
	runs, _ := v.([]any)
	for _, r := range runs {
		if ro, ok := r.(*ojson.Object); ok {
			b.WriteString(ro.String("text"))
		}
	}
	return b.String()
}
