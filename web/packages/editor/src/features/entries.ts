import { Fragment } from "prosemirror-model";
import { NodeSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { openMenu, type MenuItem } from "../core/menu";
import { schema } from "../core/schema";
import { fileNames, toStorage } from "../core/model";
import { PlacementView, canPlace, entryToText, placeEntries, placedEntries, replaceWithEntry, selectedText, type DocumentHost, type EntryTypeChoice } from "../core/structure";
import type { Feature, ToolbarKit } from "../core/feature";
import { icon } from "../core/icons";
import { Overlay, setTip, type Tip } from "@corestone/ui";

// The document's panels for placed entries: placing, converting, and the menu of a placed entry.

class DocumentUI {
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

/** The Entries group of the toolbar: Insert entries…, a convert button per entry type the host offers (its
 *  icon, its name on hover) and Turn into text. The main button repeats the last used (the
 *  last type, remembered per host name); a convert with a placed entry selected turns that
 *  entry into text instead. The type buttons follow the host's list (it may come later). */
function entriesGroup(kit: ToolbarKit, st: { entryTypes(): { remember: string; types: EntryTypeChoice[] }; convert(type: string): void; unmark(): void },
insert: { i: string; tip: Tip; run: () => void }) {
const S = () => kit.state();
  const onEntry = (s: EditorState) => s.selection instanceof NodeSelection && s.selection.node.type === schema.nodes.placement;
  const whyNot = () => { const r = selectedText(S()); return typeof r === "string" ? r : null; };
  type Item = { key: string; tip: Tip; run: () => void; icon: () => Node };
  const svg = (name: string) => () => { const t = document.createElement("template"); t.innerHTML = icon(name); return t.content; };
  const unmark: Item = { key: "unmark", icon: svg("unentry"), run: () => st.unmark(),
    tip: { text: "Turn the entry into text", disabled: () => (onEntry(S()) ? null : "Select a placed entry first.") } };
  const ins: Item = { key: "insert", icon: svg(insert.i), tip: insert.tip, run: insert.run };
  let offer = st.entryTypes();
  const convert = (t: EntryTypeChoice): Item => ({ key: "to:" + t.id, icon: t.icon, run: () => st.convert(t.id), tip: { text: `Convert selection to ${t.name}`, disabled: whyNot } });
  const lastType = () => offer.types.find((t) => t.id === kit.last("entrytype:" + offer.remember)) ?? offer.types[0];
  // the main button: insert, the last type's convert, or turn into text
  // (s absent: while the toolbar is built, before the editor has a state)
  const mainItem = (s?: EditorState): Item => {
    const used = kit.last("entries");
    // convert and turn into text are one action that follows the selection: a placed entry
    // selected turns into text, otherwise the selection converts (to the last type)
    if (used === "unmark" || used === "convert") return (s && onEntry(s)) || !lastType() ? unmark : convert(lastType()!);
    return ins;
  };
  const menu = document.createElement("div");
  menu.className = "pop";
  const main = kit.button("entry", ins.tip, () => shown.run());
  let shown = ins;
  const show = (it: Item) => {
    shown = it;
    main.replaceChildren(it.icon());
    main.dataset.cmd = it.key;
    main.setAttribute("aria-label", it.tip.text);
    setTip(main, it.tip);
  };
  const fill = () => {
    const items = [ins, ...offer.types.map(convert), unmark];
    menu.replaceChildren(...items.map((it) => {
      const b = kit.button(it.key, it.tip, () => {
        it.run();
        kit.remember("entries", it.key === "insert" ? "insert" : it.key === "unmark" ? "unmark" : "convert");
        if (it.key.startsWith("to:")) kit.remember("entrytype:" + offer.remember, it.key.slice(3));
        kit.closeMenus();
        kit.refresh();
      });
      b.replaceChildren(it.icon());
      return b;
    }));
  };
  fill();
  show(mainItem());
  kit.group(main, "Entries", menu);
  let known = JSON.stringify(offer.types.map((t) => t.id)) + offer.remember;
  kit.onUpdate((s) => {
    const next = st.entryTypes();
    const sig = JSON.stringify(next.types.map((t) => t.id)) + next.remember;
    if (sig !== known) { known = sig; offer = next; fill(); }
    const it = mainItem(s);
    if (it.key !== shown.key) show(it);
  });
}

/** Entries placed in a document: their view (the host shows them), placing and converting,
 *  the Entries group of the toolbar, and the menu of a placed entry. */
export const entriesFeature = (host: () => DocumentHost | undefined): Feature => (ctx) => {
  const ui = new DocumentUI(ctx.view, ctx.root, host, ctx.notice);
  return {
    id: "entries",
    nodeViews: { placement: (node, _view, _getPos, decorations) => new PlacementView(node, host, decorations) },
    nodes: { placement: { selector: ".cs-placement", openReadonly: true,
      menu: (hit) => ui.openMenu(hit.at!),
      // (only with the pointer: Enter on a selected entry is the text's)
      open: (hit) => { if (!hit.at) return false; host()?.openEntry(hit.node.attrs.guid, hit.newTab); } } },
    toolbarGroup(kit) {
      const insert = { i: "entry", tip: { text: "Insert entries…", disabled: () => (canPlace(kit.state()) ? null : "Place the cursor in the text first.") }, run: () => { void ui.insertEntry(); } };
      const h = host();
      // (converting is offered when the host can make entries and give their text)
      if (h?.convertToEntry && h.entryAsText && h.entryTypes) {
        entriesGroup(kit, { entryTypes: () => host()?.entryTypes?.() ?? { remember: "", types: [] },
          convert: (type) => { void ui.convert(type); }, unmark: () => { void ui.unmark(); } }, insert);
      } else kit.add(kit.button(insert.i, insert.tip, insert.run));
    },
    setReadonly: (on) => { if (on) ui.close(); },
    destroy: () => ui.destroy(),
  };
};
