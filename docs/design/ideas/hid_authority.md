# Idea: HID authority for multi-repository setups

Status: exploring · Started: 2026-11-22 · Owner: Thom

## Problem

The same data repository can be served by more than one Corestone server, for example a
local development server and a server on yogasurftech.net, kept in step with Git over SSH
(`corestone-sync.sh`). Each server numbers new items itself (`REQ-42`). If two servers
create items between two syncs, both can hand out the same HID. The server keeps running,
but `GET /api/repository/validate` reports `duplicate-hid`, and a HID no longer names one item.

The sync script avoids this today by refusing to sync when both sides have new commits.
That is safe but forces one-at-a-time work. The goal is a setup where several servers can
create items without HID collisions and without manual coordination.

## What makes this feasible

- References between artifacts use the GUID, never the HID
  (`docs/design/Corestone documents.md`: "never to a number"). Numbering an item later
  breaks no link inside Corestone.
- The HID is optional (`model.Artifact.HID`, `json:"hid,omitempty"`). An artifact without
  one is valid today, and the client already has a way to show an item without a HID.
- The server already replays direct pushes (`Foundation.Watch`, every `-watch` interval)
  and skips HIDs taken by a foreign push when it allocates a new one.

## Proposal

Exactly one server per data repository is the **HID authority**. Every other server
creates artifacts without a HID. When the authority replays commits that contain
artifacts without a HID whose type has HID generation, it numbers them in one commit
of its own. That commit reaches the other servers with the next sync.

- Setting: a server option outside the repository, e.g. `-hid-authority`
  (`CORESTONE_HID_AUTHORITY`), default `true` so a single server behaves as today.
- Commit: `HIDs assigned: REQ-43, REQ-44, TC-7`, trailer `Corestone-Op: hid-assign`,
  one commit per replay, never one per item.
- Non-authority servers refuse a HID given explicitly on create or update, so no HID
  enters the repository except through the authority.

## Open questions

1. **One authority, checked how?** A server option alone cannot stop two servers both
   believing they are the authority. Option: a file in the repository
   (`.corestone/hid-authority.json`) names the authority by a server id, and a server whose
   option disagrees with the file refuses to number. Cost: one more file to keep right.
2. **What the user sees before numbering.** A short GUID (`a3f9…`), or the prefix with a
   placeholder (`REQ-?`)? Same question for references to the item, tables, the
   overview and exported documents.
3. **Search and queries.** A query for `REQ-42` cannot find an item before it has its
   number. Is a search by short GUID enough as a fallback?
4. **Order of numbers.** By creation time (reads better, but needs the creation time of
   every item, which a later sync can still change) or by arrival at the authority
   (simple, final, may look out of order)?
5. **Documents that number entries.** Document entry numbering also uses HIDs
   (`docs/design/Corestone documents.md`: "names are the HID of an entry"). How does an
   unnumbered entry show in a document, and in an export taken before numbering?
6. **Imports and seeds.** `examples/seed.sh` and imports that set HIDs explicitly: are they
   allowed only on the authority?
7. **Moving the authority.** How is the authority handed to another server (server
   retired, laptop becomes the main machine) without a window with two or none?

## Alternative: per-server ranges or prefixes

Each server gets its own range (`REQ-A-12`, `REQ-B-7`, or blocks of numbers). Items get
their HID at once and no server waits for another. Costs: longer, less readable HIDs, a
range or prefix to configure per server, and HIDs that reveal which server created them.
Worth keeping as the answer if waiting for a number turns out to bother users.

## Not in scope

- Merging histories where both sides changed the same file (the sync script still stops).
- Syncing accounts (`accounts.json` stays per server).

## Next step

Answer the open questions, pick proposal or alternative, then write the decision record
(`docs/decisions/`) and a plan with numbered steps (`docs/plans/`).
