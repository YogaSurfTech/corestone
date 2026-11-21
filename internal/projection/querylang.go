package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/query"
)

// The query language (TSK-13) on the projection: a parsed query becomes
// one SQL condition on an artifact. What a field means comes from the
// configuration: its types decide how a value matches (words for text,
// the id for an enumeration, a day for a date, ...).
//
// The language is forgiving: a criterion that names an unknown field or a
// value that cannot fit matches nothing and is reported as a warning. In
// strict mode a warning refuses the query.

// Warning is a criterion of a query that cannot match as written.
type Warning struct {
	Pos     int    `json:"pos"` // offset in the query text
	Message string `json:"message"`
}

// compiled is a condition whose values are bound when it is rendered: a
// filter is rendered more than once, each time numbering its own
// placeholders.
type compiled struct{ parts []any }

type bound struct{ v any }

func (c *compiled) render(arg func(any) string) string {
	var b strings.Builder
	for _, p := range c.parts {
		if v, ok := p.(bound); ok {
			b.WriteString(arg(v.v))
		} else {
			b.WriteString(p.(string))
		}
	}
	return b.String()
}

// queryEnv is what the configuration says about fields, for one query.
type queryEnv struct {
	// conf is the configuration of every (folder, type) pair with artifacts.
	conf string
	// types are the field types an id has anywhere; options the values its
	// enumerations and workflows know, nil when one of them takes any value.
	types   map[string]map[model.FieldType]bool
	options map[string]map[string]bool
	open    map[string]bool
	dynamic map[string]bool // enumerations whose options are artifacts
	// links are the link types that are defined at the root or in use.
	links map[string]bool
	cfg   *model.ConfigIndex
}

