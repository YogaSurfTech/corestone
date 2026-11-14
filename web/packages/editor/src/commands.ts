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
