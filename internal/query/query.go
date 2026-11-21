// Package query parses the Corestone query language (TSK-13) into a tree.
// It knows the grammar only: what a field or a value means is decided
// where the tree is evaluated, against the configuration. The package has
// no dependencies, so every place that selects artifacts can use it.
//
//	query     = xor { [ "OR" ] xor } ;
//	xor       = and { "XOR" and } ;
//	and       = not { "AND" not } ;
//	not       = [ "NOT" ] primary ;
//	primary   = "(" query ")" | link | criterion | value ;
//	criterion = field ":" ( compare value | value | "(" values ")" ) ;
//	values    = the rules of query, over values only ;
//	field     = id [ "." id ] [ "~" number ] ;
//	compare   = "<" | "<=" | ">" | ">=" ;
//	link      = "has_link" ":" "(" [ "~" ] id [ "," query ] ")" ;
//	value     = word | quoted | "NULL" ;
//
// A word holds letters, digits and _ - . / @ + *. The star has a meaning
// only at the end of a folder ("folder:specs/*": the folder and all below).
//
// Operators are written in capitals. Two criteria side by side are joined
// by OR. NOT binds strongest, then AND, then XOR, then OR.
package query

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits of one query.
const (
	MaxLength    = 4000 // characters of the query text
	MaxCriteria  = 100  // criteria and values
	MaxDepth     = 20   // nested brackets
	MaxLinkDepth = 3    // has_link inside has_link
)

// The kinds of a node.
const (
	And  = "and"
	Or   = "or"
	Xor  = "xor"
	Not  = "not"
	Term = "term" // one criterion: a field (or none) and a value
	Link = "link" // has_link
)

// Node is one node of a parsed query.
type Node struct {
	Op string `json:"op"`
	// And, Or, Xor: two or more children. Not: one.
	Children []*Node `json:"children,omitempty"`
	// Implicit marks an Or written without the operator (criteria side by side).
	Implicit bool `json:"implicit,omitempty"`

	// Term: the field's id; empty for a value without a field.
	Field string `json:"field,omitempty"`
	// Sub is the part after a dot: "transition" in status.transition.
	Sub string `json:"sub,omitempty"`
	// Up is n of "field~n" (folder~1: the parent folder); 0 without it.
	Up int `json:"up,omitempty"`
	// Compare is "<", "<=", ">" or ">="; empty for a match.
	Compare string `json:"compare,omitempty"`
	Value   string `json:"value,omitempty"`
	// Quoted: the value was written in quotes (a phrase; never a reserved word).
	Quoted bool `json:"quoted,omitempty"`
	// Null: the value is the reserved word NULL ("no value").
	Null bool `json:"null,omitempty"`

	// Link: the link type's id, whether the direction is reversed ("~"),
	// and the query the artifact at the other end must match (nil: any).
	LinkType string `json:"linkType,omitempty"`
	Reverse  bool   `json:"reverse,omitempty"`
	Query    *Node  `json:"query,omitempty"`

	// Pos is the offset of the node's first character in the query text.
	Pos int `json:"pos"`
}

// Error is a query that cannot be parsed, with the offset of the problem.
type Error struct {
	Pos int
	Msg string
}

func (e *Error) Error() string { return fmt.Sprintf("query, position %d: %s", e.Pos+1, e.Msg) }

// Parse turns a query text into its tree. An empty query (only white
// space) has no tree: it returns nil and selects everything.
func Parse(text string) (*Node, error) {
	if utf8.RuneCountInString(text) > MaxLength {
		return nil, &Error{0, fmt.Sprintf("longer than %d characters", MaxLength)}
	}
	toks, err := lex(text)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	if p.peek().kind == tEOF {
		return nil, nil
	}
	n, err := p.query(false)
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tEOF {
		return nil, p.unexpected(t)
	}
	return n, nil
}

type tokenKind int

const (
	tEOF tokenKind = iota
	tWord
	tQuoted
	tLParen
	tRParen
	tColon
	tComma
	tTilde
	tCompare
)

type token struct {
	kind tokenKind
	text string
	pos  int // offset of the first byte
	end  int // offset after the last byte
}

// wordRune reports whether r may appear in a value without quotes.
func wordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("_-./@+*", r)
}

