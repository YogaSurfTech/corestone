package foundation

import (
	"context"
	"fmt"
	"strings"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
)

// Underlay is the result of CreateUnderlay: the new base and the entry
// that now inherits from it.
type Underlay struct {
	Base  *View `json:"base"`
	Entry *View `json:"entry"`
}

// CreateUnderlay inserts a new base below an entry. The base gets the
// entry's type and folder, the chosen fields the entry sets itself, and the
// entry's current base (if any), so it becomes a new level in between. The
// entry then inherits those fields from it; no effective value changes.
// Both artifacts are validated as usual and written in one commit.
func (f *Foundation) CreateUnderlay(ctx context.Context, guid, ifMatch, title string, fields []string) (*Underlay, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if cur.Kind != model.KindEntry {
			return nil, model.Invalid("only entries have a base")
		}
		if err := checkETag(ifMatch, cur.ETag); err != nil {
			return nil, err
		}
		own := cur.Fields
		if own == nil {
			own = ojson.NewObject()
		}
		moved := ojson.NewObject()
		for _, id := range fields {
			v, ok := own.Get(id)
			if !ok {
				return nil, model.Invalid("field %s is not set in this entry", id)
			}
			moved.Set(id, ojson.Clone(v))
		}
		title = strings.TrimSpace(title)
		if title == "" {
			title = cur.Title
		}
		folder := cur.Loc.Folder

		// The new base: a new level between the entry and its current base.
		bguid := model.NewGUID()
		bdoc := model.NewDoc(model.KindEntry, bguid, cur.Type)
		bdoc.Set("title", title)
		if cur.Base != "" {
			bdoc.Set("base", cur.Base)
		}
		bdoc.Set("fields", moved)
		bdoc.Set("workflows", ojson.NewObject())
		base, err := model.ArtifactFromDoc(bdoc, model.KindEntry)
		if err != nil {
			return nil, err
		}
		if err := t.validateArtifact(base, folder, nil, true); err != nil {
			return nil, fmt.Errorf("new base: %w", err)
		}
		bcontent := encode(bdoc, cur.Style)
		bpath := model.ArtifactDir(folder, bguid) + "/" + model.GUIDFile
		t.stage(&loaded{Artifact: base, Bytes: bcontent, Style: cur.Style, ETag: gitx.BlobSHA(bcontent),
			Loc: &projection.Located{GUID: bguid, Kind: model.KindEntry, Type: cur.Type, Folder: folder, FilePath: bpath, Valid: true}})

		// The entry inherits the moved fields from it.
		doc := cur.Doc.Clone()
		doc.Set("base", bguid)
		if ef := doc.Object("fields"); ef != nil {
			for _, k := range moved.Keys() {
				ef.Delete(k)
			}
		}
		a, err := model.ArtifactFromDoc(doc, model.KindEntry)
		if err != nil {
			return nil, err
		}
		if err := t.validateArtifact(a, folder, cur.Artifact, false); err != nil {
			return nil, err
		}
		content := encode(doc, cur.Style)

		cs := &changeset{subject: fmt.Sprintf("Entry %s: new base %s created", label(cur.Artifact), label(base))}
		cs.trailer("Corestone-Op", "underlay")
		cs.trailer("Corestone-Guid", guid)
		cs.trailer("Corestone-Base", bguid)
		cs.ops = []gitx.Op{{Path: bpath, Content: bcontent}, {Path: cur.Loc.FilePath, Content: content}}
		cs.event = Event{Op: "update", GUID: guid, Kind: string(model.KindEntry)}
		cs.result = &Underlay{
			Base:  &View{Meta: summarize(base, folder, bpath, gitx.BlobSHA(bcontent)), Data: bdoc, ETag: gitx.BlobSHA(bcontent)},
			Entry: &View{Meta: summarize(a, folder, cur.Loc.FilePath, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)},
		}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*Underlay), nil
}
