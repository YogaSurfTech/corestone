import type { Node } from "prosemirror-model";
import { NodeSelection, type Command, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { el, Overlay } from "@corestone/ui";
import type { Feature } from "../feature";
import { openMenu, type MenuItem } from "../menu";
import { schema } from "../schema";
import { canPlace, placeAt, revealSection, structureKey, type DocumentHost } from "../structure";

// What a document generates from its structure: tables of contents and
// cross-references to its sections and entries.

/** Inserts a table of contents (a list generated from the sections) at the cursor, where an
 *  entry would be placed. A document may have several, e.g. with different levels. */
export const insertToc: Command = (state, dispatch) => {
  const at = placeAt(state);
  if (!at) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(at.from, at.to, schema.node("toc", { kind: "sections" }));
    dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.from)).scrollIntoView());
  }
  return true;
};

/** Sets how many heading levels the table of contents at pos lists (null: all). */
export function setTocDepth(pos: number, depth: number | null): Command {
  return (state, dispatch) => {
    const n = state.doc.nodeAt(pos);
    if (n?.type !== schema.nodes.toc) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, null, { ...n.attrs, depth }));
    return true;
  };
}

/** Inserts a cross-reference at the cursor. */
export function insertXref(ref: string, label: string): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.node("xref", { ref, label })).scrollIntoView());
    return true;
  };
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
    if (!nums?.sections.length) {
      const none = document.createElement("div");
      none.className = "toc-none";
      none.textContent = "The document has no headings yet.";
      this.dom.append(none);
    }
    for (const s of nums?.sections ?? []) {
      if (s.depth > depth) continue;
      const row = document.createElement("div");
      row.className = "toc-row";
      row.style.paddingLeft = `${(s.depth - 1) * 16}px`;
      row.textContent = `${s.number} ${s.title}`;
      row.dataset.section = s.id;
      row.title = "Ctrl+click goes to the section";
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

/** The menu of a table of contents and the cross-reference picker. */
class Panels {
  private readonly menu: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly overlay: Overlay;

  constructor(private readonly view: () => EditorView, root: HTMLElement, private readonly host: () => DocumentHost | undefined) {
    this.overlay = new Overlay({ root, onEscape: () => this.view().focus() });
    this.menu = this.overlay.panel("ui-pop ui-menu cs-menu cs-placementmenu", "menu", "Table of contents");
    this.picker = this.overlay.panel("ui-pop cs-pop cs-xrefpop", "dialog", "Cross-reference");
  }

  /** The menu of the selected table of contents: its levels, and removing it. */
  openTocMenu(at: { x: number; y: number }) {
    const sel = this.view().state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== schema.nodes.toc) return;
    const pos = sel.from;
    const depth = (state: EditorState) => (state.doc.nodeAt(pos)?.attrs.depth as number | null | undefined) ?? null;
    const level = (d: number | null): MenuItem => ({ label: d === null ? "All levels" : d === 1 ? "1 level" : `${d} levels`,
      cmd: setTocDepth(pos, d), check: (state) => depth(state) === d });
    this.menu.setAttribute("aria-label", "Table of contents");
    openMenu(this.overlay, this.menu, [
      { label: "Levels", sub: [null, 1, 2, 3, 4, 5].map(level) },
      { label: "Remove", danger: true, cmd: (state, dispatch) => {
        const n = state.doc.nodeAt(pos);
        if (n?.type !== schema.nodes.toc) return false;
        dispatch?.(state.tr.delete(pos, pos + n.nodeSize).scrollIntoView());
        return true;
      } },
    ], this.view, at, (v, it) => {
      if (it.cmd) it.cmd(v.state, v.dispatch);
      else it.run?.();
      v.focus();
    });
  }

  /** The cross-reference picker: the sections and the entries of this document. */
  openXref(at?: { x: number; y: number }) {
    const view = this.view();
    const h = this.host();
    const nums = structureKey.getState(view.state);
    const own = h?.guid;
    const choices: { ref: string; text: string }[] = [];
    for (const s of nums?.sections ?? []) {
      if (!own) break; // a section is referenced through its document
      choices.push({ ref: `${own}#${s.id}`, text: `${s.number} ${s.title}`.trim() });
    }
    for (const [guid] of nums?.entries ?? []) choices.push({ ref: guid, text: xrefText(view.state, guid, "", h).text });
    const head = el("div", "head");
    head.textContent = "Cross-reference";
    const filter = el("input", "filter") as HTMLInputElement;
    filter.placeholder = "Filter sections and entries";
    filter.setAttribute("aria-label", "Filter");
    const list = el("div", "list");
    list.setAttribute("role", "listbox");
    const show = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = choices.filter((c) => !q || c.text.toLowerCase().includes(q));
      list.replaceChildren(...shown.map((c) => {
        const b = el("button", "row") as HTMLButtonElement;
        b.type = "button";
        b.setAttribute("role", "option");
        b.textContent = c.text;
        b.addEventListener("click", () => {
          this.close();
          const v = this.view();
          insertXref(c.ref, c.text)(v.state, v.dispatch);
          v.focus();
        });
        return b;
      }));
      if (!shown.length) {
        const none = el("div", "none");
        none.textContent = choices.length ? "Nothing matches." : "This document has no sections or entries yet.";
        list.append(none);
      }
    };
    filter.addEventListener("input", show);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); (list.querySelector("button") as HTMLElement | null)?.click(); }
      if (e.key === "ArrowDown") { e.preventDefault(); (list.querySelector("button") as HTMLElement | null)?.focus(); }
    });
    show();
    this.picker.replaceChildren(head, filter, list);
    const c = view.coordsAtPos(view.state.selection.head);
    this.overlay.open(this.picker, at ?? { x: c.left, y: c.bottom + 4 });
    filter.focus();
  }

  close() { this.overlay.close(); }
}