func lex(text string) ([]token, error) {
	var toks []token
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		single := map[rune]tokenKind{'(': tLParen, ')': tRParen, ':': tColon, ',': tComma, '~': tTilde}
		switch {
		case unicode.IsSpace(r):
			i += size
		case single[r] != 0:
			toks = append(toks, token{single[r], string(r), i, i + size})
			i += size
		case r == '<' || r == '>':
			end := i + 1
			if end < len(text) && text[end] == '=' {
				end++
			}
			toks = append(toks, token{tCompare, text[i:end], i, end})
			i = end
		case r == '"':
			var b strings.Builder
			j, closed := i+1, false
			for j < len(text) {
				c := text[j]
				if c == '\\' && j+1 < len(text) && (text[j+1] == '"' || text[j+1] == '\\') {
					b.WriteByte(text[j+1])
					j += 2
					continue
				}
				if c == '"' {
					closed = true
					j++
					break
				}
				b.WriteByte(c)
				j++
			}
			if !closed {
				return nil, &Error{i, "the quote is not closed"}
			}
			toks = append(toks, token{tQuoted, b.String(), i, j})
			i = j
		case wordRune(r):
			j := i
			for j < len(text) {
				c, n := utf8.DecodeRuneInString(text[j:])
				if !wordRune(c) {
					break
				}
				j += n
			}
			toks = append(toks, token{tWord, text[i:j], i, j})
			i = j
		default:
			return nil, &Error{i, fmt.Sprintf("%q cannot be used here; put a value with special characters in quotes", string(r))}
		}
	}
	return append(toks, token{kind: tEOF, pos: len(text), end: len(text)}), nil
}

type parser struct {
	toks     []token
	i        int
	criteria int
	depth    int
	links    int
}

func (p *parser) peek() token { return p.toks[p.i] }
func (p *parser) peekAt(n int) token {
	if p.i+n < len(p.toks) {
		return p.toks[p.i+n]
	}
	return p.toks[len(p.toks)-1]
}
func (p *parser) next() token { t := p.toks[p.i]; p.i++; return t }

func (p *parser) unexpected(t token) error {
	switch t.kind {
	case tEOF:
		return &Error{t.pos, "the query ends too early"}
	case tRParen:
		return &Error{t.pos, "a closing bracket without an opening one"}
	}
	return &Error{t.pos, fmt.Sprintf("%q is not expected here", t.text)}
}

func isOp(t token, word string) bool { return t.kind == tWord && t.text == word }

func operator(t token) bool {
	return isOp(t, "AND") || isOp(t, "OR") || isOp(t, "XOR") || isOp(t, "NOT")
}

// starts reports whether a primary (or NOT) can begin at t.
func starts(t token) bool {
	return t.kind == tLParen || t.kind == tQuoted || isOp(t, "NOT") || (t.kind == tWord && !operator(t))
}

func join(op string, pos int, nodes []*Node, implicit bool) *Node {
	if len(nodes) == 1 {
		return nodes[0]
	}
	return &Node{Op: op, Children: nodes, Implicit: implicit, Pos: pos}
}

