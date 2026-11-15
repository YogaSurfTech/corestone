# Corestone rich-text editor: inner workings

Nov 14, 2026 · @Claude Brother

## Scope

One editor component (`web/src/editor/`), built on Tiptap/ProseMirror in vanilla TypeScript, serves documents and rich-text fields. No HTML is ever stored, and the Go server validates everything.

- **Document view:** full toolbar, including paragraph styles (H1–H6, Preformatted, Code, Body) and the Corestone functions.
- **Entry view** (`richtext` fields): no paragraph-style dropdown, so no headings, and no Corestone functions.
- **Toolbar:** as in the demo page — split buttons that keep the last-used option, and disabled buttons that explain why. Target widths: 800 px in document view, 640 px in entry view.
- **Out of scope for now:** comments, which are inserted from outside the editor. The editor only keeps their inline anchor intact.

## Storage model

The existing JSON block tree stays the contract between client and server. Paragraph text changes from a plain string to a list of formatted runs, so free fonts, colours and sizes can be stored.

- **Blocks:** `section`, `paragraph`, `list`, `code`, `image`, `entry`, `toc`, plus the new `table`, `formula` and `diagram`.
- **Runs:** each run has `text` and optional `marks`; links and inline icons are their own run types.
- **Backward compatibility:** a plain `text` string is still accepted and read as one run without marks. Full-text extraction joins the runs.

```json
{"type":"paragraph","align":"left","content":[
  {"text":"Housing in "},
  {"text":"1.4404","marks":{"bold":true,"color":"#c62828","font":"Georgia","size":12}},
  {"type":"link","href":"https://…","content":[{"text":"datasheet"}]},
  {"type":"icon","name":"risk"}
]}
```

| Mark or run | Allowed values (enforced in Go) |
| --- | --- |
| bold, italic, underline, strike | true |
| sub, sup | true, never both on one run |
| color, bg | `#rrggbb` |
| font | Arial, Times New Roman, Courier New, Georgia (final list) |
| size | 6–96 |
| link.href | http, https, mailto |
| icon.name | a name from the icon registry |

**Inline icons** replace the idea of an icon font. They come from a fixed registry (the SVGs in `examples/icons/` plus a small general set), take the colour and size of the surrounding text, are inserted from Insert › Icon (a searchable grid), and appear in search and plain-text export as `:risk:`.

## Tables

Tables support merged cells, column widths, minimum row heights, header rows and alternating row colours. Nested tables are never allowed.

### Model

```json
{"type":"table",
 "style":{"header":"row","banded":true,"bandColor":"#f6f8fa","border":"grid","width":"full"},
 "cols":[{"w":120},{"w":240},{"w":80}],
 "rows":[
  {"h":null,"cells":[{"content":[…]},{"content":[…]},{"content":[…]}]},
  {"h":40,"cells":[{"content":[…],"colspan":2,"bg":"#fff3e0","valign":"middle"},{"content":[…]}]}
 ]}
```

- **Merged cells** are stored only at their top-left position, as in HTML. The validator checks that every row covers exactly the number of columns once spans are counted.
- **Cell content** is a list of paragraph and list blocks. No tables, images or diagrams inside cells in v1.
- **Sizes:** column widths in px, scaled proportionally when the table is narrower. Row heights are a minimum; `null` means automatic.
- **Per-cell settings:** `bg`, `valign` (top, middle, bottom), `align`, `colspan`, `rowspan`.

### Looks

- **Style presets:** plain grid; header row; header row + banded rows; header row + first column; minimal (horizontal rules only).
- **Banding** is worked out when the table is shown, never stored per row, so inserts keep the stripes right. A row with a rowspan cell sets the stripe for all the rows it covers.
- **Header:** `row`, `col`, `both` or `none`. Header cells are bold on a darker background, and the header row repeats when printing or exporting long tables.
- **A cell's own `bg`** overrides banding.
- **Borders:** `grid`, `rows` or `outer`, 1 px in the theme's border colour.

### Editing

- **Insert dialog:** a size grid up to 10×10 or typed numbers, a style preset, header row on or off.
- **Context bar** while the cursor is in a table: add a row above or below, or a column left or right; delete row, column or table; merge or split; cell background and vertical alignment; style preset. Disabled actions explain why, for example “Select at least two cells forming a rectangle.”
- **Resizing:** drag column borders; drag a row's bottom edge (a custom extension of about 150 lines); double-click a border to auto-fit.
- **Merge** works on a rectangular selection and joins contents in reading order. **Split** reverses it, leaving the content in the top-left cell.
- **Keyboard:** Tab moves to the next cell; Tab in the last cell adds a row.
- **Paste** from Excel or Word keeps spans and widths; colours only when they pass the whitelist.

## Formulas and diagrams

