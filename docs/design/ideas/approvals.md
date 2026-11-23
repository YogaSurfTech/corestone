# Idea: approvals, role views and server-side scripts

Status: exploring · Started: 2026-11-23 · Owner: Thom

## Problem

Corestone is meant for regulated settings. Entries and documents must be approved by a
group of people, each approving or disapproving with an electronic signature, after which
a rule moves the status to approved or disapproved. Fields must be protected depending on
status and role, and a rework must invalidate earlier approvals. Today Corestone has
workflows (states, transitions, the author of each commit) and pinned versions, but no
signatures, no person-valued fields, no role-specific protection and no way for a project
to add its own logic.

## Phases

- **Phase 1: approvals.** Rounds, votes (approve or disapprove, disapproval with a comment),
  rules, the automatic transition, rework that voids the round, `user` fields, views with
  protected fields, and scripts with their extension points. A vote is a click by the signed-in user.
- **Phase 2: electronic signatures, optional.** Re-authentication at the vote (password,
  optionally MFA), the meaning statement, and the signature manifestation in the UI and exports.
  Switched on per approval configuration (`"signature": true`); without it, phase 1 behaviour stays.

Phase 1 prepares for phase 2 so that switching signatures on changes no data format and no
history shape: votes are already immutable records in `.corestone/signatures/`, already carry
`meaning` and an empty `authentication` part, and a vote that completes a round is already
published as two commits (decision 11).

## Decisions so far

1. **Product functions and customer scripts.** Corestone ships fixed, coded functions that
   are validated as product features. Customers write their own scripts, which they validate.
2. **Two script languages: Starlark and JavaScript.**
3. **Scripts live in the repository**, in `.corestone/config/` folders, and need an
   administrator's approval before they can run.
4. **Extension points:** a save hook, and on status transitions conditions (may refuse the
   transition) and actions (run after it).
5. **Field protection belongs to views.** A view is bound to roles and defines, per status,
   which fields are protected (read-only) for those roles.
6. **Scripts run under the account of the user who triggered them**, on the server and not
   through the API, so read-only fields and view limits do not apply to them.
7. **Approvals are driven by configurable scripts** using product functions.
8. **Votes and signatures are made only by their signer**, in the voting dialog; with signatures
   switched on (phase 2), with explicit authentication (password, optionally MFA). No script and no product function signs for anyone.
9. **Everything is recoverable from Git.** Scripts, their administrator approvals, rounds,
   signatures and provenance live in the repository and in commit messages; a reindex
   recreates the whole projection from them, nothing exists only in PostgreSQL.
10. **Repository access is a procedural control.** Direct pushes and the SSH sync stay possible
   for administrators; access is limited and described in the customer's procedures, as for a
   database administrator in any validated system.
11. **A vote is two commits, published together** (phase 1 already, so phase 2 changes nothing).
   The signer's commit adds the vote
   (author: the signer, committer: Corestone). If that signature completes the round, a second
   commit on top of it evaluates the rule and makes the transition to approved or disapproved
   (author: the signer, committer: the evaluating script, "in the name of" the signer), with
   `Corestone-Script: <id>@<blob id>` in its message. Both are published with one
   compare-and-swap of the branch: all or nothing. Only approvals use this; every other
   operation, including save hooks and transition actions, stays one commit with Corestone
   as committer.
12. **Every deviation is a recorded, reasoned amendment.** Proxies and unforeseen cases (an
   approver left, the wrong person was asked, a round is stuck) are handled by delegations and
   round amendments, never by editing records or forcing a decision. A round that cannot finish
   is cancelled and a new one started.
13. **The round is an append-only log** of write-once files; its current state is computed.
14. **The user field is not approval-aware.** While a round is open, the view renders the round
   component in the field's place; the field itself stays a plain picker.
15. **Who approves is a `user` field** (accounts and groups, single or multiple), a generic
   field type also used for assignee, owner and similar. No approval-specific field type.

## Data model

- **`user` field type.** Holds account GUIDs and group ids; `"multiple": true` for lists.
  Queries such as `reviewers:me`. Needs groups, which Corestone does not have yet.
