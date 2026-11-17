import { Fragment, type Node, type ResolvedPos } from "prosemirror-model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { fromStorage, newSectionId, type RichText } from "./model";
import { schema } from "./schema";

// Documents (docs/design/Corestone documents.md): a tree of sections under the document's
// root, entries placed in it, numbers (1.2.3 for sections, 1.2.3-2 for entries, 0-n in the
// introduction) and the commands that change the structure the way a word processor does.

/** What the host application does for a document's editor. The editor knows nothing about
 *  entries: the host picks them, shows them and opens them. */
export interface DocumentHost {
  /** The document's own GUID: references to its sections are "<GUID>#<section id>". */
  guid?: string;
  /** Lets the user choose entries to place (in this order; none: cancelled); taken: the entries
   *  already in the document. */
  pickEntries(taken: string[]): Promise<string[]>;
  /** Makes an entry of text of the document (asking the user for its type and the rest):
   *  title, its first line; text, the rest; files, the document's files the text uses (to be
   *  copied to the entry). The entry's GUID, or null when cancelled. */
  convertToEntry?(c: { title: string; text: RichText; files: string[] }): Promise<string | null>;
  /** A placed entry's text, to put in its place (its files copied to the document, the names
   *  in the text changed to theirs), or why it cannot be had. */
  entryAsText?(guid: string): Promise<{ text: RichText } | { error: string }>;
  /** Shows a placed entry in el; called again when its number or settings change. */
  renderEntry(el: HTMLElement, p: Placed): void;
  /** Opens an entry. */
  openEntry(guid: string, newTab: boolean): void;
  /** A short name of an entry (its HID, or its title) for cross-references, if known. */
  entryLabel?(guid: string): string | undefined;
  /** Whether placed entries are numbered (default true). */
  entryNumbers?: boolean;
}

/** An entry placed in the document, as the host shows it. */
export interface Placed { guid: string; view: string | null; pin: string | null; number: string }

/** A section in the outline. */
export interface OutlineItem { id: string; title: string; number: string; depth: number; pos: number; entries: number }

interface Numbers {
  rev: number; // counts the host's refreshes: placed entries and references are shown again
  sections: OutlineItem[];
  byId: Map<string, OutlineItem>;
  entries: Map<string, { number: string; pos: number }>; // by GUID
}

/** The numbers of a document: sections 1.2.3 by position, entries within their section. */
export function numbering(doc: Node, entryNumbers = true): Numbers {
  const sections: OutlineItem[] = [];
  const byId = new Map<string, OutlineItem>();
  const entries = new Map<string, { number: string; pos: number }>();
  const walk = (parent: Node, start: number, prefix: string, depth: number) => {
    let n = 0, s = 0;
    const own = prefix || "0";
    const item: OutlineItem | undefined = byId.get(parent.attrs.id);
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type === schema.nodes.placement) {
        n++;
        entries.set(child.attrs.guid, { number: entryNumbers ? `${own}-${n}` : "", pos });
        if (item) item.entries++;
      } else if (child.type === schema.nodes.section) {
        s++;
        const number = prefix ? `${prefix}.${s}` : String(s);
        const it: OutlineItem = { id: child.attrs.id, title: child.firstChild?.textContent ?? "", number, depth: depth + 1, pos, entries: 0 };
        sections.push(it);
        byId.set(it.id, it);
        walk(child, pos + 1, number, depth + 1);
      }
    });
  };
  walk(doc, 0, "", 0);
  return { rev: 0, sections, byId, entries };
}

export const structureKey = new PluginKey<Numbers>("cs-structure");

