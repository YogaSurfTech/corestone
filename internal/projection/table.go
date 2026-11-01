package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/lib/pq"

	"github.com/thomdehoog/corestone/internal/model"
)

// Generic tables (TSK-34): the server sorts the complete filtered set and
// returns its GUIDs; clients fetch the rows they show in batches (Details).

// SortLevel is one level of a multi-level table sort.
type SortLevel struct {
	Col string `json:"col"`
	Dir string `json:"dir"` // "asc" (default) or "desc"
}

const (
	// MaxTableIDs caps how many GUIDs one table query returns.
	MaxTableIDs = 50000
	// MaxSortLevels caps the sort levels of one table query.
	MaxSortLevels = 3
	// MaxDetails caps how many artifacts one Details request returns.
	MaxDetails = 500
)

// Rank sentinels. Configured ranks are small; a value outside the
// configured sequence ranks unlisted, an empty one after everything.
const (
	rankUnlisted = 1_000_000_000
	rankEmpty    = 2_000_000_000
)

// TableResult is the sorted GUID list of a table query.
type TableResult struct {
	Total     int      `json:"total"`
	IDs       []string `json:"ids"`
	Truncated bool     `json:"truncated"`
}

// sortKey is one ORDER BY expression. Fixed keys (empty or unlisted
// flags) keep their direction, so empty values stay last either way.
type sortKey struct {
	expr  string
	fixed bool
}

// Joins a sort column may need besides artifacts a.
const (
	joinSource      = "LEFT JOIN artifacts es ON es.guid = a.source"
	joinTarget      = "LEFT JOIN artifacts et ON et.guid = a.target"
	joinSubject     = "LEFT JOIN artifacts s ON s.guid = a.subject"
	joinSubjectLink = "LEFT JOIN artifacts ss ON ss.guid = s.source LEFT JOIN artifacts st ON st.guid = s.target"
)

// confPath looks up path in the configuration of the (folder, type) pair
// of artifact alias; the configuration is bound as $1 (see typeConfig).
func confPath(alias string, path ...string) string {
	return "($1::jsonb #> ARRAY[" + alias + ".folder, " + alias + ".type" + strings.Join(append([]string{""}, path...), ", ") + "])"
}

const natural = " COLLATE corestone_natural"

// textKeys orders by a text value: empty last, then natural order.
func textKeys(v string) []sortKey {
	v = "NULLIF(" + v + ", '')"
	return []sortKey{{expr: v + " IS NULL", fixed: true}, {expr: v + natural}}
}

// valueKeys orders by a value without collation (numbers, timestamps).
func valueKeys(v string) []sortKey {
	return []sortKey{{expr: v + " IS NULL", fixed: true}, {expr: v}}
}

// rankedKeys orders by a configured rank: listed values first in
// configuration order, then unlisted ones by value, empty last.
func rankedKeys(rank, value string) []sortKey {
	return []sortKey{
		{expr: rank + " >= " + strconv.Itoa(rankEmpty), fixed: true},
		{expr: rank + " >= " + strconv.Itoa(rankUnlisted), fixed: true},
		{expr: rank},
		{expr: value + natural},
	}
}

func endpointLabel(alias, guid string) string {
	return "COALESCE(NULLIF(" + alias + ".hid, ''), " + guid + ")"
}

// fieldText renders a field value like the client's fieldValue: arrays
// joined with ", ", objects as "{…}".
func fieldText(j string) string {
	return "CASE jsonb_typeof(" + j + ") WHEN 'string' THEN " + j + " #>> '{}'" +
		" WHEN 'array' THEN (SELECT string_agg(e #>> '{}', ', ') FROM jsonb_array_elements(" + j + ") e)" +
		" WHEN 'object' THEN '{…}' WHEN 'null' THEN NULL ELSE " + j + "::text END"
}

