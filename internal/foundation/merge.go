package foundation

import (
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// A save that started from an older version of the artifact is merged: the
// user's changes are applied on top of the current version. Only when the
// user and someone else changed the same thing (a property, a field, a
// workflow, an attachment, a link being removed) is the save refused with a
// SaveConflict, which names those things; the user may then overwrite them.

// SaveConflict refuses a save whose changes overlap with changes made by
// someone else since the version the user started from.
type SaveConflict struct {
	ETag      string         `json:"etag"` // the current version; Overwrite with it saves anyway
	Conflicts []ConflictItem `json:"conflicts"`
}

// ConflictItem is one thing both changed.
type ConflictItem struct {
	// Key names it: title, hid, text, fields.<id>,
	// files.<name>, links.<guid>, or another property of the artifact.
	Key    string    `json:"key"`
	Author string    `json:"author,omitempty"` // who changed it last
	Time   time.Time `json:"time,omitzero"`
	Base   any       `json:"base,omitempty"`   // as the user saw it
	Theirs any       `json:"theirs,omitempty"` // as it is now
	Mine   any       `json:"mine,omitempty"`   // what the user's save sets
}

func (e *SaveConflict) Error() string {
	keys := make([]string, len(e.Conflicts))
	for i, c := range e.Conflicts {
		keys[i] = c.Key
	}
	return fmt.Sprintf("%v: changed by someone else meanwhile: %s", model.ErrPrecondition, strings.Join(keys, ", "))
}

func (e *SaveConflict) Unwrap() error { return model.ErrPrecondition }

// mine lists what a save changes, by conflict key, with the value it sets.
func (req *SaveRequest) mine() map[string]any {
	out := map[string]any{}
	if req.Patch != nil {
		for _, k := range req.Patch.Keys() {
			v, _ := req.Patch.Get(k)
			if k == "fields" {
				if pf, ok := v.(*ojson.Object); ok {
					for _, fk := range pf.Keys() {
						fv, _ := pf.Get(fk)
						out["fields."+fk] = fv
					}
				}
				continue
			}
			out[k] = v
		}
	}
	for _, tr := range req.Transitions {
		out["fields."+tr.Field] = tr.Transition
	}
	for _, f := range req.PutFiles {
		out["files."+f.Name] = "stored"
	}
	for _, n := range req.RemoveFiles {
		out["files."+n] = "removed"
	}
	return out
}

// merge compares a save that started from the version base with the
// current version cur: it returns what both the user and someone else
// changed, with who changed it. Nothing means the save applies cleanly.
func (t *txn) merge(guid, base string, cur *loaded, req *SaveRequest) ([]ConflictItem, error) {
	commit, baseSeq, ok, err := t.f.DB.CommitOfBlob(t.ctx, guid, base)
	if err != nil {
		return nil, err
	}
	if !ok {
		// An unknown version: nothing to compare with.
		return nil, checkETag(base, cur.ETag)
	}
	baseData, err := t.f.Repo.ReadBlob(t.ctx, base)
	if err != nil {
		return nil, checkETag(base, cur.ETag)
	}
	baseDoc, err := ojson.ParseObject(baseData)
	if err != nil {
		return nil, checkETag(base, cur.ETag)
	}
	basePath, _, _, err := t.f.DB.FileAt(t.ctx, guid, baseSeq)
	if err != nil {
		return nil, err
	}
	sc := t.f.DB.Scanner()
	baseFiles, err := t.attachments(sc, commit, path.Dir(basePath))
	if err != nil {
		return nil, err
	}
	curFiles, err := t.attachments(sc, t.head, path.Dir(cur.Loc.FilePath))
	if err != nil {
		return nil, err
	}

	mine := req.mine()
	var items []ConflictItem
	add := func(key string, b, theirs any, same bool) {
		if m, ok := mine[key]; ok && !same { // the same result loses nothing
			items = append(items, ConflictItem{Key: key, Base: b, Theirs: theirs, Mine: m})
		}
	}
	for _, k := range changedProperties(baseDoc, cur.Doc) {
		theirs := valueAt(cur.Doc, k)
		add(k, valueAt(baseDoc, k), theirs, ojson.Equal(mine[k], theirs))
	}
	myFiles := map[string]string{} // name -> blob the save leaves, "" when removed
	for _, f := range req.PutFiles {
		myFiles[f.Name] = gitx.BlobSHA(f.Content)
	}
	for _, n := range req.RemoveFiles {
		myFiles[n] = ""
	}
	for _, n := range changedFiles(baseFiles, curFiles) {
		add("files."+n, fileState(baseFiles, n), fileState(curFiles, n), myFiles[n] == curFiles[n])
	}
	if len(items) == 0 {
		return nil, nil
	}
	if err := t.attribute(guid, baseSeq, baseDoc, baseFiles, items); err != nil {
		return nil, err
	}
	return items, nil
}

// linkConflict checks a link the user removes against the version the user
// saw; a link changed since is a conflict unless overwritten.
func (t *txn) linkConflict(l *loaded, seen string) (*ConflictItem, error) {
	if seen == "" || seen == l.ETag {
		return nil, nil
	}
	item := &ConflictItem{Key: "links." + l.Loc.GUID, Theirs: "changed", Mine: "removed"}
	page, err := t.f.HistoryPage(t.ctx, l.Loc.GUID, 1, "")
	if err == nil && len(page.History) > 0 {
		item.Author, item.Time = page.History[0].Author, page.History[0].Time
	}
	return item, nil
}

// attribute names, for each conflicting item, the author and time of the
// last commit since base that changed it.
func (t *txn) attribute(guid string, baseSeq int64, doc *ojson.Object, files map[string]string, items []ConflictItem) error {
	rows, err := t.f.DB.CommitsSince(t.ctx, guid, baseSeq)
	if err != nil || len(rows) == 0 {
		return err
	}
	shas := make([]string, len(rows))
	for i, r := range rows {
		shas[i] = r.Commit
	}
	log, err := t.f.Repo.Commits(t.ctx, shas)
	if err != nil {
		return err
	}
	byCommit := map[string]gitx.LogEntry{}
	for _, e := range log {
		byCommit[e.SHA] = e
	}
	want := map[string]int{}
	for i, it := range items {
		want[it.Key] = i
	}
	sc := t.f.DB.Scanner()
	dir := ""
	for _, r := range rows {
		var changed []string
		if r.Path != "" && r.Blob != "" {
			dir = path.Dir(r.Path)
			if data, err := t.f.Repo.ReadBlob(t.ctx, r.Blob); err == nil {
				if next, err := ojson.ParseObject(data); err == nil {
					changed = changedProperties(doc, next)
					doc = next
				}
			}
		}
		if dir != "" {
			next, err := t.attachments(sc, r.Commit, dir)
			if err != nil {
				return err
			}
			for _, n := range changedFiles(files, next) {
				changed = append(changed, "files."+n)
			}
			files = next
		}
		e := byCommit[r.Commit]
		for _, k := range changed {
			if i, ok := want[k]; ok {
				items[i].Author, items[i].Time = e.Author, e.Time
			}
		}
	}
	return nil
}

// attachments maps the attachment names in an artifact directory at a
// commit to their blobs.
func (t *txn) attachments(sc *scanner.Scanner, commit, dir string) (map[string]string, error) {
	out := map[string]string{}
	entries, err := t.f.Repo.ListDir(t.ctx, commit, dir)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return out, nil
		}
		return nil, err
	}
	for _, e := range entries {
		if sc.Classify(e.Path).Category == scanner.Attachment {
			out[path.Base(e.Path)] = e.SHA
		}
	}
	return out, nil
}

func changedFiles(a, b map[string]string) []string {
	var out []string
	for n, s := range a {
		if b[n] != s {
			out = append(out, n)
		}
	}
	for n := range b {
		if _, ok := a[n]; !ok {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func fileState(files map[string]string, name string) any {
	if _, ok := files[name]; ok {
		return "stored"
	}
	return "absent"
}

// valueAt reads a conflict key's value from a document.
func valueAt(doc *ojson.Object, key string) any {
	if rest, ok := strings.CutPrefix(key, "fields."); ok {
		if o := doc.Object("fields"); o != nil {
			v, _ := o.Get(rest)
			return v
		}
		return nil
	}
	v, _ := doc.Get(key)
	return v
}
