import { toggleMark } from "prosemirror-commands";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import type { MarkType, Node, NodeType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { schema, type Align, type Flag } from "./schema";

// Editing commands for the toolbar and keyboard, and the questions the
// toolbar asks about the selection (what is active, what is possible).

export const toggleFlag = (f: Flag): Command => toggleMark(schema.marks[f]);

/** Sets a valued mark (colour, background, font, size) on the selection; null removes it. */
export function setValue(type: MarkType, value: string | number | null): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { empty, ranges } = state.selection;
    const tr = state.tr;
    if (empty) {
      // nothing selected: the next typed text gets it
      const marks = type.removeFromSet(state.storedMarks ?? state.selection.$from.marks());
      tr.setStoredMarks(value === null ? marks : type.create({ value }).addToSet(marks));
    } else {
      for (const r of ranges) {
        tr.removeMark(r.$from.pos, r.$to.pos, type);
        if (value !== null) tr.addMark(r.$from.pos, r.$to.pos, type.create({ value }));
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Removes every character formatting from the selection. */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty && !state.storedMarks?.length && !state.selection.$from.marks().length) return false;
  if (dispatch) {
    const tr = state.tr;
    if (empty) tr.setStoredMarks([]);
    else for (const m of Object.values(schema.marks)) tr.removeMark(from, to, m);
    dispatch(tr);
  }
  return true;
};

/** Aligns every paragraph in the selection; "left" is the default and stores nothing. */
export function setAlign(a: Align): Command {
  return (state, dispatch) => {
    const tr = state.tr;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (n, pos) => {
      if (n.type === schema.nodes.paragraph) tr.setNodeMarkup(pos, undefined, { ...n.attrs, align: a === "left" ? null : a });
    });
    if (!tr.docChanged) return false;
    dispatch?.(tr);
    return true;
  };
}

/** The list the selection is in (innermost), with its position. */
function listAround(state: EditorState): { node: Node; pos: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === schema.nodes.bullet_list || n.type === schema.nodes.ordered_list) return { node: n, pos: $from.before(d) };
  }
  return null;
}

/** Makes the selection a list of that kind; again on the same kind lifts it out, on the other kind switches. */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const around = listAround(state);
    if (around?.node.type === type) return liftListItem(schema.nodes.list_item)(state, dispatch);
    if (around) {
      dispatch?.(state.tr.setNodeMarkup(around.pos, type));
      return true;
    }
    return wrapInList(type)(state, dispatch);
  };
}

/** Runs a command that splits a paragraph (Enter) so that the new paragraph keeps the alignment, as in Word. */
export function keepAlign(cmd: Command): Command {
  return (state, dispatch) => {
    const align = state.selection.$from.parent.attrs.align ?? null;
    return cmd(state, dispatch && ((tr) => {
      const $p = tr.selection.$from;
      const p = $p.parent;
      if (align && p.type === schema.nodes.paragraph && p.attrs.align !== align) {
        tr.setNodeMarkup($p.before(), undefined, { ...p.attrs, align });
      }
      dispatch(tr);
    }));
  };
}

// --- links ---

export interface LinkTarget { href?: string | null; ref?: string | null; file?: string | null }

/** The link at the selection's start: its target and the range of text it covers. */
export function linkAt(state: EditorState): (LinkTarget & { from: number; to: number }) | null {
  const type = schema.marks.link;
  const $pos = state.selection.$from;
  const parent = $pos.parent;
  // the text node at the cursor, or the one ending at it
  let idx = $pos.index();
  let start = $pos.pos - $pos.textOffset;
  let child = parent.maybeChild(idx);
  let mark = child && type.isInSet(child.marks);
  if (!mark && $pos.textOffset === 0 && idx > 0) {
    idx--;
    child = parent.child(idx);
    start -= child.nodeSize;
    mark = type.isInSet(child.marks);
  }
  if (!mark || !child) return null;
  let from = start, to = start + child.nodeSize;
  for (let i = idx - 1; i >= 0 && mark.isInSet(parent.child(i).marks); i--) from -= parent.child(i).nodeSize;
  for (let i = idx + 1; i < parent.childCount && mark.isInSet(parent.child(i).marks); i++) to += parent.child(i).nodeSize;
  return { href: mark.attrs.href, ref: mark.attrs.ref, file: mark.attrs.file, from, to };
}

/** Links the selection (or the link at the cursor) to a target; with nothing selected and no
 *  link at the cursor, inserts text (the address, or the item's name) as the link. */
export function setLink(target: LinkTarget, text?: string): Command {
  return (state, dispatch) => {
    const type = schema.marks.link;
    const mark = target.ref ? type.create({ ref: target.ref }) : target.file ? type.create({ file: target.file }) : type.create({ href: target.href ?? null });
    const { empty, from, to } = state.selection;
    const tr = state.tr;
    const at = empty ? linkAt(state) : null;
    if (!empty) tr.removeMark(from, to, type).addMark(from, to, mark);
    else if (at) tr.removeMark(at.from, at.to, type).addMark(at.from, at.to, mark);
    else {
      const t = text || target.href || "";
      if (!t) return false;
      const marks = mark.addToSet(state.storedMarks ?? state.selection.$from.marks());
      tr.insert(from, schema.text(t, marks));
      tr.removeStoredMark(type);
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** Removes the link from the selection, or the whole link at the cursor. */
export const removeLink: Command = (state, dispatch) => {
  const { empty, from, to } = state.selection;
  const at = empty ? linkAt(state) : null;
  const [a, b] = at ? [at.from, at.to] : [from, to];
  if (a === b || !state.doc.rangeHasMark(a, b, schema.marks.link)) return false;
  dispatch?.(state.tr.removeMark(a, b, schema.marks.link));
  return true;
};

export const indent: Command = sinkListItem(schema.nodes.list_item);
export const outdent: Command = liftListItem(schema.nodes.list_item);

// --- questions about the selection ---

/** Whether a flag is on for the whole selection, or for the text typed next. */
export function flagActive(state: EditorState, f: Flag): boolean {
  const type = schema.marks[f];
  const { from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? state.selection.$from.marks());
  return state.doc.rangeHasMark(from, to, type) && allHave(state, type);
}

function allHave(state: EditorState, type: MarkType): boolean {
  let all = true;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (n) => {
    if (n.isText && !type.isInSet(n.marks)) all = false;
  });
  return all;
}

/** The value of a valued mark at the selection's start (or for the text typed next); null when none. */
export function valueAt(state: EditorState, type: MarkType): string | number | null {
  let marks = state.selection.empty ? state.storedMarks ?? state.selection.$from.marks() : null;
  if (!marks) {
    // the first selected text decides
    state.doc.nodesBetween(state.selection.from, state.selection.to, (n) => {
      if (!marks && n.isText) marks = n.marks;
      return !marks;
    });
  }
  return (type.isInSet(marks ?? state.selection.$from.marks())?.attrs.value as string | number | undefined) ?? null;
}

/** The alignment of the paragraph the selection starts in. */
export function alignAt(state: EditorState): Align {
  const p = state.selection.$from.parent;
  return p.type === schema.nodes.paragraph ? (p.attrs.align ?? "left") : "left";
}

/** The kind of list the selection is in, if any. */
export function listAt(state: EditorState): "ul" | "ol" | null {
  const l = listAround(state);
  return !l ? null : l.node.type === schema.nodes.ordered_list ? "ol" : "ul";
}