func (p *DB) queryEnv(ctx context.Context) (*queryEnv, error) {
	cfg, err := p.Config(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT DISTINCT folder, type, kind FROM artifacts`)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	env := &queryEnv{types: map[string]map[model.FieldType]bool{}, options: map[string]map[string]bool{}, open: map[string]bool{}, dynamic: map[string]bool{},
		links: map[string]bool{}, cfg: cfg}
	conf := map[string]map[string]*typeConfig{}
	for rows.Next() {
		var folder, typ, kind string
		if err := rows.Scan(&folder, &typ, &kind); err != nil {
			return nil, unavailable(err)
		}
		if kind == string(model.KindLink) {
			env.links[typ] = true
		}
		schema := cfg.Effective(typ, folder)
		tc := newTypeConfig(cfg, folder, typ)
		if schema == nil || tc == nil {
			continue
		}
		tc.Final = map[string]map[string]bool{}
		for _, f := range schema.Fields {
			if env.types[f.ID] == nil {
				env.types[f.ID], env.options[f.ID] = map[model.FieldType]bool{}, map[string]bool{}
			}
			env.types[f.ID][f.Type] = true
			switch f.Type {
			case model.FieldEnum:
				env.open[f.ID] = env.open[f.ID] || f.Extendable || f.Source != nil
				env.dynamic[f.ID] = env.dynamic[f.ID] || f.Source != nil
				for _, o := range f.Options {
					env.options[f.ID][o.Value] = true
				}
			case model.FieldWorkflow:
				tc.Final[f.ID] = map[string]bool{}
				if wf := cfg.Workflow(typ, f.Workflow, folder); wf != nil {
					for _, st := range wf.States {
						env.options[f.ID][st.ID] = true
						if st.Final {
							tc.Final[f.ID][st.ID] = true
						}
					}
				} else {
					env.open[f.ID] = true
				}
			}
		}
		if conf[folder] == nil {
			conf[folder] = map[string]*typeConfig{}
		}
		conf[folder][typ] = tc
	}
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	b, err := json.Marshal(conf)
	if err != nil {
		return nil, err
	}
	env.conf = string(b)
	return env, nil
}

// CompileQuery parses a query text and checks it against the
// configuration, without running it: the tree and the warnings.
func (p *DB) CompileQuery(ctx context.Context, text string) (*query.Node, []Warning, error) {
	tree, _, warnings, err := p.compileQuery(ctx, text, false)
	return tree, warnings, err
}

func (p *DB) compileQuery(ctx context.Context, text string, strict bool) (*query.Node, *compiled, []Warning, error) {
	tree, err := query.Parse(text)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: %s", model.ErrValidation, err.Error())
	}
	if tree == nil {
		return nil, nil, nil, nil
	}
	env, err := p.queryEnv(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	c := &compiler{env: env, warnings: []Warning{}}
	out := &compiled{parts: c.node(tree, "a")}
	if strict && len(c.warnings) > 0 {
		w := c.warnings[0]
		return nil, nil, nil, fmt.Errorf("%w: query, position %d: %s", model.ErrValidation, w.Pos+1, w.Message)
	}
	return tree, out, c.warnings, nil
}

type compiler struct {
	env      *queryEnv
	warnings []Warning
	links    int // has_link criteria so far, for their table aliases
}

// never is a criterion that cannot match, with the reason as a warning.
func (c *compiler) never(n *query.Node, format string, args ...any) []any {
	c.warnings = append(c.warnings, Warning{Pos: n.Pos, Message: fmt.Sprintf(format, args...)})
	return []any{"FALSE"}
}

func seq(parts ...any) []any { return parts }

func (c *compiler) node(n *query.Node, a string) []any {
	switch n.Op {
	case query.Not:
		return append(append(seq("(NOT "), c.node(n.Children[0], a)...), ")")
	case query.And, query.Or, query.Xor:
		children := n.Children
		if n.Op == query.Or && n.Implicit {
			children = allWords(children)
		}
		sep := map[string]string{query.And: " AND ", query.Or: " OR ", query.Xor: " <> "}[n.Op]
		out := seq("(")
		for i, ch := range children {
			if i > 0 {
				out = append(out, sep)
			}
			out = append(out, c.node(ch, a)...)
		}
		return append(out, ")")
	case query.Link:
		return c.link(n, a)
	}
	return append(append(seq("COALESCE(("), c.term(n, a)...), "), FALSE)")
}

// link is has_link: the artifact has a link of the type to an artifact
// that matches the inner query. The artifact is the link's source and the
// inner query applies to the target; "~" turns that around.
func (c *compiler) link(n *query.Node, a string) []any {
	if s := c.env.cfg.Effective(n.LinkType, ""); !c.env.links[n.LinkType] && (s == nil || s.Kind != model.KindLink) {
		return c.never(n, "unknown link type %q", n.LinkType)
	}
	c.links++
	l, other := "l"+strconv.Itoa(c.links), "b"+strconv.Itoa(c.links)
	here, there := "source", "target"
	if n.Reverse {
		here, there = there, here
	}
	out := seq("EXISTS (SELECT 1 FROM artifacts "+l+" JOIN artifacts "+other+" ON "+other+".guid = "+l+"."+there+
		" WHERE "+l+".kind = 'link' AND "+l+"."+here+" = "+a+".guid AND "+l+".type = ", bound{n.LinkType})
	if n.Query != nil {
		out = append(append(out, " AND "), c.node(n.Query, other)...)
	}
	return append(out, ")")
}

// allWords joins values without a field that stand side by side into one
// search, exactly as the search box always worked: "table view" finds the
// artifacts that have both words, or the whole text in their title or HID.
// Quoted values stay criteria of their own, joined by AND. Criteria with a
// field side by side stay joined by OR.
func allWords(children []*query.Node) []*query.Node {
	bare := func(n *query.Node) bool { return n.Op == query.Term && n.Field == "" }
	var out []*query.Node
	for i := 0; i < len(children); {
		j := i
		for j < len(children) && bare(children[j]) {
			j++
		}
		if j-i < 2 {
			out = append(out, children[i])
			i++
			continue
		}
		var words []string
		var all []*query.Node
		for _, n := range children[i:j] {
			if n.Quoted || n.Null {
				all = append(all, n)
			} else {
				words = append(words, n.Value)
			}
		}
		if len(words) > 0 {
			all = append([]*query.Node{{Op: query.Term, Value: strings.Join(words, " "), Pos: children[i].Pos}}, all...)
		}
		if len(all) == 1 {
			out = append(out, all[0])
		} else {
			out = append(out, &query.Node{Op: query.And, Children: all, Pos: children[i].Pos})
		}
		i = j
	}
	return out
}

func tsquery(n *query.Node) []any {
	if n.Quoted {
		return seq("phraseto_tsquery('simple', ", bound{n.Value}, ")")
	}
	return seq("plainto_tsquery('simple', ", bound{n.Value}, ")")
}

func cat(parts ...[]any) []any {
	var out []any
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

var (
	numberRe = regexp.MustCompile(`^-?[0-9]{1,30}(\.[0-9]{1,30})?$`)
	dayRe    = regexp.MustCompile(`^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$`)
)

// dateRange is the time a (partial) date covers: its start and the start
// of what follows. Times without a zone are in the server's zone.
func dateRange(v string) (from, to time.Time, ok bool) {
	for _, l := range []struct {
		layout string
		next   func(time.Time) time.Time
	}{
		{"2006", func(t time.Time) time.Time { return t.AddDate(1, 0, 0) }},
		{"2006-01", func(t time.Time) time.Time { return t.AddDate(0, 1, 0) }},
		{"2006-01-02", func(t time.Time) time.Time { return t.AddDate(0, 0, 1) }},
		{"2006-01-02T15:04", func(t time.Time) time.Time { return t.Add(time.Minute) }},
		{"2006-01-02T15:04:05", func(t time.Time) time.Time { return t.Add(time.Second) }},
	} {
		if t, err := time.ParseInLocation(l.layout, v, time.Local); err == nil {
			return t, l.next(t), true
		}
	}
	return from, to, false
}

// ranged compares a value with a range [from, to): a match lies inside it,
// "<" before it, "<=" before its end, ">" after it, ">=" from its start.
func ranged(expr, compare string, from, to any) []any {
	switch compare {
	case "<":
		return seq(expr+" < ", bound{from})
	case "<=":
		return seq(expr+" < ", bound{to})
	case ">":
		return seq(expr+" >= ", bound{to})
	case ">=":
		return seq(expr+" >= ", bound{from})
	}
	return seq("("+expr+" >= ", bound{from}, " AND "+expr+" < ", bound{to}, ")")
}

func (c *compiler) term(n *query.Node, a string) []any {
	if n.Up > 0 && n.Field != "folder" {
		return c.never(n, "~%d is for folder only (folder~1 is the parent folder)", n.Up)
	}
	if n.Sub != "" {
		return c.field(n, a)
	}
	cmp := n.Compare
	text := func(expr string) []any { // a text column: equal, or compared, without case
		if n.Null {
			return seq("COALESCE(" + expr + ", '') = ''")
		}
		if cmp == "" {
			cmp = "="
		}
		return seq("lower("+expr+") "+cmp+" lower(", bound{n.Value}, ")")
	}
	switch n.Field {
	case "":
		if n.Null {
			return c.never(n, "NULL needs a field: field:NULL")
		}
		like := bound{"%" + escapeLike(n.Value) + "%"}
		return cat(seq("("+a+".tsv @@ "), tsquery(n), seq(" OR "+a+".hid ILIKE ", like, " OR "+a+".title ILIKE ", like, ")"))
	case "kind":
		return text(a + ".kind")
	case "type":
		return text(a + ".type")
	case "guid":
		return text(a + ".guid")
	case "author":
		return text("CASE WHEN " + a + ".kind = 'link' THEN " + a + ".created_author ELSE " + a + ".author END")
	case "title":
		if n.Null || cmp != "" {
			return text(a + ".title")
		}
		return cat(seq("(to_tsvector('simple', "+a+".title) @@ "), tsquery(n), seq(" OR lower("+a+".title) = lower(", bound{n.Value}, "))"))
	case "hid":
		if n.Null {
			return seq(a + ".hid IS NULL")
		}
		if cmp == "" {
			return seq("lower("+a+".hid) = lower(", bound{n.Value}, ")")
		}
		// natural order: TSK-9 before TSK-10
		v := bound{n.Value}
		return seq("("+a+".hid_prefix, COALESCE("+a+".hid_num, 0)) "+cmp+" (lower(regexp_replace(", v, "::text, '[0-9]+$', '')), COALESCE((substring(", v, "::text from '[0-9]+$'))::numeric, 0))")
	case "folder":
		return c.folder(n, a)
	case "created", "modified":
		col := a + "." + n.Field + "_at"
		if n.Null {
			return seq(col + " IS NULL")
		}
		from, to, ok := dateRange(n.Value)
		if !ok {
			return c.never(n, "%q is no date (2026, 2026-11, 2026-11-17 or 2026-11-17T14:30)", n.Value)
		}
		return ranged(col, cmp, from, to)
	case "valid", "finished":
		if n.Null || cmp != "" || (n.Value != "true" && n.Value != "false") {
			return c.never(n, "%s is true or false", n.Field)
		}
		expr := a + ".valid"
		if n.Field == "finished" {
			// every workflow field of the artifact's type is in a final state; without one, never
			wf := "COALESCE(" + c.conf(a, "'workflows'") + ", '[]'::jsonb)"
			expr = "(jsonb_array_length(" + wf + ") > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(" + wf + ") w (id) WHERE " +
				c.conf(a, "'final'", "w.id", "COALESCE("+a+".fields -> w.id ->> 'state', '')") + " IS NULL))"
		}
		if n.Value == "false" {
			return c.bind("(NOT " + expr + ")")
		}
		return c.bind(expr)
	}
	return c.field(n, a)
}

// confMark stands for the configuration parameter in a condition's text.
const confMark = "\x00conf\x00"

// conf looks up path in the configuration of the artifact's (folder, type).
func (c *compiler) conf(a string, path ...string) string {
	return "(" + confMark + " #> ARRAY[" + a + ".folder, " + a + ".type" + strings.Join(append([]string{""}, path...), ", ") + "])"
}

// bind turns a text with configuration marks into parts.
func (c *compiler) bind(text string) []any {
	var out []any
	for i, piece := range strings.Split(text, confMark) {
		if i > 0 {
			out = append(out, bound{c.env.conf}, "::jsonb")
		}
		out = append(out, piece)
	}
	return out
}

func (c *compiler) folder(n *query.Node, a string) []any {
	if n.Compare != "" {
		return c.never(n, "folder cannot be compared")
	}
	v := strings.Trim(n.Value, "/")
	if n.Up > 0 {
		// the nth parent; a folder with fewer levels has none
		seg := "string_to_array(" + a + ".folder, '/')"
		parent := "CASE WHEN " + a + ".folder <> '' AND cardinality(" + seg + ") >= " + strconv.Itoa(n.Up) +
			" THEN array_to_string((" + seg + ")[1:cardinality(" + seg + ") - " + strconv.Itoa(n.Up) + "], '/') END"
		if n.Null {
			return seq("(" + parent + ") IS NULL")
		}
		return seq("("+parent+") = ", bound{v})
	}
	if n.Null {
		return seq(a + ".folder = ''")
	}
	// "specs/*": the folder and everything below it
	if base, subtree := strings.CutSuffix(n.Value, "*"); subtree && (base == "" || strings.HasSuffix(base, "/")) {
		base = strings.Trim(base, "/")
		if base == "" {
			return seq("TRUE")
		}
		return seq("("+a+".folder = ", bound{base}, " OR "+a+".folder LIKE ", bound{escapeLike(base) + "/%"}, ")")
	}
	return seq(a+".folder = ", bound{v})
}

// classes of field types, by how their values match
func classes(types map[model.FieldType]bool) (text, number, date, ranked, boolean, ref bool) {
	for t := range types {
		switch t {
		case model.FieldInteger, model.FieldFloat, model.FieldCurrency:
			number = true
		case model.FieldDate, model.FieldDateTime, model.FieldTime:
			date = true
		case model.FieldEnum, model.FieldWorkflow:
			ranked = true
		case model.FieldBoolean:
			boolean = true
		case model.FieldReference, model.FieldReferences:
			ref = true
		case model.FieldAttachment, model.FieldJSON:
		default:
			text = true
		}
	}
	return
}

// field is a criterion on a configured field.
func (c *compiler) field(n *query.Node, a string) []any {
	types := c.env.types[n.Field]
	if types == nil {
		return c.never(n, "unknown field %q", n.Field)
	}
	key := n.Field
	text, number, date, ranked, boolean, ref := classes(types)
	if n.Sub != "" {
		if !types[model.FieldWorkflow] || (n.Sub != "transition" && n.Sub != "previous") {
			return c.never(n, "unknown field %q (a workflow field has .transition and .previous)", n.Field+"."+n.Sub)
		}
		key, text, number, date, boolean, ref = n.Field+"."+n.Sub, false, false, false, false, false
		ranked = n.Sub == "previous" // a state; a transition is only equal or not
	}
	ref = ref || (n.Sub == "" && c.env.dynamic[n.Field])
	exists := func(cond ...any) []any {
		return cat(seq("EXISTS (SELECT 1 FROM artifact_fields f WHERE f.guid = "+a+".guid AND f.field = ", bound{key}, " AND ("), cond, seq("))"))
	}
	if n.Null {
		return cat(seq("NOT "), exists("f.value <> ''"))
	}
	v := bound{n.Value}
	isNumber := numberRe.MatchString(n.Value)
	only := func(class bool) bool { // the field has this class of type only
		count := 0
		for _, b := range []bool{text, number, date, ranked, boolean, ref} {
			if b {
				count++
			}
		}
		return class && count == 1
	}
	switch {
	case only(number) && !isNumber:
		return c.never(n, "%q is no number; %s is a number", n.Value, n.Field)
	case only(boolean) && (n.Compare != "" || (n.Value != "true" && n.Value != "false")):
		return c.never(n, "%s is true or false", n.Field)
	case only(ranked) && n.Sub != "transition" && !c.env.open[n.Field] && !c.env.options[n.Field][n.Value]:
		return c.never(n, "%s has no value %q", n.Field, n.Value)
	}
	from, to, isDate := dateRange(n.Value)
	day := "2006-01-02"
	if only(date) && !isDate && !types[model.FieldTime] {
		return c.never(n, "%q is no date (2026, 2026-11, 2026-11-17 or 2026-11-17T14:30)", n.Value)
	}

	var alts [][]any
	if n.Compare == "" {
		alts = append(alts, seq("lower(f.value) = lower(", v, ")"))
		if number && isNumber {
			alts = append(alts, seq("f.num = ", v, "::numeric"))
		}
		if date && dayRe.MatchString(n.Value) {
			alts = append(alts, seq("f.value LIKE ", bound{n.Value + "%"}))
		}
		if ref {
			alts = append(alts, seq("f.value IN (SELECT o.guid FROM artifacts o WHERE lower(o.hid) = lower(", v, "))"))
		}
	} else {
		if number && isNumber {
			alts = append(alts, seq("f.num "+n.Compare+" ", v, "::numeric"))
		}
		if date && isDate {
			// stored as ISO text, which orders like time
			lo, hi := from.Format(day), to.Format(day)
			if strings.Contains(n.Value, "T") {
				lo, hi = n.Value, n.Value+"￿"
			}
			alts = append(alts, ranged(`f.value COLLATE "C"`, n.Compare, lo, hi))
		}
		if ranked {
			rank := func(value string) string { return "(" + c.conf(a, "'fields'", "f.field", value) + " #>> '{}')::int" }
			if n.Sub != "" {
				rank = func(value string) string {
					return "(" + c.conf(a, "'fields'", "split_part(f.field, '.', 1)", value) + " #>> '{}')::int"
				}
			}
			parts := c.bind(rank("f.value") + " " + n.Compare + " " + rank("\x00v\x00"))
			var withValue []any
			for _, p := range parts {
				if s, ok := p.(string); ok && strings.Contains(s, "\x00v\x00") {
					pieces := strings.Split(s, "\x00v\x00")
					for i, piece := range pieces {
						if i > 0 {
							withValue = append(withValue, v, "::text")
						}
						withValue = append(withValue, piece)
					}
					continue
				}
				withValue = append(withValue, p)
			}
			alts = append(alts, withValue)
		}
		if text {
			alts = append(alts, seq("lower(f.value) "+n.Compare+" lower(", v, ")"))
		}
		if len(alts) == 0 {
			return c.never(n, "%s cannot be compared with %q", n.Field, n.Value)
		}
	}
	var cond []any
	for i, alt := range alts {
		if i > 0 {
			cond = append(cond, " OR ")
		}
		cond = append(cond, alt...)
	}
	out := exists(cond...)
	if text && n.Compare == "" {
		// a text matches by its words, in the field's whole text
		out = cat(seq("("), out, seq(" OR EXISTS (SELECT 1 FROM artifact_field_text t WHERE t.guid = "+a+".guid AND t.field = ", bound{key}, " AND t.tsv @@ "), tsquery(n), seq("))"))
	}
	return out
}

// prepare compiles the query text of q, if it has one.
func (p *DB) prepare(ctx context.Context, q *Query) ([]Warning, error) {
	q.Lang = strings.TrimSpace(clean(q.Lang))
	if q.Lang == "" {
		return nil, nil
	}
	_, c, warnings, err := p.compileQuery(ctx, q.Lang, q.Strict)
	if err != nil {
		return nil, err
	}
	q.compiled = c
	return warnings, nil
}
