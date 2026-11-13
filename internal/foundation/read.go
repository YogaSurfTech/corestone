package foundation

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// Get returns an artifact: projected metadata plus its document from Git.
func (f *Foundation) Get(ctx context.Context, guid string) (*View, error) {
	guid, err := model.NormalizeGUID(guid)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", model.ErrNotFound, err)
	}
	if err := f.catchUp(ctx); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		meta, err := f.DB.Get(ctx, guid)
		if err != nil {
			return nil, err
		}
		head, err := f.Repo.Head(ctx)
		if err != nil {
			return nil, err
		}
		data, sha, err := f.Repo.ReadPath(ctx, head, meta.Path)
		if errors.Is(err, gitx.ErrNotFound) {
			// The projection may lag behind a direct push: resync once.
			if attempt == 0 {
				if err := f.DB.Sync(ctx); err != nil {
					return nil, err
				}
				continue
			}
			return nil, model.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		doc, err := ojson.ParseObject(data)
		if err != nil {
			doc = ojson.NewObject()
			doc.Set("guid", guid)
			doc.Set("error", "stored file is not a JSON object: "+err.Error())
		}
		meta.ETag = sha
		v := &View{Meta: meta, Data: doc, ETag: sha}
		if meta.Kind.IsFolderKind() {
			if v.Attachments, err = f.DB.Attachments(ctx, guid); err != nil {
				return nil, err
			}
		}
		return v, nil
	}
	return nil, model.ErrNotFound
}

// catchUp resynchronizes the projection when the branch moved behind the
// server's back (a direct push), so reads never miss fresh commits.
func (f *Foundation) catchUp(ctx context.Context) error {
	if f.DB.Maintenance() {
		return nil
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return err
	}
	ph, err := f.DB.ProcessedHash(ctx)
	if err != nil {
		return err
	}
	if ph == head {
		return nil
	}
	return f.DB.Sync(ctx)
}

// Documents reads the documents of many artifacts in one Git batch, keyed
// by GUID (used for comments and relationship endpoints).
func (f *Foundation) Documents(ctx context.Context, metas []*model.Summary) (map[string]*ojson.Object, error) {
	shas := make([]string, 0, len(metas))
	for _, m := range metas {
		shas = append(shas, m.ETag)
	}
	blobs, err := f.Repo.ReadBlobs(ctx, shas)
	if err != nil {
		return nil, err
	}
	out := map[string]*ojson.Object{}
	for _, m := range metas {
		if b, ok := blobs[m.ETag]; ok {
			if doc, err := ojson.ParseObject(b); err == nil {
				out[m.GUID] = doc
			}
		}
	}
	return out, nil
}

// EffectiveSchema resolves the composed schema of a type at a folder.
func (f *Foundation) EffectiveSchema(ctx context.Context, typ, folder string) (*model.Schema, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	s := cfg.Effective(typ, folder)
	if s == nil {
		return nil, fmt.Errorf("%w: no schema defines type %q at %s", model.ErrNotFound, typ, folderName(folder))
	}
	return s, nil
}

// Types lists the effective schemas of all types visible from a folder,
// which is what a client offers when creating a new artifact.
func (f *Foundation) Types(ctx context.Context, folder string) ([]*model.Schema, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	out := cfg.TypesVisible(folder)
	if out == nil {
		out = []*model.Schema{}
	}
	return out, nil
}

// FieldValues lists the values of a field in use by artifacts of a type
// in a folder and below, for suggestions in extendable enumerations, whose
// extra values are stored only in the artifacts.
func (f *Foundation) FieldValues(ctx context.Context, typ, field, folder string) ([]projection.ValueCount, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	if typ == "" || field == "" {
		return nil, model.Invalid("type and field are required")
	}
	return f.DB.FieldValues(ctx, typ, field, folder, 200)
}

// SchemaOf resolves the effective schema of an existing artifact.
func (f *Foundation) SchemaOf(ctx context.Context, guid string) (*model.Schema, *projection.Located, error) {
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, nil, err
	}
	return cfg.Effective(loc.Type, loc.Folder), loc, nil
}

// WorkflowDef resolves a workflow definition for an artifact type at a folder.
func (f *Foundation) WorkflowDef(ctx context.Context, typ, id, folder string) (*model.Workflow, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	w := cfg.Workflow(typ, id, folder)
	if w == nil {
		return nil, fmt.Errorf("%w: workflow %q for type %q at %s", model.ErrNotFound, id, typ, folderName(folder))
	}
	return w, nil
}

