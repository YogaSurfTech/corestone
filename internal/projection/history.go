package projection

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/lib/pq"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// The artifact_commits table maps every artifact GUID to the commits that
// touched it, so an artifact's history is an index lookup instead of a
// pathspec scan over the whole repository history. seq orders the commits
// along the first-parent chain: a rebuild numbers the walked history 0, -1,
// -2, … from the head backwards; every replayed or written commit after
// that gets max(seq)+1.

// HistoryGUIDs returns the artifacts whose history a changed path belongs
// to: every GUID directory on the path (the artifact file, its attachments,
// nested artifacts) and the GUID of a link or comment file in .corestone.
func HistoryGUIDs(path string) []string {
	segs := strings.Split(path, "/")
	var out []string
	last := len(segs) - 1
	for _, s := range segs[:last] {
		if model.IsGUID(s) {
			out = append(out, s)
		}
	}
	if last >= 2 && segs[last-2] == ".corestone" && (segs[last-1] == "links" || segs[last-1] == "comments") {
		if g, ok := strings.CutSuffix(segs[last], ".json"); ok && model.IsGUID(g) {
			out = append(out, g)
		}
	}
	return out
}

func commitGUIDs(changes []gitx.Change) []string {
	seen := map[string]bool{}
	var out []string
	for _, ch := range changes {
		for _, g := range HistoryGUIDs(ch.Path) {
			if !seen[g] {
				seen[g] = true
				out = append(out, g)
			}
		}
	}
	return out
}

// fileState is an artifact's own file in one commit (see artifact_commits).
type fileState struct {
	path, blob string
}

// artifactFiles finds the artifacts whose own file a commit added, changed,
// moved or deleted. A move is a deletion plus an addition: the addition wins.
func artifactFiles(sc *scanner.Scanner, changes []gitx.Change) map[string]fileState {
	out := map[string]fileState{}
	for _, ch := range changes {
		m := sc.Classify(ch.Path)
		guid := ""
		switch {
		case m.Category == scanner.Artifact:
			guid = m.GUID
		case m.Category == scanner.ConfigFile && (m.ConfigKind == scanner.ConfigLinks || m.ConfigKind == scanner.ConfigComments) && model.IsGUID(m.Name):
			guid = m.Name
		}
		if guid == "" {
			continue
		}
		if ch.Status == 'D' {
			if _, seen := out[guid]; !seen {
				out[guid] = fileState{}
			}
			continue
		}
		out[guid] = fileState{path: ch.Path, blob: ch.SHA}
	}
	return out
}

// commitRows are the history index rows of one commit.
func commitRowsOf(sc *scanner.Scanner, commit string, seq int64, changes []gitx.Change) []commitRow {
	files := artifactFiles(sc, changes)
	var rows []commitRow
	for _, g := range commitGUIDs(changes) {
		r := commitRow{guid: g, commit: commit, seq: seq}
		if f, ok := files[g]; ok {
			r.file, r.path, r.blob = true, f.path, f.blob
		}
		rows = append(rows, r)
	}
	return rows
}

// linkRef is a link file a commit touched; its content names the endpoints.
type linkRef struct {
	commit string
	seq    int64
	sha    string // the new content, or the old one when the commit deleted the link
}

// linkRefsOf lists the link files a commit added, changed or deleted.
func linkRefsOf(sc *scanner.Scanner, commit string, seq int64, changes []gitx.Change) []linkRef {
	var out []linkRef
	for _, ch := range changes {
		m := sc.Classify(ch.Path)
		if m.Category != scanner.ConfigFile || m.ConfigKind != scanner.ConfigLinks {
			continue
		}
		sha := ch.SHA
		if ch.Status == 'D' {
			sha = ch.OldSHA
		}
		if sha != "" {
			out = append(out, linkRef{commit: commit, seq: seq, sha: sha})
		}
	}
	return out
}

