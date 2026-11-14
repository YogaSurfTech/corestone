# Source structure

A guided tour of the repository: what each package does and how a request flows through them.
Layers only depend downward.

```
cmd/corestone              wiring: flags, HTTP server, response headers, access log, graceful shutdown
  └─ internal/httpapi      REST + WebSocket: decoding, ETag/If-Match, status codes, presence hub
       └─ internal/foundation   the service: operations, the §10.1 transaction, service views
            ├─ internal/projection   PostgreSQL projection (sync, replay, reindex, queries, validation)
            │     └─ internal/scanner    configurable repository scanner + foundation indexer
            ├─ internal/gitx         bare-repository Git plumbing
            └─ internal/model        domain rules (pure): identity, folders, fields, configuration, workflows, overlays
                  └─ internal/ojson      order- and format-preserving JSON
web/                     Lit + TypeScript client (talks only to /api)
```

## internal/gitx — Git as a storage engine

Drives a bare repository through plumbing subprocesses; there is never a working tree.

- `Open` creates the repository if needed and forces `core.quotepath=false`; `Head` maps only
  exit code 1 to "unborn branch" so a broken repository can never look empty.
- `BuildCommit(parent, message, ops)` hashes blobs, feeds one NUL-terminated `update-index
  --index-info` stream into a private temporary index, `write-tree`s and `commit-tree`s. The commit
  exists but is invisible until `Publish(old, new)` — a compare-and-swap `update-ref` that returns
  `ErrStale` when the branch moved.
- Reads are batched: `ListTree` (`ls-tree -r -z -l`), `ReadBlobs` (`cat-file --batch`), `ReadPath`
  with `:(literal)` pathspecs so folder names are never interpreted as pathspec magic.
- History: `FirstParentChain` (`rev-list --first-parent --parents`) for replay, `DiffTree` (raw,
  `-z`, no renames) for per-commit changes, `Log` with trailer parsing, and `Walk` — one `git log
  --raw` process streaming the whole first-parent history for the reindex history phase.
- `BlobSHA` computes an object name without touching the repository: it is the artifact ETag.

## internal/ojson — stable JSON

`Object` is an ordered JSON object; numbers keep their literal text. `Parse` records the source
text of every object; `Encode` writes an unchanged object verbatim, edits values in place, appends
new keys, and formats changed objects in the file's detected style (indent, line ending, trailing
newline). `MarshalJSON`/`UnmarshalJSON` let API responses carry documents in repository order.
Fuzzed for the fixed-point property.

## internal/model — the domain vocabulary

- `identity.go` — kinds, GUID generation/validation, HID and type-id rules.
- `folder.go` — `CleanFolder`, the single gate for user-supplied folder paths (traversal, `.corestone`,
  GUID-shaped segments, control characters, pathspec magic, depth/length limits), plus lineage
  helpers.
- `fields.go` — the field types of design guide §4.6 and value validation.
- `config.go` — the configuration layout of [CONFIGURATION.md](CONFIGURATION.md): classifies files
  below `.corestone/config/` by path, parses types, fields, enumerations and workflows, and the
  `ConfigIndex` that resolves them for a folder — nearest folder first, a per-kind inheritance
  switch, type-specific before shared definitions — into effective schemas, visible types, allowed
  link types and workflows; `Problems` reports references that do not resolve.
- `schema.go` — the effective schema of a type and `Compose`, which merges a type's definitions from
  the root down (nearest wins per property).
- `workflow.go` — definitions and transition lookup.
- `artifact.go` — the typed view over an artifact document; writes go back into the document so
  unknown properties survive.
- `overlay.go` — base-chain resolution with cycle and depth detection, per-field origin.
- `content.go` — document block validation, referenced GUIDs, searchable text.

## internal/scanner — which files matter

`scanner.json` (`guid_files`, `config_folders`, `indexers`) with defaults. `Classify` turns a path
into *artifact file*, *attachment*, *configuration file* (`config/` — the type
system —, links, comments, scanner, other) or *ignore*; configured indexers decide whether a match is processed. Only the
`foundation` indexer is built in; the registry is the extension point for application indexers.

## internal/projection — the PostgreSQL projection

- `projection.go` — connection, DDL (`repo_state.processed_hash`, `artifacts` with an `ltree` path,
  `artifact_fields`, `artifact_refs`, `artifact_files`, `config_files`, `hid_history`,
  `deleted_artifacts`, the history index `artifact_commits` and `relation_commits`; generated `hid_prefix`/`hid_num` columns for natural ID order and the
  ICU collation `corestone_natural`), status
  and maintenance mode (also advertised through `repo_state.maintenance` for other processes), the
  §10.1 publish mutex, ltree label encoding.
- `extract.go` — turns a blob into a row: metadata, key/value field index, outgoing references
  (reference fields, document entry blocks), sanitized search text;
  malformed files become rows with `valid = false`, never failures.
- `sync.go` — `Sync` compares `processed_hash` with HEAD and replays the first-parent chain one
  commit per transaction (`ProjectCommit` + CAS advance); anything else triggers a rebuild. Also the
  configuration index, cached per processed revision, and its unresolved references.
