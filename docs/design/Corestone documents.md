# Corestone documents: specification (draft)

Status: draft for TSK-7, revision 4. It replaces the current document format and view, which were
never specified. Inputs: design guide §2.3.1–§2.3.2, §7.6, §7.7, §9.5; the rich-text editor
([inner workings](Corestone%20rich-text%20editor%20inner%20workings.md)); decisions of
2026-11-16.

## 1. What a document is

A document composes text and entries into one readable whole: a specification, a manual, a
report. It is a **tree of sections**: each section has a heading and holds content (text,
pictures, tables, entries) and further sections. The tree is the document's structure, not only
its looks:

- every entry in a document sits **under a heading**, and the server knows where;
- the entries under a heading can be **queried**, directly or with all sections below it;
- from an entry, the way **up to the top** of each document it is in is known.

A document only **references** entries. No document owns an entry: an entry can be in any number
of documents, and none of them has a special role for it. Sections exist only inside documents;
they are not entries.

**Reuse is the norm.** Corestone's main idea is that entries are reused by reference, as often as
possible: a requirement written once serves every product that needs it, together with its links
to test cases, risks and other entries. Overlays and duplicates are exceptions, for the few
entries where a document really differs (section 6).

Like entries, documents have a type, fields, workflows, links, comments and files (design guide
§2.3.2). The document view shows only the content; the rest is in sidebars (§7.6).

## 2. Stored format

The document itself is the **root** of the tree. The root is not shown as a heading: its title is
the document's title, and its own content is the document's introduction. The document's `content`
holds the root's children. Text nodes are the same paragraphs as rich-text fields (formatting,
lists, alignment, tables, links, images, formulas, diagrams; see the editor's storage model).
Documents add sections and entries:

```json
"content": [
  { "text": "An introduction, the root's own content." },
  { "entry": "0b6f6a7e-5d55-4c38-9f0e-1f6f3c2f4b11" },
  { "section": "k3v9q2xa", "title": "Scope", "children": [
      { "text": [ { "text": "The pump " }, { "text": "shall", "bold": true }, { "text": " …" } ] },
      { "entry": "6d3a9c4e-0dfe-47fe-9da7-b075c955adb5" },
      { "section": "p0m4z8re", "title": "Start-up", "children": [
          { "entry": "a261dff3-cc83-43c2-9ccf-8688f3162daf", "view": "card" },
          { "entry": "9f3edfe4-f63d-47e3-a9c2-7c12d78f58ed", "pin": "3f1c9a0d…" },
          { "text": [ { "diagram": "diagram.drawio.png", "width": 480 } ] }
      ] }
  ] }
]
```

### Sections

- `section` is the section's **id**: 8 characters `[a-z0-9]`, unique in the document, permanent.
  It survives renaming, moving and renumbering. Comments, references, deep links
  (`?section=<id>`) and queries use it. A new section gets a new id; a copied section gets a new
  id; a moved section keeps its id.
- `title` is plain text (one line, at most 500 characters). Headings carry no formatting of their
  own; they are shown in Corestone's heading formatting (section 4).
- `children` holds the section's content first, then its subsections. The order is always
  *content, then sections*.
- The depth is the heading level: a top section is a heading 1, its subsections heading 2, and so
  on. Levels cannot be skipped. The depth is not limited to 6; a technical limit of 16 guards
  against runaway nesting.

### Entries

- `{ "entry": "<guid>" }` places an entry. Optional: `view` (section 5) and `pin` (section 7.3).
- An entry is placed **at most once per document**, so each placement has one path to the top.
  Variants of an entry are other entries (overlays, section 6), not a second placement.
- Entries cannot be placed inside tables or lists.

### Files

Pictures, formulas and diagrams are files of the document, exactly as in rich-text fields: an
edited picture replaces its file, an unused one is removed with Save, and the history keeps old
versions.

### Generated lists

`{ "toc": "sections" | "figures" | "tables", "depth": 3 }` places a generated list (from the
editor notes). It stores only its settings; the list is built when the document is shown.

### Old format

The current block format (`type: section | paragraph | entry | image | list | code | toc`) is
dropped. The server refuses it on write; the view says that a document in the old format must be
created again. The one existing document ("Open Tasks") is recreated by hand.

