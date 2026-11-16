# Corestone documents: specification (draft)

Status: draft for TSK-7, for review. It replaces the current document format and view, which were
never specified. Inputs: design guide §2.3.2, §7.6, §7.7, §9.5; the rich-text editor
([inner workings](Corestone%20rich-text%20editor%20inner%20workings.md)); decisions of 2026-11-16.

## 1. What a document is

A document composes text and reusable entries into one readable whole: a specification, a manual,
a report. It is a **tree of sections**. Each section has a heading and holds content (text,
pictures, tables, entries) and further sections. The tree is the document's structure, not only
its looks:

- every entry in a document sits **under a heading**, and the server knows where;
- the entries under a heading can be **queried**, directly or with all sections below it;
- from an entry, the way **up to the top** of each document it is in is known.

Like entries, documents have a type, fields, workflows, links, comments and files (design guide
§2.3.2). The document view shows only the content; the rest is in sidebars (§7.6).

## 2. Stored format

The document's `content` is a list of nodes. The text nodes are the same paragraphs as rich-text
fields (formatting, lists, alignment, tables, links, images, formulas, diagrams; see the editor's
storage model). Documents add sections and entries:

```json
"content": [
  { "text": "An introduction before the first heading." },
  { "section": "k3v9q2xa", "title": "Scope", "children": [
      { "text": [ { "text": "The pump " }, { "text": "shall", "bold": true }, { "text": " …" } ] },
      { "entry": "6d3a9c4e-0dfe-47fe-9da7-b075c955adb5" },
      { "section": "p0m4z8re", "title": "Start-up", "children": [
          { "entry": "a261dff3-cc83-43c2-9ccf-8688f3162daf", "view": "card" },
          { "text": [ { "diagram": "diagram.drawio.png", "width": 480 } ] }
      ] }
  ] }
]
```

**Sections**

- `section` is the section's **id**: 8 characters `[a-z0-9]`, unique in the document, permanent.
  It survives renaming and moving; comments, deep links (`?section=<id>`) and queries use it.
  A new section gets a new id; a copied section gets a new id; a moved section keeps its id.
- `title` is plain text (one line, at most 500 characters). Headings carry no inline formatting,
  so the outline, the table of contents, queries and search read them as they are.
- `children` holds the section's content first, then its subsections. Content after a subsection
  would read as part of that subsection, so it is not allowed: the order is always
  *content, then sections*.
- The depth is the heading level: a top section is a heading 1, its subsections heading 2, and so
  on. Levels cannot be skipped. The depth is limited to 16 (as today); headings deeper than 6
  look like heading 6.
- Content before the first section is the document's introduction (no heading).

**Entries**

- `{ "entry": "<guid>", "view": "<view id>" }` places an entry; `view` is optional (section 4).
- An entry is placed **at most once per document**, so each placement has one path to the top.
  It can be in any number of documents. Variants of an entry are made with overlays, not with a
  second placement.
- Entries cannot be placed inside tables or lists.

**Files**

Pictures, formulas and diagrams are files of the document, exactly as in rich-text fields: an
edited picture replaces its file, an unused one is removed with Save, and the history keeps old
versions.

**Generated lists**

`{ "toc": "sections" | "figures" | "tables", "depth": 3 }` places a generated list (from the
editor notes). It stores only its settings; the list is built when the document is shown.

**Old format**

The current block format (`type: section | paragraph | entry | image | list | code | toc`) is
dropped. The server refuses it on write; the view says that a document in the old format must be
created again. The one existing document ("Open Tasks") is recreated by hand.

## 3. Editing

One editor holds the whole document. It is the rich-text editor of the entry fields, with the
document additions; the toolbar and context menus look and work the same.

- **Paragraph style** (Structure group): Normal, Heading. Making a paragraph a heading starts a
  new section at the current level; the content after it, up to the next heading of the same or a
  higher level, moves into the new section (as in Word).
- **Tab / Shift+Tab** in a heading moves the section one level down or up, with its content and
  subsections. A section cannot go deeper than one level below the section before it.
- **Backspace at the start of a heading** makes it a normal paragraph: its content joins the
  section before it, and its subsections move up with it. Its id is gone; what referred to it is
  handled as in open question 3.