// endpointRows puts link commits into the history of both endpoints: a
// link's creation, change and deletion are part of what happened to the
// artifacts it connects. The rows carry no file (the endpoint's own file is
// untouched).
func (p *DB) endpointRows(ctx context.Context, refs []linkRef) ([]commitRow, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	shas := make([]string, len(refs))
	for i, r := range refs {
		shas[i] = r.sha
	}
	blobs, err := p.repo.ReadBlobs(ctx, shas)
	if err != nil {
		return nil, err
	}
	var rows []commitRow
	for _, r := range refs {
		a, err := model.ParseArtifact(blobs[r.sha], model.KindLink)
		if err != nil {
			continue // a malformed link names no endpoints
		}
		for _, g := range []string{a.Source, a.Target} {
			if g = strings.ToLower(g); model.IsGUID(g) {
				rows = append(rows, commitRow{guid: g, commit: r.commit, seq: r.seq})
			}
		}
	}
	return rows, nil
}

// onConflict keeps a row's file when the same artifact and commit come in
// twice (its own file changed and it is the endpoint of a changed link).
const onConflict = `ON CONFLICT (guid, commit_sha) DO UPDATE SET
	path = COALESCE(artifact_commits.path, EXCLUDED.path), blob = COALESCE(artifact_commits.blob, EXCLUDED.blob)`

// recordCommit appends commit to the history of every artifact it touched.
func (p *DB) recordCommit(ctx context.Context, tx *sql.Tx, commit string, changes []gitx.Change) error {
	sc := p.Scanner()
	rows := commitRowsOf(sc, commit, 0, changes)
	ends, err := p.endpointRows(ctx, linkRefsOf(sc, commit, 0, changes))
	if err != nil {
		return err
	}
	rows = append(rows, ends...)
	if len(rows) == 0 {
		return nil
	}
	guids, paths, blobs, files := rowArrays(rows)
	_, err = tx.ExecContext(ctx, `INSERT INTO artifact_commits (guid, commit_sha, seq, path, blob)
		SELECT g, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM artifact_commits),
			CASE WHEN f THEN p END, CASE WHEN f THEN b END
		FROM unnest($1::text[], $3::text[], $4::text[], $5::bool[]) AS t(g, p, b, f)
		`+onConflict, pq.Array(guids), commit, pq.Array(paths), pq.Array(blobs), pq.Array(files))
	return unavailable(err)
}

type commitRow struct {
	guid, commit string
	seq          int64
	file         bool // the commit touched the artifact's own file
	path, blob   string
}

// rowArrays turns rows into insert arrays, one row per artifact and commit
// (the one with the file wins): an INSERT … ON CONFLICT DO UPDATE must not
// meet the same key twice.
func rowArrays(rows []commitRow) (guids, paths, blobs []string, files []bool) {
	rows = mergeRows(rows)
	for _, r := range rows {
		guids = append(guids, r.guid)
		paths = append(paths, r.path)
		blobs = append(blobs, r.blob)
		files = append(files, r.file)
	}
	return
}

func mergeRows(rows []commitRow) []commitRow {
	type key struct{ guid, commit string }
	at := make(map[key]int, len(rows))
	out := rows[:0:0]
	for _, r := range rows {
		k := key{r.guid, r.commit}
		if i, ok := at[k]; ok {
			if r.file && !out[i].file {
				out[i] = r
			}
			continue
		}
		at[k] = len(out)
		out = append(out, r)
	}
	return out
}

func (p *DB) insertCommitRows(ctx context.Context, rows []commitRow) error {
	rows = mergeRows(rows)
	if len(rows) == 0 {
		return nil
	}
	guids, paths, blobs, files := rowArrays(rows)
	commits := make([]string, len(rows))
	seqs := make([]int64, len(rows))
	for i, r := range rows {
		commits[i], seqs[i] = r.commit, r.seq
	}
	_, err := p.sql.ExecContext(ctx, `INSERT INTO artifact_commits (guid, commit_sha, seq, path, blob)
		SELECT g, c, s, CASE WHEN f THEN pa END, CASE WHEN f THEN b END
		FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::bool[]) AS t(g, c, s, pa, b, f)
		`+onConflict,
		pq.Array(guids), pq.Array(commits), pq.Array(seqs), pq.Array(paths), pq.Array(blobs), pq.Array(files))
	return unavailable(err)
}

// HistoryEntry is one commit in an artifact's history with the blob of the
// artifact's own file as of that commit ("" when it did not exist then).
type HistoryEntry struct {
	Commit string
	Blob   string
}

