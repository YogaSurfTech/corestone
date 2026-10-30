package projection

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/lib/pq"
)

// fillLinkAuthors derives creators from the same commits as created_at.
// It also backfills older projections without changing repository documents.
func (p *DB) fillLinkAuthors(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT created_commit FROM artifacts
		WHERE kind = 'link' AND created_author = '' AND created_commit IS NOT NULL AND created_commit <> ''`)
	if err != nil {
		return unavailable(err)
	}
	var commits []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return unavailable(err)
		}
		commits = append(commits, sha)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return unavailable(err)
	}
	const batchSize = 1000
	for start := 0; start < len(commits); start += batchSize {
		batch := commits[start:min(start+batchSize, len(commits))]
		entries, err := p.repo.Commits(ctx, batch)
		if err != nil {
			return err
		}
		if len(entries) != len(batch) {
			return fmt.Errorf("link authors: expected %d creation commits, got %d", len(batch), len(entries))
		}
		shas, authors := make([]string, len(entries)), make([]string, len(entries))
		for i, entry := range entries {
			shas[i], authors[i] = entry.SHA, entry.Author
		}
		if _, err := tx.ExecContext(ctx, `UPDATE artifacts a SET created_author = c.author
			FROM unnest($1::text[], $2::text[]) AS c(sha, author)
			WHERE a.kind = 'link' AND a.created_commit = c.sha AND a.created_author = ''`,
			pq.Array(shas), pq.Array(authors)); err != nil {
			return unavailable(err)
		}
	}
	return nil
}
