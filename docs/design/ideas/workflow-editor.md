# Idea: visual workflow editor

Status: exploring · Started: 2026-11-24 · Owner: Thom

## Problem

Workflows are state machines in `<scope>/.corestone/config/<kind>/workflows/<id>-workflow.json`.
Today they are written by hand as JSON, through the configuration API or a push. The client only
shows them: the "diagram" button of a workflow field lists the states as pills and the transitions
as text (`web/src/detail/workflows.ts`). With approvals, conditions, actions, protected fields per
view and permissions, a workflow grows past what people can follow in JSON. Process owners, who
are often not developers, need to see and change it as a picture.

## Goal

One editor in the client where a workflow is drawn as states and arrows, edited directly on the
canvas, with everything a state or transition carries in a side panel, checked while editing, and
saved as the same JSON the server reads today. The JSON stays the source of truth; the editor is a
view of it.

## What the editor shows

- **States** as boxes: name, colour from `presentation.color`, a marker on the initial state, a
  double border on final states, and small badges for what the state carries (lock: protected
  fields; seal: approval round; count: artifacts in this state now).
- **Transitions** as arrows: name on the arrow, badges for conditions (`?`), actions (gear) and
  permissions (person). A transition with several `from` states is drawn as one arrow per source,
  joined at the label. Two transitions between the same states are drawn as separate curves.
- **Side panel** for the selection:
  - workflow: name, initial state, the folder that defines it (`scope`), types and fields that use it;
  - state: id, name, colour, final, protected fields per view, approval block (approvers field,
    rule, outcome transitions, meaning, signature on or off);
  - transition: id, name, from, to, conditions and actions (script, field mapping, approval state of
    the script), roles allowed to make it.

## Editing

| Action | On the canvas | In the JSON |
| --- | --- | --- |
| Add a state | double-click on empty canvas | new entry in `states` |
| Add a transition | drag from a state's edge to another state | new entry in `transitions` |
| Reconnect | drag an arrow's end to another state | changes `from` or `to` |
| Rename | edit the label | changes `name`; the `id` stays |
| Set initial / final | context menu | `initial`, `final` |
| Attach a script | side panel, picker of scripts visible in the scope | `conditions` / `actions` |
| Move a box | drag | the picture only (below) |

**Ids are permanent once used.** An artifact stores the state id, so changing or deleting a state
that artifacts are in would orphan them. The editor shows how many artifacts are in each state
(from the projection) and:

- lets the id be changed only while no artifact uses it;
- refuses to delete a used state unless a target state is chosen; the save then also moves those
  artifacts, as one migration commit with its own message;
- treats a transition id the same way, because a workflow value stores the transition that led to
  its state.

## Checked while editing

Shown on the canvas (red outline, warning badge) and listed in a problems strip:

- a state no transition reaches (except the initial one);
- a state with no way out that is not marked final;
- a transition to or from an unknown state; duplicate ids;
- a script that does not exist in the scope, is not approved in its current version, or whose field
  mapping names a field the using types do not have;
- an approval block whose approvers field is not a `user` field, or whose outcome transitions do not
  leave the state;
- protected fields that do not exist on the using types.

The same checks run on the server when the configuration is saved; the editor only shows them earlier.

## Layout and picture

Positions are presentation, not behaviour. They are kept out of the workflow file, in a picture
next to it: `<id>-workflow.svg`, the workflow as the editor draws it, with the layout in the SVG's
`<metadata>` element.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 260">
  <metadata>
    <corestone-layout workflow-blob="9f2c4e1a…">
      { "states": { "draft": { "x": 40, "y": 120 }, "in_approval": { "x": 260, "y": 120 } },
        "transitions": { "rework": { "bend": 40 } } }
    </corestone-layout>
  </metadata>
  <!-- boxes and arrows -->
</svg>
```

- **One file, readable anywhere.** The picture opens in a browser, a file manager or GitHub without
  Corestone, and carries its own layout. Rich-text diagrams already work this way (draw.io PNG with
  the diagram inside).
- **SVG, not PNG:** text, so a moved box is a readable diff; sharp at any zoom; small. It follows the
  rules for icons: no scripts, no event handlers, no external references.
- **The server never reads it for behaviour.** Moving a box changes only the SVG, never the workflow
  file or anything that depends on it (for example a customer's approval of configuration changes).
- **Stale pictures are detected.** `workflow-blob` is the Git blob id of the workflow file the picture
  was drawn from. When the editor or the entry page loads the picture and the workflow file's blob
  id differs (the JSON was changed by a push or through the API), it keeps the saved positions of
  states that still exist, places new states automatically, drops removed ones, and marks the
  picture as outdated until the next save.
- **Without a picture**, or for states it does not list, the editor places states automatically: a
  simplified layered layout. Back edges (rework, reject) are set aside, states get columns from the
  initial state left to right, states in a column are ordered by the average position of their
  neighbours to reduce crossings, forward arrows are curves, back edges curve below. About 150 to
  250 lines; `@dagrejs/dagre` is the fallback if real workflows need more.

## Inheritance

Workflows resolve nearest folder first, like all configuration. The editor shows where the open
workflow is defined. Opened from a folder that inherits it, it offers to edit the definition where it
lives (with the folders affected listed), or to copy it into this folder as an override.

## Saving

- The editor works on a draft; nothing is written until Save.
- Save writes the workflow file and its picture in one commit, and shows the change as a diff of the JSON, plus what it does: "moves 3 artifacts from `review`
  to `in_approval`", "transition `waive` removed".
- One Save is one commit through the configuration API (`Configuration workflows/dev updated`),
  or two when a migration moves artifacts.
- A conflict (someone else saved the workflow meanwhile) shows the other version and does not
  overwrite it, as for artifacts.

## Try it

A **simulation mode** walks through the workflow without writing anything: pick a type, a role and
a starting state; the canvas highlights the transitions that role may make, shows which fields
become protected, and runs conditions as a dry run against a chosen artifact. This doubles as
evidence for validating a customer's workflow.

## The same picture elsewhere

The read-only form of the canvas replaces today's pill list in the detail view: the current state
highlighted, the transitions available to the user drawn as clickable arrows, and on request the
path the artifact took (from its history).

## Building it

- A component in `src/components/` (layer 3): it gets the workflow, the layout, the counts and the
  problems as properties and fires change events; the view around it talks to the server.
- Plain SVG drawn by Lit, with `ui/lib/drag.ts` for moving and connecting, `Overlay` for menus and
  `iconSet` for badges. No diagram library: draw.io stays for diagrams inside rich text, which are
  pictures, not configuration.
- Saving the picture is serializing the SVG on screen and adding the metadata; no export step.

## Open questions

1. Who may edit workflows: the maintainer role of the folder roles, or a separate permission?
2. Do workflow changes need an approval before they take effect, like scripts? The picture
   would stay outside it.
3. Moving artifacts out of a deleted state: always allowed, or only for states with no approval rounds?
4. Should the editor also edit views (protected fields per state) graphically, or link to a separate
   view editor?
5. Should one canvas show several workflows of a type side by side when a type has several workflow fields?
