package foundation

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// Historic versions (TSK-22). A version of an artifact is addressed by the
// blob of its file plus the commit it is viewed at: the blob is the item's
// content, the commit is the moment that fixes everything around it (base
// chain, links, comments, attachments). The item's data is read from Git as
// of that commit; configuration and permissions are always the present ones
// from the projection. The history index (artifact_commits) knows the path
// and blob of every artifact file per commit, so moved items are found too.

var objectName = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// HistoryEntry is a commit in an artifact's history; Blob addresses the
// artifact's version as of that commit ("" when it did not exist then).
type HistoryEntry struct {
	gitx.LogEntry
	Blob string `json:"blob,omitempty"`
}

// HistoryPage is one batch of an artifact's history, newest first.
type HistoryPage struct {
	History []HistoryEntry `json:"history"`
	More    bool           `json:"more"` // older commits remain: ask again with before = the last SHA
}

// HistoryPage lists the commits that touched an artifact, following its
// GUID across moves: at most limit of them, older than before when given.
// It reads the projection's per-artifact index; only while a rebuild has not
// yet produced that index does it fall back to scanning the Git history
// (without versions and in a single batch).
func (f *Foundation) HistoryPage(ctx context.Context, guid string, limit int, before string) (*HistoryPage, error) {
	guid, err := model.NormalizeGUID(guid)
	if err != nil {
		return nil, model.ErrNotFound
	}
	if before != "" && !objectName.MatchString(before) {
		return nil, model.Invalid("before must be a commit SHA")
	}
	if f.DB.Status().Capabilities.History {
		if err := f.catchUp(ctx); err != nil && !errors.Is(err, model.ErrMaintenance) {
			return nil, err
		}
		if f.DB.Status().Capabilities.History {
			rows, more, err := f.DB.HistoryPage(ctx, guid, limit, before)
			if err != nil {
				return nil, err
			}
			shas := make([]string, len(rows))
			for i, r := range rows {
				shas[i] = r.Commit
			}
			log, err := f.Repo.Commits(ctx, shas)
			if err != nil {
				return nil, err
			}
			byCommit := map[string]gitx.LogEntry{}
			for _, e := range log {
				byCommit[e.SHA] = e
			}
			page := &HistoryPage{History: []HistoryEntry{}, More: more}
			for _, r := range rows {
				if e, ok := byCommit[r.Commit]; ok {
					page.History = append(page.History, HistoryEntry{LogEntry: e, Blob: r.Blob})
				}
			}
			return page, nil
		}
	}
	page := &HistoryPage{History: []HistoryEntry{}}
	if before != "" {
		return page, nil
	}
	log, err := f.scanHistory(ctx, guid, limit)
	if err != nil {
		return nil, err
	}
	for _, e := range log {
		page.History = append(page.History, HistoryEntry{LogEntry: e})
	}
	return page, nil
}

// History lists the commits that touched an artifact (all when limit <= 0).
func (f *Foundation) History(ctx context.Context, guid string, limit int) ([]gitx.LogEntry, error) {
	page, err := f.HistoryPage(ctx, guid, limit, "")
	if err != nil {
		return nil, err
	}
	out := make([]gitx.LogEntry, len(page.History))
	for i, e := range page.History {
		out[i] = e.LogEntry
	}
	return out, nil
}

// Version is an artifact as it was at one commit, with what surrounded it
// then. It is read-only: nothing in it can be written back.
type Version struct {
	View
	Commit gitx.LogEntry `json:"commit"`
	// Exact is false when the requested commit could not be used (unknown,
	// e.g. after a history rewrite, or not showing this blob): the version is
	// then shown at the commit that introduced the blob.
	Exact         bool            `json:"exact"`
	Exists        bool            `json:"exists"` // the artifact still exists today
	Schema        *model.Schema   `json:"schema,omitempty"`
	Overlay       *model.Overlay  `json:"overlay,omitempty"`
	BaseOverlay   *model.Overlay  `json:"baseOverlay,omitempty"` // the base's effective fields then
	Workflows     []WorkflowState `json:"workflows"`
	Relationships *Relationships  `json:"relationships"`
	Comments      []CommentView   `json:"comments"`
	// What a link or comment pointed to, as it was then (nil: it did not
	// exist then).
	Endpoints *VersionEndpoints `json:"endpoints,omitempty"`
	Subject   *VersionSubject   `json:"subject,omitempty"`
	Change    *VersionChange    `json:"change"`
}

