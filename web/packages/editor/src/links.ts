import type { EditorView } from "prosemirror-view";
import { linkAt, removeLink, setLink, type LinkTarget } from "./commands";
import type { EntryFiles } from "./files";
import { safeHref } from "./schema";

// Links: the popover that sets one (Ctrl+K or the toolbar), the bubble that
// shows the link at the cursor (open, edit, remove), and opening links.
// Item links point to things of the host application; the host supplies
// how to pick, name and open them (the editor knows nothing of them).

/** How the host application links to its items. Without it, only web links are offered. */
export interface ItemLinks {
  /** Lets the user choose an item; resolves with its id and a name for the link text, or null. */
  pick(): Promise<{ ref: string; label: string } | null>;
  /** The name of an item, shown in the link bubble. */
  label?(ref: string): Promise<string>;
  /** Opens an item; newTab when Ctrl/⌘ was held. */
  open(ref: string, newTab: boolean): void;
}

/** Opens a link: web addresses and files in a new tab, items through the host. */
export function openLink(t: LinkTarget, newTab: boolean, items: ItemLinks | undefined, files: EntryFiles | undefined) {
  if (t.ref) items?.open(t.ref, newTab);
  else if (t.file) { const u = files?.url(t.file); if (u) window.open(u, "_blank", "noopener"); }
  else if (t.href && safeHref(t.href)) window.open(safeHref(t.href)!, "_blank", "noopener,noreferrer");
}

const BAD_ADDRESS = "Enter a web address (https://…), a mail address (mailto:…) or ftp://…";

export class LinkUI {
  private readonly pop: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly msg: HTMLElement;
  private readonly pickBtn: HTMLButtonElement;
  private readonly fileBtn: HTMLButtonElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly bubble: HTMLElement;
  private outside?: (e: MouseEvent) => void;
  private shown = ""; // the link the bubble shows, to refresh it only on change

