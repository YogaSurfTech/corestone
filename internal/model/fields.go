package model

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// FieldType is one of the Foundation's generic field types (design guide §4.6).
type FieldType string

const (
	FieldHID        FieldType = "hid"
	FieldBoolean    FieldType = "boolean"
	FieldInteger    FieldType = "integer"
	FieldFloat      FieldType = "float"
	FieldCurrency   FieldType = "currency"
	FieldDate       FieldType = "date"
	FieldTime       FieldType = "time"
	FieldDateTime   FieldType = "datetime"
	FieldText       FieldType = "text"
	FieldMultiline  FieldType = "multiline"
	FieldRichText   FieldType = "richtext"
	FieldEnum       FieldType = "enum"
	FieldHyperlink  FieldType = "hyperlink"
	FieldReference  FieldType = "reference"
	FieldReferences FieldType = "references"
	FieldAttachment FieldType = "attachment"
	FieldJSON       FieldType = "json"
	FieldWorkflow   FieldType = "workflow"
)

// FieldTypes lists every supported type.
var FieldTypes = []FieldType{FieldHID, FieldBoolean, FieldInteger, FieldFloat, FieldCurrency,
	FieldDate, FieldTime, FieldDateTime, FieldText, FieldMultiline, FieldRichText, FieldEnum,
	FieldHyperlink, FieldReference, FieldReferences, FieldAttachment, FieldJSON, FieldWorkflow}

// IsFieldType reports whether t is supported.
func IsFieldType(t FieldType) bool {
	for _, f := range FieldTypes {
		if f == t {
			return true
		}
	}
	return false
}

// EnumOption is one selectable enumeration value.
type EnumOption struct {
	Value        string         `json:"value"`
	Label        string         `json:"label,omitempty"`
	Presentation map[string]any `json:"presentation,omitempty"`
}

// EnumSource makes an enumeration dynamic: its options are the artifacts
// of one kind and of the given types, anywhere in the repository. A value
// is the GUID of the chosen artifact.
type EnumSource struct {
	Kind  Kind     `json:"kind"`  // entry or document
	Types []string `json:"types"` // the artifact types offered
	// Query narrows the options, in the query language. It is stored and
	// not evaluated yet.
	Query string `json:"query,omitempty"`
	// Sort is the order of the options, first level first: a built-in
	// field ("title", "hid", …) or a field id, with "~" in front for
	// descending ("~title" is Z to A). Empty: by title.
	Sort []string `json:"sort,omitempty"`
}

// SortOrder splits a sort level into the field and its direction: "~" in
// front means descending.
func SortOrder(level string) (field string, descending bool) {
	if strings.HasPrefix(level, "~") {
		return level[1:], true
	}
	return level, false
}

// MaxEnumSortLevels caps the sort levels of a dynamic enumeration.
const MaxEnumSortLevels = 3

func (s *EnumSource) validate(field string) error {
	if s.Kind != KindEntry && s.Kind != KindDocument {
		return Invalid("field %q source: kind must be \"entry\" or \"document\"", field)
	}
	if len(s.Types) == 0 {
		return Invalid("field %q source: name at least one type", field)
	}
	for _, t := range s.Types {
		if err := ValidateTypeID(t); err != nil {
			return fmt.Errorf("field %q source type: %w", field, err)
		}
	}
	if len(s.Query) > MaxTextLen {
		return Invalid("field %q source: query too long", field)
	}
	if len(s.Sort) > MaxEnumSortLevels {
		return Invalid("field %q source: at most %d sort levels", field, MaxEnumSortLevels)
	}
	for _, l := range s.Sort {
		id, _ := SortOrder(l)
		if id == "" || len(id) > 64 || strings.ContainsAny(id, " \t\n/.~$") {
			return Invalid("field %q source: sort level %q is no field (\"title\", or \"~title\" for descending)", field, l)
		}
	}
	return nil
}

// Allows reports whether an artifact of this kind and type is an option.
func (s *EnumSource) Allows(kind Kind, typ string) bool {
	if s.Kind != kind {
		return false
	}
	for _, t := range s.Types {
		if t == typ {
			return true
		}
	}
	return false
}