// VersionChange is what the version's commit changed about the artifact,
// compared with the state just before it.
type VersionChange struct {
	Created bool `json:"created,omitempty"` // the commit created the artifact
	// Changed lists the stored properties that changed: top-level names
	// (title, hid, text, …), fields and workflows as fields.<id> and
	// workflows.<id>.
	Changed []string `json:"changed"`
	// Added are the links and comments that came to point to the artifact.
	Added           []string `json:"added"`
	RemovedLinks    int      `json:"removedLinks,omitempty"`
	RemovedComments int      `json:"removedComments,omitempty"`
}

// VersionEndpoints are a link version's endpoints as they were then.
type VersionEndpoints struct {
	Source *model.Summary `json:"source"`
	Target *model.Summary `json:"target"`
}

// VersionSubject is what a comment version was on, as it was then; a link
// comes with its endpoints and role name.
type VersionSubject struct {
	Meta   *model.Summary `json:"meta"`
	Source *model.Summary `json:"source,omitempty"`
	Target *model.Summary `json:"target,omitempty"`
	Role   string         `json:"role,omitempty"`
}

// at is a resolved point in the history index.
type at struct {
	commit string
	seq    int64
	exact  bool
}

// resolveVersion checks that blob is a version of the artifact and finds
// the commit to view it at: the requested one when it shows this blob,
// otherwise the commit that introduced the blob.
func (f *Foundation) resolveVersion(ctx context.Context, guid, blob, commit string) (string, at, projection.FileRef, error) {
	guid, err := model.NormalizeGUID(guid)
	if err != nil || !objectName.MatchString(blob) || (commit != "" && !objectName.MatchString(commit)) {
		return "", at{}, projection.FileRef{}, model.ErrNotFound
	}
	if !f.DB.Status().Capabilities.History {
		return "", at{}, projection.FileRef{}, fmt.Errorf("%w: the history index is being rebuilt", model.ErrMaintenance)
	}
	if err := f.catchUp(ctx); err != nil {
		return "", at{}, projection.FileRef{}, err
	}
	if commit != "" {
		seq, ok, err := f.DB.CommitSeq(ctx, commit)
		if err != nil {
			return "", at{}, projection.FileRef{}, err
		}
		if ok {
			p, b, ok, err := f.DB.FileAt(ctx, guid, seq)
			if err != nil {
				return "", at{}, projection.FileRef{}, err
			}
			if ok && b == blob {
				return guid, at{commit: commit, seq: seq, exact: true}, projection.FileRef{Path: p, Blob: b}, nil
			}
		}
	}
	c, seq, ok, err := f.DB.CommitOfBlob(ctx, guid, blob)
	if err != nil {
		return "", at{}, projection.FileRef{}, err
	}
	if !ok {
		return "", at{}, projection.FileRef{}, model.ErrNotFound
	}
	p, _, _, err := f.DB.FileAt(ctx, guid, seq)
	if err != nil {
		return "", at{}, projection.FileRef{}, err
	}
	return guid, at{commit: c, seq: seq}, projection.FileRef{Path: p, Blob: blob}, nil
}

// historicArtifact parses an artifact file read from history.
func historicArtifact(sc *scanner.Scanner, file projection.FileRef, data []byte) (*model.Artifact, *model.Summary, *ojson.Object, error) {
	m := sc.Classify(file.Path)
	kind := model.KindEntry
	if m.Category == scanner.ConfigFile {
		kind, _ = scanner.KindOf(m.ConfigKind)
	}
	doc, err := ojson.ParseObject(data)
	if err != nil {
		return nil, nil, nil, model.Invalid("stored file is not a JSON object: %v", err)
	}
	a, err := model.ArtifactFromDoc(doc, kind)
	if err != nil {
		return nil, nil, nil, err
	}
	return a, summarize(a, m.Folder, file.Path, file.Blob), doc, nil
}