  constructor(
    private readonly view: () => EditorView,
    private readonly root: HTMLElement,
    private readonly items: () => ItemLinks | undefined,
    private readonly files: () => EntryFiles | undefined,
    /** Lets the user pick or add a file of the entry. */
    private readonly pickFile: (chosen: (name: string) => void) => void,
  ) {
    this.pop = el("div", "cs-linkpop");
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "Link");
    this.input = el("input", "addr") as HTMLInputElement;
    this.input.placeholder = "https://…";
    this.input.setAttribute("aria-label", "Address");
    const apply = button("Apply", "apply", () => this.apply());
    this.pickBtn = button("Item…", "pick", () => this.pick());
    this.pickBtn.title = "Link to an item";
    this.fileBtn = button("File…", "file", () => this.file());
    this.fileBtn.title = "Link to a file of this entry";
    this.removeBtn = button("Remove", "unlink", () => this.unlink());
    this.msg = el("div", "msg");
    const row = el("div", "row");
    row.append(this.input, apply, this.pickBtn, this.fileBtn, this.removeBtn);
    this.pop.append(row, this.msg);
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.apply(); }
      if (e.key === "Escape") { e.preventDefault(); this.close(true); }
    });
    this.input.addEventListener("input", () => { this.input.classList.remove("bad"); this.msg.textContent = ""; });

    this.bubble = el("div", "cs-linkbubble");
    // clicks in the bubble keep the cursor in the text
    this.bubble.addEventListener("mousedown", (e) => e.preventDefault());
    this.pop.hidden = this.bubble.hidden = true;
    root.append(this.pop, this.bubble);
  }

  get open() { return !this.pop.hidden; }

  /** Opens the popover for the selection, or for the link at the cursor. */
  edit() {
    const view = this.view();
    const at = linkAt(view.state);
    this.input.value = at?.href ?? "";
    this.input.classList.remove("bad");
    this.msg.textContent = at?.ref ? "Linked to an item. Enter an address to link to the web instead."
      : at?.file ? `Linked to the file ${at.file}. Enter an address to link to the web instead.` : "";
    this.pickBtn.hidden = !this.items();
    this.fileBtn.hidden = !this.files();
    this.removeBtn.hidden = !at && !view.state.doc.rangeHasMark(view.state.selection.from, view.state.selection.to, view.state.schema.marks.link);
    this.bubble.hidden = true;
    this.pop.hidden = false;
    this.place(this.pop, at?.from ?? view.state.selection.from);
    this.input.focus();
    this.input.select();
    this.outside = (e) => { if (!this.pop.contains(e.target as Node)) this.close(false); };
    document.addEventListener("mousedown", this.outside, true);
  }

  close(refocus: boolean) {
    if (this.pop.hidden) return;
    this.pop.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
    if (refocus) this.view().focus();
  }

  private apply() {
    const typed = this.input.value.trim();
    const href = safeHref(typed);
    if (!href) {
      this.input.classList.add("bad");
      this.msg.textContent = BAD_ADDRESS;
      return;
    }
    const view = this.view();
    setLink({ href }, typed)(view.state, view.dispatch);
    this.close(true);
  }

  private pick() {
    const items = this.items();
    if (!items) return;
    void items.pick().then((r) => {
      if (!r) return;
      const view = this.view();
      setLink({ ref: r.ref }, r.label)(view.state, view.dispatch);
      this.close(false); // a picker of the host may have closed it already
      view.focus();
    });
  }

  private file() {
    this.close(false);
    this.pickFile((name) => {
      const view = this.view();
      setLink({ file: name }, name)(view.state, view.dispatch);
      view.focus();
    });
  }

  private unlink() {
    const view = this.view();
    removeLink(view.state, view.dispatch);
    this.close(true);
  }

  /** Shows the bubble while the cursor is in a link (and the text has the focus). */
  update(view: EditorView, readonly: boolean) {
    const at = !readonly && this.pop.hidden && view.hasFocus() ? linkAt(view.state) : null;
    const sel = view.state.selection;
    if (!at || sel.from < at.from || sel.to > at.to) {
      this.bubble.hidden = true;
      this.shown = "";
      return;
    }
    const key = `${at.href ?? ""}|${at.ref ?? ""}|${at.file ?? ""}|${at.from}`;
    if (key !== this.shown) {
      this.shown = key;
      this.bubble.replaceChildren();
      const target = el("a", "tgt") as HTMLAnchorElement;
      if (at.ref) {
        target.textContent = "Item";
        target.title = at.ref;
        void this.items()?.label?.(at.ref).then((name) => { if (this.shown === key) target.textContent = name; }).catch(() => undefined);
      } else if (at.file) {
        target.textContent = at.file;
        target.title = "File: " + at.file;
      } else {
        target.textContent = at.href ?? "";
        target.title = at.href ?? "";
        target.href = at.href ?? "";
      }
      target.addEventListener("click", (e) => { e.preventDefault(); openLink(at, e.ctrlKey || e.metaKey, this.items(), this.files()); });
      this.bubble.append(target,
        button("Edit", "edit", () => this.edit()),
        button("Remove", "unlink", () => { removeLink(this.view().state, this.view().dispatch); }));
    }
    this.bubble.hidden = false;
    this.place(this.bubble, at.from);
  }

  hideBubble() { this.bubble.hidden = true; this.shown = ""; }

  /** Puts a panel under the text at pos, inside the editor. */
  private place(panel: HTMLElement, pos: number) {
    const view = this.view();
    const c = view.coordsAtPos(pos);
    const r = this.root.getBoundingClientRect();
    const left = Math.max(0, Math.min(c.left - r.left, r.width - panel.offsetWidth));
    panel.style.left = `${left}px`;
    panel.style.top = `${c.bottom - r.top + 4}px`;
  }

  destroy() { this.close(false); }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function button(text: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el("button", "lb " + cls) as HTMLButtonElement;
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", (e) => { e.preventDefault(); run(); });
  return b;
}