/** Numbers, ids and the looks that depend on them. */
export function structurePlugin(host: () => DocumentHost | undefined): Plugin<Numbers> {
  return new Plugin<Numbers>({
    key: structureKey,
    state: {
      init: (_c, state) => numbering(state.doc, host()?.entryNumbers !== false),
      apply: (tr, old, _o, state) => {
        const rev = old.rev + (tr.getMeta("cs-refresh") ? 1 : 0);
        if (tr.docChanged || tr.getMeta("cs-refresh")) return { ...numbering(state.doc, host()?.entryNumbers !== false), rev };
        return old;
      },
    },
    // every section has an id of its own: new ones get one, copies get a new one
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.docChanged)) return null;
      const seen = new Set<string>();
      const tr = state.tr;
      state.doc.descendants((n, pos) => {
        if (n.type !== schema.nodes.section) return n.type === schema.nodes.docroot;
        let id = n.attrs.id as string;
        if (!/^[a-z0-9]{8}$/.test(id) || seen.has(id)) {
          id = newSectionId();
          tr.setNodeMarkup(pos, null, { ...n.attrs, id });
        }
        seen.add(id);
        return true;
      });
      return tr.docChanged ? tr.setMeta("addToHistory", false) : null;
    },
    props: {
      decorations: (state) => {
        const nums = structureKey.getState(state)!;
        const decos: Decoration[] = [];
        for (const s of nums.sections) {
          const title = state.doc.nodeAt(s.pos + 1);
          if (!title) continue;
          decos.push(Decoration.node(s.pos + 1, s.pos + 1 + title.nodeSize, {
            class: `cs-heading cs-h${Math.min(s.depth, 7)}`, "data-num": s.number, role: "heading", "aria-level": String(s.depth),
          }));
        }
        for (const [, e] of nums.entries) decos.push(Decoration.node(e.pos, e.pos + 1, { "data-num": e.number }, { number: e.number, rev: nums.rev }));
        // cross-references and generated lists are made again when the structure changes
        const sig = nums.rev + "@" + nums.sections.map((s) => `${s.id}:${s.number}:${s.title}`).join("|") + "#" + [...nums.entries].map(([g, e]) => g + e.number).join("|");
        state.doc.descendants((n, pos) => {
          if (n.type === schema.nodes.xref || n.type === schema.nodes.toc) decos.push(Decoration.node(pos, pos + n.nodeSize, {}, { sig }));
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

// --- where the cursor is ---

/** The depth of the list (root or section) the cursor's block belongs to, and that block's
 *  depth; null outside the document's structure. */
function blockAt($pos: ResolvedPos): { listDepth: number; blockDepth: number } | null {
  for (let d = $pos.depth; d >= 0; d--) {
    const t = $pos.node(d).type;
    if (t === schema.nodes.docroot || t === schema.nodes.section) return d < $pos.depth ? { listDepth: d, blockDepth: d + 1 } : null;
  }
  return null;
}

/** The section whose heading the cursor is in. */
function titleAt(state: EditorState): { section: Node; pos: number; depth: number } | null {
  const $f = state.selection.$from;
  if ($f.parent.type !== schema.nodes.section_title) return null;
  const depth = $f.depth - 1;
  return { section: $f.node(depth), pos: $f.before(depth), depth };
}

/** Whether the cursor is in a paragraph that can become a heading (directly in the root or a
 *  section, not in a list or a table). */
function headingCandidate(state: EditorState): { pos: number; node: Node; listDepth: number } | null {
  const $f = state.selection.$from;
  if ($f.parent.type !== schema.nodes.paragraph) return null;
  const at = blockAt($f);
  if (!at || at.blockDepth !== $f.depth) return null;
  return { pos: $f.before($f.depth), node: $f.parent, listDepth: at.listDepth };
}

/** The paragraph style at the cursor: "heading", "normal", or null (elsewhere). */
export function styleAt(state: EditorState): "heading" | "normal" | null {
  if (titleAt(state)) return "heading";
  return headingCandidate(state) ? "normal" : null;
}

// --- commands ---

/** Makes the paragraph at the cursor a heading at the level of the section it is in (level 1
 *  in the introduction), as in a word processor: everything after it in that section (text and
 *  subsections) now belongs to the new heading. Tab makes it a subsection. */
export const makeHeading: Command = (state, dispatch) => {
  const p = headingCandidate(state);
  if (!p) return !!titleAt(state);
  if (!dispatch) return true;
  const $f = state.selection.$from;
  const list = $f.node(p.listDepth);
  const index = $f.index(p.listDepth);
  const inRoot = list.type === schema.nodes.docroot;
  // in the introduction only the text up to the first section moves in; in a section all the rest
  let end = index + 1;
  if (inRoot) while (end < list.childCount && list.child(end).type !== schema.nodes.section) end++;
  else end = list.childCount;
  const moved: Node[] = [];
  for (let i = index + 1; i < end; i++) moved.push(list.child(i));
  const title = p.node.textContent.replace(/\s+/g, " ").slice(0, 500);
  const section = schema.node("section", { id: newSectionId() }, [schema.node("section_title", null, title ? schema.text(title) : undefined), ...moved]);
  const from = p.pos;
  const to = from + moved.reduce((s, n) => s + n.nodeSize, p.node.nodeSize);
  const offset = Math.min($f.parentOffset, title.length);
  const tr = state.tr;
  let at = from;
  if (inRoot) tr.replaceWith(from, to, section);
  else {
    // the section it was in keeps what came before; the new one follows it
    const parentEnd = $f.after(p.listDepth);
    tr.delete(from, to);
    at = tr.mapping.map(parentEnd);
    tr.insert(at, section);
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 2 + offset));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Makes the heading at the cursor a normal paragraph: its text and content join the end of the
 *  section before it, its subsections become children of its parent. */
export const makeNormal: Command = (state, dispatch) => {
  const t = titleAt(state);
  if (!t) return !!headingCandidate(state);
  if (!dispatch) return true;
  const $f = state.selection.$from;
  const parentDepth = t.depth - 1;
  const parent = $f.node(parentDepth);
  const index = $f.index(parentDepth);
  const title = t.section.firstChild!;
  const content: Node[] = [schema.node("paragraph", null, title.content.size ? schema.text(title.textContent) : undefined)];
  const subs: Node[] = [];
  t.section.forEach((c, _o, i) => {
    if (i === 0) return;
    (c.type === schema.nodes.section ? subs : content).push(c);
  });
  // where the content goes: the end of the last, deepest section before it; or the end of the
  // parent's content when it is the parent's first section
  let ins = t.pos;
  if (index > 0 && parent.child(index - 1).type === schema.nodes.section) {
    let pos = t.pos - parent.child(index - 1).nodeSize;
    let node = parent.child(index - 1);
    while (node.lastChild?.type === schema.nodes.section) {
      pos = pos + node.nodeSize - 1 - node.lastChild.nodeSize;
      node = node.lastChild;
    }
    ins = pos + node.nodeSize - 1;
  }
  const tr = state.tr.replaceWith(t.pos, t.pos + t.section.nodeSize, subs);
  tr.insert(ins, Fragment.from(content));
  tr.setSelection(TextSelection.create(tr.doc, ins + 1 + Math.min($f.parentOffset, title.textContent.length)));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Why the heading at the cursor cannot go one level deeper; null when it can. */
export function demoteBlocked(state: EditorState): string | null {
  const t = titleAt(state);
  if (!t) return "Only a heading has a level: put the cursor into one.";
  const $f = state.selection.$from;
  const index = $f.index(t.depth - 1);
  if (index === 0 || $f.node(t.depth - 1).child(index - 1).type !== schema.nodes.section) return "Needs a heading before it at its level to go under.";
  if (t.depth + 1 > 16) return "Headings go at most 16 levels deep.";
  return null;
}

/** Why the heading at the cursor cannot go one level up; null when it can. */
export function promoteBlocked(state: EditorState): string | null {
  const t = titleAt(state);
  if (!t) return "Only a heading has a level: put the cursor into one.";
  return state.selection.$from.node(t.depth - 1).type === schema.nodes.section ? null : "Already at the top level.";
}

/** Moves the section of the heading at the cursor one level deeper: it becomes the last
 *  subsection of the section before it. */
export const demoteSection: Command = (state, dispatch) => {
  const t = titleAt(state);
  if (!t) return false;
  const $f = state.selection.$from;
  const parent = $f.node(t.depth - 1);
  const index = $f.index(t.depth - 1);
  if (index === 0 || parent.child(index - 1).type !== schema.nodes.section) return true; // nothing to go under: no change
  if (t.depth + 1 > 16) return true;
  if (!dispatch) return true;
  const prev = parent.child(index - 1);
  const prevPos = t.pos - prev.nodeSize;
  const offset = $f.parentOffset;
  const tr = state.tr.delete(t.pos, t.pos + t.section.nodeSize);
  const at = prevPos + prev.nodeSize - 1;
  tr.insert(at, t.section);
  tr.setSelection(TextSelection.create(tr.doc, at + 2 + offset));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Moves the section of the heading at the cursor one level up: it follows its parent, and the
 *  sections after it in the parent become its subsections (so nothing moves on the page). */
export const promoteSection: Command = (state, dispatch) => {
  const t = titleAt(state);
  if (!t) return false;
  const $f = state.selection.$from;
  const parentDepth = t.depth - 1;
  if ($f.node(parentDepth).type !== schema.nodes.section) return true; // already at the top
  if (!dispatch) return true;
  const parent = $f.node(parentDepth);
  const parentPos = $f.before(parentDepth);
  const index = $f.index(parentDepth);
  const following: Node[] = [];
  for (let i = index + 1; i < parent.childCount; i++) following.push(parent.child(i));
  const moved = t.section.copy(t.section.content.append(Fragment.from(following)));
  const offset = $f.parentOffset;
  const tr = state.tr.delete(t.pos, parentPos + parent.nodeSize - 1);
  const at = tr.mapping.map(parentPos + parent.nodeSize);
  tr.insert(at, moved);
  tr.setSelection(TextSelection.create(tr.doc, at + 2 + offset));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Enter in a heading: the text after the cursor starts the section's content. */
export const splitHeading: Command = (state, dispatch) => {
  if (!isTitle(state.selection.$from.parent) || state.selection.$to.parent !== state.selection.$from.parent) return false;
  if (!dispatch) return true;
  const $f = state.selection.$from;
  const $t = state.selection.$to;
  const titleEnd = $f.end();
  const after = $t.parent === $f.parent ? $f.parent.textBetween($t.parentOffset, $f.parent.content.size) : "";
  // at the end, with an empty line already after it: just go there
  const next = state.doc.nodeAt($f.after());
  if (!after && $f.pos === $t.pos && next?.type === schema.nodes.paragraph && !next.content.size) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, $f.after() + 1)).scrollIntoView());
    return true;
  }
  const tr = state.tr.delete($f.pos, $t.parent === $f.parent ? titleEnd : $f.pos);
  const at = tr.mapping.map($f.after());
  tr.insert(at, schema.node("paragraph", null, after ? schema.text(after) : undefined));
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Backspace at the start of a heading makes it normal text; at the start of the first
 *  paragraph after a heading it goes to the heading's end (no text joins a heading). */
export const backspaceStructure: Command = (state, dispatch, view) => {
  if (view && syncSelection(view)) return backspaceStructure(view.state, view.dispatch, view);
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  const $c = sel.$cursor;
  if (!$c || $c.parentOffset > 0 || (view && !view.endOfTextblock("backward"))) return false;
  if ($c.parent.type === schema.nodes.section_title) return makeNormal(state, dispatch);
  if ($c.parent.type === schema.nodes.doc_title) return true; // nothing before the title
  const at = blockAt($c);
  if (!at || at.blockDepth !== $c.depth) return false;
  const list = $c.node(at.listDepth);
  if (!list.firstChild || !isTitle(list.firstChild) || $c.index(at.listDepth) !== 1) return false;
  if (dispatch) {
    const titleEnd = $c.start(at.listDepth) + list.firstChild!.nodeSize - 1;
    const tr = state.tr;
    if ($c.parent.type === schema.nodes.paragraph && !$c.parent.content.size) tr.delete($c.before(), $c.after());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, titleEnd)).scrollIntoView());
  }
  return true;
};

/** A key command that first takes over the browser's cursor (see syncSelection). */
export function synced(cmd: Command): Command {
  return (state, dispatch, view) => (view && syncSelection(view) ? cmd(view.state, view.dispatch, view) : cmd(state, dispatch, view));
}

/** Takes over the browser's cursor when the editor has not seen it move yet (a key right after
 *  Home or a click): otherwise a key handled here would act at the old place and the browser
 *  would do its own thing at the new one. Returns whether the selection changed. */
function syncSelection(view: EditorView): boolean {
  const dom = view.dom.ownerDocument.getSelection();
  if (!dom?.focusNode || !dom.isCollapsed || !view.dom.contains(dom.focusNode)) return false;
  let pos: number;
  try { pos = view.posAtDOM(dom.focusNode, dom.focusOffset); } catch { return false; }
  const sel = view.state.selection;
  if (!sel.empty || sel.head === pos || pos < 0 || pos > view.state.doc.content.size) return false;
  const $p = view.state.doc.resolve(pos);
  if (!$p.parent.inlineContent) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return true;
}

/** Delete at the end of a heading does not pull the next paragraph into it. */
export const deleteStructure: Command = (state) => {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection) || !sel.$cursor) return false;
  const $c = sel.$cursor;
  return isTitle($c.parent) && $c.parentOffset === $c.parent.content.size;
};

