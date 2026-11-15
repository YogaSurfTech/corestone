// Package ojson is an order-preserving JSON codec for repository files.
//
// The design guide (§3.16) makes serialization part of the repository
// format: reloading and re-saving an unchanged artifact must produce an
// identical file, edits keep property positions, new properties are
// appended, and indentation / line-ending / trailing-newline style is kept.
// Values are represented as ordinary Go values except that objects are
// *Object (ordered) and numbers are Number (their exact source literal).
package ojson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Number is a JSON number kept as its literal text so 2^53+1 or 1.10 survive.
type Number = json.Number

// Object is a JSON object that remembers key order.
type Object struct {
	keys []string
	vals map[string]any
	raw  []byte // source text this object was parsed from, if any
}

// NewObject returns an empty ordered object.
func NewObject() *Object { return &Object{vals: map[string]any{}} }

// Len returns the number of properties.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys returns the property names in order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	return append([]string(nil), o.keys...)
}

// Get returns a property value.
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Set replaces a property in place or appends a new one.
func (o *Object) Set(key string, v any) {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
	o.raw = nil
}

// Delete removes a property; the remaining order is untouched.
func (o *Object) Delete(key string) {
	if o == nil {
		return
	}
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
	o.raw = nil
}

// String returns a string property or "".
func (o *Object) String(key string) string {
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

// Object returns a nested object property or nil.
func (o *Object) Object(key string) *Object {
	v, _ := o.Get(key)
	n, _ := v.(*Object)
	return n
}

// Array returns an array property or nil.
func (o *Object) Array(key string) []any {
	v, _ := o.Get(key)
	a, _ := v.([]any)
	return a
}

// Clone deep-copies the object.
func (o *Object) Clone() *Object {
	if o == nil {
		return nil
	}
	n := NewObject()
	for _, k := range o.keys {
		n.Set(k, Clone(o.vals[k]))
	}
	n.raw = o.raw
	return n
}

// Clone deep-copies any value produced by this package.
func Clone(v any) any {
	switch t := v.(type) {
	case *Object:
		return t.Clone()
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = Clone(t[i])
		}
		return out
	default:
		return v
	}
}

// unchanged reports whether the object still equals the text it was parsed
// from (a nested object may have been edited in place).
func (o *Object) unchanged() bool {
	v, err := Parse(o.raw)
	if err != nil {
		return false
	}
	return Equal(o, v)
}

// MarshalJSON encodes the object compactly, in order.
func (o *Object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	if err := encode(&b, o, Style{}, 0, nil); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// UnmarshalJSON parses into the object, preserving key order.
func (o *Object) UnmarshalJSON(data []byte) error {
	v, err := Parse(data)
	if err != nil {
		return err
	}
	n, ok := v.(*Object)
	if !ok {
		return errors.New("ojson: expected a JSON object")
	}
	*o = *n
	return nil
}

// Style is the formatting of a repository file.
type Style struct {
	Indent   string // "" means compact single-line output
	Newline  string // "\n" or "\r\n"
	Trailing bool   // newline after the closing bracket
	// Rows, when set, picks arrays (by their path of object keys and
	// array indexes from the top) that are written with one compact
	// element per line, so a line in the file is a row of the data
	// (rich-text blocks: one line per paragraph). Only used when Indent is set.
	Rows func(path []string, a []any) bool

	oneLine bool // a row: no line breaks, a space after ':' and ','
}

// DefaultStyle is used for files the Foundation creates.
var DefaultStyle = Style{Indent: "  ", Newline: "\n", Trailing: true}

// DetectStyle infers the formatting conventions of an existing file.
func DetectStyle(data []byte) Style {
	s := Style{Newline: "\n"}
	if bytes.Contains(data, []byte("\r\n")) {
		s.Newline = "\r\n"
	}
	s.Trailing = len(data) > 0 && data[len(data)-1] == '\n'
	// indentation = whitespace of the first line following the opening bracket
	open := bytes.IndexAny(data, "{[")
	if open < 0 {
		return s
	}
	nl := bytes.IndexByte(data[open:], '\n')
	if nl < 0 {
		return s
	}
	rest := data[open+nl+1:]
	i := 0
	for i < len(rest) && (rest[i] == ' ' || rest[i] == '\t') {
		i++
	}
	s.Indent = string(rest[:i])
	return s
}

// Parse decodes JSON into ordered values. Numbers keep their literal form
// and objects remember their source text, so untouched objects are written
// back verbatim by Encode (design guide §3.16: indentation, positions and
// formatting of unchanged content survive).
func Parse(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	p := &parser{dec: dec, src: data}
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("ojson: trailing data after JSON value")
	}
	return v, nil
}

