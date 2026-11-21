# Structure of the web client

The client is built in layers. A module imports only from the layers below
it. `npm run check:layers` enforces this in CI; the rule itself is the table
at the top of `scripts/check-layers.mjs`.

| Layer | Where | Contains | May import |
|---|---|---|---|
| 1 | `packages/ui/src/lib/` | Helpers without a user interface of their own: `el`, `button`, `prefs`, `errorText`, `drag`, formatting, `LightElement` | Lit |
| 2 | `packages/ui/src/` | Controls built on layer 1: `Overlay` and `dialogHead`, menus (`buildMenu`, `popupMenu`), `Resizer` and `splitter` | Lit, layer 1 |
| 3 | `packages/editor/src/` | The rich-text and document editor | `@corestone/ui`, ProseMirror, MathJax |
| 3 | `src/components/` | The application's components, which show Corestone's data: table, field editor, enum control, folder field, type icon, query field, kind menu, and the helpers for artifacts (`util.ts`) | `@corestone/ui`, `@corestone/editor`, Lit, the types of `src/types.ts` |
| 4 | `src/` | The application: server access (`api.ts`, `ws.ts`), state (`store.ts`, `router.ts`), the views, and the shell that puts them together (`app.ts`, `main.ts`) | Everything above |

## Rules

- Only `src/api.ts` calls `fetch`, and only `src/ws.ts` opens a WebSocket.
- Only `prefs` (`packages/ui/src/lib/prefs.ts`) touches `localStorage` and
  `sessionStorage`. Keys of stored preferences do not change.
- Layers 1 to 3 know nothing about the server, the store or the router. What
  they need from the application is handed in (a callback, a property).
- A component in `src/components/` does not import `api`, `store`, `router` or
  a view. Its data is a property, what it wants done is an event; the view
  around it talks to the server.
- A view (every file directly in `src/` that is not listed as base or shell
  in `check-layers.mjs`) is imported by `app.ts` or `main.ts` only. What two
  views share moves to a file of its own (`files.ts`, `types.ts`) or becomes
  a component.
- Layers 1 and 2 know nothing about Corestone's data (artifacts, fields,
  schemas) and nothing about ProseMirror.

## Before writing new code

- Look in `@corestone/ui` first. If a helper or control exists there, use it;
  do not write another copy in the file at hand.
- If something is needed a second time, move it down to the lowest layer that
  can hold it, and replace the first copy in the same change.
- Show a failure with `errorText(e)`, or `toastError(e)` in the application.
- Components of the application extend `LightElement`.
- A new file states its layer by where it is: a control that shows data goes
  to `src/components/`, a page or dialog directly to `src/`.

## The allowlist

`scripts/layer-allowlist.txt` lists the violations that existed when a rule
of the check was introduced. It only shrinks: fix the code, then remove the line
(`node scripts/check-layers.mjs --prune`). A new violation is not added to
the list; the code is changed instead.