/** The document's title or a section's heading: one line of plain text. */
function isTitle(n: Node): boolean { return n.type === schema.nodes.section_title || n.type === schema.nodes.doc_title; }

/** Tab in the document's title: no level to change, and the cursor stays. */
export const titleTab: Command = (state) => state.selection.$from.parent.type === schema.nodes.doc_title;

/** The entries placed in the document. */
export function placedEntries(doc: Node): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.type === schema.nodes.placement) out.push(n.attrs.guid);
    return n.type === schema.nodes.docroot || n.type === schema.nodes.section;
  });
  return out;
}

/** Where a placed entry goes for the cursor: after the block the cursor is in (a list or a
 *  table as a whole), at the start of a section's content from its heading; an empty paragraph
 *  is replaced. */
function placeAt(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type === schema.nodes.placement) return { from: sel.to, to: sel.to };
  const $f = sel.$from;
  const at = blockAt($f);
  if (!at) return null;
  const block = $f.node(at.blockDepth);
  if (isTitle(block)) {
    // at the start of the section's content, taking the place of an empty first paragraph
    const p = $f.after(at.blockDepth);
    const next = state.doc.nodeAt(p);
    if (next?.type === schema.nodes.paragraph && !next.content.size) return { from: p, to: p + next.nodeSize };
    return { from: p, to: p };
  }
  if (block.type === schema.nodes.paragraph && !block.content.size && at.blockDepth === $f.depth) return { from: $f.before(at.blockDepth), to: $f.after(at.blockDepth) };
  const p = $f.after(at.blockDepth);
  return { from: p, to: p };
}

