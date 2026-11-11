package model

import (
	"encoding/json"
	"path"
)

// AccessPath is the repository file that gives accounts their roles:
//
//	{"admins": ["<account guid>", ...]}
//
// Accounts not listed are users. The accounts themselves (names, emails,
// password hashes) live outside the repository.
var AccessPath = path.Join(MetadataDir, "access.json")

// Access is the parsed access file.
type Access struct {
	Admins []string `json:"admins"`
}

// IsAdmin reports whether the account is listed as admin.
func (a *Access) IsAdmin(guid string) bool {
	if a == nil {
		return false
	}
	for _, g := range a.Admins {
		if g == guid {
			return true
		}
	}
	return false
}

// ParseAccess parses and validates an access file.
func ParseAccess(data []byte) (*Access, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, Invalid("access file: %v", err)
	}
	a := &Access{Admins: []string{}}
	if r, ok := raw["admins"]; ok {
		if err := json.Unmarshal(r, &a.Admins); err != nil {
			return nil, Invalid("access file: admins must be a list of account ids")
		}
	}
	seen := map[string]bool{}
	for _, g := range a.Admins {
		if !IsGUID(g) {
			return nil, Invalid("access file: %q is no account id", g)
		}
		if seen[g] {
			return nil, Invalid("access file: %s is listed twice", g)
		}
		seen[g] = true
	}
	return a, nil
}
