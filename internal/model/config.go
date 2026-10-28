package model

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
)

// Repository configuration (docs/CONFIGURATION.md). Every folder may hold
// <folder>/.corestone/config/ with one directory per artifact kind:
//
//	<kind>/types.json                          types of the kind, inheritance switch
//	<kind>/fields.json                         shared fields
//	<kind>/<type_id>-fields.json               fields of one type
//	<kind>/enums/[<type_id>-]<id>-enum.json    enumerations
//	<kind>/workflows/[<type_id>-]<id>-workflow.json
//	icons/<name>.svg                           icons, shared by all kinds
//
// File names are constructed from identifiers and never split: a lookup of
// enumeration "priority" for type "task" tries "task-priority" before
// "priority". Enumeration and workflow files may state "id" and "type" to
// disambiguate; when present they must match the lookup.

// ConfigDir is the configuration directory below a folder.
const ConfigDir = MetadataDir + "/config"

// ConfigKinds lists the kind directories in resolution order.
var ConfigKinds = []struct {
	Dir  string
	Kind Kind
}{{"entries", KindEntry}, {"documents", KindDocument}, {"links", KindLink}, {"comments", KindComment}}

// ConfigRole says what a configuration file defines.
type ConfigRole string

const (
	RoleTypes    ConfigRole = "types"
	RoleFields   ConfigRole = "fields"
	RoleEnum     ConfigRole = "enum"
	RoleWorkflow ConfigRole = "workflow"
	RoleIcon     ConfigRole = "icon"
)

// ConfigName is what a configuration file's path says about it.
type ConfigName struct {
	Kind Kind
	Role ConfigRole
	// Name is the type id of a fields file ("" = shared), the file name of
	// an enumeration or workflow without its suffix, or an icon's name.
	Name string
}

// ConfigPath is the repository path of a file below scope's config directory.
func ConfigPath(scope, rel string) string {
	return path.Join(scope, ConfigDir, rel)
}

// ClassifyConfig interprets a path relative to a config directory, such as
// "entries/enums/task-priority-enum.json" or "icons/testcase.svg".
func ClassifyConfig(rel string) (ConfigName, bool) {
	parts := strings.Split(rel, "/")
	if len(parts) == 2 && parts[0] == "icons" {
		name := strings.TrimSuffix(parts[1], ".svg")
		if name != parts[1] && ValidIconName(name) {
			return ConfigName{Role: RoleIcon, Name: name}, true
		}
		return ConfigName{}, false
	}
	var kind Kind
	for _, k := range ConfigKinds {
		if k.Dir == parts[0] {
			kind = k.Kind
		}
	}
	if kind == "" {
		return ConfigName{}, false
	}
	stem := func(file, suffix string) (string, bool) {
		if !strings.HasSuffix(file, suffix) || len(file) == len(suffix) {
			return "", false
		}
		return strings.TrimSuffix(file, suffix), true
	}
	switch {
	case len(parts) == 2 && parts[1] == "types.json":
		return ConfigName{kind, RoleTypes, ""}, true
	case len(parts) == 2 && parts[1] == "fields.json":
		return ConfigName{kind, RoleFields, ""}, true
	case len(parts) == 2:
		if n, ok := stem(parts[1], "-fields.json"); ok {
			return ConfigName{kind, RoleFields, n}, true
		}
	case len(parts) == 3 && parts[1] == "enums":
		if n, ok := stem(parts[2], "-enum.json"); ok {
			return ConfigName{kind, RoleEnum, n}, true
		}
	case len(parts) == 3 && parts[1] == "workflows":
		if n, ok := stem(parts[2], "-workflow.json"); ok {
			return ConfigName{kind, RoleWorkflow, n}, true
		}
	}
	return ConfigName{}, false
}

// ---- files ----------------------------------------------------------------

// TypesFile is a kind's types.json.
type TypesFile struct {
	Inheritance string // "off" ignores this kind's configuration above the folder
	Types       []*TypeDef
}