/** Places entries at the cursor, in this order, as one step (undone together); entries already
 *  in the document are left out. False when none can be placed. */
export function placeEntries(guids: string[]): Command {
  return (state, dispatch) => {
    const placed = new Set(placedEntries(state.doc));
    const fresh = guids.filter((g) => !placed.has(g) && (placed.add(g), true));
    if (!fresh.length) return false;
    const at = placeAt(state);
    if (!at) return false;
    if (dispatch) {
      const nodes = fresh.map((guid) => schema.node("placement", { guid }));
      const tr = state.tr.replaceWith(at.from, at.to, nodes);
      const last = at.from + nodes.slice(0, -1).reduce((n, x) => n + x.nodeSize, 0);
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, last)).scrollIntoView());
    }
    return true;
  };
}

/** The text the selection covers, as whole blocks of one section's text (or the introduction),
 *  for "Convert to entry"; or why it cannot be converted. */
export function selectedText(state: EditorState): { from: number; to: number; nodes: Node[] } | string {
  const sel = state.selection;
  if (sel instanceof NodeSelection || sel.empty) return "Select the text that becomes the entry.";
  const { $from, $to } = sel;
  const a = blockAt($from), b = blockAt($to);
  if (!a || !b || a.blockDepth !== b.blockDepth || $from.before(a.blockDepth) > $to.before(b.blockDepth)
    || (a.listDepth > 0 && $from.before(a.listDepth) !== $to.before(b.listDepth)))
    return "Select text within one section: the selection goes across a heading.";
  const d = a.listDepth;
  const parent = $from.node(d);
  let i = $from.index(d), j = $to.index(d);
  // a selection that ends at the very start of a block leaves that block out
  if (j > i && !state.doc.textBetween($to.before(b.blockDepth), $to.pos).length) j--;
  const nodes: Node[] = [];
  for (let k = i; k <= j; k++) {
    const n = parent.child(k);
    if (isTitle(n)) return "Headings stay in the document: select only text.";
    if (!n.type.isInGroup("block")) return "Select only text: a placed entry or a list of contents is in the selection.";
    nodes.push(n);
  }
  return { from: $from.posAtIndex(i, d), to: $from.posAtIndex(j + 1, d), nodes };
}