// ParseObject parses data that must be a JSON object.
func ParseObject(data []byte) (*Object, error) {
	v, err := Parse(data)
	if err != nil {
		return nil, err
	}
	o, ok := v.(*Object)
	if !ok {
		return nil, errors.New("ojson: expected a JSON object")
	}
	return o, nil
}

// ParseBody parses a request body that must be a JSON object. Unlike
// ParseObject it keeps only the values, not the sender's layout: what a
// client sends is written into files in the files' own style.
func ParseBody(data []byte) (*Object, error) {
	o, err := ParseObject(data)
	if err != nil {
		return nil, err
	}
	forgetSource(o)
	return o, nil
}

func forgetSource(v any) {
	switch t := v.(type) {
	case *Object:
		t.raw = nil
		for _, e := range t.vals {
			forgetSource(e)
		}
	case []any:
		for _, e := range t {
			forgetSource(e)
		}
	}
}

// MaxDepth bounds nesting so hostile documents cannot exhaust the stack.
const MaxDepth = 256

type parser struct {
	dec   *json.Decoder
	src   []byte
	depth int
}

func (p *parser) value() (any, error) {
	tok, err := p.dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); ok && (d == '{' || d == '[') {
		p.depth++
		if p.depth > MaxDepth {
			return nil, fmt.Errorf("ojson: nesting deeper than %d", MaxDepth)
		}
		defer func() { p.depth-- }()
	}
	return p.fromToken(tok)
}

func (p *parser) fromToken(tok json.Token) (any, error) {
	dec := p.dec
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			start := dec.InputOffset() - 1
			o := NewObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("ojson: bad object key %v", kt)
				}
				v, err := p.value()
				if err != nil {
					return nil, err
				}
				o.Set(k, v)
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			end := dec.InputOffset()
			if p.src != nil && start >= 0 && end <= int64(len(p.src)) && p.src[start] == '{' {
				o.raw = p.src[start:end]
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := p.value()
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("ojson: unexpected delimiter %v", t)
	case nil, bool, string, json.Number:
		return t, nil
	default:
		return nil, fmt.Errorf("ojson: unexpected token %T", tok)
	}
}

// Encode serializes a value in the given style.
func Encode(v any, style Style) ([]byte, error) {
	if style.Newline == "" {
		style.Newline = "\n"
	}
	var b bytes.Buffer
	if err := encode(&b, v, style, 0, nil); err != nil {
		return nil, err
	}
	if style.Trailing {
		b.WriteString(style.Newline)
	}
	return b.Bytes(), nil
}

// MustEncode is Encode for values known to be encodable.
func MustEncode(v any, style Style) []byte {
	b, err := Encode(v, style)
	if err != nil {
		panic(err)
	}
	return b
}