// OverlayView is the overlay analysis service result.
type OverlayView struct {
	*model.Overlay
	Overlays []*model.Summary `json:"overlays"` // entries deriving from this one
}

// Overlay analyzes an entry's base chain and lists its own overlays.
func (f *Foundation) Overlay(ctx context.Context, guid string) (*OverlayView, error) {
	v, err := f.Get(ctx, guid)
	if err != nil {
		return nil, err
	}
	a, err := model.ArtifactFromDoc(v.Data, v.Meta.Kind)
	if err != nil {
		return nil, err
	}
	ov, err := model.ResolveOverlay(a, func(g string) (*model.Artifact, error) {
		bv, err := f.Get(ctx, g)
		if err != nil {
			return nil, err
		}
		return model.ArtifactFromDoc(bv.Data, bv.Meta.Kind)
	})
	if err != nil {
		return nil, err
	}
	overlays, err := f.DB.Overlays(ctx, guid)
	if err != nil {
		return nil, err
	}
	if overlays == nil {
		overlays = []*model.Summary{}
	}
	return &OverlayView{Overlay: ov, Overlays: overlays}, nil
}

// UsedInDocuments lists the documents embedding the entry in their content.
func (f *Foundation) UsedInDocuments(ctx context.Context, guid string) ([]*model.Summary, error) {
	if _, err := f.Get(ctx, guid); err != nil {
		return nil, err
	}
	return f.DB.ReferencingDocuments(ctx, guid)
}

// WorkflowState is the workflow evaluation of one assigned workflow.
type WorkflowState struct {
	ID         string             `json:"id"`
	Definition *model.Workflow    `json:"definition"`
	State      string             `json:"state"`
	Available  []model.Transition `json:"available"`
}

// Workflows evaluates every workflow assigned to an artifact.
func (f *Foundation) Workflows(ctx context.Context, guid string) ([]WorkflowState, error) {
	v, err := f.Get(ctx, guid)
	if err != nil {
		return nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	out := []WorkflowState{}
	eff := cfg.Effective(v.Meta.Type, v.Meta.Folder)
	if eff == nil {
		return out, nil
	}
	for _, wid := range eff.AllWorkflows() {
		def := cfg.Workflow(v.Meta.Type, wid, v.Meta.Folder)
		if def == nil {
			continue
		}
		state := v.Meta.Workflows[wid]
		if state == "" {
			state = def.Initial
		}
		av := def.Available(state)
		if av == nil {
			av = []model.Transition{}
		}
		out = append(out, WorkflowState{ID: wid, Definition: def, State: state, Available: av})
	}
	return out, nil
}

// LinkView is a link together with the artifact at its other end.
type LinkView struct {
	Link  *model.Summary `json:"link"`
	Other *model.Summary `json:"other"`
	// Role names the link as read from this artifact: the link type's display
	// name on outgoing links, its reverse name on incoming ones.
	Role string `json:"role"`
}

// Relationships is the relationship analysis of one artifact.
type Relationships struct {
	Incoming []LinkView      `json:"incoming"`
	Outgoing []LinkView      `json:"outgoing"`
	AsSource []*model.Schema `json:"allowedAsSource"` // link types this artifact may originate
	AsTarget []*model.Schema `json:"allowedAsTarget"`
}

// Relationships lists an artifact's links with their endpoints and the
// link types its schema allows.
func (f *Foundation) Relationships(ctx context.Context, guid string) (*Relationships, error) {
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, err
	}
	in, out, err := f.DB.LinksOf(ctx, guid)
	if err != nil {
		return nil, err
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	r := &Relationships{Incoming: []LinkView{}, Outgoing: []LinkView{}, AsSource: []*model.Schema{}, AsTarget: []*model.Schema{}}
	other := func(l *model.Summary, g string, incoming bool) LinkView {
		o, err := f.DB.Get(ctx, g)
		if err != nil {
			o = &model.Summary{GUID: g, Title: "(missing)"}
		}
		role := l.Type
		if s := cfg.Effective(l.Type, l.Folder); s != nil {
			role = s.DisplayName
			if incoming && s.ReverseName != "" {
				role = s.ReverseName
			}
		}
		return LinkView{Link: l, Other: o, Role: role}
	}
	for _, l := range in {
		r.Incoming = append(r.Incoming, other(l, l.Source, true))
	}
	for _, l := range out {
		r.Outgoing = append(r.Outgoing, other(l, l.Target, false))
	}
	src, tgt := cfg.LinkTypesFor(loc.Kind, loc.Type, loc.Folder)
	if src != nil {
		r.AsSource = src
	}
	if tgt != nil {
		r.AsTarget = tgt
	}
	return r, nil
}

// CommentView is a comment with its full document.
type CommentView struct {
	Meta *model.Summary `json:"meta"`
	Data *ojson.Object  `json:"data"`
}

// Comments lists the comments on an artifact chronologically, with text.
func (f *Foundation) Comments(ctx context.Context, guid string) ([]CommentView, error) {
	metas, err := f.DB.CommentsOf(ctx, guid)
	if err != nil {
		return nil, err
	}
	docs, err := f.Documents(ctx, metas)
	if err != nil {
		return nil, err
	}
	out := []CommentView{}
	for _, m := range metas {
		out = append(out, CommentView{Meta: m, Data: docs[m.GUID]})
	}
	return out, nil
}

// scanHistory finds an artifact's commits with a pathspec walk over the
// whole history: always correct, but linear in the repository's age.
func (f *Foundation) scanHistory(ctx context.Context, guid string, limit int) ([]gitx.LogEntry, error) {
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, err
	}
	specs := []string{
		":(glob)**/" + guid + "/**",
		":(glob)" + guid + "/**",
		":(glob)**/.corestone/links/" + guid + ".json",
		":(glob)**/.corestone/comments/" + guid + ".json",
		":(glob).corestone/links/" + guid + ".json",
		":(glob).corestone/comments/" + guid + ".json",
	}
	log, err := f.Repo.Log(ctx, head, specs, limit)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = []gitx.LogEntry{}
	}
	return log, nil
}

