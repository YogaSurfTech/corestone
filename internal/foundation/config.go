package foundation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
)

// ConfigWrite is the result of storing a configuration file.
type ConfigWrite struct {
	Path string `json:"path"`
	ETag string `json:"etag"`
	// Warnings are references in the folder's configuration that do not
	// resolve yet, such as fields named by types.json but not defined.
	Warnings []model.ConfigProblem `json:"warnings"`
}

// configPath validates a folder and a path below its config directory.
func configPath(scope, rel string) (string, string, error) {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return "", "", err
	}
	for _, seg := range strings.Split(rel, "/") {
		if err := model.ValidateSegment(seg); err != nil {
			return "", "", err
		}
	}
	if _, ok := model.ClassifyConfig(rel); !ok {
		return "", "", model.Invalid("%q is not a configuration file: expected <kind>/types.json, <kind>/[<type>-]fields.json, <kind>/enums/<name>-enum.json or <kind>/workflows/<name>-workflow.json, with kind entries, documents, links or comments", rel)
	}
	return scope, model.ConfigPath(scope, rel), nil
}

// ConfigFile reads a configuration file at head.
func (f *Foundation) ConfigFile(ctx context.Context, scope, rel string) ([]byte, string, error) {
	_, path, err := configPath(scope, rel)
	if err != nil {
		return nil, "", err
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, "", err
	}
	data, sha, err := f.Repo.ReadPath(ctx, head, path)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, "", fmt.Errorf("%w: %s", model.ErrNotFound, path)
	}
	return data, sha, err
}

// PutConfig stores a configuration file (docs/CONFIGURATION.md). A file
// that does not parse is rejected; references to definitions that do not
// exist yet are accepted and returned as warnings, so a configuration can
// be written one file at a time. ifMatch is the expected ETag ("" or "*"
// to skip).
func (f *Foundation) PutConfig(ctx context.Context, scope, rel string, body []byte, ifMatch string) (*ConfigWrite, error) {
	scope, path, err := configPath(scope, rel)
	if err != nil {
		return nil, err
	}
	if _, _, err := model.ParseConfigFile(rel, body); err != nil {
		return nil, err
	}
	obj, err := ojson.ParseObject(body)
	if err != nil {
		return nil, model.Invalid("%v", err)
	}
	var etag string
	_, err = f.write(ctx, false, func(t *txn) (*changeset, error) {
		style := ojson.DefaultStyle
		verb := "created"
		old, sha, err := t.f.Repo.ReadPath(t.ctx, t.head, path)
		if err == nil {
			style = ojson.DetectStyle(old)
			verb = "updated"
		} else if !errors.Is(err, gitx.ErrNotFound) {
			return nil, err
		}
		if err := checkETag(ifMatch, sha); err != nil {
			return nil, err
		}
		content := encode(obj, style)
		etag = gitx.BlobSHA(content)
		if bytes.Equal(content, old) {
			return &changeset{}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("Configuration %s in %s %s", rel, folderName(scope), verb)}
		cs.trailer("Corestone-Op", "config")
		cs.trailer("Corestone-Path", path)
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "config", Subject: path}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	warnings, err := f.configWarnings(ctx, scope)
	if err != nil {
		return nil, err
	}
	return &ConfigWrite{Path: path, ETag: etag, Warnings: warnings}, nil
}

// configWarnings lists unresolved references reported for files of scope.
func (f *Foundation) configWarnings(ctx context.Context, scope string) ([]model.ConfigProblem, error) {
	problems, err := f.DB.ConfigProblems(ctx)
	if err != nil {
		return nil, err
	}
	prefix := model.ConfigPath(scope, "") + "/"
	out := []model.ConfigProblem{}
	for _, p := range problems {
		if strings.HasPrefix(p.Path, prefix) {
			out = append(out, p)
		}
	}
	return out, nil
}

// DeleteConfig removes a configuration file and returns the warnings that
// remain for the folder (references the file satisfied may now dangle).
func (f *Foundation) DeleteConfig(ctx context.Context, scope, rel, ifMatch string) ([]model.ConfigProblem, error) {
	scope, path, err := configPath(scope, rel)
	if err != nil {
		return nil, err
	}
	_, err = f.write(ctx, false, func(t *txn) (*changeset, error) {
		_, sha, err := t.f.Repo.ReadPath(t.ctx, t.head, path)
		if err != nil {
			if errors.Is(err, gitx.ErrNotFound) {
				return nil, fmt.Errorf("%w: %s", model.ErrNotFound, path)
			}
			return nil, err
		}
		if err := checkETag(ifMatch, sha); err != nil {
			return nil, err
		}
		cs := &changeset{subject: fmt.Sprintf("Configuration %s in %s deleted", rel, folderName(scope))}
		cs.trailer("Corestone-Op", "config")
		cs.trailer("Corestone-Path", path)
		cs.ops = []gitx.Op{{Path: path, Delete: true}}
		cs.event = Event{Op: "config", Subject: path}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return f.configWarnings(ctx, scope)
}

// ValidateAttachmentName checks a file name inside a GUID directory.
func ValidateAttachmentName(name string) error {
	if err := model.ValidateSegment(name); err != nil {
		return err
	}
	if name == model.GUIDFile || strings.HasPrefix(name, ".corestone") {
		return model.Invalid("%q is reserved", name)
	}
	return nil
}

// PutAttachment stores a file inside an artifact's GUID directory.
func (f *Foundation) PutAttachment(ctx context.Context, guid, name string, content []byte) error {
	if err := ValidateAttachmentName(name); err != nil {
		return err
	}
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if !cur.Kind.IsFolderKind() {
			return nil, model.Invalid("only entries and documents can hold attachments")
		}
		path := model.ArtifactDir(cur.Loc.Folder, guid) + "/" + name
		if old, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path); err == nil && bytes.Equal(old, content) {
			return &changeset{}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("Attachment %s of %s stored", name, label(cur.Artifact))}
		cs.trailer("Corestone-Op", "attachment")
		cs.trailer("Corestone-Guid", guid)
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "attachment", GUID: guid, Kind: string(cur.Kind)}
		return cs, nil
	})
	return err
}

// DeleteAttachment removes a file from an artifact's GUID directory.
func (f *Foundation) DeleteAttachment(ctx context.Context, guid, name string) error {
	if err := ValidateAttachmentName(name); err != nil {
		return err
	}
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		path := model.ArtifactDir(cur.Loc.Folder, guid) + "/" + name
		if _, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path); err != nil {
			if errors.Is(err, gitx.ErrNotFound) {
				return nil, fmt.Errorf("%w: attachment %s", model.ErrNotFound, name)
			}
			return nil, err
		}
		cs := &changeset{subject: fmt.Sprintf("Attachment %s of %s removed", name, label(cur.Artifact))}
		cs.trailer("Corestone-Op", "attachment")
		cs.trailer("Corestone-Guid", guid)
		cs.ops = []gitx.Op{{Path: path, Delete: true}}
		cs.event = Event{Op: "attachment", GUID: guid, Kind: string(cur.Kind)}
		return cs, nil
	})
	return err
}

// Attachment reads a file from an artifact's GUID directory.
func (f *Foundation) Attachment(ctx context.Context, guid, name string) ([]byte, string, error) {
	if err := ValidateAttachmentName(name); err != nil {
		return nil, "", err
	}
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, "", err
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, "", err
	}
	data, sha, err := f.Repo.ReadPath(ctx, head, model.ArtifactDir(loc.Folder, guid)+"/"+name)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, "", model.ErrNotFound
	}
	return data, sha, err
}