func encode(b *bytes.Buffer, v any, st Style, depth int, path []string) error {
	pretty := st.Indent != "" && !st.oneLine
	// the depth of nested values: on one line they add none (rows inside them indent from the line)
	inner := depth + 1
	if st.oneLine {
		inner = depth
	}
	newline := func(d int) {
		b.WriteString(st.Newline)
		b.WriteString(strings.Repeat(st.Indent, d))
	}
	nl := func(d int) {
		if pretty {
			newline(d)
		}
	}
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		if t == "" {
			b.WriteString("0")
		} else {
			b.WriteString(string(t))
		}
	case string:
		writeString(b, t)
	case int:
		fmt.Fprintf(b, "%d", t)
	case int64:
		fmt.Fprintf(b, "%d", t)
	case float64:
		n, err := json.Marshal(t)
		if err != nil {
			return err
		}
		b.Write(n)
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return nil
		}
		// rows: one element per line, each written on one line (without the
		// remembered source layout); a row may hold rows of its own (a table's)
		rows := st.Indent != "" && st.Rows != nil && st.Rows(path, t)
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
				if st.oneLine && !rows {
					b.WriteByte(' ')
				}
			}
			elem := st
			if rows {
				newline(depth + 1)
				elem.oneLine = true
			} else {
				nl(depth + 1)
			}
			d := inner
			if rows {
				d = depth + 1
			}
			if err := encode(b, e, elem, d, append(path, strconv.Itoa(i))); err != nil {
				return err
			}
		}
		if rows {
			newline(depth)
		} else {
			nl(depth)
		}
		b.WriteByte(']')
	case []string:
		arr := make([]any, len(t))
		for i := range t {
			arr[i] = t[i]
		}
		return encode(b, arr, st, depth, path)
	case *Object:
		if t == nil || len(t.keys) == 0 {
			b.WriteString("{}")
			return nil
		}
		if t.raw != nil && pretty && t.unchanged() {
			b.Write(t.raw)
			return nil
		}
		b.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				b.WriteByte(',')
				if st.oneLine {
					b.WriteByte(' ')
				}
			}
			nl(depth + 1)
			writeString(b, k)
			b.WriteByte(':')
			if pretty || st.oneLine {
				b.WriteByte(' ')
			}
			if err := encode(b, t.vals[k], st, inner, append(path, k)); err != nil {
				return err
			}
		}
		nl(depth)
		b.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := NewObject()
		for _, k := range keys {
			o.Set(k, t[k])
		}
		return encode(b, o, st, depth, path)
	case json.Marshaler:
		raw, err := t.MarshalJSON()
		if err != nil {
			return err
		}
		parsed, err := Parse(raw)
		if err != nil {
			return err
		}
		return encode(b, parsed, st, depth, path)
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			return err
		}
		parsed, err := Parse(raw)
		if err != nil {
			return err
		}
		return encode(b, parsed, st, depth, path)
	}
	return nil
}

func writeString(b *bytes.Buffer, s string) {
	enc := json.NewEncoder(b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	b.Truncate(b.Len() - 1) // Encode appends a newline
}

// FromPlain converts decoded encoding/json values (maps, slices) into the
// ordered representation. Map keys are sorted so the result is deterministic.
func FromPlain(v any) any {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := NewObject()
		for _, k := range keys {
			o.Set(k, FromPlain(t[k]))
		}
		return o
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = FromPlain(t[i])
		}
		return out
	case float64:
		n, _ := json.Marshal(t)
		return json.Number(n)
	default:
		return v
	}
}

// ToPlain converts ordered values to plain maps and slices.
func ToPlain(v any) any {
	switch t := v.(type) {
	case *Object:
		m := make(map[string]any, t.Len())
		for _, k := range t.keys {
			m[k] = ToPlain(t.vals[k])
		}
		return m
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = ToPlain(t[i])
		}
		return out
	default:
		return v
	}
}

// Equal reports deep equality of two values (object key order is ignored).
func Equal(a, b any) bool {
	switch x := a.(type) {
	case *Object:
		y, ok := b.(*Object)
		if !ok || x.Len() != y.Len() {
			return false
		}
		for _, k := range x.keys {
			yv, ok := y.vals[k]
			if !ok || !Equal(x.vals[k], yv) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !Equal(x[i], y[i]) {
				return false
			}
		}
		return true
	case json.Number:
		y, ok := b.(json.Number)
		return ok && x == y
	default:
		return a == b
	}
}