// Version returns an artifact as it was: its content blob viewed at commit.
func (f *Foundation) Version(ctx context.Context, guid, blob, commit string) (*Version, error) {
	guid, pt, file, err := f.resolveVersion(ctx, guid, blob, commit)
	if err != nil {
		return nil, err
	}
	data, err := f.Repo.ReadBlob(ctx, blob)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sc := f.DB.Scanner()
	a, meta, doc, err := historicArtifact(sc, file, data)
	if err != nil {
		return nil, err
	}
	log, err := f.Repo.Commits(ctx, []string{pt.commit})
	if err != nil {
		return nil, err
	}
	if len(log) != 1 {
		return nil, model.ErrNotFound
	}
	t := log[0].Time
	meta.ModifiedAt = &t
	v := &Version{View: View{Meta: meta, Data: doc, ETag: blob}, Commit: log[0], Exact: pt.exact,
		Workflows: []WorkflowState{}, Comments: []CommentView{}, Change: &VersionChange{Changed: []string{}, Added: []string{}},
		Relationships: &Relationships{Incoming: []LinkView{}, Outgoing: []LinkView{}, AsSource: []*model.Schema{}, AsTarget: []*model.Schema{}}}

	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	// The present configuration applies: at the item's present folder when it
	// still exists, else where it last was.
	folder := meta.Folder
	if loc, err := f.DB.Locate(ctx, guid); err == nil {
		v.Exists, folder = true, loc.Folder
	} else if !errors.Is(err, model.ErrNotFound) {
		return nil, err
	}
	v.Schema = cfg.Effective(a.Type, folder)

	if meta.Kind.IsFolderKind() {
		if v.Attachments, err = f.historicAttachments(ctx, sc, pt.commit, path.Dir(file.Path)); err != nil {
			return nil, err
		}
	}
	if err := f.ownChange(ctx, v.Change, guid, doc, blob, pt.seq); err != nil {
		return nil, err
	}
	lookup := f.historicLookup(ctx, sc, pt.seq)
	if v.Overlay, err = historicOverlay(a, lookup); err != nil {
		return nil, err
	}
	if a.Base != "" && v.Overlay != nil {
		base, err := lookup.get(a.Base)
		if err != nil {
			return nil, err
		}
		if v.BaseOverlay, err = historicOverlay(base, lookup); err != nil {
			return nil, err
		}
	}
	if v.Schema != nil {
		for _, wid := range v.Schema.AllWorkflows() {
			def := cfg.Workflow(a.Type, wid, folder)
			if def == nil {
				continue
			}
			state := a.Workflows[wid]
			if state == "" {
				state = def.Initial
			}
			v.Workflows = append(v.Workflows, WorkflowState{ID: wid, Definition: def, State: state, Available: []model.Transition{}})
		}
	}
	if err := f.historicSurroundings(ctx, sc, cfg, v, guid, pt.seq); err != nil {
		return nil, err
	}
	return v, nil
}

// ownChange compares the artifact's file with its state just before seq.
func (f *Foundation) ownChange(ctx context.Context, c *VersionChange, guid string, doc *ojson.Object, blob string, seq int64) error {
	_, prev, ok, err := f.DB.FileAt(ctx, guid, seq-1)
	if err != nil {
		return err
	}
	if !ok {
		c.Created = true
		return nil
	}
	if prev == blob {
		return nil
	}
	data, err := f.Repo.ReadBlob(ctx, prev)
	if err != nil {
		return nil //nolint:nilerr // an unreadable predecessor shows no changes
	}
	old, err := ojson.ParseObject(data)
	if err != nil {
		return nil //nolint:nilerr // a malformed predecessor shows no changes
	}
	c.Changed = changedProperties(old, doc)
	return nil
}

// changedProperties lists the properties that differ between two versions
// of a file; fields and workflows are compared one by one.
func changedProperties(old, cur *ojson.Object) []string {
	out := []string{}
	diff := func(prefix string, a, b *ojson.Object) {
		seen := map[string]bool{}
		for _, o := range []*ojson.Object{a, b} {
			if o == nil {
				continue
			}
			for _, k := range o.Keys() {
				if seen[k] {
					continue
				}
				seen[k] = true
				var x, y any
				var okA, okB bool
				if a != nil {
					x, okA = a.Get(k)
				}
				if b != nil {
					y, okB = b.Get(k)
				}
				if okA != okB || !ojson.Equal(x, y) {
					out = append(out, prefix+k)
				}
			}
		}
	}
	top := func(o *ojson.Object) *ojson.Object {
		t := o.Clone()
		t.Delete("fields")
		t.Delete("workflows")
		return t
	}
	diff("", top(old), top(cur))
	diff("fields.", old.Object("fields"), cur.Object("fields"))
	diff("workflows.", old.Object("workflows"), cur.Object("workflows"))
	sort.Strings(out)
	return out
}