// Tree is one level of the repository navigation.
type Tree struct {
	Folder    string                  `json:"folder"`
	Folders   []projection.FolderInfo `json:"folders"`
	Artifacts []*model.Summary        `json:"artifacts"`
	Total     int                     `json:"total"`
}

// Tree lists the child folders of a folder and the entries/documents in
// it (or below it when subtree is set).
func (f *Foundation) Tree(ctx context.Context, folder string, subtree bool, limit, offset int) (*Tree, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	folders, err := f.DB.Folders(ctx, folder)
	if err != nil {
		return nil, err
	}
	if folders == nil {
		folders = []projection.FolderInfo{}
	}
	arts, total, err := f.DB.Search(ctx, projection.Query{Kinds: []model.Kind{model.KindEntry, model.KindDocument}, Folder: folder, Subtree: subtree, Sort: "path", Limit: limit, Offset: offset})
	if err != nil {
		return nil, err
	}
	if arts == nil {
		arts = []*model.Summary{}
	}
	return &Tree{Folder: folder, Folders: folders, Artifacts: arts, Total: total}, nil
}

// Search is the search service.
func (f *Foundation) Search(ctx context.Context, q projection.Query) ([]*model.Summary, int, error) {
	if q.Folder != "" {
		folder, err := model.CleanFolder(q.Folder)
		if err != nil {
			return nil, 0, err
		}
		q.Folder = folder
	}
	res, total, err := f.DB.Search(ctx, q)
	if res == nil {
		res = []*model.Summary{}
	}
	return res, total, err
}

// TableQuery returns the sorted GUIDs of every artifact matching q
// (generic tables, TSK-34).
func (f *Foundation) TableQuery(ctx context.Context, q projection.Query, sort []projection.SortLevel, limit int) (*projection.TableResult, error) {
	if q.Folder != "" {
		folder, err := model.CleanFolder(q.Folder)
		if err != nil {
			return nil, err
		}
		q.Folder = folder
	}
	return f.DB.QueryIDs(ctx, q, sort, limit)
}

// TableRows are the rows of a generic table plus the artifacts they
// point at (link endpoints, comment subjects and the endpoints of link
// subjects), so a client can label them without further requests.
type TableRows struct {
	Artifacts []*model.Summary          `json:"artifacts"`
	Related   map[string]*model.Summary `json:"related"`
	// TypeNames holds the display names of the types involved, by folder
	// and type (the type id when none is configured); undefined types are
	// left out.
	TypeNames map[string]map[string]string `json:"typeNames"`
}

