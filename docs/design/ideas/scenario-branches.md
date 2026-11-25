# Idea: scenarios with a layered index

Status: exploring, phase 1 scoped · Started: 2026-11-24 · Owner: Thom

## The idea

A scenario lets users try changes to the repository and see the result in the client, without the
changes becoming part of main. The scenario is a Git branch; its index is a thin layer on top of
main's index that holds only what the scenario changed. When a scenario is accepted, its actions are
redone on main, so main's history stays linear.

## Decisions for phase 1

1. **A scenario is a Git branch**, `refs/scenarios/<id>`, written by the server only, with the same
   plumbing, commit messages and compare-and-swap as main.
2. **Scenarios branch from main only.** No nested scenarios.
3. **Main moves; the scenario follows.** The scenario is rebased onto main continuously, so it always
   sits on top of the present.
4. **The index is layered.** The scenario's layer holds the artifacts the scenario created, changed or
   deleted (deletions as markers). Everything else is read from main's index, live.
5. **Accepting a scenario redoes its actions on main**, all of them, in their original order. No
   cherry-picking. Git history stays linear.
6. **GUIDs are kept.** Items created in the scenario keep their GUIDs when redone on main, so links
   between scenario items stay intact.
7. **Scenarios can be shared.** Several users can work in one scenario.
8. **Scenarios are kept as a list**: name, who started it, when, state (active, redone, dropped).
   Finished scenarios stay listed but cannot be opened or reviewed in phase 1.

## How the layered index works

- A query inside a scenario reads the scenario's layer first and falls back to main's index for every
  artifact the layer does not cover. An artifact the layer marks as deleted is hidden.
- Untouched artifacts always come from main's current index, so the scenario's base moves with main
  without rebuilding anything.
- Every query path needs the same rule: full-text and field searches must not return main's version of
  an artifact the scenario changed (a search for old text must not find an entry the scenario rewrote).
- Outside the scenario nothing changes: main's index and every other user see main only.
- Like everything in the projection, the layer is rebuildable from Git: it is the difference between
  the scenario branch and main.

The pattern matches overlays one level up: an overlay entry shows its own fields over a base entry,
a scenario shows its own artifacts over main.

## Following main

- Every commit on main is checked against the scenario's files (which files the commit touched).
  Untouched by the scenario: nothing to do beyond the rebase.
- **Conflicts** are detected with Git: a file changed both on main and in the scenario since the
  scenario's base is a conflict, whatever Git's line merge would say. JSON merged line by line can look
  clean and still produce a version nobody saved, so Git detects and Corestone resolves.
- Conflicts are resolved interactively inside the scenario, when they appear, field by field, with
  both versions shown.
- The rebase is a server operation under compare-and-swap. A user's save that lands first makes the
  rebase run again on top of it; a save that collides with a rebase gets the normal version conflict.
  Users never see a half-rebased scenario.
- The rebase rewrites the scenario branch. No record of earlier states is kept: what matters is how
  the scenario differs from main now, and a diff of main against the scenario always shows that.

## Redoing a scenario on main

1. Each scenario action is applied to main as a normal operation, with the same GUIDs, in the original
   order. Each gives a commit on main, checked by main's rules: validation, scripts, protected fields,
   permissions.
2. Main's index syncs from those commits as usual.
3. For every artifact now on main in the same state, the scenario's layer row is redundant and is
   removed. Because GUIDs match, the scenario view shows the same item, now from main.

Consequences:

- Data moves into main through Git first; the index follows. Layer rows are never moved into main's
  index directly, which keeps main's index rebuildable from main's Git.
- HIDs are assigned when items are created on main, so scenarios cannot cause duplicate HIDs.
- Approvals made in a scenario do not count on main; main's approval rules apply to redone changes.
- Because the scenario is continuously rebased, conflicts are settled before the redo; the redo
  normally runs through.
- Each redone commit can name its origin, e.g. `Corestone-Scenario: <id>@<commit>`.

## Open questions

1. What can a scenario contain: the whole repository, or a chosen subset (folder, document and its
   entries)? With a layer over main, the whole repository costs nothing until changed.
2. How is the scenario owner told about a conflict that appears while they work elsewhere?
3. A conflict found during the redo despite the rebase (main moved during the redo): stop and retry,
   or resolve interactively?
4. Do scripts and save hooks run inside the scenario, and do they run again on the redo?
5. Can items created in a scenario have a provisional HID for display, and how is it shown?
6. Which pins and references to scenario-only commits are allowed, given those commits never reach main?
7. Who may create, share, redo and drop scenarios (roles and permissions)?
8. Later phase: opening and reviewing finished scenarios; a base frozen at a point in time instead of
   following main.