- **Approval round:** a folder per round, `<scope>/.corestone/approvals/<round guid>/`, holding
  only write-once files:
  - `round.json`, written when the round opens: the artifact, the version approved (commit and
    the artifact file's Git blob id), the field the approvers came from (`"field": "reviewers"`),
    the approvers copied from it, the rule and the meaning text;
  - one event file per change, `<event guid>.json`, of these kinds: `amend` (add, remove or
    replace an approver; reason required), `cancel` (reason required), `void` (by rework; reason
    required) and `decided` (approved or disapproved, written by the evaluating script).
  The round's state (open, approved, disapproved, cancelled, voided) and its current approvers
  are computed from `round.json`, its events and its votes, in order of commit.
- **Vote (signature in phase 2):** `<scope>/.corestone/signatures/<guid>.json`, written once,
  never changed. Round, signer, decision, meaning, time, for a disapproval the id of its comment,
  for a vote by proxy `onBehalfOf` (the represented approver) and `delegation` (its id),
  and `authentication` (phase 2: method such as password or password+TOTP; empty in phase 1).
  The server refuses edits and deletions; validation reports any made by a push.
- **Signatures are voided, not deleted.** A rework voids the round with a reason; the
  signatures stay in the repository and in the audit trail.
- Not stored in the artifact itself: signing would change what is signed, and concurrent
  votes would write the same file.

## From scenario to files

| What happens | Files written (one commit unless noted) | What Corestone does |
| --- | --- | --- |
| Author submits | `round.json`; entry status to in_approval | Copies the `reviewers` field into the round, records the version, protects fields by view |
| Approver votes | a vote file in `signatures/` | Checks the voter is a current approver or their proxy; requires a comment on disapprove |
| A vote meets the rule | second commit: `decided` event, entry status to approved or disapproved; committer = the script | Runs the script at its approved blob; publishes both commits with one compare-and-swap |
| Approver replaced | `amend` event | Permission check; reason required |
| Overrule | `overrule` event; entry status | Permission check; reason required; the rule's own result stays visible |
| Rework | `void` event; entry status to draft | The round's votes stop counting and stay in the repository |

**How the state is read.** A round's current approvers are `round.json` plus its `amend` events, in
commit order. Its votes are the files in `signatures/` that name it. Its status is its last
`decided`, `void`, `cancel` or `overrule` event, otherwise open. A reindex reads exactly these files
and commits into PostgreSQL tables, so the approval panel and queries such as "waiting for my
approval" are fast, and the tables can always be rebuilt from Git.

## Proxies and exceptions

- **Delegation:** a record in the repository, `.corestone/config/delegations/<guid>.json`:
  represented account, proxy account, from and to dates, optionally limited to folders, types or
  meanings, and who created it. The proxy votes as themselves on behalf of the represented
  approver; in phase 2 with their own credentials, never the represented person's.
- **Amendments:** add, remove or replace an approver, or cancel the round, each with a required
  reason, by an approval manager (a role) or an administrator. Shown in the round's timeline.
- **Who may start, restart, amend or overrule a round is a permission** of the roles and
  permissions model, not part of the approval feature. An overrule is an event like an amendment
  (`kind: "overrule"`, outcome, required reason, by whom), so the round log shows it and the
  rule's own result stays visible beside it.
- **New extension point "round event"**, run after every vote and amendment, so customers can
  add their own handling (reminders, escalation after a deadline, automatic replacement of an
  inactive approver) without product changes. Amendments made by a script name the script as
  committer, like the evaluation (decision 11).

## Views and roles

A view names roles and, per status, the fields that are protected for them:

```json
{ "id": "author-view", "roles": ["editor"],
  "protected": { "in_approval": "*", "approved": "*", "draft": ["hid"] } }
```

Enforced by the server for every change made through the API and the client, and shown in
the client as read-only fields with a lock. Builds on the folder roles of the roadmap
(reader, editor, maintainer, admin).

## Scripts

- **Where:** `.corestone/config/scripts/<id>.star` or `<id>.js`, resolved lexically like the
  rest of the configuration.
- **Activation:** a script runs only in a version an administrator has approved. The approval
  is a record in the repository (`.corestone/config/scripts/approvals/<guid>.json`: script id,
  blob id, administrator, time) and names the script's Git blob id, so any change makes it
  inactive until approved again. Approval by the script's own author is the customer's
  procedural choice, not enforced.
- **Extension points:**

  | Point | When | May |
  | --- | --- | --- |
  | Save hook | before a save is published | change fields, refuse the save |
  | Transition condition | before a transition | refuse it, with a message |
  | Transition action | after a transition, same commit | change fields, call product functions |
  | Round event | after a vote or an amendment | amend the round (with reason), notify; never vote |

- **Product functions scripts can call** (validated with the product): open, evaluate and void an
  approval round; read signatures; set a status by transition; require a comment.
- **Workflow configuration names the scripts per transition:**

  ```json
  { "id": "submit", "from": "draft", "to": "in_approval",
    "conditions": ["tests-passed"], "actions": ["open-approval"] }
  ```

- **Results are stored, not recomputed.** A script's changes go into the commit of the
  operation that triggered it; rebuilding the projection never runs scripts again.
- **Provenance:** a commit made by a script names it in a trailer next to today's
  `Corestone-Op` and `Corestone-Guid`: `Corestone-Script: <id>@<blob id>`. The script blob is in
  the repository at the commit's parent, with its approval record, so a reindex can show from
  Git alone which approved script made a change. For approvals the script is also the commit's
  committer (decision 11).

## UI

- **Approval round component** (`corestone-approval-round`): while a round is open, the entry
  view renders it in place of the field the approvers came from, and the document view in an
  Approval sidebar. Version approved (opens the version view); approvers with decision, time and
  comment; votes by proxy as "Carol for Bob"; a timeline of amendments with reason and author;
  earlier rounds collapsed with how they ended.
- **Amend** (approval managers): add, remove or replace an approver, or cancel, each asking for
  a reason.
- **Voting dialog:** what is approved (HID, title, version, meaning) and for a disapproval a
  required comment. Phase 2 adds the password (and MFA) field; nothing is recorded until it is checked.
- **Rework:** a transition whose dialog asks for a reason and says how many signatures it voids.
- **Overview:** an Approval column and a saved query "Waiting for my approval".
- **Scripts:** a list in the configuration view with language, extension point, approval state
  and the approving administrator.

## Open questions

1. **Approval rule for scripts:** one administrator, or a configurable number?
2. **MFA (phase 2):** which second factor (TOTP, WebAuthn), and configured per server or per meaning
   of a signature?
3. **History view:** shows the signature and the evaluation as one operation ("Anna approved;
   round 2 approved by rule"), or as two lines?
4. **Script approval revoked:** does revoking an approval stop running rounds that use it?
5. **Delegations:** may a proxy who is also an approver vote twice? Does a delegation apply
   automatically, or must it be activated per round? May the represented person still vote, and
   whose vote counts?
6. **Permissions:** which roles may start, restart, amend and overrule rounds; may the author of
   the artifact amend its rounds, and may an approver amend their own round? Does replacing an approver
   keep a vote they already cast?
7. **Two languages.** Starlark is deterministic by design; JavaScript (e.g. goja) needs limits
   on time, memory and non-deterministic calls (`Date.now`, `Math.random`). Same API for both?
8. **Recursion.** A save hook that saves, or an action that transitions: do they trigger hooks
   again, and how deep?
9. **Failure.** A failing action after a transition: is the whole operation refused (proposal)
   or the transition kept and the failure reported?
10. **Direct Git pushes** bypass views and scripts. What validation reports after such a push
   (e.g. a signature file written outside the server) and how the client shows it.
11. **Rule options:** all, any, N of M, required members; decide at the first disapproval or
   when everyone has voted; may a vote be changed while the round is open?
12. **Documents:** does approving a document also approve, and pin, the entries placed in it?

## Prerequisites

- Real identities in commits (roadmap: "the identity reaches Git"); no `-auth none` on a
  regulated server.
- Phase 2 only: password re-check and an optional second factor at signing.
- Groups of accounts.
- Folder roles from the roadmap.

## Next step

Answer the open questions, then write decision records for the data model, views and
scripts, and a plan with numbered steps.
