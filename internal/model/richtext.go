package model

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// Rich text (field type "richtext") is stored either as a plain string,
// lines separated by "\n", or as a list of blocks, one per paragraph or table:
//
//	{"text": "plain line"}
//	{"align": "center", "text": [{"text": "Housing", "bold": true, "color": "#1565c0"}]}
//	{"list": "ol", "level": 2, "text": "one.one"}
//	{"stripes": "rows", "widths": [120, null], "table": [[{"content": "Name", "header": true}, "Value"], [{"content": "both", "colspan": 2}]]}
//
// text is a string or a list of runs (text with its formatting); "\n"
// inside a text is a line break within the paragraph. A run may be a link:
// href to a web address (http(s), ftp(s), mailto), or ref to an item (GUID). list makes the
// paragraph a list item (ul bulleted, ol numbered) at level (1 when absent).
// A table has rows of cells; a cell is rich text itself (anything but a
// table), or, when formatted, an object with its content, header (formatted
// as a header cell) and colspan/rowspan; the cells a spanning cell covers are
// left out, as in HTML. stripes shades every other row or column (colors:
// the two stripe colours, absent: the theme's), borders
// draws only some lines (absent: the full grid), widths are the column widths
// in pixels (null: automatic).
// The editor (web/packages/editor) writes this form; see its model.ts.

const (
	maxListLevel  = 9
	maxSpan       = 100
	maxTableCells = 10000
)

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
	total, err := validateRichBlocks(what, blocks, false)
	if err != nil {
		return err
	}
	if total > MaxTextLen {
		return Invalid("%s longer than %d bytes", what, MaxTextLen)
	}
	return nil
}

