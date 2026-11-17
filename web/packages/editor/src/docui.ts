import { Fragment } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { buildMenu, type MenuItem } from "./menu";
import { schema } from "./schema";
import { fileNames, toStorage } from "./model";
import { entryToText, insertXref, placeEntries, placedEntries, replaceWithEntry, selectedText, structureKey, xrefText, type DocumentHost } from "./structure";

// The document's own panels: the menu of a placed entry and the cross-reference picker.

export class DocumentUI {
  private readonly menu: HTMLElement;
  private readonly picker: HTMLElement;
  private outside?: (e: MouseEvent) => void;

  constructor(private readonly view: () => EditorView, private readonly root: HTMLElement, private readonly host: () => DocumentHost | undefined,
    private readonly notice: (msg: string) => void) {
    this.menu = el("div", "cs-menu cs-placementmenu");
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-label", "Entry");
    this.picker = el("div", "cs-xrefpop");
    this.picker.setAttribute("role", "dialog");
    this.picker.setAttribute("aria-label", "Cross-reference");
    for (const p of [this.menu, this.picker]) {
      p.hidden = true;
      p.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.view().focus();
      });
    }
    root.append(this.menu, this.picker);
  }

  /** Lets the host pick entries and places them at the cursor, in the order picked. */
  async insertEntry() {
    const h = this.host();
    if (!h) return;
    const guids = await h.pickEntries(placedEntries(this.view().state.doc));
    if (!guids.length) return;
    const v = this.view();
    if (!placeEntries(guids)(v.state, v.dispatch)) this.notice(guids.length === 1 ? "The entry is in this document already; an entry is placed once per document."
      : "These entries are in this document already; an entry is placed once per document.");
    v.focus();
  }

  /** Makes an entry of the selected text: its first line is the title, the rest its text (the
   *  host asks for the type and the rest). The entry takes the text's place. */
  async convert() {
    const h = this.host();
    if (!h?.convertToEntry) return;
    const sel = selectedText(this.view().state);
    if (typeof sel === "string") { this.notice(sel); return; }
    const [first, ...rest] = sel.nodes;
    const titled = first.type === schema.nodes.paragraph;
    const body = titled ? rest : sel.nodes;
    const text = body.length ? toStorage(schema.node("doc", null, body)) : "";
    const guid = await h.convertToEntry({ title: titled ? first.textContent.replace(/\s+/g, " ").trim() : "", text, files: fileNames(text) });
    if (!guid) return;
    const v = this.view();
    // the text is replaced where it is, if it is still there unchanged; otherwise the entry is placed at the cursor
    const same = sel.to <= v.state.doc.content.size && v.state.doc.slice(sel.from, sel.to).content.eq(Fragment.from(sel.nodes));
    if (same) replaceWithEntry(sel.from, sel.to, guid)(v.state, v.dispatch);
    else if (!placeEntries([guid])(v.state, v.dispatch)) this.notice("The entry is made, but the text changed meanwhile; insert it with Insert entries.");
    v.focus();
  }

  /** Puts a placed entry's text in its place (the entry stays in the repository). */
  async unmark(guid?: string) {
    const h = this.host();
    if (!h?.entryAsText) return;
    const sel = this.view().state.selection;
    guid ??= sel instanceof NodeSelection && sel.node.type === schema.nodes.placement ? sel.node.attrs.guid as string : undefined;
    if (!guid) { this.notice("Select a placed entry first."); return; }
    const r = await h.entryAsText(guid);
    if ("error" in r) { this.notice(r.error); return; }
    const v = this.view();
    if (!entryToText(guid, r.text)(v.state, v.dispatch)) this.notice("The entry is not in the document any more.");
    v.focus();
  }

  /** The menu of the selected placed entry. */
  openMenu(at: { x: number; y: number }) {
    const view = this.view();
    const sel = view.state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== schema.nodes.placement) return;
    const guid = sel.node.attrs.guid as string;
    const pos = sel.from;
    const items: MenuItem[] = [
      { label: "Open", run: () => this.host()?.openEntry(guid, false) },
      ...(this.host()?.entryAsText ? [{ label: "Turn into text", run: () => void this.unmark(guid) }] : []),
      { label: "Remove from document", danger: true, cmd: (state, dispatch) => {
        const n = state.doc.nodeAt(pos);
        if (n?.type !== schema.nodes.placement) return false;
        dispatch?.(state.tr.delete(pos, pos + n.nodeSize).scrollIntoView());
        return true;
      } },
    ];
    this.menu.replaceChildren(...buildMenu(items, view.state, (it) => {
      this.close();
      const v = this.view();
      if (it.cmd) it.cmd(v.state, v.dispatch);
      else it.run?.();
      v.focus();
    }));
    this.open(this.menu, at);
    (this.menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
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
    this.open(this.picker, at ?? { x: c.left, y: c.bottom + 4 });
    filter.focus();
  }

  private open(panel: HTMLElement, at: { x: number; y: number }) {
    this.close();
    panel.hidden = false;
    const r = this.root.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - panel.offsetWidth))}px`;
    panel.style.top = `${at.y - r.top}px`;
    this.outside = (e) => { if (!panel.contains(e.target as globalThis.Node)) this.close(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  close() {
    this.menu.hidden = this.picker.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
  }

  destroy() { this.close(); }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