// query, xor, and, not follow the grammar. With field != nil they parse a
// value group: every value becomes a term of that field.
func (p *parser) query(group bool, field ...*Node) (*Node, error) {
	first, err := p.xor(group, field...)
	if err != nil {
		return nil, err
	}
	nodes, implicit := []*Node{first}, true
	for {
		t := p.peek()
		if isOp(t, "OR") {
			p.next()
			implicit = false
		} else if !starts(t) {
			break
		}
		n, err := p.xor(group, field...)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return join(Or, first.Pos, nodes, implicit), nil
}

func (p *parser) xor(group bool, field ...*Node) (*Node, error) {
	return p.chain("XOR", Xor, func() (*Node, error) {
		return p.chain("AND", And, func() (*Node, error) { return p.not(group, field...) })
	})
}

func (p *parser) chain(word, op string, operand func() (*Node, error)) (*Node, error) {
	first, err := operand()
	if err != nil {
		return nil, err
	}
	nodes := []*Node{first}
	for isOp(p.peek(), word) {
		p.next()
		n, err := operand()
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return join(op, first.Pos, nodes, false), nil
}

func (p *parser) not(group bool, field ...*Node) (*Node, error) {
	if t := p.peek(); isOp(t, "NOT") {
		p.next()
		n, err := p.not(group, field...)
		if err != nil {
			return nil, err
		}
		return &Node{Op: Not, Children: []*Node{n}, Pos: t.pos}, nil
	}
	return p.primary(group, field...)
}

func (p *parser) primary(group bool, field ...*Node) (*Node, error) {
	t := p.peek()
	switch {
	case t.kind == tLParen:
		p.next()
		if p.depth++; p.depth > MaxDepth {
			return nil, &Error{t.pos, fmt.Sprintf("brackets nested deeper than %d", MaxDepth)}
		}
		n, err := p.query(group, field...)
		if err != nil {
			return nil, err
		}
		if c := p.next(); c.kind != tRParen {
			if c.kind == tEOF {
				return nil, &Error{t.pos, "the bracket is not closed"}
			}
			return nil, p.unexpected(c)
		}
		p.depth--
		return n, nil
	case operator(t):
		return nil, &Error{t.pos, fmt.Sprintf("%s needs a criterion before and after it", t.text)}
	case t.kind == tWord && !group:
		if isOp(t, "has_link") && p.peekAt(1).kind == tColon {
			return p.link()
		}
		if f, ok, err := p.field(); err != nil {
			return nil, err
		} else if ok {
			return p.criterion(f)
		}
		return p.value(&Node{Op: Term, Pos: t.pos})
	case t.kind == tWord || t.kind == tQuoted:
		n := &Node{Op: Term, Pos: t.pos}
		if group {
			n.Field, n.Sub, n.Up = field[0].Field, field[0].Sub, field[0].Up
		}
		return p.value(n)
	}
	return nil, p.unexpected(t)
}

// field reads "id[.id][~n]:" if the parser stands at one.
func (p *parser) field() (*Node, bool, error) {
	t := p.peek()
	n := &Node{Op: Term, Pos: t.pos}
	width := 0
	switch {
	case p.peekAt(1).kind == tColon:
		width = 2
	case p.peekAt(1).kind == tTilde && p.peekAt(2).kind == tWord && p.peekAt(3).kind == tColon:
		up, err := strconv.Atoi(p.peekAt(2).text)
		if err != nil || up < 1 || up > 99 {
			return nil, false, &Error{p.peekAt(2).pos, "a number from 1 is expected after ~ (folder~1 is the parent folder)"}
		}
		n.Up, width = up, 4
	default:
		return nil, false, nil
	}
	n.Field, n.Sub, _ = strings.Cut(t.text, ".")
	if n.Field == "" || strings.HasSuffix(t.text, ".") || strings.Contains(n.Sub, ".") {
		return nil, false, &Error{t.pos, fmt.Sprintf("%q is no field name", t.text)}
	}
	p.i += width
	return n, true, nil
}

func (p *parser) criterion(f *Node) (*Node, error) {
	t := p.peek()
	switch t.kind {
	case tCompare:
		p.next()
		f.Compare = t.text
		n, err := p.value(f)
		if err != nil {
			return nil, err
		}
		if n.Null {
			return nil, &Error{t.pos, "NULL cannot be compared; use field:NULL or NOT field:NULL"}
		}
		return n, nil
	case tLParen:
		return p.primary(true, f)
	}
	return p.value(f)
}

// value reads one value into the term n.
func (p *parser) value(n *Node) (*Node, error) {
	t := p.next()
	if t.kind != tWord && t.kind != tQuoted {
		p.i--
		if t.kind == tEOF || t.kind == tRParen {
			return nil, &Error{t.pos, "a value is expected"}
		}
		return nil, p.unexpected(t)
	}
	if t.kind == tWord && operator(t) {
		return nil, &Error{t.pos, fmt.Sprintf("a value is expected, not %s; write it in quotes to search for the word", t.text)}
	}
	if p.criteria++; p.criteria > MaxCriteria {
		return nil, &Error{t.pos, fmt.Sprintf("more than %d criteria", MaxCriteria)}
	}
	n.Value, n.Quoted = t.text, t.kind == tQuoted
	if t.kind == tWord && t.text == "NULL" {
		n.Value, n.Null = "", true
	}
	// A time is written without quotes: 2026-11-17T14:30. The colon belongs
	// to the value when digits follow it directly.
	for t.kind == tWord && n.Field != "" {
		c, d := p.peek(), p.peekAt(1)
		if c.kind != tColon || c.pos != t.end || d.kind != tWord || d.pos != c.end || strings.Trim(d.text, "0123456789.") != "" || !strings.ContainsAny(t.text, "T") && !strings.Contains(n.Value, ":") {
			break
		}
		n.Value += ":" + d.text
		p.i += 2
		t = d
	}
	return n, nil
}

func (p *parser) link() (*Node, error) {
	start := p.next() // has_link
	p.next()          // :
	open := p.next()
	if open.kind != tLParen {
		p.i--
		return nil, &Error{open.pos, "has_link is written as has_link:(type) or has_link:(type, query)"}
	}
	if p.links++; p.links > MaxLinkDepth {
		return nil, &Error{start.pos, fmt.Sprintf("has_link nested deeper than %d", MaxLinkDepth)}
	}
	n := &Node{Op: Link, Pos: start.pos}
	if p.peek().kind == tTilde {
		p.next()
		n.Reverse = true
	}
	id := p.next()
	if id.kind != tWord || operator(id) {
		p.i--
		return nil, &Error{id.pos, "a link type is expected"}
	}
	n.LinkType = id.text
	if p.criteria++; p.criteria > MaxCriteria {
		return nil, &Error{id.pos, fmt.Sprintf("more than %d criteria", MaxCriteria)}
	}
	if p.peek().kind == tComma {
		p.next()
		q, err := p.query(false)
		if err != nil {
			return nil, err
		}
		n.Query = q
	}
	if c := p.next(); c.kind != tRParen {
		if c.kind == tEOF {
			return nil, &Error{open.pos, "the bracket is not closed"}
		}
		return nil, p.unexpected(c)
	}
	p.links--
	return n, nil
}
