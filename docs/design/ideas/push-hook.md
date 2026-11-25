# Idea: enforcing pre-receive hook

Status: exploring · Started: 2026-11-25 · Owner: Thom

## Problem

Corestone checks every change made through its API: valid artifacts and configuration, workflow
transitions, write-once approval records, permissions. A direct Git push into the data repository
skips all of it. The server notices the new commits and replays them, and validation reports problems
afterwards, but by then they are in the history. So far this was a procedural control ("only
administrators have Git access").

## The idea

Git runs a `pre-receive` hook in the receiving repository before it accepts a push, and rejects the
push if the hook fails. Everything the hook prints reaches the pusher's terminal, prefixed with
`remote:`. Corestone installs such a hook in its data repository and enforces its own rules on every
push, with the same code that checks API writes.

## Decisions

1. **Repositories are self-contained.** No links between repositories. Several repositories are
   separate Corestone instances, each with its own server, index and accounts.
2. **Reading is all or nothing per repository.** A clone always contains everything; Git cannot hide
   folders. Read restrictions below the repository exist only in the web client.
3. **Two modes per repository:**
   - **closed** (default): Git access over SSH only for global administrators; everyone else uses the
     client, which can filter reads per folder once folder roles exist;
   - **open** ("open source mode"): every account may clone everything and push; the hook enforces
     write rights per folder. Folder read roles are refused in this mode, because anyone can clone.
4. **The hook is Corestone itself.** `hooks/pre-receive` is one line, `exec corestone check-push`,
   running the Go validation the server uses for API writes. The rules exist once.
5. **The server installs the hook** into the data repository at every start, so the hook always
   matches the running version (also in Docker).
6. **Every commit is checked**, in order, each against its parent, because each one becomes part of
   the audit trail and of the history views. Not only the final tree.
7. **History stays linear.** Non-fast-forward pushes and merge commits are rejected
   (`receive.denyNonFastForwards` plus a check in the hook). Only the branch Corestone owns may be pushed.
   Scenario edits reach main only by being redone, never by a merge, so main's history shows only
   what really happened on main.
8. **Branches are never deleted on the server.** Not by push, not through Corestone, not by a local
   command on the server's repository (below). Scenarios end as redone or dropped and keep their branch.

## Who is pushing

The commit author is whatever the pusher's Git is configured to say; it cannot carry permissions.
The identity comes from the SSH key: each key in `authorized_keys` has a fixed command naming the
Corestone account,

```
command="corestone git-shell 11111111-aaaa-4aaa-8aaa-111111111111",no-port-forwarding,no-pty ssh-ed25519 AAAA… anna@laptop
```

`corestone git-shell` allows only `git-receive-pack` and `git-upload-pack` on the data repository and
passes the account to the hook (`CORESTONE_PUSHER`). The hook rejects commits whose author is not the
pusher, except for administrators importing history.

In open mode, keys are managed per account in the client (like the planned access tokens), and
Corestone writes `authorized_keys` itself.

## What it checks

| Group | Examples | On failure |
| --- | --- | --- |
| Push shape | fast-forward only, no merge commits, only Corestone's branch, no deletion of any branch | reject |
| Structure | valid JSON, artifacts and records in the right places, unique GUIDs | reject |
| Write-once records | signatures and approval round files never changed or deleted | reject |
| Configuration | types, fields, workflows, views valid; scripts and every file they load approved by blob id | reject |
| HIDs | no HID used twice | reject |
| Workflows | a workflow field changes only through a valid transition; approved or disapproved only with the round's `decided` event | reject |
| Permissions | write rights per folder (open mode); `.corestone/access.json`, script approvals and configuration only by the roles allowed | reject |
| Identity | commit author is the pusher | reject |
| References | links and placements pointing to missing artifacts | warn |

Rules that need the index (HID uniqueness, references) use the projection the server keeps; the hook
asks the running server (`POST /api/internal/check-push` on a local socket) instead of building its
own. If the server is not running, the push is rejected: no unchecked push.

## No branch deletion

| Path | How it is prevented |
| --- | --- |
| Push | `receive.denyDeletes = true`; the hook also rejects any update whose new commit is all zeros (Git's way of deleting) |
| Corestone | no operation deletes a branch; scenarios end as redone or dropped and keep their branch |
| A command on the server (`git update-ref -d`, `git branch -D`) | a `reference-transaction` hook (Git 2.28+), installed by the server like the `pre-receive` hook, refuses any deletion of a branch |

What stays open: someone editing files inside the repository's `.git` directory by hand. That is
the procedural control for server administrators.

A branch deleted in a user's own clone is not prevented and need not be: it changes nothing on the
server, and the next fetch brings the server's branches back.

So every commit that ever was on a branch stays reachable, and a trailer such as
`Corestone-Scenario: <id>@<commit>` on a redone commit always points to history that still exists.

## Messages

The hook answers in short, line-based messages the pusher sees in their terminal:

```
remote: Corestone: push refused, 2 problems in commit 3f1c9a0 "Update boot requirements"
remote:   specs/boot/.corestone/signatures/c1000002-….json: signatures are write-once
remote:   specs/boot/7c1e4a2b-…/.corestone.json: status draft -> approved is not a transition of workflow dev
remote: Fix the commit and push again; see https://corestone.example/help/push
 ! [remote rejected] main -> main (pre-receive hook declined)
```

A `post-receive` hook reports what happened after an accepted push ("3 artifacts updated, index synced").

## Introducing it

- **Warn mode** first: the hook reports everything and accepts the push. Problems found in existing
  data are fixed, then the repository is switched to **enforce**.
- Existing history is never rechecked; only new pushes are.
- The mode is a server setting (`-push-check warn|enforce`), shown in the repository status.

## What it does not cover

- Corestone's own writes do not pass through push hooks; they go through the same checks in the API.
  The `reference-transaction` hook is used only to refuse branch deletions, not to recheck content.
- Someone with file-system access to the server can still change the repository directly. That stays
  a procedural control for server administrators.
- Hosted Git services do not run custom `pre-receive` hooks (except self-hosted enterprise editions);
  the data repository must be served by the Corestone host.

## Effects on other ideas

- **SSH sync** (`corestone-sync.sh`) becomes safe in both directions: what it pushes is checked like
  anything else.
- **Approvals and scripts:** write-once records and script approvals are enforced on every path, not
  only through the client.
- **Scenarios:** pushes go to main only; scenario branches are written by the server only and never
  deleted, so the scenario list stays complete.

## Open questions

1. Does the hook check each commit with the configuration of its parent, or the configuration the push
   itself introduces (a push that changes a type and an artifact of that type together)?
2. Limits: maximum commits per push, maximum time, so a large import does not block the server.
3. Large imports and migrations by administrators: a way to push many commits in one checked batch, or
   a maintenance mode that checks the result instead of each commit?
4. Should rejected pushes be logged in the server, so administrators see attempts to change write-once records?
5. How does the client show the mode (closed or open) and, in open mode, the clone address and the
   user's SSH keys?