The source is the truth and the PNG is a rendering of it; both are stored as attachments of the entry. Formulas use LaTeX (KaTeX), diagrams use Mermaid.

```json
{"type":"formula","id":"eq-3f2a","display":"block","src":"att:<guid>/eq-3f2a.tex","png":"att:<guid>/eq-3f2a.png","alt":"E = mc^2"}
{"type":"diagram","id":"dia-91bc","lang":"mermaid","src":"att:<guid>/dia-91bc.mmd","png":"att:<guid>/dia-91bc.png","w":480}
```

- **Placement:** `display` is `block` or `inline`; inline is for formulas only.
- **File names:** `<id>.<ext>`, with the id fixed when the formula or diagram is created.
- **Search and accessibility:** `alt` holds the LaTeX source or the diagram's first line.
- **Attachment field required:** without one, the insert buttons are disabled with an explanation.

### Flow

1. **Open:** the toolbar button, or a double-click on an existing one, opens a dialog with the source on the left and a live preview on the right. KaTeX and Mermaid load only then.
2. **Save:** render to SVG, rasterise on a canvas to PNG at the configured scale, upload source and PNG to the attachment field, and insert or update the node.
3. **Edit later:** the dialog loads the source; saving overwrites both files under the same names. Corestone's versioning keeps the history.
4. **Delete:** removing the node deletes both attachments when the document is saved, unless undo brought it back first.
5. **Render scale:** application option `editor.renderScale`, default 2.

### Failure cases

- **Render error:** the preview shows the error line and Save is disabled.
- **Upload fails:** nothing is inserted; the dialog stays open with the source kept.
- **Missing PNG:** a placeholder with “Re-render” if the source still exists.

PNG keeps display, export and print free of client-side renderers and SVG sanitising, while the source stays editable and diffable.

## Images

Images need an attachment field; without one, the image button is disabled and the future picker is the only way to add existing attachments.

- **Paste or drop** of OS images and screenshots uploads to the attachment field, and the node references the attachment. A `data:` URL is never stored.
- **Images pasted from web pages or Word** are fetched and re-uploaded where possible, otherwise dropped with a notice.
- **Resizing** uses drag handles; the width is stored and the aspect ratio kept.
- **Removing** an image deletes its attachment when the document is saved, as for formulas and diagrams.

## Comments (placeholder)

Comments are created by the outside comment system as an inline node, `{"type":"commentRef","id":"<comment-id>"}`. The editor shows it as an icon, can't edit it, and keeps it intact through cut, paste, undo and redo. Everything else is specified later.

## Host integration

The editor knows nothing about Corestone: the app plugs in three hooks, and the Corestone functions are toolbar groups the app registers and places through the toolbar API below, in document view only. Entries can never be nested, so none of them appear in entry rich-text fields.

```ts
createEditor(el, {
  mode: "document" | "entry",
  blocks, attachmentField?,
  host: {
    pickEntry(): Promise<{guid: string} | null>,
    createEntry(fragment: Block[]): Promise<{guid: string} | null>,
    loadEntry(guid): Promise<{title: string, type: string, blocks: Block[]}>,
  },
  onChange(blocks), onEntryDetached?(guid),
})
```

### Toolbar API

Every toolbar group, built-in or from the app, is addressed by an id, and the toolbar is laid out from an ordered list of those ids. The app can register its own split-button groups and place them anywhere between the built-in ones.

```ts
editor.toolbar.register({
  id: "cs-entry",
  items: [
    { id: "insert",  icon: "entry-insert",  label: "Insert entry…",
      run: () => host.pickEntry(), state: s => s.inTable ? "Entries can't be placed inside tables." : true },
    { id: "convert", icon: "entry-convert", label: "Convert selection to entry…",
      run: …, state: s => s.hasSelection ? true : "Select text to convert." },
    { id: "unmark",  icon: "entry-unmark",  label: "Unmark entry",
      run: …, state: s => s.entrySelected ? true : "Select an entry card first." },
  ],
  modes: ["document"],
})

editor.toolbar.layout([
  "history", "|", "style", "cs-entry", "|", "format", "color", "bg", "font", "size", "|",
  "list", "align", "|", "insert", "cs-toc",
])
```

- **Built-in group ids:** `history` (undo, redo, clear formatting), `style`, `format`, `color`, `bg`, `font`, `size`, `list`, `align`, `insert`. `"|"` is a separator.
- **An item's `state`** returns `true` (enabled) or a string, which disables it and becomes the tooltip reason, the same as built-in buttons. It is re-evaluated on every selection change.
- **Split behaviour** is the same for every group: the main button repeats the last-used item, ▾ shows the rest in one row.
- **`modes`** hides a group in views where it doesn't apply, so the Corestone groups disappear in entry view.
- **Icons** are registered by name with an SVG string, so app groups match the built-in style.
- **Proposed Corestone layout:** `cs-entry` (insert, convert, unmark) in the middle, right after the paragraph style; `cs-toc` (table of contents, list of figures, list of tables) at the far right, as it is used about once per document.
- **Width:** each app group adds about 45 px, so document view comes to about 845 px with both. Either raise the limit to 860 px or merge `cs-toc` into the Insert group's dropdown.