// historicAttachments lists the files in an artifact directory at a commit.
func (f *Foundation) historicAttachments(ctx context.Context, sc *scanner.Scanner, commit, dir string) ([]projection.Attachment, error) {
	entries, err := f.Repo.ListDir(ctx, commit, dir)
	if err != nil {
		return nil, err
	}
	out := []projection.Attachment{}
	for _, e := range entries {
		if sc.Classify(e.Path).Category != scanner.Attachment {
			continue
		}
		out = append(out, projection.Attachment{Name: path.Base(e.Path), Path: e.Path, ETag: e.SHA, Size: e.Size})
	}
	return out, nil
}

// lookupAt reads artifacts as they were at one index position.
type lookupAt struct {
	get    func(guid string) (*model.Artifact, error)
	failed error // a lookup failed for another reason than absence
}

func (f *Foundation) historicLookup(ctx context.Context, sc *scanner.Scanner, seq int64) *lookupAt {
	l := &lookupAt{}
	l.get = func(g string) (*model.Artifact, error) {
		p, b, ok, err := f.DB.FileAt(ctx, g, seq)
		if err != nil {
			l.failed = err
			return nil, err
		}
		if !ok {
			return nil, model.ErrNotFound
		}
		data, err := f.Repo.ReadBlob(ctx, b)
		if err != nil {
			return nil, model.ErrNotFound
		}
		a, _, _, err := historicArtifact(sc, projection.FileRef{Path: p, Blob: b}, data)
		return a, err
	}
	return l
}

// historicOverlay resolves a base chain with every base as it was then; a
// base that did not exist then leaves the chain unresolved (nil).
func historicOverlay(a *model.Artifact, l *lookupAt) (*model.Overlay, error) {
	ov, err := model.ResolveOverlay(a, l.get)
	if l.failed != nil {
		return nil, l.failed
	}
	if err != nil {
		return nil, nil //nolint:nilerr // a broken chain then is shown without overlay, not as an error
	}
	return ov, nil
}