- `reindex.go` — the phased rebuild: identity (GUID → path), fields, full text (drop GIN index,
  parallel workers stream text, recreate index), history scan (deletions, HID history, timestamps,
  history index).
- `history.go` — the history index: per commit the artifacts it touched with their file's path and
  blob (`artifact_commits`), and the artifacts a changed link or comment pointed to before or after
  it (`relation_commits`, old and new content), so a past version finds the links and comments of
  its time, also those deleted or reassigned since. Live writes and the rebuild fill both alike.
- `query.go` — locate, get, search (filters, states, fields, full text), folders, scopes, HID
  helpers, links/comments, attachments, configuration files, HID history, deleted artifacts,
  statistics.
- `table.go` — generic tables: `QueryIDs` sorts the complete filtered set in SQL (up to three
  levels over overview columns or field ids; enum, workflow-field and state values rank by
  configuration, passed as one JSON parameter; empty values last in either direction) and returns
  up to 50 000 GUIDs; `Details` fetches rows by GUID in request order.
- `validate.go` — the repository validation service.

## internal/foundation — the service

- `foundation.go` — `write(prepare)`: the repository update transaction. `prepare` builds the
  changeset against the head it will be published on; on a stale CAS it is re-run from scratch.
- `artifacts.go` — create/update/delete/move for entries and documents, HID generation, field and
  reference validation, workflow initialization, cascading deletes, folder moves with metadata
  relocation and maintenance mode for large operations, the relocate-metadata maintenance job.
- `metadata.go` — links (endpoint rules, cardinality, duplicates), comments (threads), transitions.
- `save.go` — the detail form's Save: patch, transitions, link removals and additions, comments and
  attachments composed in one `write`. Each operation is a txn builder (`t.update`, `t.transition`,
  `t.createLink`, …) that stages its ops into the txn, so later steps read earlier ones
  (`t.load` honours staged ops; duplicate and cardinality checks count links dropped or added in
  the same save); the parts are combined into one commit with one event.
- `config.go` — configuration files (read, write with warnings for unresolved references, delete),
  attachments. Enforcement of the configuration — types defined where an artifact lives, including
  after moves; no new or changed undefined fields — sits in `artifacts.go` and `metadata.go`.
- `read.go` — views: artifact, effective schema, visible types, overlay analysis, workflow
  evaluation, relationship analysis (each link with its role as read from this artifact: the
  display name outgoing, the `reverseName` incoming), comments, documents embedding an entry, history across moves,
  tree, search, table query and row details (with related endpoints and subjects), status.
- `version.go` — historic versions (blob viewed at a commit): history pages, the item and its
  base chain, attachments, links, comments, endpoints and subject as they were then, plus what that
  commit changed (properties, added links/comments, counts of removed ones); configuration and
  permissions are today's.

## internal/httpapi — transport

Routes (Go 1.22 method patterns), 4 MiB body cap, ETag/If-Match/If-None-Match per RFC 9110, error
mapping (400/404/409/412/503), kind-checked collections. Generic tables use `POST /api/repository/query`
(`{filter, sort: [{col, dir}], limit}` → `{total, ids, truncated}`; `filter.types` restricts to type
ids, `kind/*` or `*`) and `POST /api/artifacts/details` (`{ids ≤ 500, columns}` →
`{artifacts, related, typeNames}`). `ws.go` is the session hub: hello, commit
and status broadcasts, viewer/editor presence per artifact.

## web — the client

`store.ts` (central state), `router.ts` (URL ⇄ state; save/discard/cancel guards protect
unsaved edits when changing artifacts or historic versions, including browser back/forward),
`api.ts`, `ws.ts`; components `app`
(shell), `sidebar`, `overview` (with the ＋ New menu), `dialogs` (type choice → generated form →
create; picker; confirm), `table` (`<corestone-table>`: server-sorted, lazily loaded rows in
batches of 50 with a virtual window; a header click promotes that column to the first of up to three sort levels; with
`items` set it sorts rows held in the browser by the columns' `value` instead; pure helpers in
`table-model.ts`). The overview (all kinds, no row limit), the picker and the detail lists
(relationships, documents, attachments, history) all use it; `rows-load` and `widths-change` let the
overview resolve row schemas and persist its layout. The picker loads all fields for each fetched
batch so selection callbacks can use the complete summary (including document entry-card fields).
`fields` (one input per field type), `detail` (entry sections; a historic version shows what
surrounded it then with the commit's changes highlighted, and its references open the other artifacts as of the same commit), `document`
(block editor + sidebars), `toast`. Components observe the store and never talk to each other. Tests
in `web/tests` drive the built client in Chromium against a live server; `*.unit.mjs` run with
`node --test` (`npm run test:unit`).

## A request, end to end

`POST /api/entries` → `httpapi.create` parses the body as an ordered object → `Foundation.
CreateArtifact` enters `write`: `DB.Sync` (replay if a push landed), `prepare` validates against
the effective schema (fields, required, references, HID uniqueness, overlay chain) and stages the
file → `gitx.BuildCommit` → `DB.ProjectCommit` inside a transaction → mutex → `gitx.Publish` (CAS)
→ `DB.AdvanceProcessed` (CAS) → commit → an event is broadcast to WebSocket clients → the response
carries the document, its metadata and the ETag.