/** Puts an entry in place of from…to (the converted text), selected. */
export function replaceWithEntry(from: number, to: number, guid: string): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const tr = state.tr.replaceWith(from, to, schema.node("placement", { guid }));
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, from)).scrollIntoView());
    }
    return true;
  };
}

/** Puts text in place of a placed entry (its card becomes ordinary text of the document). */
export function entryToText(guid: string, text: RichText): Command {
  return (state, dispatch) => {
    let at = -1;
    state.doc.descendants((n, pos) => {
      if (at < 0 && n.type === schema.nodes.placement && n.attrs.guid === guid) at = pos;
      return at < 0 && (n.type === schema.nodes.docroot || n.type === schema.nodes.section);
    });
    if (at < 0) return false;
    if (dispatch) {
      const content = fromStorage(text).content;
      const tr = state.tr.replaceWith(at, at + 1, content);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + content.size), -1)).scrollIntoView());
    }
    return true;
  };
}

/** Whether an entry can be placed at the cursor. */
export const canPlace: Command = (state) => !!placeAt(state);

/** Inserts a cross-reference at the cursor. */
export function insertXref(ref: string, label: string): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.node("xref", { ref, label })).scrollIntoView());
    return true;
  };
}

/** Moves a section (with everything in it) into a parent (null: the root), before that parent's
 *  index-th section (at the end when there are fewer). */