// TypeDef is one type in a types.json: the type's own properties, and the
// fields it uses with their order and per-type required flag.
type TypeDef struct {
	Schema *Schema // Type and Kind set, no Fields
	Fields []FieldRef
}

// FieldRef selects a field for a type: "id" or {"id": ..., "required": ...}.
type FieldRef struct {
	ID       string `json:"id"`
	Required *bool  `json:"required,omitempty"`
}

// UnmarshalJSON accepts a plain field id as well as the object form.
func (r *FieldRef) UnmarshalJSON(b []byte) error {
	if err := json.Unmarshal(b, &r.ID); err == nil {
		return nil
	}
	type plain FieldRef
	return json.Unmarshal(b, (*plain)(r))
}

// typeKeysReserved are set by the layout, not by a type entry.
var typeKeysReserved = []string{"type", "kind", "inheritance"}

// ParseTypesFile decodes and validates a kind's types.json.
func ParseTypesFile(data []byte, kind Kind) (*TypesFile, error) {
	var raw struct {
		Inheritance string            `json:"inheritance"`
		Types       []json.RawMessage `json:"types"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, Invalid("types file is not valid JSON: %v", err)
	}
	if raw.Inheritance != "" && raw.Inheritance != "on" && raw.Inheritance != "off" {
		return nil, Invalid("inheritance must be \"on\" or \"off\"")
	}
	tf := &TypesFile{Inheritance: raw.Inheritance}
	seen := map[string]bool{}
	for i, t := range raw.Types {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(t, &m); err != nil {
			return nil, Invalid("type %d is not an object", i)
		}
		var id string
		_ = json.Unmarshal(m["id"], &id)
		if err := ValidateTypeID(id); err != nil {
			return nil, fmt.Errorf("type %d id: %w", i, err)
		}
		if seen[id] {
			return nil, Invalid("type %q is defined twice", id)
		}
		seen[id] = true
		for _, k := range typeKeysReserved {
			if _, ok := m[k]; ok {
				return nil, Invalid("type %q: %q is not set per type", id, k)
			}
		}
		var refs []FieldRef
		if f, ok := m["fields"]; ok {
			if err := json.Unmarshal(f, &refs); err != nil {
				return nil, Invalid("type %q: fields must list field ids", id)
			}
		}
		used := map[string]bool{}
		for _, r := range refs {
			if !validFieldID(r.ID) {
				return nil, Invalid("type %q: field id %q is invalid", id, r.ID)
			}
			if used[r.ID] {
				return nil, Invalid("type %q lists field %q twice", id, r.ID)
			}
			used[r.ID] = true
		}
		delete(m, "fields")
		delete(m, "id")
		m["type"], _ = json.Marshal(id)
		m["kind"], _ = json.Marshal(kind)
		b, _ := json.Marshal(m)
		s, err := ParseSchema(b)
		if err != nil {
			return nil, fmt.Errorf("type %q: %w", id, err)
		}
		if err := validateIconPresentation(s.Presentation); err != nil {
			return nil, fmt.Errorf("type %q: %w", id, err)
		}
		tf.Types = append(tf.Types, &TypeDef{Schema: s, Fields: refs})
	}
	return tf, nil
}

func validateIconPresentation(p map[string]any) error {
	if icon, ok := p["icon"]; ok {
		if name, _ := icon.(string); !ValidIconName(name) {
			return Invalid("presentation icon must be an icon name of letters, digits, \"_\" and \"-\"")
		}
	}
	if value, ok := p["backgroundColor"]; ok {
		color, valid := value.(string)
		if !valid || strings.TrimSpace(color) == "" {
			return Invalid("presentation backgroundColor must be a non-empty CSS color string")
		}
	}
	return nil
}

func validFieldID(id string) bool {
	return id != "" && len(id) <= 64 && !strings.ContainsAny(id, " \t\n/.")
}

var iconNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,255}$`)

// ValidIconName reports whether name can name an icon (icons/<name>.svg).
func ValidIconName(name string) bool { return iconNameRe.MatchString(name) }

// MaxIconSize bounds an icon file.
const MaxIconSize = 64 << 10

// ParseIcon validates an icon file: a well-formed SVG document without
// scripts, event handlers, embedded HTML or references to other files.
// Icons are only ever displayed as images, where none of this would run;
// the check keeps the files harmless when opened directly as well.
func ParseIcon(data []byte) error {
	if len(data) == 0 || len(data) > MaxIconSize {
		return Invalid("icon must be an SVG file of at most %d KiB", MaxIconSize>>10)
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	root := true
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Invalid("icon is not well-formed SVG: %v", err)
		}
		switch t := tok.(type) {
		case xml.Directive:
			return Invalid("icon must not contain a DOCTYPE or other directives")
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			if root && name != "svg" {
				return Invalid("icon must be an SVG document, found <%s>", t.Name.Local)
			}
			root = false
			if name == "script" || name == "foreignobject" {
				return Invalid("icon must not contain <%s>", t.Name.Local)
			}
			for _, a := range t.Attr {
				an := strings.ToLower(a.Name.Local)
				if strings.HasPrefix(an, "on") {
					return Invalid("icon must not contain event handler %q", a.Name.Local)
				}
				if an == "href" && !strings.HasPrefix(strings.TrimSpace(a.Value), "#") {
					return Invalid("icon must not reference other files (%s=%q)", a.Name.Local, a.Value)
				}
			}
		}
	}
	if root {
		return Invalid("icon must be an SVG document")
	}
	return nil
}

