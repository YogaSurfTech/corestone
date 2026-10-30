package model

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Cardinality of a link type (design guide §4.8).
type Cardinality string

const (
	OneToOne   Cardinality = "one-to-one"
	OneToMany  Cardinality = "one-to-many"
	ManyToOne  Cardinality = "many-to-one"
	ManyToMany Cardinality = "many-to-many"
)

// HIDConfig drives automatic HID generation for a type.
type HIDConfig struct {
	Prefix    string `json:"prefix"`
	Separator string `json:"separator,omitempty"` // default "-"
	Digits    int    `json:"digits,omitempty"`    // zero padding, 0 = none
}

// Schema is one schema definition file, or the effective (composed) schema
// of an artifact type at a location. Any native kind can be typed: entry and
// document types describe folder artifacts, link types describe
// relationships (with endpoint constraints and cardinality), comment types
// describe annotations.
type Schema struct {
	Type         string         `json:"type"`
	Kind         Kind           `json:"kind"`
	Inheritance  string         `json:"inheritance,omitempty"` // "off" severs composition
	DisplayName  string         `json:"displayName,omitempty"`
	Description  string         `json:"description,omitempty"`
	HID          *HIDConfig     `json:"hid,omitempty"`
	Fields       []Field        `json:"fields,omitempty"`
	Workflows    []string       `json:"workflows,omitempty"`
	SourceTypes  []string       `json:"sourceTypes,omitempty"` // links: allowed source types ("*" = any)
	TargetTypes  []string       `json:"targetTypes,omitempty"` // links: allowed target types
	Cardinality  Cardinality    `json:"cardinality,omitempty"` // links
	Presentation map[string]any `json:"presentation,omitempty"`
	Extra        map[string]any `json:"-"` // unknown top-level properties, passed through

	// Sources lists the scopes whose definitions were composed (effective schemas only).
	Sources []string `json:"sources,omitempty"`
}

// knownSchemaKeys are consumed by the typed struct; everything else is kept in Extra.
var knownSchemaKeys = map[string]bool{"type": true, "kind": true, "inheritance": true, "displayName": true,
	"description": true, "hid": true, "fields": true, "workflows": true, "sourceTypes": true,
	"targetTypes": true, "cardinality": true, "presentation": true, "sources": true}