### Table of contents, figures and tables

- The existing `toc` block gains a kind: `{"type":"toc","kind":"sections"|"figures"|"tables","depth":3}`.
- The list is generated each time it is shown, never stored.
- Images, diagrams, formulas and tables get an optional `caption` with automatic numbering (“Figure 3”, “Table 2”); only captioned items appear in the lists.

### Insert existing entry at cursor

- `host.pickEntry()` opens the app's picker; the editor inserts an `entry` block at the cursor, splitting the paragraph if needed.
- The entry shows as a read-only card with its current content and type icon; double-click opens it.
- Disabled inside table cells, with the reason “Entries can't be placed inside tables.”

### Convert selection to a new entry

- The selection is widened to whole blocks; selections inside a table are refused with a reason.
- `host.createEntry(fragment)` receives the selected blocks; the app asks for type and title (first line suggested) and creates the entry.
- On success the selection is replaced by the entry's card; if the app cancels, nothing changes.
- Attachments used by images, formulas and diagrams in the selection are copied to the new entry.
- Undo restores the text, but the entry stays in the repository; the app decides whether to delete it.

### Unmark entry back to text

- Available when an entry card is selected.
- `host.loadEntry(guid)` returns the entry's current blocks, which replace the card as plain document text.
- The entry is not deleted; `onEntryDetached(guid)` lets the app warn or offer deletion if nothing else references it.

## Toolbar behaviour

The demo page is the reference for look and feel; this section records what it settled.

### Groups, left to right

| Group | Contents | Shown in |
| --- | --- | --- |
| History | Undo, redo, clear formatting (T with eraser) | Both views |
| Structure | Paragraph style, Corestone entry group | Document view |
| Text formatting | Format split (B I U S, sub, sup), font colour, background colour, then after a 10 px gap font and size | Both views |
| Layout | Lists and indent, alignment | Both views |
| Insert | Insert split (link, image, table, diagram, formula, icon, comment), Corestone lists group | Both views; lists group document only |

Separators sit only between these groups. Target widths: 860 px in document view, 640 px in entry view.

### Buttons and tooltips

- **Split buttons** have a 1 px box around both parts and a divider before the 12 px ▾. The main button repeats the last-used option, remembered per user.
- **Colour buttons** apply the last-used colour on a click; ▾ opens the menu.
- **Tooltips** show the name and shortcut, or “Unavailable” plus the reason. They appear after 0.5 s on hover or focus; moving to another button hides the tooltip at once and starts a new 0.5 s wait.
- **Tooltip style:** 50% transparent dark background, 1.5 px backdrop blur, white text with a faint shadow.
- **Disabled state** uses `aria-disabled`, not `disabled`, so tooltips still work.

### Colours

- **Menu layout:** row 1 holds the 8 palette colours and the custom colour picker. Row 2 holds the colour history: up to 8 colours picked with the picker, added on the right, oldest dropped on the left, shared by font and background colour. A bin button under the picker clears the history.
- **No scheme generator.** It would add colours without meaning and weaken consistency.
- **Palette API:** the embedding app sets the palette, for example from company design guidelines or a user setting. When no palette is given, the default 8 are used.

```ts
editor.setPalette({
  colors: ["#1f2328", "#c62828", "#e65100", "#f9a825", "#2e7d32", "#1565c0", "#6a1b9a", "#ffffff"],
  names?: ["Text", "Alert", …],   // shown in tooltips
  allowCustom: true,                  // false hides the picker and history: only palette colours
})
```

- **`allowCustom: false`** enforces the guideline. The server can enforce it too: an application option `editor.colors.strict` makes the validator accept only palette colours.
- **Changing the palette later** doesn't change existing text, because colours are stored as hex values.

## Decisions and open questions

| Topic | Decision |
| --- | --- |
| Fonts | Final: Arial, Times New Roman, Courier New, Georgia |
| Icons | Inline icon runs from a registry, no icon font |
| Old formula, diagram and image files | Overwritten on edit, deleted when unused; Corestone versions them |
| PNG resolution | 2× by default, set through `editor.renderScale` |
| Nested tables | Never |
| Nested entries | Never; Corestone functions are document-only |

- [ ] Can documents hold images, formulas and diagrams without an attachment field, for example through a document-level store?
- [ ] Should Convert to entry and Unmark each be a single undo step?