// HistoryPage lists the commits that touched an artifact or one of its
// current comments, newest first: at most limit of them, older than the
// commit before when given. more reports whether older commits remain.
func (p *DB) HistoryPage(ctx context.Context, guid string, limit int, before string) ([]HistoryEntry, bool, error) {
	var beforeSeq any
	if before != "" {
		seq, ok, err := p.CommitSeq(ctx, before)
		if err != nil {
			return nil, false, err
		}
		if !ok {
			return nil, false, model.Invalid("unknown commit %q", before)
		}
		beforeSeq = seq
	}
	var lim any
	if limit > 0 {
		lim = limit + 1
	}
	rows, err := p.sql.QueryContext(ctx, `WITH c AS (
			SELECT commit_sha, max(seq) AS seq FROM artifact_commits
			WHERE guid = $1 OR guid IN (SELECT guid FROM artifacts WHERE kind = 'comment' AND subject = $1)
			GROUP BY commit_sha)
		SELECT c.commit_sha, COALESCE((SELECT a.blob FROM artifact_commits a
			WHERE a.guid = $1 AND a.seq <= c.seq AND a.path IS NOT NULL ORDER BY a.seq DESC LIMIT 1), '')
		FROM c WHERE $2::bigint IS NULL OR c.seq < $2
		ORDER BY c.seq DESC, c.commit_sha LIMIT $3`, guid, beforeSeq, lim)
	if err != nil {
		return nil, false, unavailable(err)
	}
	defer rows.Close()
	out := []HistoryEntry{}
	for rows.Next() {
		var e HistoryEntry
		if err := rows.Scan(&e.Commit, &e.Blob); err != nil {
			return nil, false, unavailable(err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, false, unavailable(err)
	}
	more := limit > 0 && len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}

// CommitSeq returns the position of a commit in the history index.
func (p *DB) CommitSeq(ctx context.Context, commit string) (int64, bool, error) {
	var seq int64
	err := p.sql.QueryRowContext(ctx, `SELECT seq FROM artifact_commits WHERE commit_sha = $1 LIMIT 1`, commit).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, unavailable(err)
	}
	return seq, true, nil
}

// FileAt returns the path and blob of an artifact's own file (entry,
// document, link or comment) as of the index position seq; ok is false when
// the file did not exist then.
func (p *DB) FileAt(ctx context.Context, guid string, seq int64) (path, blob string, ok bool, err error) {
	err = p.sql.QueryRowContext(ctx, `SELECT path, blob FROM artifact_commits
		WHERE guid = $1 AND seq <= $2 AND path IS NOT NULL ORDER BY seq DESC LIMIT 1`, guid, seq).Scan(&path, &blob)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, unavailable(err)
	}
	return path, blob, path != "", nil
}

// CommitOfBlob finds the commit that first gave an artifact's file the
// content blob, with its index position.
func (p *DB) CommitOfBlob(ctx context.Context, guid, blob string) (string, int64, bool, error) {
	var commit string
	var seq int64
	err := p.sql.QueryRowContext(ctx, `SELECT commit_sha, seq FROM artifact_commits
		WHERE guid = $1 AND blob = $2 ORDER BY seq LIMIT 1`, guid, blob).Scan(&commit, &seq)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, unavailable(err)
	}
	return commit, seq, true, nil
}

// FileRef is the path and blob of an artifact's own file.
type FileRef struct{ Path, Blob string }

// FilesAt is FileAt for many artifacts: those whose file existed as of seq.
func (p *DB) FilesAt(ctx context.Context, guids []string, seq int64) (map[string]FileRef, error) {
	out := map[string]FileRef{}
	if len(guids) == 0 {
		return out, nil
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT DISTINCT ON (guid) guid, path, blob FROM artifact_commits
		WHERE guid = ANY($1) AND seq <= $2 AND path IS NOT NULL ORDER BY guid, seq DESC`, pq.Array(guids), seq)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	for rows.Next() {
		var g string
		var f FileRef
		if err := rows.Scan(&g, &f.Path, &f.Blob); err != nil {
			return nil, unavailable(err)
		}
		if f.Path != "" {
			out[g] = f
		}
	}
	return out, unavailable(rows.Err())
}
