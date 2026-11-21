package model

import (
	"encoding/json"
	"fmt"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// State is one workflow state.
type State struct {
	ID           string         `json:"id"`
	Name         string         `json:"name,omitempty"`
	Presentation map[string]any `json:"presentation,omitempty"`
	Final        bool           `json:"final,omitempty"`
}

// Transition moves an artifact between states. Its id names it within the
// workflow: it is what a client sends to run it, and two transitions may
// lead from the same state to the same state.
type Transition struct {
	ID   string   `json:"id"`
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
		if err := validateIconPresentation(s.Presentation); err != nil {
			return fmt.Errorf("workflow %q state %q: %w", w.ID, s.ID, err)
		}
		seen[s.ID] = true
	}
	if w.Initial == "" {
		w.Initial = w.States[0].ID
	}
	if !seen[w.Initial] {
		return Invalid("workflow %q initial state %q is not defined", w.ID, w.Initial)
	}
	ids := map[string]bool{}
	for i, t := range w.Transitions {
		if t.ID == "" {
			return Invalid("workflow %q transition %d has no id", w.ID, i)
		}
		if err := ValidateTypeID(t.ID); err != nil {
			return fmt.Errorf("workflow %q transition %d id: %w", w.ID, i, err)
		}
		if ids[t.ID] {
			return Invalid("workflow %q has two transitions with the id %q", w.ID, t.ID)
		}
		ids[t.ID] = true
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

// Find returns the transition with the given id, if it is allowed from
// state `from`.
func (w *Workflow) Find(from, id string) (Transition, bool) {
	for _, t := range w.Available(from) {
		if t.ID == id {
			return t, true
		}
	}
	return Transition{}, false
}

// IsFinal reports whether id is a final state of the workflow.
func (w *Workflow) IsFinal(id string) bool {
	for _, s := range w.States {
		if s.ID == id {
			return s.Final
		}
	}
	return false
}

// WorkflowValue is the value of a workflow field: the state the artifact is
// in, the transition that led there and the state before it. A new artifact
// has only the state. The server writes it; clients send transitions.
type WorkflowValue struct {
	State      string
	Transition string
	Previous   string
}

// ParseWorkflowValue reads a workflow field's stored value: an object with
// "state" and optionally "transition" and "previous", all strings.
func ParseWorkflowValue(v any) (WorkflowValue, bool) {
	var get func(string) (any, bool)
	var keys []string
	switch o := v.(type) {
	case *ojson.Object:
		if o == nil {
			return WorkflowValue{}, false
		}
		get, keys = o.Get, o.Keys()
	case map[string]any:
		get = func(k string) (any, bool) { x, ok := o[k]; return x, ok }
		for k := range o {
			keys = append(keys, k)
		}
	default:
		return WorkflowValue{}, false
	}
	var w WorkflowValue
	for _, k := range keys {
		x, _ := get(k)
		s, ok := x.(string)
		if !ok {
			return WorkflowValue{}, false
		}
		switch k {
		case "state":
			w.State = s
		case "transition":
			w.Transition = s
		case "previous":
			w.Previous = s
		default:
			return WorkflowValue{}, false
		}
	}
	return w, w.State != ""
}

// WorkflowStateOf is the state in a workflow field's stored value, or "".
func WorkflowStateOf(v any) string {
	w, _ := ParseWorkflowValue(v)
	return w.State
}

// Object is the stored form of the value.
func (w WorkflowValue) Object() *ojson.Object {
	o := ojson.NewObject()
	o.Set("state", w.State)
	if w.Transition != "" {
		o.Set("transition", w.Transition)
	}
	if w.Previous != "" {
		o.Set("previous", w.Previous)
	}
	return o
}