// Details returns the summaries of guids in that order, unknown ones left
// out. With columns, only the field values of those columns are included.
func (f *Foundation) Details(ctx context.Context, guids, columns []string) (*TableRows, error) {
	if len(guids) > projection.MaxDetails {
		return nil, fmt.Errorf("%w: at most %d artifacts per request", model.ErrValidation, projection.MaxDetails)
	}
	rows, err := f.DB.Details(ctx, guids)
	if err != nil {
		return nil, err
	}
	if columns != nil {
		keep := map[string]bool{}
		for _, c := range columns {
			keep[c] = true
		}
		for _, s := range rows {
			for id := range s.Fields {
				if !keep[id] {
					delete(s.Fields, id)
				}
			}
		}
	}
	out := &TableRows{Artifacts: rows, Related: map[string]*model.Summary{}, TypeNames: map[string]map[string]string{}}
	// Two rounds: endpoints, subjects and parent comments, then the endpoints of link subjects.
	pending := rows
	for round := 0; round < 2 && len(pending) > 0; round++ {
		var want []string
		for _, s := range pending {
			for _, g := range []string{s.Source, s.Target, s.Subject, s.Parent} {
				if g != "" && out.Related[g] == nil {
					want = append(want, g)
				}
			}
		}
		if len(want) == 0 {
			break
		}
		found, err := f.DB.Details(ctx, want)
		if err != nil {
			return nil, err
		}
		pending = nil
		for _, s := range found {
			s.Fields = nil
			out.Related[s.GUID] = s
			if s.Kind == model.KindLink {
				pending = append(pending, s)
			}
		}
	}
	cfg, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	seen := map[[2]string]bool{}
	name := func(s *model.Summary) {
		if seen[[2]string{s.Folder, s.Type}] {
			return
		}
		seen[[2]string{s.Folder, s.Type}] = true
		if schema := cfg.Effective(s.Type, s.Folder); schema != nil && schema.DisplayName != "" {
			if out.TypeNames[s.Folder] == nil {
				out.TypeNames[s.Folder] = map[string]string{}
			}
			out.TypeNames[s.Folder][s.Type] = schema.DisplayName
		}
	}
	for _, s := range rows {
		name(s)
	}
	for _, s := range out.Related {
		name(s)
	}
	return out, nil
}

// Status is the repository status report.
type Status struct {
	Branch     string            `json:"branch"`
	Head       string            `json:"head"`
	Projection projection.Status `json:"projection"`
	InSync     bool              `json:"inSync"`
	Stats      *projection.Stats `json:"stats,omitempty"`
	Scanner    any               `json:"scanner"`
	// InvalidConfig lists configuration files that are ignored because
	// they are not valid, so clients can warn about them.
	InvalidConfig []projection.Issue `json:"invalidConfig,omitempty"`
}

// Status reports repository head, projection state and statistics.
func (f *Foundation) Status(ctx context.Context) (*Status, error) {
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, err
	}
	st := f.DB.Status()
	s := &Status{Branch: f.Repo.Branch, Head: head, Projection: st, InSync: st.ProcessedHash == head, Scanner: f.DB.Scanner().Config()}
	if stats, err := f.DB.Stats(ctx); err == nil {
		s.Stats = stats
	}
	if issues, err := f.DB.InvalidConfig(ctx); err == nil {
		s.InvalidConfig = issues
	}
	return s, nil
}

// Reindex runs a full rebuild in the background and returns immediately.
func (f *Foundation) Reindex() {
	go func() {
		if err := f.DB.Reindex(context.Background()); err != nil {
			log.Printf("foundation: reindex: %v", err)
		}
	}()
}

// ConfigFiles lists the configuration files of one folder, or of all
// folders, with their validity.
func (f *Foundation) ConfigFiles(ctx context.Context, scope string, all bool) ([]projection.ConfigRecord, error) {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return nil, err
	}
	return f.DB.ConfigFiles(ctx, scanner.ConfigConfig, scope, all)
}

// HIDLookup resolves a HID to its current and historical owners.
func (f *Foundation) HIDLookup(ctx context.Context, hid string) ([]projection.HIDRecord, error) {
	recs, err := f.DB.HIDHistory(ctx, hid, "")
	if err != nil {
		return nil, err
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].Current && !recs[j].Current })
	return recs, nil
}
