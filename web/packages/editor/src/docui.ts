import { Fragment } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { openMenu, type MenuItem } from "./menu";
import { schema } from "./schema";
import { fileNames, toStorage } from "./model";
import { entryToText, placeEntries, placedEntries, replaceWithEntry, selectedText, type DocumentHost } from "./structure";
import { Overlay } from "@corestone/ui";

// The document's panels for placed entries: placing, converting, and the menu of a placed entry.

export class DocumentUI {
  private readonly menu: HTMLElement;
  private readonly overlay: Overlay;

  constructor(private readonly view: () => EditorView, root: HTMLElement, private readonly host: () => DocumentHost | undefined,
    private readonly notice: (msg: string) => void) {
    this.overlay = new Overlay({ root, onEscape: () => this.view().focus() });
    this.menu = this.overlay.panel("ui-pop ui-menu cs-menu cs-placementmenu", "menu", "Entry");
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

  /** Makes a new entry of the selected text, held until the document is saved: with two blocks
   *  or more, the first paragraph is the title and the rest its text; a single block is the
   *  text, and its start the title (to the first word end after 40 characters). The entry
   *  takes the text's place. */
  async convert(type: string) {
    const h = this.host();
    if (!h?.convertToEntry) return;
    const sel = selectedText(this.view().state);
    if (typeof sel === "string") { this.notice(sel); return; }
    const [first, ...rest] = sel.nodes;
    const titled = sel.nodes.length > 1 && first.type === schema.nodes.paragraph && !!first.textContent.trim();
    const body = titled ? rest : sel.nodes;
    const text = body.length ? toStorage(schema.node("doc", null, body)) : "";
    const flat = (n: { textContent: string }) => n.textContent.replace(/\s+/g, " ").trim();
    const title = titled ? flat(first) : shortTitle(sel.nodes.map(flat).join(" "));
    const guid = await h.convertToEntry({ type, title, text, files: fileNames(text) });
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
    this.showMenu("Entry", items, at);
  }

  private showMenu(label: string, items: MenuItem[], at: { x: number; y: number }) {
    this.menu.setAttribute("aria-label", label);
    openMenu(this.overlay, this.menu, items, this.view, at, (v, it) => {
      if (it.cmd) it.cmd(v.state, v.dispatch);
      else it.run?.();
      v.focus();
    });
  }

  close() { this.overlay.close(); }

  destroy() { this.close(); }
}


/** The start of a text as a title: up to the end of the word that reaches 40 characters. */
export function shortTitle(text: string, min = 40): string {
  const t = text.trim();
  if (t.length <= min) return t;
  const end = t.slice(min).search(/\s/);
  return end < 0 ? t : t.slice(0, min + end);
}