// Field is a schema field definition.
type Field struct {
	ID           string         `json:"id"`
	Name         string         `json:"name,omitempty"`
	Type         FieldType      `json:"type"`
	Multiple     bool           `json:"multiple,omitempty"`
	Required     bool           `json:"required,omitempty"`
	Options      []EnumOption   `json:"options,omitempty"`
	Extendable   bool           `json:"extendable,omitempty"`  // enum: values outside options allowed
	Enum         string         `json:"enum,omitempty"`        // enum: enumeration id (configuration layout); resolved into Options
	Source       *EnumSource    `json:"source,omitempty"`      // enum: the options are artifacts (dynamic enumeration)
	Currency     string         `json:"currency,omitempty"`    // currency: ISO code
	Workflow     string         `json:"workflow,omitempty"`    // workflow: definition id
	TargetTypes  []string       `json:"targetTypes,omitempty"` // reference(s): allowed artifact types
	Description  string         `json:"description,omitempty"`
	Default      any            `json:"default,omitempty"`
	Presentation map[string]any `json:"presentation,omitempty"`
	Searchable   *bool          `json:"searchable,omitempty"`
}

// ValidateDefinition checks a field definition itself.
func (f *Field) ValidateDefinition() error {
	if f.ID == "" || len(f.ID) > 64 || strings.ContainsAny(f.ID, " \t\n/.") {
		return Invalid("field id %q is invalid", f.ID)
	}
	if !IsFieldType(f.Type) {
		return Invalid("field %q has unknown type %q", f.ID, f.Type)
	}
	if f.Type == FieldWorkflow {
		if f.Workflow == "" {
			return Invalid("workflow field %q needs a workflow id", f.ID)
		}
		if err := ValidateTypeID(f.Workflow); err != nil {
			return fmt.Errorf("field %q workflow: %w", f.ID, err)
		}
		if f.Multiple || f.Default != nil {
			return Invalid("workflow field %q: a workflow field has one state, starting with the workflow's initial state", f.ID)
		}
	} else if f.Workflow != "" {
		return Invalid("field %q: only workflow fields name a workflow", f.ID)
	}
	if f.Enum != "" {
		if f.Type != FieldEnum {
			return Invalid("field %q: only enum fields reference an enumeration", f.ID)
		}
		if err := ValidateTypeID(f.Enum); err != nil {
			return fmt.Errorf("field %q enumeration: %w", f.ID, err)
		}
	}
	if f.Source != nil {
		if f.Type != FieldEnum {
			return Invalid("field %q: only enum fields have a source", f.ID)
		}
		if f.Enum != "" || len(f.Options) > 0 || f.Extendable {
			return Invalid("enum field %q: a source replaces options, an enumeration and extendable", f.ID)
		}
		if f.Default != nil {
			return Invalid("enum field %q: a field with a source has no default", f.ID)
		}
		if err := f.Source.validate(f.ID); err != nil {
			return err
		}
	}
	if f.Type == FieldEnum && f.Enum == "" && len(f.Options) == 0 && !f.Extendable && f.Source == nil {
		return Invalid("enum field %q has no options", f.ID)
	}
	for _, option := range f.Options {
		if err := validateIconPresentation(option.Presentation); err != nil {
			return fmt.Errorf("field %q option %q: %w", f.ID, option.Value, err)
		}
	}
	return nil
}

// ValidateValue checks a stored value against the definition. Values come
// from ojson (string, bool, ojson.Number, []any, *ojson.Object, nil).
func (f *Field) ValidateValue(v any) error {
	if v == nil {
		return nil
	}
	if f.Multiple && f.Type != FieldReferences && f.Type != FieldJSON {
		arr, ok := v.([]any)
		if !ok {
			return Invalid("field %q expects a list", f.ID)
		}
		for _, e := range arr {
			if err := f.validateSingle(e); err != nil {
				return err
			}
		}
		return nil
	}
	return f.validateSingle(v)
}