// sortColumn resolves a table column id to its sort keys and joins.
// Ids starting with "$" are the overview columns; others are field ids.
func sortColumn(col string, arg func(any) string) ([]sortKey, []string, error) {
	switch col {
	case "$hid":
		return []sortKey{{expr: "a.hid IS NULL", fixed: true}, {expr: "a.hid_prefix"}, {expr: "a.hid_num"}, {expr: "a.hid"}, {expr: "a.guid"}}, nil, nil
	case "$title":
		return textKeys("COALESCE(NULLIF(a.title, ''), a.kind)"), nil, nil
	case "$type", "$role":
		return textKeys("COALESCE(" + confPath("a", "'label'") + " #>> '{}', a.type)"), nil, nil
	case "$state":
		// One rank per workflow the type declares, in declaration order;
		// arrays compare element by element. Direction is folded into the
		// ranks so empty and unlisted states stay last.
		return []sortKey{{expr: `ARRAY(SELECT CASE WHEN COALESCE(a.states ->> w.id, '') = '' THEN ` + strconv.Itoa(rankEmpty) +
			` ELSE COALESCE((` + confPath("a", "'states'", "w.id", "a.states ->> w.id") + ` #>> '{}')::int * $dir, ` + strconv.Itoa(rankUnlisted) + `) END
			FROM jsonb_array_elements_text(COALESCE(` + confPath("a", "'workflows'") + `, '[]')) WITH ORDINALITY w (id, n)
			ORDER BY w.n) || ` + strconv.Itoa(rankEmpty), fixed: true}}, nil, nil
	case "$folder":
		return textKeys("a.folder"), nil, nil
	case "$social":
		return valueKeys("(SELECT count(*) FROM artifacts l WHERE l.kind = 'link' AND (l.source = a.guid OR l.target = a.guid))"), nil, nil
	case "$modified":
		return valueKeys("a.modified_at"), nil, nil
	case "$created":
		return valueKeys("a.created_at"), nil, nil
	case "$author":
		return textKeys("CASE WHEN a.kind = 'link' THEN a.created_author ELSE a.author END"), nil, nil
	case "$excerpt":
		return textKeys("a.excerpt"), nil, nil
	case "$source":
		return textKeys(endpointLabel("es", "a.source")), []string{joinSource}, nil
	case "$target":
		return textKeys(endpointLabel("et", "a.target")), []string{joinTarget}, nil
	case "$kind":
		return valueKeys(`CASE WHEN COALESCE(a.parent, '') <> '' THEN 4 WHEN s.guid IS NULL THEN NULL
			ELSE CASE s.kind WHEN 'entry' THEN 1 WHEN 'document' THEN 2 WHEN 'link' THEN 3 ELSE 4 END END`), []string{joinSubject}, nil
	case "$subject":
		return textKeys(`CASE WHEN s.guid IS NULL THEN a.subject
			WHEN s.kind <> 'link' THEN COALESCE(NULLIF(concat_ws(' ', NULLIF(s.hid, ''), NULLIF(s.title, '')), ''), s.guid)
			ELSE ` + endpointLabel("ss", "s.source") + ` || ' → ' || COALESCE(` + confPath("s", "'label'") + ` #>> '{}', s.type) || ' → ' || ` + endpointLabel("st", "s.target") + ` END`),
			[]string{joinSubject, joinSubjectLink}, nil
	}
	if col == "" || strings.HasPrefix(col, "$") {
		return nil, nil, fmt.Errorf("%w: column %q cannot be sorted", model.ErrValidation, col)
	}
	id := arg(col) + "::text"
	j := "(a.fields -> " + id + ")"
	// Enum and workflow fields rank by configuration; a multi-valued
	// field ranks by its highest value. Other fields are all unlisted.
	r := "(" + confPath("a", "'fields'", id, "v") + " #>> '{}')::int"
	rank := `(SELECT CASE WHEN count(*) = 0 THEN ` + strconv.Itoa(rankEmpty) + ` WHEN bool_or(` + r + ` IS NULL) THEN ` + strconv.Itoa(rankUnlisted) + ` ELSE max(` + r + `) END
		FROM jsonb_array_elements_text(CASE jsonb_typeof(` + j + `) WHEN 'array' THEN ` + j + ` WHEN 'null' THEN '[]'::jsonb ELSE jsonb_build_array(` + j + `) END) v
		WHERE v <> '')`
	keys := rankedKeys(rank, "NULLIF("+fieldText(j)+", '')")
	// Numbers compare numerically before the text fallback.
	keys = append(keys[:3], sortKey{expr: "CASE WHEN jsonb_typeof(" + j + ") = 'number' THEN (" + j + ")::text::numeric END"}, keys[3])
	return keys, nil, nil
}