/** Tables of contents and cross-references: their views, their buttons, the picker and the
 *  menu, and going where a click on one leads. */
export const contentsFeature = (host: () => DocumentHost | undefined): Feature => (ctx) => {
  const ui = new Panels(ctx.view, ctx.root, host);
  return {
    id: "contents",
    nodeViews: { xref: (node, view) => new XrefView(node, view, host), toc: (node, view) => new TocView(node, view) },
    nodes: { toc: { selector: ".cs-toc", menu: (hit) => ui.openTocMenu(hit.at!) } },
    toolbar: [
      { group: "ins", id: "xref", tip: { text: "Cross-reference…" }, run: (at) => ui.openXref(at) },
      { group: "ins", id: "toc", tip: { text: "Table of contents", disabled: () => (canPlace(ctx.view().state) ? null : "Place the cursor in the text first.") }, run: () => ctx.run(insertToc) },
    ],
    // followed on a click when reading, and on Ctrl/⌘+click while editing
    click(view, e) {
      const follow = ctx.readonly() || e.ctrlKey || e.metaKey;
      // a cross-reference: to a section of this document, or through the host
      const x = (e.target as HTMLElement).closest(".cs-xref");
      if (x && view.dom.contains(x) && follow) {
        e.preventDefault();
        const ref = x.getAttribute("data-xref") ?? "";
        const [guid, sec] = ref.split("#");
        const h = host();
        if (sec && (!h?.guid || h.guid === guid) && revealSection(view, sec)) return true;
        if (!sec && h && structureKey.getState(view.state)?.entries.has(guid)) h.openEntry(guid, e.ctrlKey || e.metaKey);
        else ctx.items()?.open(ref, e.ctrlKey || e.metaKey);
        return true;
      }
      // a row of a table of contents goes to its section (like a cross-reference)
      const row = (e.target as HTMLElement).closest(".cs-toc .toc-row") as HTMLElement | null;
      if (row && view.dom.contains(row) && follow) {
        e.preventDefault();
        return revealSection(view, row.dataset.section ?? "");
      }
      return false;
    },
    setReadonly: (on) => { if (on) ui.close(); },
    destroy: () => ui.close(),
  };
};
