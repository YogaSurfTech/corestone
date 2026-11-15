import type { Node } from "prosemirror-model";
import { Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import {
  addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable,
  goToNextCell, isInTable, mergeCells, splitCell,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";

// Tables: inserting one (a size grid), the bar shown while the cursor is in
// a table (rows, columns, merging, header row), Tab between cells, and the
// cleanup of pasted tables (no tables in tables).

/** A new table, the first row as header row. */
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    if (isInTable(state)) return false; // no tables in tables
    if (dispatch) {
      const cell = (header: boolean) => (header ? schema.nodes.table_header : schema.nodes.table_cell).createAndFill()!;
      const table = schema.nodes.table.create(null,
        Array.from({ length: rows }, (_, r) => schema.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(r === 0)))));
      const tr = state.tr.replaceSelectionWith(table);
      // the cursor into the first cell
      let first = -1;
      tr.doc.descendants((n, pos) => {
        if (first < 0 && n === table) first = pos;
        return first < 0;
      });
      if (first >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(first + 3)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** The first row as header row, on or off, wherever the cursor is in the table (the stored
 *  "header" means the first row; other rows never hold header cells). */
export const toggleHeader: Command = (state, dispatch) => {
  const t = tableAt(state);
  if (!t) return false;
  const first = t.node.firstChild;
  if (!first) return false;
  if (dispatch) {
    const on = !isHeaderRow(t.node);
    const tr = state.tr;
    let pos = t.pos + 2; // into the table, into the first row
    first.forEach((cell) => {
      tr.setNodeMarkup(pos, on ? schema.nodes.table_header : schema.nodes.table_cell, cell.attrs);
      pos += cell.nodeSize;
    });
    dispatch(tr);
  }
  return true;
};

/** Whether the table's first row is a header row. */
export function isHeaderRow(table: Node): boolean {
  let all = !!table.firstChild?.childCount;
  table.firstChild?.forEach((c) => { if (c.type !== schema.nodes.table_header) all = false; });
  return all;
}

/** Tab: the next cell; in the last cell a new row. Lists in cells still indent first (see the keymap). */
export const nextCell: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (dispatch && view && addRowAfter(state, dispatch)) goToNextCell(1)(view.state, view.dispatch);
  return true;
};
export const prevCell: Command = (state, dispatch) => (isInTable(state) ? goToNextCell(-1)(state, dispatch) || true : false);

/** A table at the start or the end of the text gets an empty line before / after it, so the
 *  cursor can get there. These lines are not stored (see model.ts). */
export const tableEdges = new Plugin({
  appendTransaction: (trs, _old, state) => {
    if (!trs.some((t) => t.docChanged)) return null;
    const doc = state.doc;
    const tr = state.tr;
    if (doc.lastChild?.type === schema.nodes.table) tr.insert(doc.content.size, schema.nodes.paragraph.create());
    if (doc.firstChild?.type === schema.nodes.table) tr.insert(0, schema.nodes.paragraph.create());
    return tr.docChanged ? tr : null;
  },
});

/** Pasted HTML: a table inside a table cell becomes lines of text (one per row, cells separated by " | "). */
export function flattenNestedTables(html: string): string {
  if (!/<table/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let inner = [...doc.querySelectorAll("td table, th table")];
  while (inner.length) {
    // innermost first, so a table in a table in a table ends as text too
    const t = inner.find((x) => !x.querySelector("table")) ?? inner[0];
    const lines = [...t.querySelectorAll("tr")].map((tr) => {
      const p = doc.createElement("p");
      p.textContent = [...tr.children].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ");
      return p;
    });
    t.replaceWith(...lines);
    inner = [...doc.querySelectorAll("td table, th table")];
  }
  return doc.body.innerHTML;
}

interface Action { label: string; title: string; cmd: Command; cls?: string }

const ACTIONS: (Action | "|")[] = [
  { label: "+ Row above", title: "Insert a row above", cmd: addRowBefore },
  { label: "+ Row below", title: "Insert a row below", cmd: addRowAfter },
  { label: "+ Column left", title: "Insert a column to the left", cmd: addColumnBefore },
  { label: "+ Column right", title: "Insert a column to the right", cmd: addColumnAfter },
  "|",
  { label: "Merge", title: "Merge the selected cells (select them by dragging across)", cmd: mergeCells },
  { label: "Split", title: "Split the merged cell", cmd: splitCell },
  { label: "Header row", title: "The first row as header row, on or off", cmd: toggleHeader, cls: "hdr" },
  "|",
  { label: "− Row", title: "Delete the row", cmd: deleteRow, cls: "danger" },
  { label: "− Column", title: "Delete the column", cmd: deleteColumn, cls: "danger" },
  { label: "Delete table", title: "Delete the whole table", cmd: deleteTable, cls: "danger" },
];

export class TableUI {
  private readonly grid: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly buttons: { b: HTMLButtonElement; a: Action }[] = [];
  private outside?: (e: MouseEvent) => void;

  /** root: where the size grid opens; toolbar: the bar becomes its last row. */
  constructor(private readonly view: () => EditorView, private readonly root: HTMLElement, toolbar: HTMLElement) {
    // the size grid
    this.grid = el("div", "cs-tablegrid");
    this.grid.setAttribute("role", "dialog");
    this.grid.setAttribute("aria-label", "Insert table");
    const label = el("div", "size");
    const cells = el("div", "cells");
    const R = 8, C = 10;
    const mark = (r: number, c: number) => {
      cells.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", +b.dataset.r! <= r && +b.dataset.c! <= c));
      label.textContent = r && c ? `${c} × ${r}` : "Table size";
    };
    for (let r = 1; r <= R; r++) for (let c = 1; c <= C; c++) {
      const b = el("button", "") as HTMLButtonElement;
      b.type = "button";
      b.dataset.r = String(r);
      b.dataset.c = String(c);
      b.setAttribute("aria-label", `${c} columns, ${r} rows`);
      b.addEventListener("mouseenter", () => mark(r, c));
      b.addEventListener("focus", () => mark(r, c));
      b.addEventListener("click", (e) => {
        e.preventDefault();
        this.closeGrid();
        const v = this.view();
        insertTable(r, c)(v.state, v.dispatch);
        v.focus();
      });
      cells.append(b);
    }
    cells.addEventListener("mouseleave", () => mark(0, 0));
    mark(0, 0);
    this.grid.append(label, cells);
    this.grid.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); this.closeGrid(); this.view().focus(); } });

    // the table row of the toolbar, while the cursor is in a table
    this.bar = el("div", "cs-tablebar");
    this.bar.setAttribute("role", "group");
    this.bar.setAttribute("aria-label", "Table");
    this.bar.append(el("span", "what"));
    (this.bar.lastChild as HTMLElement).textContent = "Table";
    for (const a of ACTIONS) {
      if (a === "|") { this.bar.append(el("span", "sep")); continue; }
      const b = el("button", "lb " + (a.cls ?? "")) as HTMLButtonElement;
      b.type = "button";
      b.textContent = a.label;
      b.title = a.title;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const v = this.view();
        a.cmd(v.state, v.dispatch);
        v.focus();
      });
      this.buttons.push({ b, a });
      this.bar.append(b);
    }
    this.grid.hidden = this.bar.hidden = true;
    root.append(this.grid);
    toolbar.append(this.bar);
  }

  /** Opens the size grid at the cursor. */
  openGrid() {
    const view = this.view();
    this.grid.hidden = false;
    const r = this.root.getBoundingClientRect(), c = view.coordsAtPos(view.state.selection.from);
    this.grid.style.left = `${Math.max(0, Math.min(c.left - r.left, r.width - this.grid.offsetWidth))}px`;
    this.grid.style.top = `${c.bottom - r.top + 4}px`;
    (this.grid.querySelector("button") as HTMLElement).focus();
    this.outside = (e) => { if (!this.grid.contains(e.target as globalThis.Node)) this.closeGrid(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  closeGrid() {
    if (this.grid.hidden) return;
    this.grid.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
  }

  /** Shows the table row of the toolbar while the cursor is in a table, with what is possible there. */
  update(view: EditorView, readonly: boolean) {
    const table = !readonly ? tableAt(view.state) : null;
    this.bar.hidden = !table;
    if (!table) return;
    for (const { b, a } of this.buttons) {
      b.disabled = !a.cmd(view.state);
      if (a.cls === "hdr") b.setAttribute("aria-pressed", String(isHeaderRow(table.node)));
    }
  }

  destroy() { this.closeGrid(); }
}

/** The table the selection is in, with its position. */
export function tableAt(state: EditorState): { node: Node; pos: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.table) return { node: $from.node(d), pos: $from.before(d) };
  }
  return null;
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
