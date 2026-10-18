package model

import (
	"encoding/json"
	"fmt"
)

// State is one workflow state.
type State struct {
	ID    string `json:"id"`
	Name  string `json:"name,omitempty"`
	Color string `json:"color,omitempty"`
	Final bool   `json:"final,omitempty"`
}

// Transition moves an artifact between states.
type Transition struct {
	ID   string   `json:"id,omitempty"`
	Name string   `json:"name,omitempty"`
	From []string `json:"from"` // state ids, or ["*"]
	To   string   `json:"to"`
}

// Workflow is a state machine definition (design guide §2.7). Workflows
// are resolved lexically: the nearest definition wins wholesale.
type Workflow struct {
	ID          string       `json:"id"`
	Type        string       `json:"type,omitempty"` // configuration layout: the type a type-specific file belongs to
	Name        string       `json:"name,omitempty"`
	Description string       `json:"description,omitempty"`
	Initial     string       `json:"initial"`
	States      []State      `json:"states"`
	Transitions []Transition `json:"transitions"`
	Scope       string       `json:"scope,omitempty"` // filled when resolved
}

// UnmarshalJSON accepts the compact forms: states as strings and
// transition "from" as a single string.
func (w *Workflow) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID          string            `json:"id"`
		Type        string            `json:"type"`
		Name        string            `json:"name"`
		Description string            `json:"description"`
		Initial     string            `json:"initial"`
		States      []json.RawMessage `json:"states"`
		Transitions []struct {
			ID   string          `json:"id"`
			Name string          `json:"name"`
			From json.RawMessage `json:"from"`
			To   string          `json:"to"`
		} `json:"transitions"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	w.ID, w.Type, w.Name, w.Description, w.Initial = raw.ID, raw.Type, raw.Name, raw.Description, raw.Initial
	w.States = nil
	for _, s := range raw.States {
		var id string
		if err := json.Unmarshal(s, &id); err == nil {
			w.States = append(w.States, State{ID: id})
			continue
		}
		var st State
		if err := json.Unmarshal(s, &st); err != nil {
			return err
		}
		w.States = append(w.States, st)
	}
	w.Transitions = nil
	for _, t := range raw.Transitions {
		tr := Transition{ID: t.ID, Name: t.Name, To: t.To}
		var one string
		if err := json.Unmarshal(t.From, &one); err == nil {
			tr.From = []string{one}
		} else if err := json.Unmarshal(t.From, &tr.From); err != nil && len(t.From) > 0 {
			return err
		}
		w.Transitions = append(w.Transitions, tr)
	}
	return nil
}

// ParseWorkflow decodes and validates a workflow file.
func ParseWorkflow(data []byte) (*Workflow, error) {
	var w Workflow
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, Invalid("workflow is not valid JSON: %v", err)
	}
	if err := w.Validate(); err != nil {
		return nil, err
	}
	return &w, nil
}

// Validate checks structural consistency.
func (w *Workflow) Validate() error {
	if err := ValidateTypeID(w.ID); err != nil {
		return fmt.Errorf("workflow id: %w", err)
	}
	if len(w.States) == 0 {
		return Invalid("workflow %q has no states", w.ID)
	}
	seen := map[string]bool{}
	for _, s := range w.States {
		if s.ID == "" || seen[s.ID] {
			return Invalid("workflow %q has an empty or duplicate state", w.ID)
		}
		seen[s.ID] = true
	}
	if w.Initial == "" {
		w.Initial = w.States[0].ID
	}
	if !seen[w.Initial] {
		return Invalid("workflow %q initial state %q is not defined", w.ID, w.Initial)
	}
	for i, t := range w.Transitions {
		if !seen[t.To] {
			return Invalid("workflow %q transition %d targets unknown state %q", w.ID, i, t.To)
		}
		if len(t.From) == 0 {
			return Invalid("workflow %q transition %d has no source state", w.ID, i)
		}
		for _, f := range t.From {
			if f != "*" && !seen[f] {
				return Invalid("workflow %q transition %d starts from unknown state %q", w.ID, i, f)
			}
		}
	}
	return nil
}

// HasState reports whether id is a state of the workflow.
func (w *Workflow) HasState(id string) bool {
	for _, s := range w.States {
		if s.ID == id {
			return true
		}
	}
	return false
}

// Available lists the transitions allowed from the given state.
func (w *Workflow) Available(from string) []Transition {
	var out []Transition
	for _, t := range w.Transitions {
		for _, f := range t.From {
			if f == "*" || f == from {
				out = append(out, t)
				break
			}
		}
	}
	return out
}

// Find returns the transition from state `from` to state `to` (by target
// state or by transition id).
func (w *Workflow) Find(from, to string) (Transition, bool) {
	for _, t := range w.Available(from) {
		if t.To == to || (t.ID != "" && t.ID == to) {
			return t, true
		}
	}
	return Transition{}, false
}

// WorkflowIndex resolves workflows lexically (nearest definition wins).
type WorkflowIndex struct {
	byScope map[string]map[string]*Workflow
}

// NewWorkflowIndex builds an index from scoped definitions.
func NewWorkflowIndex(scopes map[string][]*Workflow) *WorkflowIndex {
	idx := &WorkflowIndex{byScope: map[string]map[string]*Workflow{}}
	for scope, defs := range scopes {
		m := map[string]*Workflow{}
		for _, w := range defs {
			m[w.ID] = w
		}
		idx.byScope[scope] = m
	}
	return idx
}

// Resolve returns the nearest definition of id visible from folder.
func (idx *WorkflowIndex) Resolve(id, folder string) *Workflow {
	for _, scope := range Ancestors(folder) {
		if w := idx.byScope[scope][id]; w != nil {
			c := *w
			c.Scope = scope
			return &c
		}
	}
	return nil
}