// historicSurroundings fills what surrounded the artifact at seq, everything
// as it was then: the links and comments that pointed to it (also those
// deleted or reassigned since), the other endpoint of each link, and for a
// link or comment version what it pointed to. A comment shows the thread of
// its subject.
func (f *Foundation) historicSurroundings(ctx context.Context, sc *scanner.Scanner, cfg *model.ConfigIndex, v *Version, guid string, seq int64) error {
	meta := v.Meta
	on := guid
	if meta.Kind == model.KindComment {
		on = meta.Subject
	}
	related, err := f.DB.RelatedAt(ctx, on, seq)
	if err != nil {
		return err
	}
	then, err := f.summariesAt(ctx, sc, related, seq)
	if err != nil {
		return err
	}
	before, err := f.summariesAt(ctx, sc, related, seq-1)
	if err != nil {
		return err
	}
	// pointsHere says whether a link or comment was one of the artifact's then.
	pointsHere := func(h *historicItem) bool {
		if h == nil {
			return false
		}
		switch h.meta.Kind {
		case model.KindLink:
			return meta.Kind != model.KindComment && (h.meta.Source == on || h.meta.Target == on)
		case model.KindComment:
			return h.meta.Subject == on
		}
		return false
	}
	for _, g := range related {
		now, was := pointsHere(then[g]), pointsHere(before[g])
		switch {
		case now && !was:
			v.Change.Added = append(v.Change.Added, g)
		case was && !now && before[g].meta.Kind == model.KindLink:
			v.Change.RemovedLinks++
		case was && !now:
			v.Change.RemovedComments++
		}
	}
	var others []string
	for _, g := range related {
		if h := then[g]; h != nil && h.meta.Kind == model.KindLink {
			others = append(others, h.meta.Source, h.meta.Target)
		}
	}
	switch meta.Kind {
	case model.KindLink:
		others = append(others, meta.Source, meta.Target)
	case model.KindComment:
		others = append(others, meta.Subject)
	}
	ends, err := f.summariesAt(ctx, sc, others, seq)
	if err != nil {
		return err
	}
	// A comment on a link shows that link's endpoints as they were too.
	if meta.Kind == model.KindComment {
		if s := ends[meta.Subject]; s != nil && s.meta.Kind == model.KindLink {
			more, err := f.summariesAt(ctx, sc, []string{s.meta.Source, s.meta.Target}, seq)
			if err != nil {
				return err
			}
			for g, h := range more {
				ends[g] = h
			}
		}
	}
	endOf := func(g string) *model.Summary {
		if h := ends[g]; h != nil {
			return h.meta
		}
		return nil
	}
	other := func(g string) *model.Summary {
		if s := endOf(g); s != nil {
			return s
		}
		return &model.Summary{GUID: g, Title: "(missing)"}
	}
	link := func(l *model.Summary, incoming bool) LinkView {
		role := l.Type
		if s := cfg.Effective(l.Type, l.Folder); s != nil {
			role = s.DisplayName
			if incoming && s.ReverseName != "" {
				role = s.ReverseName
			}
		}
		o := l.Target
		if incoming {
			o = l.Source
		}
		return LinkView{Link: l, Other: other(o), Role: role}
	}
	for _, g := range related {
		h := then[g]
		if h == nil {
			continue // not there then
		}
		switch h.meta.Kind {
		case model.KindLink:
			if meta.Kind == model.KindComment {
				continue // the subject's links are not the comment's
			}
			if h.meta.Source == on {
				v.Relationships.Outgoing = append(v.Relationships.Outgoing, link(h.meta, false))
			}
			if h.meta.Target == on {
				v.Relationships.Incoming = append(v.Relationships.Incoming, link(h.meta, true))
			}
		case model.KindComment:
			if h.meta.Subject == on {
				v.Comments = append(v.Comments, CommentView{Meta: h.meta, Data: h.doc})
			}
		}
	}
	sort.SliceStable(v.Comments, func(i, j int) bool { return v.Comments[i].Meta.Created < v.Comments[j].Meta.Created })
	switch meta.Kind {
	case model.KindLink:
		v.Endpoints = &VersionEndpoints{Source: endOf(meta.Source), Target: endOf(meta.Target)}
	case model.KindComment:
		if s := endOf(meta.Subject); s != nil {
			v.Subject = &VersionSubject{Meta: s}
			if s.Kind == model.KindLink {
				v.Subject.Source, v.Subject.Target = endOf(s.Source), endOf(s.Target)
				v.Subject.Role = link(s, false).Role
			}
		}
	}
	return nil
}

// historicItem is an artifact as it was at some index position.
type historicItem struct {
	meta *model.Summary
	doc  *ojson.Object
}

// summariesAt reads artifacts as they were at seq; those that did not exist
// then (or cannot be read) are left out.
func (f *Foundation) summariesAt(ctx context.Context, sc *scanner.Scanner, guids []string, seq int64) (map[string]*historicItem, error) {
	out := map[string]*historicItem{}
	var want []string
	seen := map[string]bool{}
	for _, g := range guids {
		if g != "" && !seen[g] {
			seen[g] = true
			want = append(want, g)
		}
	}
	files, err := f.DB.FilesAt(ctx, want, seq)
	if err != nil || len(files) == 0 {
		return out, err
	}
	shas := make([]string, 0, len(files))
	for _, fr := range files {
		shas = append(shas, fr.Blob)
	}
	blobs, err := f.Repo.ReadBlobs(ctx, shas)
	if err != nil {
		return nil, err
	}
	for g, fr := range files {
		data, ok := blobs[fr.Blob]
		if !ok {
			continue
		}
		if _, meta, doc, err := historicArtifact(sc, fr, data); err == nil {
			out[g] = &historicItem{meta: meta, doc: doc}
		}
	}
	return out, nil
}

// VersionFile reads an attachment of an artifact version at its commit.
func (f *Foundation) VersionFile(ctx context.Context, guid, blob, commit, name string) ([]byte, string, error) {
	if err := ValidateAttachmentName(name); err != nil {
		return nil, "", err
	}
	_, pt, file, err := f.resolveVersion(ctx, guid, blob, commit)
	if err != nil {
		return nil, "", err
	}
	data, sha, err := f.Repo.ReadPath(ctx, pt.commit, path.Dir(file.Path)+"/"+name)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, "", model.ErrNotFound
	}
	return data, sha, err
}