export function moveSection(id: string, parentId: string | null, index: number): Command {
  return (state, dispatch) => {
    const find = (doc: Node, sid: string | null): { node: Node; pos: number } | null => {
      if (sid === null) return { node: doc, pos: -1 };
      let found: { node: Node; pos: number } | null = null;
      doc.descendants((n, pos) => {
        if (found) return false;
        if (n.type === schema.nodes.section && n.attrs.id === sid) { found = { node: n, pos }; return false; }
        return n.type === schema.nodes.docroot || n.type === schema.nodes.section;
      });
      return found;
    };
    const src = find(state.doc, id);
    const target = find(state.doc, parentId);
    if (!src || !target) return false;
    // not into itself or a section inside it
    if (target.pos >= src.pos && target.pos < src.pos + src.node.nodeSize) return false;
    if (!dispatch) return true;
    const tr = state.tr.delete(src.pos, src.pos + src.node.nodeSize);
    const t = find(tr.doc, parentId)!;
    let at = t.pos < 0 ? tr.doc.content.size : t.pos + t.node.nodeSize - 1; // the end of its content
    let k = 0;
    let p = t.pos + 1;
    for (let i = 0; i < t.node.childCount; i++) {
      const c = t.node.child(i);
      if (c.type === schema.nodes.section) {
        if (k === index) { at = p; break; }
        k++;
      }
      p += c.nodeSize;
    }
    tr.insert(at, src.node);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Puts the cursor into a section's heading and scrolls there. */
export function revealSection(view: EditorView, id: string): boolean {
  const it = structureKey.getState(view.state)?.byId.get(id);
  if (!it) return false;
  const title = view.state.doc.nodeAt(it.pos + 1);
  if (!title) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, it.pos + 2 + title.content.size)).scrollIntoView());
  view.focus();
  (view.nodeDOM(it.pos) as HTMLElement | null)?.scrollIntoView({ block: "start" });
  return true;
}

// --- views ---