## 3. Numbering and references

### Numbers

- Sections are numbered by their position: 1, 1.2, 1.2.3.
- **Entries are numbered within their section**, after a dash: `1.2.3-2` is the second entry in
  section 1.2.3. Entries in the introduction are numbered `0-1`, `0-2`, …
- Text paragraphs are not numbered.
- Numbers are for reading only and change when something is inserted before them. The stable
  names are the HID of an entry and the ids. A document type can switch entry numbering off.

### References

- A reference in the text points to an **entry** (its GUID) or to a **section**
  (`<document guid>#<section id>`), never to a number.
- Its visible text is generated when the document is shown, for example "3.2 Start-up" or
  "REQ-12", so it stays right after renumbering or renaming (like a cross-reference in Word).
- References to sections of other documents work the same way.
- A reference whose target no longer exists (a removed section, a missing entry) stays in the
  text and is shown as **missing**, with the last known title or HID, or the id if none is known.
  The author fixes it; nothing breaks.

## 4. Editing

One editor holds the whole document. It is the rich-text editor of the entry fields, with the
document additions; the toolbar and context menus look and work the same.

### Structure

- **Paragraph style** (Structure group): Normal, Heading. Making a paragraph a heading starts a
  new section at the current level; the content after it, up to the next heading of the same or a
  higher level, moves into the new section (as in Word).
- **Tab / Shift+Tab** in a heading moves the section one level down or up, with its content and
  subsections. A section cannot go deeper than one level below the section before it.
- **Removing a heading** (Backspace at its start, or the style Normal) works as in Word:
  - its own content (text and entries) joins the end of the section before it, which is what
    the page shows anyway;
  - its subsections become children of its parent;
  - its id is gone. Comments anchored to the section move with its content.
- **Heading formatting** is built in for now: Arial, bold, in sizes that decrease with the level
  from 1 to 6, with the section number before the title. Deeper levels use the size of level 6
  and are underlined. A configurable format in the repository's configuration comes later,
  together with the other Corestone formatting.
- **Outline** (a sidebar panel): the tree of headings with their numbers. A click scrolls to the
  section; dragging moves a section with everything in it.

### Entries

- **Insert entry…** (Structure group) opens the picker; entries already in the document cannot be
  picked.
- **New entry here…** creates an entry and places it at the cursor in one step. It asks for the
  type first, then stores the entry in the nearest folder above the document whose configuration
  allows that type. A document type can name a different folder (`entryFolder`, section 5).
- A placed entry is read-only in the document; a double click opens it.
- **Shared entries are marked:** a small mark on an entry that other documents use too, with
  their names in its tooltip. Editing it changes all of them, so authors see what a change
  affects.
- Its right-click menu offers:
  - Open;
  - View ▸ (section 5);
  - Replace with overlay, Replace with duplicate (section 6), each as a deliberate decision for
    this one entry;
  - Pin to this version / Unpin (section 7.3);
  - Remove from document.
- **Remove from document** and moving an entry to another place are document changes. The entry
  itself stays in the repository.
- Later: "Convert selection to entry" and "Unmark entry" (editor notes).

### Saving and merging

- **Save** stores the document as one commit, as today.
- **Merging is per section:** a section's unit is its title plus its own content (text and
  placements, not its subsections). Two people editing different sections merge without a
  conflict. Moving or deleting a section that someone else changed is a conflict, shown in the
  conflict dialog as for entries.
- Sidebars (properties, current entry, relationships, comments, versions) stay as they are.

### Large documents

Entries are loaded lazily, when they come near the visible part of the document. The app keeps a
cache of entries and refreshes it from the change notices it already receives over the WebSocket.

## 5. Document type settings

Set on the document type, in `types.json` of `documents/`:

```json
{ "id": "spec", "displayName": "Specification",
  "entryFolder": "requirements",
  "entryNumbers": true,
  "entryViews": [
    { "id": "text", "name": "As text", "types": ["requirement"], "layout": "text",
      "fields": ["description"] },
    { "id": "card", "name": "Card", "types": ["entry/*"], "layout": "card",
      "fields": ["priority", "description"] },
    { "id": "title", "name": "Title only", "types": ["entry/*"], "layout": "title" }
  ] }
```

**`entryViews`: how entries look.**

