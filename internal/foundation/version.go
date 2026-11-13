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
		Workflows: []WorkflowState{}, Comments: []CommentView{},
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

// historicSurroundings fills the links and comments as they were at seq:
// those that exist today and existed then, read in their version of then.
// Links and comments deleted since are not shown yet (TSK-22 follow-up).
func (f *Foundation) historicSurroundings(ctx context.Context, sc *scanner.Scanner, cfg *model.ConfigIndex, v *Version, guid string, seq int64) error {
	in, out, err := f.DB.LinksOf(ctx, guid)
	if err != nil {
		return err
	}
	comments, err := f.DB.CommentsOf(ctx, guid)
	if err != nil {
		return err
	}
	var guids []string
	for _, l := range append(append(append([]*model.Summary{}, in...), out...), comments...) {
		guids = append(guids, l.GUID)
	}
	files, err := f.DB.FilesAt(ctx, guids, seq)
	if err != nil {
		return err
	}
	shas := make([]string, 0, len(files))
	for _, fr := range files {
		shas = append(shas, fr.Blob)
	}
	blobs, err := f.Repo.ReadBlobs(ctx, shas)
	if err != nil {
		return err
	}
	then := func(g string) (*model.Summary, *ojson.Object) {
		fr, ok := files[g]
		if !ok {
			return nil, nil
		}
		data, ok := blobs[fr.Blob]
		if !ok {
			return nil, nil
		}
		_, meta, doc, err := historicArtifact(sc, fr, data)
		if err != nil {
			return nil, nil
		}
		return meta, doc
	}
	link := func(l *model.Summary, incoming bool) (LinkView, bool) {
		hl, _ := then(l.GUID)
		if hl == nil {
			return LinkView{}, false
		}
		g := hl.Target
		if incoming {
			g = hl.Source
		}
		o, err := f.DB.Get(ctx, g)
		if err != nil {
			o = &model.Summary{GUID: g, Title: "(missing)"}
		}
		role := hl.Type
		if s := cfg.Effective(hl.Type, hl.Folder); s != nil {
			role = s.DisplayName
			if incoming && s.ReverseName != "" {
				role = s.ReverseName
			}
		}
		return LinkView{Link: hl, Other: o, Role: role}, true
	}
	for _, l := range in {
		if lv, ok := link(l, true); ok && lv.Link.Target == guid {
			v.Relationships.Incoming = append(v.Relationships.Incoming, lv)
		}
	}
	for _, l := range out {
		if lv, ok := link(l, false); ok && lv.Link.Source == guid {
			v.Relationships.Outgoing = append(v.Relationships.Outgoing, lv)
		}
	}
	for _, c := range comments {
		if meta, doc := then(c.GUID); meta != nil {
			v.Comments = append(v.Comments, CommentView{Meta: meta, Data: doc})
		}
	}
	sort.SliceStable(v.Comments, func(i, j int) bool { return v.Comments[i].Meta.Created < v.Comments[j].Meta.Created })
	return nil
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