// validateRichBlocks checks a list of blocks (a value's, or a table cell's) and
// returns the length of their text.
func validateRichBlocks(what string, blocks []any, inCell bool) (int, error) {
	total := 0
	for i, b := range blocks {
		at := what + " paragraph " + strconv.Itoa(i+1)
		o, ok := b.(*ojson.Object)
		if !ok {
			return 0, Invalid("%s is not an object", at)
		}
		var n int
		var err error
		if _, isTable := o.Get("table"); isTable {
			if inCell {
				return 0, Invalid("%s: no tables in tables", at)
			}
			n, err = validateTable(what+" table "+strconv.Itoa(i+1), o)
		} else {
			n, err = validateBlock(at, o)
		}
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}

// validateTable checks a table block and returns the length of its text.
func validateTable(at string, o *ojson.Object) (int, error) {
	for _, k := range o.Keys() {
		v, _ := o.Get(k)
		switch k {
		case "table":
		case "stripes":
			if v != "rows" && v != "columns" {
				return 0, Invalid("%s: stripes is rows or columns", at)
			}
		case "colors":
			cs, ok := v.([]any)
			if !ok || len(cs) != 2 {
				return 0, Invalid("%s: colors is the two stripe colors", at)
			}
			for _, c := range cs {
				if s, _ := c.(string); !hexColor.MatchString(s) {
					return 0, Invalid("%s: a stripe color is #rrggbb", at)
				}
			}
		case "borders":
			if v != "outside" && v != "rows" && v != "columns" && v != "none" {
				return 0, Invalid("%s: borders is outside, rows, columns or none", at)
			}
		case "widths":
			ws, ok := v.([]any)
			if !ok {
				return 0, Invalid("%s: widths is a list of column widths", at)
			}
			for _, w := range ws {
				if w == nil {
					continue
				}
				if f, ok := number(w); !ok || f < 10 || f > 4000 {
					return 0, Invalid("%s: a column width is 10 to 4000 pixels, or null", at)
				}
			}
		default:
			return 0, Invalid("%s: unknown property %q", at, k)
		}
	}
	tv, _ := o.Get("table")
	rows, ok := tv.([]any)
	if !ok || len(rows) == 0 {
		return 0, Invalid("%s: table is a list of rows", at)
	}
	n, count := 0, 0
	for r, rv := range rows {
		cells, ok := rv.([]any)
		if !ok || len(cells) == 0 {
			return 0, Invalid("%s row %d: a row is a list of cells", at, r+1)
		}
		for c, cv := range cells {
			if count++; count > maxTableCells {
				return 0, Invalid("%s: more than %d cells", at, maxTableCells)
			}
			cat := at + " row " + strconv.Itoa(r+1) + " cell " + strconv.Itoa(c+1)
			l, err := validateCell(cat, cv)
			if err != nil {
				return 0, err
			}
			n += l
		}
	}
	return n, nil
}

// validateCell checks a table cell: rich text, or an object with its content and spans.
func validateCell(at string, v any) (int, error) {
	if o, ok := v.(*ojson.Object); ok {
		content, has := o.Get("content")
		if !has {
			return 0, Invalid("%s: a formatted cell has a content", at)
		}
		for _, k := range o.Keys() {
			switch k {
			case "content":
			case "header":
				if hv, _ := o.Get(k); hv != true {
					return 0, Invalid("%s: header is true or absent", at)
				}
			case "colspan", "rowspan":
				sv, _ := o.Get(k)
				if n, ok := integer(sv); !ok || n < 1 || n > maxSpan {
					return 0, Invalid("%s: %s is 1 to %d", at, k, maxSpan)
				}
			default:
				return 0, Invalid("%s: unknown property %q", at, k)
			}
		}
		v = content
	}
	switch t := v.(type) {
	case string:
		return len(t), ValidateText(at, t, MaxTextLen)
	case []any:
		return validateRichBlocks(at, t, true)
	}
	return 0, Invalid("%s: a cell is text, a list of paragraphs, or an object with content", at)
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
			case "href":
				if s, _ := v.(string); len(s) > 2048 || !SafeURL(s) {
					return 0, Invalid("%s: href is a web address (http, https, ftp or mailto)", at)
				}
			case "ref":
				if s, _ := v.(string); !IsGUID(s) {
					return 0, Invalid("%s: ref is an item id (GUID)", at)
				}
			default:
				return 0, Invalid("%s: unknown formatting %q", at, k)
			}
		}
		if _, href := o.Get("href"); href {
			if _, ref := o.Get("ref"); ref {
				return 0, Invalid("%s: a link goes to a web address or an item, not both", at)
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

// RichTextRefs returns the items a rich-text value links to (ref of its
// runs), also in table cells.
func RichTextRefs(v any) []string {
	var out []string
	var walk func(v any)
	walk = func(v any) {
		blocks, _ := v.([]any)
		for _, b := range blocks {
			o, _ := b.(*ojson.Object)
			if o == nil {
				continue
			}
			if tv, ok := o.Get("table"); ok {
				forCells(tv, walk)
				continue
			}
			text, _ := o.Get("text")
			list, _ := text.([]any)
			for _, r := range list {
				if ro, ok := r.(*ojson.Object); ok {
					if g := ro.String("ref"); g != "" {
						out = append(out, g)
					}
				}
			}
		}
	}
	walk(v)
	return out
}

// forCells calls f with the content of every cell of a table's rows.
func forCells(rows any, f func(content any)) {
	rs, _ := rows.([]any)
	for _, r := range rs {
		cells, _ := r.([]any)
		for _, c := range cells {
			if o, ok := c.(*ojson.Object); ok {
				c, _ = o.Get("content")
			}
			f(c)
		}
	}
}

// IsRichText reports whether a value has the shape of rich text in
// blocks: a non-empty list of objects that all have "text" (paragraphs) or
// "table". Rich text is the only field type with that shape, so a value can
// be recognised without its field definition (search, file layout).
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
		_, text := o.Get("text")
		_, table := o.Get("table")
		if !text && !table {
			return false
		}
	}
	return true
}

// RichTextPlain is the plain text of a rich-text value, for search and
// previews: one line per paragraph, list items with their marker, numbered
// lists numbered across levels as the editor shows them (1.2.1.), a table
// row per line with its cells separated by " | ".
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
		if tv, ok := o.Get("table"); ok {
			// a row per line, its cells separated by " | "
			stack = stack[:0]
			rows, _ := tv.([]any)
			for _, r := range rows {
				var cells []string
				forCells([]any{r}, func(c any) {
					cells = append(cells, strings.Join(strings.Fields(RichTextPlain(c)), " "))
				})
				lines = append(lines, strings.Join(cells, " | "))
			}
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