- **Outline** (a sidebar panel): the tree of headings. A click scrolls to the section; dragging
  moves a section with everything in it.
- **Entries**: "Insert entry…" (Structure group, document view only) opens the picker; entries
  already in the document cannot be picked. A placed entry is read-only in the document; a double
  click opens it, its right-click menu offers Open, View ▸ (section 4) and Remove from document.
  Later: "Convert selection to entry" and "Unmark entry" (editor notes).
- **Save** stores the whole document as one commit, as today. Sidebars (properties, current entry,
  relationships, comments, versions) stay as they are.

## 4. How entries look: entry views

How an entry appears in a document is configured on the document type, in `types.json` of
`documents/`:

```json
{ "id": "spec", "displayName": "Specification",
  "entryViews": [
    { "id": "text", "name": "As text", "types": ["requirement"], "layout": "text",
      "fields": ["description"] },
    { "id": "card", "name": "Card", "types": ["entry/*"], "layout": "card",
      "fields": ["priority", "description"] },
    { "id": "title", "name": "Title only", "types": ["entry/*"], "layout": "title" }
  ] }
```

- **Layouts:**
  - `text`: flows as document text. The HID and title make one bold line, and the chosen fields
    follow as body text without labels.
  - `card`: a box with type icon, HID, title and workflow state, and the chosen fields with their
    labels.
  - `title`: one line, HID and title, like a link.
- `types` uses the same patterns as link types (`"requirement"`, `"entry/*"`, `"*"`).
- **Default:** for each placement, the first view whose `types` match the entry. A placement's
  `view` overrides it, chosen through View ▸ in the entry's menu. Without configured views, every
  entry uses a built-in `card` with all rich-text fields.
- Views only change how an entry is shown; its content is always the entry's own.

## 5. Queries

The server keeps the structure of every document in the database, as a projection rebuilt from
Git on reindex:

- **sections:** document, section id, parent id, position, title, depth;
- **placements:** document, entry, section id (none for the introduction), position.

API:

| Request | Answer |
| --- | --- |
| `GET /api/documents/{guid}/outline` | The section tree: ids, titles, entry counts |
| `GET /api/documents/{guid}/sections/{id}/entries?recursive=1` | The entries under a section, in document order; with `recursive`, also those in all its subsections |
| `GET /api/entries/{guid}/documents` | The documents an entry is in, each with its section path (the "Documents" of an entry, TSK-12) |

## 6. History

**The history of a document** is its own changes plus the changes of the entries in it **now**:

- the document's own commits (text, structure, placements) are listed, including the commit that
  removed an entry;
- for every entry in the document now, its commits are listed too, each marked with the entry
  and its section;
- an entry that was removed no longer counts: its later changes are not listed, only its removal
  (a document commit) stays. The history always starts from the current state.

**A version of a document** is shown as it was then: the document's content at that commit, and
every entry in it **as it looked at that moment**. Both come from the same commit, as Git holds the
whole repository in it. The same applies to comparing two versions.

## 7. Phases

1. Format, validation and the editor with sections, entries (built-in card) and files. The old
   format is dropped.
2. Structure in the database: outline, entries under a section, documents of an entry; the outline
   panel and deep links to sections.
3. History: the combined history and versions shown with their entries as they were.
4. Configured entry views, generated lists (contents, figures, tables).

Later: convert selection to entry and unmark, comments anchored to sections and text ranges
(design guide §7.7), export (ROADMAP 3.2), pinned versions of entries (TSK-33).

## 8. Open questions

1. **Entry history before it was added.** Does the combined history list an entry's changes from
   before it was placed in the document? Proposal: only from the commit that placed it. Older
   changes are in the entry's own history.
2. **Section titles with formatting.** Plain text proposed; is a formula or a code word in a
   heading needed?
3. **A removed heading.** Comments and deep links to a section whose heading was made a normal
   paragraph: they move to the section that took its content, or stay as orphans with a note?
4. **Entries in several documents of one tree.** Is an entry in several documents fine (proposed)
   or should one document "own" it?
5. **Sections as entries.** Not now; the section id keeps it open. Does a later "make this section
   an entry" fit?