// typeConfig is the configuration of one (folder, type) pair a sort
// needs: display name, declared workflows in order, state ranks per
// workflow and value ranks of enum and workflow fields.
type typeConfig struct {
	Label     string                    `json:"label,omitempty"`
	Workflows []string                  `json:"workflows"`
	States    map[string]map[string]int `json:"states"`
	Fields    map[string]map[string]int `json:"fields"`
}

func ranks(states []model.State) map[string]int {
	out := map[string]int{}
	for r, st := range states {
		if _, dup := out[st.ID]; !dup {
			out[st.ID] = r
		}
	}
	return out
}

func newTypeConfig(cfg *model.ConfigIndex, folder, typ string) *typeConfig {
	schema := cfg.Effective(typ, folder)
	if schema == nil {
		return nil
	}
	tc := &typeConfig{Label: schema.DisplayName, Workflows: schema.Workflows, States: map[string]map[string]int{}, Fields: map[string]map[string]int{}}
	if tc.Workflows == nil {
		tc.Workflows = []string{}
	}
	for _, id := range schema.Workflows {
		if wf := cfg.Workflow(typ, id, folder); wf != nil {
			tc.States[id] = ranks(wf.States)
		}
	}
	for _, f := range schema.Fields {
		switch f.Type {
		case model.FieldEnum:
			m := map[string]int{}
			for r, o := range f.Options {
				if _, dup := m[o.Value]; !dup {
					m[o.Value] = r
				}
			}
			tc.Fields[f.ID] = m
		case model.FieldWorkflow:
			if wf := cfg.Workflow(typ, f.Workflow, folder); wf != nil {
				tc.Fields[f.ID] = ranks(wf.States)
			}
		}
	}
	return tc
}