func (f *Field) validateSingle(v any) error {
	bad := func(want string) error { return Invalid("field %q expects %s", f.ID, want) }
	switch f.Type {
	case FieldBoolean:
		if _, ok := v.(bool); !ok {
			return bad("a boolean")
		}
	case FieldInteger:
		n, ok := v.(json.Number)
		if !ok {
			return bad("an integer")
		}
		if _, err := n.Int64(); err != nil {
			return bad("an integer")
		}
	case FieldFloat, FieldCurrency:
		n, ok := v.(json.Number)
		if !ok {
			return bad("a number")
		}
		if _, err := n.Float64(); err != nil {
			return bad("a number")
		}
	case FieldDate:
		s, ok := v.(string)
		if !ok {
			return bad("a date (YYYY-MM-DD)")
		}
		if _, err := time.Parse("2006-01-02", s); err != nil {
			return bad("a date (YYYY-MM-DD)")
		}
	case FieldTime:
		s, ok := v.(string)
		if !ok {
			return bad("a time (HH:MM or HH:MM:SS)")
		}
		if _, err := time.Parse("15:04", s); err != nil {
			if _, err := time.Parse("15:04:05", s); err != nil {
				return bad("a time (HH:MM or HH:MM:SS)")
			}
		}
	case FieldDateTime:
		s, ok := v.(string)
		if !ok {
			return bad("an RFC 3339 timestamp")
		}
		if _, err := time.Parse(time.RFC3339, s); err != nil {
			return bad("an RFC 3339 timestamp")
		}
	case FieldRichText:
		if err := ValidateRichText("field "+f.ID, v); err != nil {
			return err
		}
	case FieldHID, FieldText, FieldMultiline, FieldAttachment:
		s, ok := v.(string)
		if !ok {
			return bad("a string")
		}
		if err := ValidateText("field "+f.ID, s, MaxTextLen); err != nil {
			return err
		}
	case FieldEnum:
		s, ok := v.(string)
		if !ok {
			return bad("an enumeration value")
		}
		if f.Source != nil {
			// that the artifact exists and is an option is checked when the value is set
			if !IsGUID(s) {
				return bad("the GUID of an artifact")
			}
			return nil
		}
		if !f.Extendable {
			for _, o := range f.Options {
				if o.Value == s {
					return nil
				}
			}
			return Invalid("field %q does not allow value %q", f.ID, s)
		}
	case FieldHyperlink:
		s, ok := v.(string)
		if !ok {
			return bad("a URL")
		}
		if !SafeURL(s) {
			return bad("an http(s), ftp(s) or mailto URL")
		}
	case FieldReference:
		s, ok := v.(string)
		if !ok || !IsGUID(s) {
			return bad("an artifact GUID")
		}
	case FieldReferences:
		arr, ok := v.([]any)
		if !ok {
			return bad("a list of artifact GUIDs")
		}
		for _, e := range arr {
			if s, ok := e.(string); !ok || !IsGUID(s) {
				return bad("a list of artifact GUIDs")
			}
		}
	case FieldWorkflow:
		if _, ok := ParseWorkflowValue(v); !ok {
			return bad("a workflow state (written by the server)")
		}
	case FieldJSON:
		// anything goes
	}
	return nil
}

// SafeURL reports whether s is an absolute URL with a scheme that is safe
// to render as a link (never javascript:, data:, vbscript:, …).
func SafeURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Scheme == "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "ftp", "ftps", "mailto":
		return true
	}
	return false
}

// ReferencedGUIDs extracts GUIDs held by reference fields so the caller can
// verify they exist.
func (f *Field) ReferencedGUIDs(v any) []string {
	switch f.Type {
	case FieldReference:
		if s, ok := v.(string); ok {
			return []string{s}
		}
		if arr, ok := v.([]any); ok && f.Multiple {
			return stringsOf(arr)
		}
	case FieldReferences:
		if arr, ok := v.([]any); ok {
			return stringsOf(arr)
		}
	case FieldRichText:
		return RichTextRefs(v)
	}
	return nil
}

// SourceGUIDs are the artifacts a dynamic enumeration's value names.
func (f *Field) SourceGUIDs(v any) []string {
	if f.Type != FieldEnum || f.Source == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		return []string{s}
	}
	if arr, ok := v.([]any); ok {
		return stringsOf(arr)
	}
	return nil
}

func stringsOf(arr []any) []string {
	var out []string
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// FieldsObject is a convenience wrapper for the "fields" property.
func FieldsObject(o *ojson.Object) *ojson.Object {
	if o == nil {
		return ojson.NewObject()
	}
	if f := o.Object("fields"); f != nil {
		return f
	}
	return ojson.NewObject()
}
