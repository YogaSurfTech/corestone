package projection

import (
	"context"
	"database/sql"

	"github.com/lib/pq"

	"github.com/thomdehoog/corestone/internal/model"
)

// fillCommentExcerpts backfills excerpts of comments projected before the
// column existed, from the blobs they were projected from. Valid comments
// always have text, so an empty excerpt means "not filled yet".
func (p *DB) fillCommentExcerpts(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT blob_sha FROM artifacts
		WHERE kind = 'comment' AND excerpt = '' AND valid AND blob_sha <> ''`)
	if err != nil {
		return unavailable(err)
	}
	var blobs []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return unavailable(err)
		}
		blobs = append(blobs, sha)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return unavailable(err)
	}
	const batchSize = 1000
	for start := 0; start < len(blobs); start += batchSize {
		batch := blobs[start:min(start+batchSize, len(blobs))]
		contents, err := p.repo.ReadBlobs(ctx, batch)
		if err != nil {
			return err
		}
		var shas, excerpts []string
		for _, sha := range batch {
			a, err := model.ParseArtifact(contents[sha], model.KindComment)
			if err != nil {
				continue
			}
			if e := clean(model.Excerpt(a.Text)); e != "" {
				shas, excerpts = append(shas, sha), append(excerpts, e)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE artifacts a SET excerpt = c.excerpt
			FROM unnest($1::text[], $2::text[]) AS c(sha, excerpt)
			WHERE a.kind = 'comment' AND a.blob_sha = c.sha AND a.excerpt = ''`,
			pq.Array(shas), pq.Array(excerpts)); err != nil {
			return unavailable(err)
		}
	}
	return nil
}
