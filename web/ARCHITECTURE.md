# Structure of the web client

The client is built in layers. A module imports only from the layers below
it. `npm run check:layers` enforces this in CI; the rule itself is the table
at the top of `scripts/check-layers.mjs`.

| Layer | Where | Contains | May import |
|---|---|---|---|
| 1 | `packages/ui/src/lib/` | Helpers without a user interface of their own: `el`, `button`, `prefs`, `errorText`, `drag`, formatting, `LightElement` | Lit |
| 2 | `packages/ui/src/` | Controls built on layer 1: `Overlay` and `dialogHead`, menus (`buildMenu`, `popupMenu`), `Resizer` and `splitter` | Lit, layer 1 |
| 3 | `packages/editor/src/` | The rich-text and document editor | `@corestone/ui`, ProseMirror, MathJax |
| 4 | `src/` | The application: server access, store, router, views | Everything above |

## Rules

- Only `src/api.ts` calls `fetch`, and only `src/ws.ts` opens a WebSocket.
- Only `prefs` (`packages/ui/src/lib/prefs.ts`) touches `localStorage` and
  `sessionStorage`. Keys of stored preferences do not change.
- Layers 1 to 3 know nothing about the server, the store or the router. What
  they need from the application is handed in (a callback, a property).
- Layers 1 and 2 know nothing about Corestone's data (artifacts, fields,
  schemas) and nothing about ProseMirror.

## Before writing new code

- Look in `@corestone/ui` first. If a helper or control exists there, use it;
  do not write another copy in the file at hand.
- If something is needed a second time, move it down to the lowest layer that
  can hold it, and replace the first copy in the same change.
- Show a failure with `errorText(e)`, or `toastError(e)` in the application.
- Components of the application extend `LightElement`.

## The allowlist

`scripts/layer-allowlist.txt` lists the violations that existed when the
check was introduced. It only shrinks: fix the code, then remove the line
(`node scripts/check-layers.mjs --prune`). A new violation is not added to
the list; the code is changed instead.