- **Layouts:**
  - `text`: flows as document text. The number, HID and title make one bold line, and the chosen
    fields follow as body text without labels.
  - `card`: a box with type icon, number, HID, title and workflow state, and the chosen fields
    with their labels.
  - `title`: one line with number, HID and title, like a link.
- `types` uses the same patterns as link types (`"requirement"`, `"entry/*"`, `"*"`).
- **Default:** for each placement, the first view whose `types` match the entry. A placement's
  `view` overrides it, chosen through View ▸ in the entry's menu. Without configured views, every
  entry uses a built-in `card` with all rich-text fields.
- Views only change how an entry is shown. The content is always the entry's own, with overlays
  resolved.

**Other settings.**

- **`entryFolder`** (optional) is where "New entry here" and the bulk actions put new entries,
  relative to the document's folder. Without it, they go to the nearest folder above the document
  whose configuration allows the type.
- **`entryNumbers`** (default true) switches entry numbering on or off.

## 6. Reuse, overlays, duplicates and templates

### Reuse by reference

The normal way to build a new document is to **reference existing entries**. Their links to test
cases, risks and other entries stay valid and are reused with them. Copying entries for every new
document would bring reuse to zero and require all links to be made again, often to copies of
those entries too.

### Libraries and templates

A **template is a library**: one or more documents whose entries other documents reference.

- **Copy document** creates a new document with the same text and sections, placing the **same
  entries**. Nothing is copied but the document. The copy can create a link to the original, with
  a link type from the repository's configuration (for example "instantiated from").
- **Insert section from document…** places a section of another document (a library chapter)
  into the current document: its headings and text are copied, its entries are placed as
  references. Section ids are new; the entries are the same.

### Overlays

An overlay is an entry of its own whose `base` is another entry; it sets some fields and takes the
rest from its base (design guide §2.3.1.1). A document places an overlay like any entry, by its
GUID, and shows its effective content.

```
REQ-12   "The pump shall start within 2 s."   priority: high
└─ REQ-31  overlay of REQ-12, sets only: "… within 3 s."
```

"Global spec" places REQ-12, and "EU spec" places REQ-31. REQ-31 shows "3 s" and priority "high"
(from REQ-12). One document may place both: they are two entries.

**An overlay starts without links.** It inherits fields, but not links. It differs from its base,
so the base's links do not necessarily hold for it. For example: REQ-12 is used in four products
and verified by one test case in each. Showing all four test cases on REQ-31 would be wrong: it
may need only the third, or a new one. Inherited links would also be hard to remove. The overlay's
links are made for it, deliberately.

### Replacing a placed entry

Where a document really differs, one entry is replaced, with two operations in its right-click
menu:

- **Replace with overlay** creates a new entry whose base is the placed entry, with no fields of
  its own and no links. The placement now points to it. The document shows the same content at
  first, and can then change any field. Fields it does not change follow the original.
- **Replace with duplicate** creates a full copy without a base and without links. The placement
  now points to it; the copy has no connection to the original.

The original stays where it is, including in other documents. The document records the change
("REQ-12 replaced by its overlay REQ-31"). The new entry's history in this document starts there,
and the original's ends there, as with a removal. New entries go to the folder of section 5.

### Bulk actions

Bulk actions work on a **set of entries**:

- **Sets:**
  - a selection in the overview table;
  - in a document, a section with or without its subsections;
  - the root, which means all entries of the document.
- **Actions:**
  - set a field;
  - run a workflow transition;
  - move to a folder;
  - Replace all with overlays, Replace all with duplicates (from a document only).