// QueryIDs returns the GUIDs of every artifact matching q in the order
// of the sort levels (design: TSK-34). Without levels the order is the
// one of Search (relevance for text, else most recently modified).
// Ties fall back to that order and finally the file path.
func (p *DB) QueryIDs(ctx context.Context, q Query, levels []SortLevel, limit int) (*TableResult, error) {
	if q.Text != "" && !p.Status().Capabilities.Search {
		return nil, fmt.Errorf("%w: full-text search is being rebuilt", model.ErrUnavailable)
	}
	if !p.Status().Capabilities.Query {
		return nil, fmt.Errorf("%w: projection is being rebuilt", model.ErrUnavailable)
	}
	if len(levels) > MaxSortLevels {
		return nil, fmt.Errorf("%w: at most %d sort levels", model.ErrValidation, MaxSortLevels)
	}
	if limit <= 0 || limit > MaxTableIDs {
		limit = MaxTableIDs
	}
	q.normalize()
	// $1 is the configuration (folder -> type -> typeConfig), bound once
	// the needed (folder, type) pairs are known.
	args := make([]any, 1)
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := q.conditions(arg)
	var order, joins []string
	seen := map[string]bool{}
	needCfg, needSubjects := false, false
	for _, l := range levels {
		var dir string
		switch strings.ToLower(l.Dir) {
		case "", "asc":
			dir = "ASC"
		case "desc":
			dir = "DESC"
		default:
			return nil, fmt.Errorf("%w: sort direction %q", model.ErrValidation, l.Dir)
		}
		keys, js, err := sortColumn(l.Col, arg)
		if err != nil {
			return nil, err
		}
		sign := "1"
		if dir == "DESC" {
			sign = "-1"
		}
		for _, k := range keys {
			expr := strings.ReplaceAll(k.expr, "$dir", sign)
			if k.fixed {
				order = append(order, expr+" ASC")
			} else {
				order = append(order, expr+" "+dir+" NULLS LAST")
			}
		}
		for _, j := range js {
			if !seen[j] {
				seen[j] = true
				joins = append(joins, j)
			}
		}
		needCfg = needCfg || !strings.HasPrefix(l.Col, "$") || l.Col == "$type" || l.Col == "$role" || l.Col == "$state" || l.Col == "$subject"
		needSubjects = needSubjects || l.Col == "$subject"
	}
	if q.Text != "" {
		order = append(order, "ts_rank(a.tsv, plainto_tsquery('simple', "+arg(q.Text)+")) DESC")
	}
	order = append(order, "a.modified_at DESC NULLS LAST", "a.file_path")
	sqlWhere := ""
	if len(where) > 0 {
		sqlWhere = " WHERE " + strings.Join(where, " AND ")
	}

	conf := map[string]map[string]*typeConfig{}
	if needCfg {
		cfg, err := p.Config(ctx)
		if err != nil {
			return nil, err
		}
		// The same filter, numbered on its own: unused placeholders have
		// no type PostgreSQL could infer.
		var pairArgs []any
		cond := q.conditions(func(v any) string {
			pairArgs = append(pairArgs, v)
			return "$" + strconv.Itoa(len(pairArgs))
		})
		pairWhere := ""
		if len(cond) > 0 {
			pairWhere = " WHERE " + strings.Join(cond, " AND ")
		}
		pairs := `SELECT DISTINCT a.folder, a.type FROM artifacts a` + pairWhere
		if needSubjects {
			pairs += ` UNION SELECT DISTINCT s.folder, s.type FROM artifacts a JOIN artifacts s ON s.guid = a.subject` + pairWhere
		}
		res, err := p.sql.QueryContext(ctx, pairs, pairArgs...)
		if err != nil {
			return nil, unavailable(err)
		}
		for res.Next() {
			var folder, typ string
			if err := res.Scan(&folder, &typ); err != nil {
				res.Close()
				return nil, unavailable(err)
			}
			if tc := newTypeConfig(cfg, folder, typ); tc != nil {
				if conf[folder] == nil {
					conf[folder] = map[string]*typeConfig{}
				}
				conf[folder][typ] = tc
			}
		}
		res.Close()
		if err := res.Err(); err != nil {
			return nil, unavailable(err)
		}
	}
	confJSON, err := json.Marshal(conf)
	if err != nil {
		return nil, err
	}
	args[0] = string(confJSON)

	stmt := `SELECT a.guid, count(*) OVER () FROM artifacts a ` + strings.Join(joins, " ") + `
		WHERE $1::jsonb IS NOT NULL` + // always reference $1, so its type is known
		strings.Replace(sqlWhere, " WHERE ", " AND ", 1) +
		` ORDER BY ` + strings.Join(order, ", ") + ` LIMIT ` + arg(limit)
	res, err := p.sql.QueryContext(ctx, stmt, args...)
	if err != nil {
		return nil, unavailable(err)
	}
	defer res.Close()
	out := &TableResult{IDs: []string{}}
	for res.Next() {
		var guid string
		if err := res.Scan(&guid, &out.Total); err != nil {
			return nil, unavailable(err)
		}
		out.IDs = append(out.IDs, guid)
	}
	if err := res.Err(); err != nil {
		return nil, unavailable(err)
	}
	out.Truncated = out.Total > len(out.IDs)
	return out, nil
}

// Details returns the summaries of guids in the given order; unknown
// GUIDs are left out.
func (p *DB) Details(ctx context.Context, guids []string) ([]*model.Summary, error) {
	valid := make([]string, 0, len(guids))
	for _, g := range guids {
		if model.IsGUID(g) {
			valid = append(valid, g)
		}
	}
	out := []*model.Summary{}
	if len(valid) == 0 {
		return out, nil
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.guid = ANY($1)`, pq.Array(valid))
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	byGUID := map[string]*model.Summary{}
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		byGUID[s.GUID] = s
	}
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	for _, g := range guids {
		if s := byGUID[g]; s != nil {
			out = append(out, s)
			delete(byGUID, g)
		}
	}
	return out, nil
}