/** A placed entry: shown by the host, with its number. */
export class PlacementView implements NodeView {
  readonly dom: HTMLElement;
  private shown = "";
  constructor(private node: Node, private readonly host: () => DocumentHost | undefined, decorations: readonly Decoration[]) {
    this.dom = document.createElement("div");
    this.dom.className = "cs-placement";
    this.dom.contentEditable = "false";
    this.dom.dataset.placement = node.attrs.guid;
    this.render(decorations);
  }
  private render(decorations: readonly Decoration[]) {
    const spec = decorations.find((d) => (d.spec as { number?: string }).number !== undefined)?.spec as { number?: string; rev?: number } | undefined;
    const p: Placed = { guid: this.node.attrs.guid, view: this.node.attrs.view, pin: this.node.attrs.pin, number: spec?.number ?? "" };
    const key = JSON.stringify(p) + (spec?.rev ?? 0);
    if (key === this.shown) return;
    this.shown = key;
    const h = this.host();
    if (h) h.renderEntry(this.dom, p);
    else this.dom.textContent = p.guid;
  }
  update(node: Node, decorations: readonly Decoration[]) {
    if (node.type !== this.node.type || node.attrs.guid !== this.node.attrs.guid) return false;
    this.node = node;
    this.render(decorations);
    return true;
  }
  stopEvent(e: Event) { return e.type === "mousedown" && !!(e.target as HTMLElement).closest("a, button"); }
  ignoreMutation() { return true; }
}

/** A cross-reference: its text made from the document (number and title) or the host. */
export class XrefView implements NodeView {
  readonly dom: HTMLElement;
  constructor(private node: Node, private readonly view: EditorView, private readonly host: () => DocumentHost | undefined) {
    this.dom = document.createElement("a");
    this.dom.className = "cs-xref";
    this.dom.dataset.xref = node.attrs.ref;
    this.render();
  }
  private render() {
    const { text, missing } = xrefText(this.view.state, this.node.attrs.ref, this.node.attrs.label, this.host());
    this.dom.textContent = text;
    this.dom.classList.toggle("missing", missing);
    this.dom.title = missing ? "Not found: removed or not shown here. Last known: " + (this.node.attrs.label || this.node.attrs.ref) : "";
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  ignoreMutation() { return true; }
}

/** The text of a cross-reference: "1.2 Start-up" for a section of this document, the number
 *  and name of a placed entry, the host's name of another item, else the last known text. */
export function xrefText(state: EditorState, ref: string, label: string, host: DocumentHost | undefined): { text: string; missing: boolean } {
  const nums = structureKey.getState(state);
  const [guid, sec] = ref.split("#");
  if (sec) {
    if (host?.guid && guid !== host.guid) return { text: label || ref, missing: false }; // another document's section
    const s = nums?.byId.get(sec);
    return s ? { text: `${s.number} ${s.title}`.trim(), missing: false } : { text: label || ref, missing: true };
  }
  const placed = nums?.entries.get(guid);
  const name = host?.entryLabel?.(guid);
  if (placed) return { text: [placed.number, name ?? label].filter(Boolean).join(" "), missing: false };
  return { text: name ?? (label || guid), missing: false };
}

/** A generated list of the sections (figures and tables come later). */
export class TocView implements NodeView {
  readonly dom: HTMLElement;
  constructor(private node: Node, private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cs-toc";
    this.dom.contentEditable = "false";
    this.render();
  }
  private render() {
    const nums = structureKey.getState(this.view.state);
    const depth = this.node.attrs.depth ?? 99;
    this.dom.replaceChildren();
    const head = document.createElement("div");
    head.className = "toc-head";
    head.textContent = this.node.attrs.kind === "sections" ? "Contents" : this.node.attrs.kind === "figures" ? "Figures" : "Tables";
    this.dom.append(head);
    if (this.node.attrs.kind !== "sections") return;
    for (const s of nums?.sections ?? []) {
      if (s.depth > depth) continue;
      const row = document.createElement("div");
      row.className = "toc-row";
      row.style.paddingLeft = `${(s.depth - 1) * 16}px`;
      row.textContent = `${s.number} ${s.title}`;
      row.dataset.section = s.id;
      this.dom.append(row);
    }
  }
  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  ignoreMutation() { return true; }
}

/** The section the cursor is in (its id), if any. */
export function sectionAt(state: EditorState): string | null {
  const $f = state.selection.$from;
  for (let d = $f.depth; d >= 0; d--) if ($f.node(d).type === schema.nodes.section) return $f.node(d).attrs.id;
  return null;
}

export type { Transaction };
