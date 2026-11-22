import { html, nothing } from "lit";
import { LightElement } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import type { SortLevel } from "../types";
import type { TableColumn } from "./table";
import { ordered, shown, type TableLayout, type TableViews } from "./views";
import { appIcon } from "../icons";

// The dialog of a table's columns and sorting: which columns are shown, in
// which order (dragged by their grip, or moved with Alt+↑/↓), up to three sort
// levels, and the saved views: OK applies (and keeps the chosen view), a new
// view is saved under a name, one view can be the one the table starts with.
// The ✕, Escape and a click beside it close it without a change.

const LEVELS = 3;

@customElement("corestone-columns-dialog")
export class ColumnsDialog extends LightElement {
  @property({ attribute: false }) views!: TableViews;
  @property({ attribute: false }) columns: TableColumn[] = [];

  /** The columns in their order, each shown or not. */
  @state() private cols: { id: string; name: string; on: boolean; sortable: boolean }[] = [];
  @state() private sort: SortLevel[] = [];
  /** The saved view the settings belong to ("": none). */
  @state() private view = "";
  @state() private newName = "";
  private base!: TableLayout;
  private dragged = -1;

  override connectedCallback() {
    super.connectedCallback();
    this.view = this.views.active;
    this.take(this.views.layout);
    // above the page's own Escape (closing the picker or the artifact)
    window.addEventListener("keydown", this.onKey, true);
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".cd-cols input")?.focus());
  }
  override disconnectedCallback() { window.removeEventListener("keydown", this.onKey, true); super.disconnectedCallback(); }

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.views.closeEditor();
  };

  /** Fills the dialog from a layout. */
  private take(l: TableLayout) {
    this.base = l;
    this.cols = ordered(this.columns, l).map((c) => ({ id: c.id, name: c.name || c.id, on: shown(c, l), sortable: c.sortable !== false }));
    this.sort = l.sort.filter((s) => this.columns.some((c) => c.id === s.col)).slice(0, LEVELS);
  }

  /** The layout as set here; the widths stay those of the layout it started from. */
  private layout(): TableLayout {
    const visible: Record<string, boolean> = { ...this.base.visible };
    for (const c of this.cols) visible[c.id] = c.on;
    return { widths: { ...this.base.widths }, sort: this.sort.filter((s) => s.col), order: this.cols.map((c) => c.id), visible };
  }

  private move(from: number, to: number) {
    if (to < 0 || to >= this.cols.length || from === to) return;
    const cols = [...this.cols];
    const [c] = cols.splice(from, 1);
    cols.splice(to, 0, c);
    this.cols = cols;
  }

  private toggle(i: number, on: boolean) {
    this.cols = this.cols.map((c, j) => (j === i ? { ...c, on } : c));
  }

  private setLevel(i: number, level: SortLevel | null) {
    const sort = [...this.sort];
    if (level) sort[i] = level; else sort.splice(i, 1);
    // a column sorts once
    this.sort = sort.filter((s, j) => s.col && sort.findIndex((x) => x.col === s.col) === j);
  }

  private chooseView(name: string) {
    this.view = name;
    const v = this.views.views.find((x) => x.name === name);
    if (v) this.take(v.layout);
  }

  private ok = () => {
    this.views.apply(this.layout(), this.view);
    this.views.closeEditor();
  };

  private saveAs = () => {
    const name = this.newName.trim();
    if (!name) return;
    this.views.apply(this.layout(), name);
    this.views.closeEditor();
  };

  override render() {
    const none = !this.cols.some((c) => c.on);
    const sortable = this.cols.filter((c) => c.sortable);
    const views = this.views.views;
    const level = (i: number) => {
      const s = this.sort[i];
      if (i > this.sort.length) return nothing;
      return html`<div class="cd-level" data-test="cd-level">
        <span class="muted small">${i ? "then" : "Sort by"}</span>
        <select aria-label="Sort level ${i + 1}" .value=${s?.col ?? ""} @change=${(e: Event) => {
          const col = (e.target as HTMLSelectElement).value;
          this.setLevel(i, col ? { col, dir: s?.dir ?? "asc" } : null);
        }}><option value="">—</option>${sortable.map((c) => html`<option value=${c.id} ?selected=${s?.col === c.id}>${c.name}</option>`)}</select>
        <select aria-label="Direction ${i + 1}" ?disabled=${!s} .value=${s?.dir ?? "asc"}
          @change=${(e: Event) => s && this.setLevel(i, { col: s.col, dir: (e.target as HTMLSelectElement).value as "asc" | "desc" })}>
          <option value="asc" ?selected=${s?.dir !== "desc"}>ascending</option><option value="desc" ?selected=${s?.dir === "desc"}>descending</option></select></div>`;
    };
    return html`<div class="backdrop columns-layer" @click=${(e: Event) => { if (e.target === e.currentTarget) this.views.closeEditor(); }}>
      <div class="dialog columns-dialog" role="dialog" aria-modal="true" aria-label="Columns and sorting" data-test="columns-dialog">
        <button class="dialog-close" data-test="dialog-close" title="Close (Esc)" aria-label="Close" @click=${this.views.closeEditor}>✕</button>
        <h2>Columns and sorting</h2>
        <div class="cd-view">
          <label class="small muted" for="cd-view">View</label>
          <select id="cd-view" data-test="cd-view" .value=${this.view} @change=${(e: Event) => this.chooseView((e.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!this.view}>Unsaved settings</option>
            ${views.map((v) => html`<option value=${v.name} ?selected=${v.name === this.view}>${v.name}${v.name === this.views.start ? " (start)" : ""}</option>`)}</select>
          ${this.view ? html`
            <label class="small cd-start"><input type="checkbox" data-test="cd-start" .checked=${this.views.start === this.view}
              @change=${(e: Event) => this.views.setStart((e.target as HTMLInputElement).checked ? this.view : "")}> the table starts with it</label>
            <button class="btn sm danger" data-test="cd-delete" @click=${() => { this.views.remove(this.view); this.view = ""; }}>Delete view</button>` : nothing}
        </div>
        <div class="cd-grid">
          <section><h3 class="small muted">Columns</h3>
            <ul class="cd-cols" data-test="cd-cols">${this.cols.map((c, i) => html`<li draggable="true" data-col=${c.id}
                @dragstart=${(e: DragEvent) => { this.dragged = i; e.dataTransfer?.setData("text/plain", c.id); }}
                @dragover=${(e: DragEvent) => e.preventDefault()}
                @drop=${(e: DragEvent) => { e.preventDefault(); this.move(this.dragged, i); this.dragged = -1; }}>
              <span class="cd-grip" title="Drag to move; Alt+↑/↓">${appIcon("grip", 14)}</span>
              <label><input type="checkbox" .checked=${c.on} @change=${(e: Event) => this.toggle(i, (e.target as HTMLInputElement).checked)}
                @keydown=${(e: KeyboardEvent) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const to = i + (e.key === "ArrowUp" ? -1 : 1);
                  this.move(i, to);
                  void this.updateComplete.then(() => this.querySelectorAll<HTMLInputElement>(".cd-cols input")[to]?.focus());
                }}> ${c.name}</label></li>`)}</ul>
          </section>
          <section><h3 class="small muted">Sorting</h3>
            ${Array.from({ length: LEVELS }, (_, i) => level(i))}
          </section>
        </div>
        ${none ? html`<div class="notice error small">Choose at least one column.</div>` : nothing}
        <div class="foot">
          <input type="text" class="cd-name" data-test="cd-name" placeholder="Name of a new view" .value=${this.newName}
            @input=${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.saveAs(); }}>
          <button class="btn" data-test="cd-save-as" ?disabled=${none || !this.newName.trim()} @click=${this.saveAs}>Save as new view</button>
          <span class="grow"></span>
          <button class="btn primary" data-test="cd-ok" ?disabled=${none} @click=${this.ok}>OK</button>
        </div>
      </div></div>`;
  }
}