// ParseSchema decodes and validates a schema definition file.
func ParseSchema(data []byte) (*Schema, error) {
	var s Schema
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, Invalid("schema is not valid JSON: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		for k, v := range raw {
			if !knownSchemaKeys[k] {
				if s.Extra == nil {
					s.Extra = map[string]any{}
				}
				var any_ any
				_ = json.Unmarshal(v, &any_)
				s.Extra[k] = any_
			}
		}
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

// MarshalJSON emits the schema with pass-through properties.
func (s *Schema) MarshalJSON() ([]byte, error) {
	type alias Schema
	b, err := json.Marshal((*alias)(s))
	if err != nil || len(s.Extra) == 0 {
		return b, err
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k, v := range s.Extra {
		if _, taken := m[k]; !taken {
			m[k] = v
		}
	}
	return json.Marshal(m)
}

// Validate checks a single definition.
func (s *Schema) Validate() error {
	if err := ValidateTypeID(s.Type); err != nil {
		return fmt.Errorf("schema type: %w", err)
	}
	if s.Kind == "" {
		s.Kind = KindEntry
	}
	if _, err := ParseKind(string(s.Kind)); err != nil {
		return err
	}
	if s.Inheritance != "" && s.Inheritance != "off" && s.Inheritance != "on" {
		return Invalid("inheritance must be \"on\" or \"off\"")
	}
	seen := map[string]bool{}
	for i := range s.Fields {
		if err := s.Fields[i].ValidateDefinition(); err != nil {
			return err
		}
		if seen[s.Fields[i].ID] {
			return Invalid("duplicate field id %q", s.Fields[i].ID)
		}
		seen[s.Fields[i].ID] = true
	}
	for _, w := range s.Workflows {
		if err := ValidateTypeID(w); err != nil {
			return fmt.Errorf("workflow reference: %w", err)
		}
	}
	if err := validateEndpoints("sourceTypes", s.SourceTypes); err != nil {
		return err
	}
	if err := validateEndpoints("targetTypes", s.TargetTypes); err != nil {
		return err
	}
	switch s.Cardinality {
	case "", OneToOne, OneToMany, ManyToOne, ManyToMany:
	default:
		return Invalid("unknown cardinality %q", s.Cardinality)
	}
	if s.HID != nil && s.HID.Prefix == "" {
		return Invalid("hid.prefix must not be empty")
	}
	if s.HID != nil {
		if err := ValidateHID(s.HID.Prefix + "1"); err != nil {
			return err
		}
	}
	return nil
}

// Field returns the definition of a field id.
func (s *Schema) Field(id string) *Field {
	for i := range s.Fields {
		if s.Fields[i].ID == id {
			return &s.Fields[i]
		}
	}
	return nil
}

// AllWorkflows returns workflow ids from both the workflows list and
// workflow-typed fields, in a stable order.
func (s *Schema) AllWorkflows() []string {
	set := map[string]bool{}
	var out []string
	add := func(id string) {
		if id != "" && !set[id] {
			set[id] = true
			out = append(out, id)
		}
	}
	for _, w := range s.Workflows {
		add(w)
	}
	for _, f := range s.Fields {
		if f.Type == FieldWorkflow {
			add(f.Workflow)
		}
	}
	return out
}

// EndpointKind reports the kind of a "<kind>/*" endpoint pattern. The kind
// may be written as the kind ("document") or its config directory ("documents").
func EndpointKind(pattern string) (Kind, bool) {
	name, ok := strings.CutSuffix(pattern, "/*")
	if !ok {
		return "", false
	}
	for _, k := range ConfigKinds {
		if name == string(k.Kind) || name == k.Dir {
			return k.Kind, true
		}
	}
	return "", false
}

// validateEndpoints checks sourceTypes/targetTypes entries: "*", "<kind>/*" or a type id.
func validateEndpoints(name string, allowed []string) error {
	for _, a := range allowed {
		if a == "*" {
			continue
		}
		if strings.HasSuffix(a, "/*") {
			if _, ok := EndpointKind(a); !ok {
				return Invalid("%s: unknown kind in %q", name, a)
			}
			continue
		}
		if err := ValidateTypeID(a); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// AllowsEndpoint reports whether a link schema accepts an artifact of the
// given kind and type as source/target. No list or "*" allows anything;
// "<kind>/*" allows every type of that kind.
func AllowsEndpoint(allowed []string, kind Kind, typ string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if a == "*" || a == typ {
			return true
		}
		if k, ok := EndpointKind(a); ok && k == kind {
			return true
		}
	}
	return false
}

// ScopedSchema is a definition together with the folder that owns it.
type ScopedSchema struct {
	Scope  string
	Schema *Schema
}

// Compose builds the effective schema for a type from the definitions found
// along the lineage root → folder (design guide §4.3–§4.4): every matching
// definition contributes; the nearer definition wins per property; fields
// and relationships merge by id with complete replacement; a definition
// with inheritance "off" discards everything above it. defs must be ordered
// root first. Returns nil when no definition matches.
func Compose(defs []ScopedSchema) *Schema {
	if len(defs) == 0 {
		return nil
	}
	start := 0
	for i := range defs {
		if defs[i].Schema.Inheritance == "off" {
			start = i
		}
	}
	defs = defs[start:]
	eff := &Schema{Type: defs[0].Schema.Type, Kind: defs[0].Schema.Kind}
	for _, d := range defs {
		s := d.Schema
		eff.Sources = append(eff.Sources, d.Scope)
		if s.Kind != "" {
			eff.Kind = s.Kind
		}
		if s.DisplayName != "" {
			eff.DisplayName = s.DisplayName
		}
		if s.Description != "" {
			eff.Description = s.Description
		}
		if s.HID != nil {
			h := *s.HID
			eff.HID = &h
		}
		for _, f := range s.Fields {
			replaced := false
			for i := range eff.Fields {
				if eff.Fields[i].ID == f.ID {
					eff.Fields[i] = f
					replaced = true
					break
				}
			}
			if !replaced {
				eff.Fields = append(eff.Fields, f)
			}
		}
		for _, w := range s.Workflows {
			found := false
			for _, e := range eff.Workflows {
				if e == w {
					found = true
				}
			}
			if !found {
				eff.Workflows = append(eff.Workflows, w)
			}
		}
		if s.SourceTypes != nil {
			eff.SourceTypes = append([]string(nil), s.SourceTypes...)
		}
		if s.TargetTypes != nil {
			eff.TargetTypes = append([]string(nil), s.TargetTypes...)
		}
		if s.Cardinality != "" {
			eff.Cardinality = s.Cardinality
		}
		if len(s.Presentation) > 0 {
			if eff.Presentation == nil {
				eff.Presentation = map[string]any{}
			}
			for k, v := range s.Presentation {
				eff.Presentation[k] = v
			}
		}
		for k, v := range s.Extra {
			if eff.Extra == nil {
				eff.Extra = map[string]any{}
			}
			eff.Extra[k] = v
		}
	}
	if eff.DisplayName == "" {
		eff.DisplayName = eff.Type
	}
	return eff
}