- Each action shows a preview first ("creates 48 overlays in `projects/a/requirements`; they have
  no links") and is saved as **one commit**. This is ROADMAP 3.3 (bulk operations), on the batch
  endpoint (2.1).
- **Replacing in bulk is possible but not prominent.** It works against reuse. It sits at the end
  of the bulk actions menu, and its preview says how many entries and links are affected. It
  exists for the rare case where a whole copy must stand on its own.

## 7. Entries in documents: rules

### 7.1 Deleting

An entry placed in any document **cannot be deleted**. The server refuses it and names the
documents; in documents, entries are removed or moved out instead. The same holds for deleting a
folder that contains such entries.

**The delete dialog:**

- **Placed in documents:** the dialog is a notification without a Delete button. It says that
  the entry is used in documents and lists all of them, each with the section and number of the
  entry and a link to open it there. Once it is removed from all of them, it can be deleted.
- **Not placed anywhere:** the entry is deleted together with its links and comments (and their
  replies), in one commit, as today. The confirmation lists those links and comments, each with a
  link to open it, so they can be looked at before confirming.

Git is the source of truth, so an entry can still disappear through a direct Git change. The
document view is **forgiving**: it shows "missing entry" in its place with the entry's HID, taken
from the last version that had it, or its GUID if no HID can be found. The document still opens,
saves and exports; validation reports the missing entry.

An entry that was removed from all documents can be deleted. Older versions of a document still
show it as it was, from their commit.

### 7.2 History

**The history of a document** is its own changes plus the changes of the entries in it **now**:

- The document's own commits are listed: text, structure, placements, removals, replacements and
  pins.
- For every entry in the document now, its commits are listed too, each marked with the entry,
  its number and its section. They are **cropped at the placement**: changes from before the
  entry was placed are not listed (they are in the entry's own history).
- For an overlay, the commits of its bases count too, as they change what it shows, cropped in
  the same way.
- An entry that was removed no longer counts: its later changes are not listed, only its removal
  stays. An entry that is placed again starts again at its new placement.
- Moving an entry to another section is a document change; its history continues.
- The history always starts from the current state.

**A version of a document** is shown as it was then: the document at that commit, and every entry
in it **as it looked at that moment**, with overlays resolved at that commit. All of it comes from
the same commit, as Git holds the whole repository in it. Comparing two versions works the same
way.

### 7.3 Pinned entries

- A placement can be **pinned**: `"pin": "<commit>"`. The document then shows the entry's
  effective content at that commit, with overlays resolved at the same commit, and ignores later
  changes. This is the "pinned version" of TSK-33, for documents.
- The pin is a commit, not a version of the entry alone, so changes to an overlay's base do not
  reach a pinned overlay either.
- **History:**
  - pinned when placed: the history shows only "added";
  - pinned later: the history ends at the pin;
  - changing or removing a pin is a document change ("REQ-12 updated to the version of
    16 Nov 2026").

## 8. Queries

The server keeps the structure of every document in the database, as a projection rebuilt from
Git on reindex:

- **sections:** document, section id, parent id, position, number, title, depth;
- **placements:** document, entry, section id (the root for the introduction), position, number,
  pin.

API:

| Request | Answer |
| --- | --- |
| `GET /api/documents/{guid}/outline` | The section tree: ids, numbers, titles, entry counts |
| `GET /api/documents/{guid}/sections/{id}/entries?recursive=1` | The entries under a section, in document order; with `recursive`, also those in all its subsections. The root's id is the document's GUID |
| `GET /api/entries/{guid}/documents` | The documents an entry is in, each with its section path and number (the "Documents" of an entry, TSK-12) |

**In the overview:** a filter "in document D, under section S, with subsections" combines with
the other filters (type, status, fields). The table can show the entry's number and section as
columns.

## 9. Phases

1. **Format and editor:**
   - the format with the root, sections and entries;
   - validation, including entries placed once per document;
   - the editor with headings, the outline, entries (built-in card) and files;
   - references to entries and sections;
   - numbering.

   The old format is dropped.
2. **Structure in the database:**
   - outline, entries under a section, and the documents of an entry;
   - deletion refused for placed entries;
   - the overview filter;
   - deep links to sections.
3. **Merging per section.**
4. **History:** the combined history, and versions shown with their entries as they were.
5. **Entries and reuse:**
   - configured entry views;
   - the mark on shared entries;
   - "New entry here" with the folder rule;
   - Replace with overlay and Replace with duplicate (per entry);
   - Copy document and Insert section from document;
   - generated lists.
6. **Bulk actions** (ROADMAP 3.3), including the replacing ones, and **pinned entries** (TSK-33).

Later: convert selection to entry and unmark, comments anchored to sections and text ranges
(design guide §7.7), export (ROADMAP 3.2).

## 10. Open questions

None at the moment. Corestone's configurable formatting (headings and the rest) is defined later,
outside this specification.