// ParseFieldsFile decodes and validates a fields.json or <type>-fields.json.
func ParseFieldsFile(data []byte) ([]Field, error) {
	var raw struct {
		Fields []Field `json:"fields"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, Invalid("fields file is not valid JSON: %v", err)
	}
	seen := map[string]bool{}
	for i := range raw.Fields {
		if err := raw.Fields[i].ValidateDefinition(); err != nil {
			return nil, err
		}
		if seen[raw.Fields[i].ID] {
			return nil, Invalid("duplicate field id %q", raw.Fields[i].ID)
		}
		seen[raw.Fields[i].ID] = true
	}
	return raw.Fields, nil
}

// Enum is an enumeration file: the options of enum fields referencing it.
type Enum struct {
	ID          string       `json:"id,omitempty"`   // optional: must match the lookup when set
	Type        string       `json:"type,omitempty"` // optional: the type a type-specific file belongs to
	Name        string       `json:"name,omitempty"`
	Description string       `json:"description,omitempty"`
	Extendable  bool         `json:"extendable,omitempty"` // values outside the options are allowed
	Options     []EnumOption `json:"options"`
}

// ParseEnum decodes and validates an enumeration file.
func ParseEnum(data []byte) (*Enum, error) {
	var e Enum
	if err := json.Unmarshal(data, &e); err != nil {
		return nil, Invalid("enumeration is not valid JSON: %v", err)
	}
	for _, id := range []string{e.ID, e.Type} {
		if id != "" {
			if err := ValidateTypeID(id); err != nil {
				return nil, err
			}
		}
	}
	if len(e.Options) == 0 && !e.Extendable {
		return nil, Invalid("enumeration has no options")
	}
	seen := map[string]bool{}
	for _, o := range e.Options {
		if o.Value == "" || seen[o.Value] {
			return nil, Invalid("enumeration has an empty or duplicate value %q", o.Value)
		}
		if err := validateIconPresentation(o.Presentation); err != nil {
			return nil, fmt.Errorf("enumeration option %q: %w", o.Value, err)
		}
		seen[o.Value] = true
	}
	return &e, nil
}

// ParseWorkflowFile decodes and validates a workflow file of the
// configuration layout, where "id" is optional (the lookup supplies it).
func ParseWorkflowFile(data []byte, name string) (*Workflow, error) {
	var w Workflow
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, Invalid("workflow is not valid JSON: %v", err)
	}
	declared := w.ID
	if w.ID == "" {
		w.ID = name // only for the messages of Validate
	}
	if err := w.Validate(); err != nil {
		return nil, err
	}
	if w.Type != "" {
		if err := ValidateTypeID(w.Type); err != nil {
			return nil, fmt.Errorf("workflow type: %w", err)
		}
	}
	w.ID = declared
	return &w, nil
}

// ParseConfigFile classifies and validates one file below a config
// directory. References to other files are checked by ConfigIndex.Problems.
func ParseConfigFile(rel string, data []byte) (ConfigName, any, error) {
	n, ok := ClassifyConfig(rel)
	if !ok {
		return n, nil, Invalid("not a configuration file: expected <kind>/types.json, <kind>/[<type>-]fields.json, <kind>/enums/<name>-enum.json, <kind>/workflows/<name>-workflow.json or icons/<name>.svg")
	}
	var v any
	var err error
	switch n.Role {
	case RoleTypes:
		v, err = ParseTypesFile(data, n.Kind)
	case RoleFields:
		v, err = ParseFieldsFile(data)
	case RoleEnum:
		v, err = ParseEnum(data)
	case RoleWorkflow:
		v, err = ParseWorkflowFile(data, n.Name)
	case RoleIcon:
		err = ParseIcon(data)
	}
	return n, v, err
}

// ---- index ----------------------------------------------------------------

// ConfigFile is one file below a folder's config directory.
type ConfigFile struct {
	Scope string // the folder holding the .corestone directory
	Path  string // relative to <scope>/.corestone/config
	Data  []byte
}

// ConfigProblem is an unusable file or a reference that does not resolve.
type ConfigProblem struct {
	Path    string `json:"path"` // repository path of the file concerned
	Message string `json:"message"`
}

// kindConfig is one kind's configuration in one folder.
type kindConfig struct {
	types      *TypesFile
	typeByID   map[string]*TypeDef
	shared     map[string]*Field
	typeFields map[string]map[string]*Field
	typeOrder  map[string][]string // field ids of <type>-fields.json in file order
	enums      map[string]*Enum
	workflows  map[string]*Workflow
}

func newKindConfig() *kindConfig {
	return &kindConfig{typeByID: map[string]*TypeDef{}, shared: map[string]*Field{}, typeFields: map[string]map[string]*Field{},
		typeOrder: map[string][]string{}, enums: map[string]*Enum{}, workflows: map[string]*Workflow{}}
}

// ConfigIndex resolves types, fields, enumerations and workflows for any
// folder from the configuration files of a repository.
type ConfigIndex struct {
	scopes map[string]map[Kind]*kindConfig
	icons  map[string]map[string]bool // scope -> icon names defined there
}

// NewConfigIndex builds an index; files that do not parse are left out and
// returned as problems. Icons are indexed by name only: their content is
// validated when written and when projected, and is read from Git on use.
func NewConfigIndex(files []ConfigFile) (*ConfigIndex, []ConfigProblem) {
	idx := &ConfigIndex{scopes: map[string]map[Kind]*kindConfig{}, icons: map[string]map[string]bool{}}
	var problems []ConfigProblem
	for _, f := range files {
		if n, ok := ClassifyConfig(f.Path); ok && n.Role == RoleIcon {
			if idx.icons[f.Scope] == nil {
				idx.icons[f.Scope] = map[string]bool{}
			}
			idx.icons[f.Scope][n.Name] = true
			continue
		}
		n, v, err := ParseConfigFile(f.Path, f.Data)
		if err != nil {
			problems = append(problems, ConfigProblem{ConfigPath(f.Scope, f.Path), err.Error()})
			continue
		}
		if idx.scopes[f.Scope] == nil {
			idx.scopes[f.Scope] = map[Kind]*kindConfig{}
		}
		kc := idx.scopes[f.Scope][n.Kind]
		if kc == nil {
			kc = newKindConfig()
			idx.scopes[f.Scope][n.Kind] = kc
		}
		switch v := v.(type) {
		case *TypesFile:
			kc.types = v
			for _, t := range v.Types {
				kc.typeByID[t.Schema.Type] = t
			}
		case []Field:
			m := map[string]*Field{}
			for i := range v {
				m[v[i].ID] = &v[i]
				if n.Name != "" {
					kc.typeOrder[n.Name] = append(kc.typeOrder[n.Name], v[i].ID)
				}
			}
			if n.Name == "" {
				kc.shared = m
			} else {
				kc.typeFields[n.Name] = m
			}
		case *Enum:
			kc.enums[n.Name] = v
		case *Workflow:
			kc.workflows[n.Name] = v
		}
	}
	return idx, problems
}

// scoped is one folder's configuration of a kind on a resolution chain.
type scoped struct {
	scope string
	kc    *kindConfig
}

// chain lists the configuration of kind visible from folder, nearest folder
// first, ending at the first types.json that switches inheritance off.
func (idx *ConfigIndex) chain(kind Kind, folder string) []scoped {
	var out []scoped
	for _, scope := range Ancestors(folder) {
		kc := idx.scopes[scope][kind]
		if kc == nil {
			continue
		}
		out = append(out, scoped{scope, kc})
		if kc.types != nil && kc.types.Inheritance == "off" {
			break
		}
	}
	return out
}

// IconScope finds the folder whose configuration defines icon name for
// folder, nearest first. Icons are always inherited: "inheritance": "off"
// in a types.json does not apply to them.
func (idx *ConfigIndex) IconScope(name, folder string) (string, bool) {
	for _, scope := range Ancestors(folder) {
		if idx.icons[scope][name] {
			return scope, true
		}
	}
	return "", false
}

// kindOf finds the kind defining typ at folder, in ConfigKinds order.
func (idx *ConfigIndex) kindOf(typ, folder string) (Kind, []scoped, bool) {
	for _, k := range ConfigKinds {
		ch := idx.chain(k.Kind, folder)
		for _, sc := range ch {
			if sc.kc.typeByID[typ] != nil {
				return k.Kind, ch, true
			}
		}
	}
	return "", nil, false
}

// Effective resolves the effective schema of typ for an artifact in folder,
// with fields resolved and enumeration options inlined. Nil when the type
// is not defined there.
func (idx *ConfigIndex) Effective(typ, folder string) *Schema {
	kind, ch, ok := idx.kindOf(typ, folder)
	if !ok {
		return nil
	}
	eff, _ := idx.compose(typ, kind, ch)
	return eff
}

func (idx *ConfigIndex) compose(typ string, kind Kind, ch []scoped) (*Schema, []string) {
	var defs []ScopedSchema
	for i := len(ch) - 1; i >= 0; i-- {
		if td := ch[i].kc.typeByID[typ]; td != nil {
			s := *td.Schema
			s.Fields, s.Inheritance = nil, ""
			defs = append(defs, ScopedSchema{Scope: ch[i].scope, Schema: &s})
		}
	}
	eff := Compose(defs)
	eff.Kind = kind
	// Field ids in order of first appearance from the root down; the nearest
	// required flag of a type's field list wins.
	var ids []string
	seen := map[string]bool{}
	required := map[string]*bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for i := len(ch) - 1; i >= 0; i-- {
		if td := ch[i].kc.typeByID[typ]; td != nil {
			for _, r := range td.Fields {
				add(r.ID)
				if r.Required != nil {
					required[r.ID] = r.Required
				}
			}
		}
		for _, id := range ch[i].kc.typeOrder[typ] {
			add(id)
		}
	}
	var problems []string
	for _, id := range ids {
		def := fieldDef(ch, typ, id)
		if def == nil {
			problems = append(problems, fmt.Sprintf("type %q uses field %q, which is not defined", typ, id))
			continue
		}
		f := *def
		f.Options = append([]EnumOption(nil), def.Options...)
		if r := required[id]; r != nil {
			f.Required = *r
		}
		if f.Type == FieldEnum && f.Enum != "" {
			e, _ := lookup(ch, typ, f.Enum, func(kc *kindConfig) map[string]*Enum { return kc.enums },
				func(e *Enum) (string, string) { return e.ID, e.Type })
			if e == nil {
				problems = append(problems, fmt.Sprintf("field %q of type %q uses enumeration %q, which is not defined", id, typ, f.Enum))
				continue
			}
			f.Options = append([]EnumOption(nil), e.Options...)
			f.Extendable = f.Extendable || e.Extendable
		}
		if f.Type == FieldWorkflow && workflowDef(ch, typ, f.Workflow) == nil {
			problems = append(problems, fmt.Sprintf("field %q of type %q uses workflow %q, which is not defined", id, typ, f.Workflow))
		}
		eff.Fields = append(eff.Fields, f)
	}
	for _, w := range eff.Workflows {
		if workflowDef(ch, typ, w) == nil {
			problems = append(problems, fmt.Sprintf("type %q uses workflow %q, which is not defined", typ, w))
		}
	}
	return eff, problems
}

// fieldDef finds a field definition nearest first; within a folder the
// type's own fields file wins over the shared one.
func fieldDef(ch []scoped, typ, id string) *Field {
	for _, sc := range ch {
		if f := sc.kc.typeFields[typ][id]; f != nil {
			return f
		}
		if f := sc.kc.shared[id]; f != nil {
			return f
		}
	}
	return nil
}

// lookup finds a definition by constructed file name, nearest folder first;
// within a folder "<typ>-<id>" before "<id>". Declared ids and types must
// match the lookup.
func lookup[T any](ch []scoped, typ, id string, files func(*kindConfig) map[string]T, declared func(T) (string, string)) (T, string) {
	for _, sc := range ch {
		m := files(sc.kc)
		for _, name := range []string{typ + "-" + id, id} {
			v, ok := m[name]
			if !ok {
				continue
			}
			if dID, dType := declared(v); (dID == "" || dID == id) && (dType == "" || dType == typ) {
				return v, sc.scope
			}
		}
	}
	var zero T
	return zero, ""
}

func workflowDef(ch []scoped, typ, id string) *Workflow {
	w, scope := lookup(ch, typ, id, func(kc *kindConfig) map[string]*Workflow { return kc.workflows },
		func(w *Workflow) (string, string) { return w.ID, w.Type })
	if w == nil {
		return nil
	}
	c := *w
	c.ID, c.Scope = id, scope
	return &c
}

// Workflow resolves workflow id for an artifact of typ in folder.
func (idx *ConfigIndex) Workflow(typ, id, folder string) *Workflow {
	_, ch, ok := idx.kindOf(typ, folder)
	if !ok {
		return nil
	}
	return workflowDef(ch, typ, id)
}

// TypesVisible lists the effective schemas of every type defined at folder,
// sorted by type id. A kind without types is not available there.
func (idx *ConfigIndex) TypesVisible(folder string) []*Schema {
	var out []*Schema
	seen := map[string]bool{}
	for _, k := range ConfigKinds {
		for _, sc := range idx.chain(k.Kind, folder) {
			if sc.kc.types == nil {
				continue
			}
			for _, t := range sc.kc.types.Types {
				if id := t.Schema.Type; !seen[id] {
					seen[id] = true
					if eff := idx.Effective(id, folder); eff != nil {
						out = append(out, eff)
					}
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

// LinkTypesFor lists link types visible from folder that allow typ as
// source or target.
func (idx *ConfigIndex) LinkTypesFor(typ, folder string) (asSource, asTarget []*Schema) {
	for _, s := range idx.TypesVisible(folder) {
		if s.Kind != KindLink {
			continue
		}
		if AllowsEndpoint(s.SourceTypes, typ) {
			asSource = append(asSource, s)
		}
		if AllowsEndpoint(s.TargetTypes, typ) {
			asTarget = append(asTarget, s)
		}
	}
	return
}

// Problems reports references that do not resolve and type ids defined for
// more than one kind. Each folder holding configuration is checked as an
// artifact location, and a problem is reported at the file of that folder
// that introduces it, so it appears once rather than in every subfolder.
func (idx *ConfigIndex) Problems() []ConfigProblem {
	scopes := make([]string, 0, len(idx.scopes))
	for s := range idx.scopes {
		scopes = append(scopes, s)
	}
	sort.Strings(scopes)
	var out []ConfigProblem
	seen := map[ConfigProblem]bool{}
	report := func(p ConfigProblem) {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, scope := range scopes {
		kinds := map[string][]string{}  // type id -> kind dirs where it is visible here
		localDir := map[string]string{} // type id -> kind dir of this folder defining it
		for _, k := range ConfigKinds {
			ch := idx.chain(k.Kind, scope)
			local := idx.scopes[scope][k.Kind]
			for _, sc := range ch {
				if sc.kc.types == nil {
					continue
				}
				for _, t := range sc.kc.types.Types {
					kinds[t.Schema.Type] = appendOnce(kinds[t.Schema.Type], k.Dir)
				}
			}
			if local == nil {
				continue
			}
			for name, enum := range local.enums {
				for _, option := range enum.Options {
					if icon, _ := option.Presentation["icon"].(string); icon != "" {
						if _, ok := idx.IconScope(icon, scope); !ok {
							report(ConfigProblem{
								ConfigPath(scope, k.Dir+"/enums/"+name+"-enum.json"),
								fmt.Sprintf("enumeration option %q uses icon %q, which is not defined", option.Value, icon),
							})
						}
					}
				}
			}
			// Types this folder defines or adds fields to.
			var types []string
			for id := range local.typeByID {
				types = append(types, id)
				localDir[id] = k.Dir
			}
			for id := range local.typeOrder {
				if local.typeByID[id] == nil {
					types = append(types, id)
				}
			}
			sort.Strings(types)
			for _, typ := range types {
				file := ConfigPath(scope, k.Dir+"/types.json")
				if local.typeByID[typ] == nil {
					file = ConfigPath(scope, k.Dir+"/"+typ+"-fields.json")
				}
				if !definesIn(ch, typ) {
					report(ConfigProblem{file, fmt.Sprintf("fields for type %q, which is not defined here", typ)})
					continue
				}
				_, msgs := idx.compose(typ, k.Kind, ch)
				for _, m := range msgs {
					report(ConfigProblem{file, m})
				}
				if td := local.typeByID[typ]; td != nil {
					if icon, _ := td.Schema.Presentation["icon"].(string); icon != "" {
						if _, ok := idx.IconScope(icon, scope); !ok {
							report(ConfigProblem{file, fmt.Sprintf("type %q uses icon %q, which is not defined", typ, icon)})
						}
					}
				}
			}
		}
		for typ, dirs := range kinds {
			if len(dirs) > 1 && localDir[typ] != "" {
				report(ConfigProblem{ConfigPath(scope, localDir[typ]+"/types.json"), fmt.Sprintf("type %q is defined for several kinds (%s); type ids must be unique", typ, strings.Join(dirs, ", "))})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Message < out[j].Message
	})
	return out
}

func definesIn(ch []scoped, typ string) bool {
	for _, sc := range ch {
		if sc.kc.typeByID[typ] != nil {
			return true
		}
	}
	return false
}

func appendOnce(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}
