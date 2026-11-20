package query

import (
	"errors"
	"strings"
	"testing"
)

// show writes a tree with explicit brackets, so the tests read the
// structure the parser found.
func show(n *Node) string {
	if n == nil {
		return "<all>"
	}
	switch n.Op {
	case Not:
		return "NOT " + show(n.Children[0])
	case And, Or, Xor:
		var parts []string
		for _, c := range n.Children {
			parts = append(parts, show(c))
		}
		op := strings.ToUpper(n.Op)
		if n.Implicit {
			op = "or"
		}
		return "(" + strings.Join(parts, " "+op+" ") + ")"
	case Link:
		s := "has_link:("
		if n.Reverse {
			s += "~"
		}
		s += n.LinkType
		if n.Query != nil {
			s += ", " + show(n.Query)
		}
		return s + ")"
	}
	s := n.Field
	if n.Sub != "" {
		s += "." + n.Sub
	}
	if n.Up > 0 {
		s += "~" + string(rune('0'+n.Up))
	}
	if n.Field != "" {
		s += ":"
	}
	s += n.Compare
	switch {
	case n.Null:
		return s + "NULL"
	case n.Quoted:
		return s + `"` + n.Value + `"`
	}
	return s + n.Value
}

func TestParse(t *testing.T) {
	for _, c := range []struct{ query, want string }{
		{"", "<all>"}, {"  \n", "<all>"},
		{"corestone", "corestone"},
		{"description:corestone", "description:corestone"},
		{"description : corestone", "description:corestone"},
		{"description:(corestone claude)", "(description:corestone or description:claude)"},
		{"tags:(server AND NOT docs)", "(tags:server AND NOT tags:docs)"},
		{"tags:((a OR b) AND c)", "((tags:a OR tags:b) AND tags:c)"},
		{"type:task AND priority:high", "(type:task AND priority:high)"},
		{"type:task AND NOT finished:true", "(type:task AND NOT finished:true)"},
		{"created:>=2026-11-01 AND created:<2026-12-01", "(created:>=2026-11-01 AND created:<2026-12-01)"},
		{"modified:2026-11", "modified:2026-11"},
		{"created:>2026-11-17T14:30 AND x:1", "(created:>2026-11-17T14:30 AND x:1)"},
		{"created:2026-11-17T14:30:05", "created:2026-11-17T14:30:05"},
		{"NOT assignee:NULL", "NOT assignee:NULL"},
		{`title:"NULL"`, `title:"NULL"`},
		{`title:"table view"`, `title:"table view"`},
		{`title:"a \"b\" \\ c"`, `title:"a "b" \ c"`},
		{`"two words" x`, `("two words" or x)`},
		// side by side is OR; precedence: NOT, AND, XOR, OR
		{"type:task priority:high", "(type:task or priority:high)"},
		{"a AND b c", "((a AND b) or c)"},
		{"a OR b AND c", "(a OR (b AND c))"},
		{"a XOR b AND c OR d", "((a XOR (b AND c)) OR d)"},
		{"NOT a AND b", "(NOT a AND b)"},
		{"NOT NOT a", "NOT NOT a"},
		{"NOT (a b)", "NOT (a or b)"},
		{"(a OR b) AND c", "((a OR b) AND c)"},
		// operators in lower case are words
		{"a and b", "(a or and or b)"},
		{"folder:specs/brakes", "folder:specs/brakes"},
		{"folder~1:specs", "folder~1:specs"},
		{"folder:specs/*", "folder:specs/*"},
		{"status.transition:approve AND status.previous:review", "(status.transition:approve AND status.previous:review)"},
		{"owner:ann@example.org v:1.2+3", "(owner:ann@example.org or v:1.2+3)"},
		{"type:task has_link:(depends_on, created:<2026-11-01)", "(type:task or has_link:(depends_on, created:<2026-11-01))"},
		{"type:task AND has_link:( ~depends_on , created:<2026-11-01 )", "(type:task AND has_link:(~depends_on, created:<2026-11-01))"},
		{"NOT has_link:(~verifies)", "NOT has_link:(~verifies)"},
		{"has_link:(a, has_link:(b, has_link:(c)) AND x:1)", "has_link:(a, (has_link:(b, has_link:(c)) AND x:1))"},
		{"has_link", "has_link"}, // a word without the colon
		{"Größe:über", "Größe:über"},
	} {
		n, err := Parse(c.query)
		if err != nil {
			t.Errorf("%q: %v", c.query, err)
		} else if got := show(n); got != c.want {
			t.Errorf("%q: got %s, want %s", c.query, got, c.want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for query, pos := range map[string]int{
		"(a":            0, // the bracket is not closed
		"a)":            1,
		`title:"open`:   6,
		"a AND":         5,
		"AND a":         0,
		"a OR OR b":     5,
		"NOT":           3,
		"title:":        6,
		"title:AND":     6,
		"title:<":       7,
		"title:<NULL":   6,
		"title:<(a b)":  7,
		"a:b:c":         3,
		"a=b":           1,
		"[a TO b]":      0,
		"folder~x:a":    7,
		"folder~0:a":    7,
		".x:a":          0,
		"a.b.c:d":       0,
		"has_link:x":    9,
		"has_link:()":   10,
		"has_link:(a":   9,
		"has_link:(a,)": 12,
		"tags:(a b:c)":  9,
		"has_link:(a, has_link:(b, has_link:(c, has_link:(d))))": 39,
	} {
		_, err := Parse(query)
		var e *Error
		if !errors.As(err, &e) {
			t.Errorf("%q: no error (%v)", query, err)
		} else if e.Pos != pos {
			t.Errorf("%q: error at %d, want %d (%s)", query, e.Pos, pos, e.Msg)
		}
	}
}

func TestLimits(t *testing.T) {
	if _, err := Parse(strings.Repeat("a", MaxLength+1)); err == nil {
		t.Error("too long a query accepted")
	}
	if _, err := Parse(strings.Repeat("a ", MaxCriteria)); err != nil {
		t.Errorf("%d criteria: %v", MaxCriteria, err)
	}
	if _, err := Parse(strings.Repeat("a ", MaxCriteria+1)); err == nil {
		t.Error("too many criteria accepted")
	}
	if _, err := Parse(strings.Repeat("(", MaxDepth) + "a" + strings.Repeat(")", MaxDepth)); err != nil {
		t.Errorf("depth %d: %v", MaxDepth, err)
	}
	if _, err := Parse(strings.Repeat("(", MaxDepth+1) + "a" + strings.Repeat(")", MaxDepth+1)); err == nil {
		t.Error("too deep a query accepted")
	}
	// links one after the other are not nested
	if _, err := Parse("has_link:(a) has_link:(b) has_link:(c) has_link:(d)"); err != nil {
		t.Errorf("four links side by side: %v", err)
	}
}

func FuzzParse(f *testing.F) {
	for _, s := range []string{"a AND (b OR NOT c:d)", `x:"q\"" has_link:(~l, y:<1)`, "folder~2:a.b", "((((", "a:b:c", "NOT NOT"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		n, err := Parse(s)
		if err == nil && n != nil {
			show(n)
		}
	})
}
