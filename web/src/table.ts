import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { api } from "./api";
import { store } from "./store";
import type { SortValue } from "./sorting";
import { BATCH, batchesFor, promoteSort, sortLocal } from "./table-model";
import type { SortLevel, Summary, TableFilter } from "./types";

/** What a cell can use besides its row: pointed-at artifacts and type names. */
export interface TableContext {
  related: Record<string, Summary>;
  typeName: (s: Pick<Summary, "folder" | "type">) => string;
}

export interface TableColumn<T = Summary> {
  /** An overview column id ("$hid", "$title", …) or a field id; the server sorts by it. */
  id: string;
  name: string;
  /** Default width in px. Once any column has a width the layout is fixed. */
  width?: number;
  cls?: string;
  /** False for columns without an order (buttons). */
  sortable?: boolean;
  render: (row: T, ctx: TableContext) => unknown;
  title?: (row: T, ctx: TableContext) => string;
  /** The sort key of rows held in the browser (items). */
  value?: (row: T) => SortValue;
}

// Rows are Summaries from the server or any object held in the browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** Rows rendered beyond the visible ones in each direction. */
const OVERSCAN = 10;
/** Cached rows kept across reloads before the cache starts over. */
const CACHE = 5000;
const MIN_W = 48, MAX_W = 1200;

/**
 * A table with sortable headers (up to three levels) and resizable columns,
 * in one of two modes:
 * - server: the server returns every matching GUID in order, rows are
 *   fetched in batches while they scroll into view, and only the visible
 *   rows are rendered;
 * - items: rows held in the browser, sorted by the columns' value functions.
 *
 * Events: row-click (detail: row), sort-change (detail: SortLevel[]),
 * table-load (detail: { total, truncated }), rows-load (detail: Summary[]),
 * widths-change (detail: Record<column id, px>).
 */
@customElement("corestone-table")
export class Table extends LitElement {
  @property({ attribute: false }) columns: TableColumn<Row>[] = [];
  @property({ attribute: false }) filter: TableFilter = {};
  @property({ attribute: false }) sort: SortLevel[] = [];
  /** GUIDs left out of the list (e.g. the artifact a picker was opened from). */
  @property({ attribute: false }) exclude: string[] = [];
  /** Rows held in the browser; set, the table never asks the server. */
  @property({ attribute: false }) items?: Row[];
  @property({ attribute: false }) rowKey: (row: Row) => string = (row) => row.guid;
  /** Shown but not selectable rows return the reason, used as tooltip. */
  @property({ attribute: false }) disabled?: (row: Row) => string | undefined;
  @property({ attribute: false }) selected?: (row: Row) => boolean;
  /** Extra classes of a row (e.g. hooks of styles and tests). */
  @property({ attribute: false }) rowClass?: (row: Row) => string;
  @property({ attribute: false }) widths: Record<string, number> = {};
  @property({ type: Boolean }) resizable = false;
  /** Fetch every field, not only the field columns' (for columns that follow the loaded rows). */
  @property({ type: Boolean }) allFields = false;
  /** Keyboard selection (move, pickActive) starts on the first row. */
  @property({ type: Boolean }) navigable = false;
  @property() empty = "Nothing to show";
  @property({ type: Number }) rowHeight = 32;

  @state() private ids: string[] = [];
  @state() private total = 0;
  @state() private truncated = false;
  @state() private loading = false;
  @state() private error = "";
  @state() private range = { start: 0, end: 0 };
  @state() private active = -1;
  /** Widths while a column edge is dragged. */
  @state() private live?: Record<string, number>;
  /** The measured row height. */
  @state() private rh = 32;
  private localRows: Row[] = [];
  private rows = new Map<string, Summary>();
  private ctx: TableContext = { related: {}, typeName: (s) => this.typeNames[s.folder]?.[s.type] ?? s.type };
  private typeNames: Record<string, Record<string, string>> = {};
  private requested = new Set<number>();
  private generation = 0;
  private abort?: AbortController;
  private queryKey = "";
  private tick = -1;
  private frame = 0;
  private filler = false;
  private unsub?: () => void;
  private observer?: ResizeObserver;

  override createRenderRoot() { return this; }

  private get local() { return this.items !== undefined; }

  override connectedCallback() {
    super.connectedCallback();
    this.tick = store.state.refreshTick;
    // Commits (own or remote) bump the tick: reload in place.
    this.unsub = store.subscribe((s) => {
      if (s.refreshTick !== this.tick) {
        this.tick = s.refreshTick;
        if (!this.local) this.reload(true);
      }
    });
  }

  override disconnectedCallback() {
    this.unsub?.();
    this.observer?.disconnect();
    this.abort?.abort();
    cancelAnimationFrame(this.frame);
    super.disconnectedCallback();
  }

  override firstUpdated() {
    this.observer = new ResizeObserver(() => this.updateRange());
    this.observer.observe(this.body!);
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("rowHeight")) this.rh = this.rowHeight;
    if (changed.has("widths")) this.live = undefined;
    if (this.local) {
      if (changed.has("items") || changed.has("sort") || changed.has("columns")) {
        this.localRows = sortLocal(this.items!, this.sort, (col) => this.columns.find((c) => c.id === col)?.value);
      }
      return;
    }
    if (changed.has("filter") || changed.has("sort") || changed.has("exclude") || changed.has("columns") || changed.has("items")) {
      const key = JSON.stringify([this.filter, this.sort, this.exclude, this.allFields ? [] : this.fieldColumns()]);
      if (key !== this.queryKey) {
        this.queryKey = key;
        this.reload(false);
      }
    }
  }

  override updated() {
    if (this.local) return;
    // Rows have one line; their real height drives the scroll arithmetic.
    const h = this.querySelector<HTMLElement>("tbody tr:not(.placeholder)")?.getBoundingClientRect().height;
    if (h && Math.abs(h - this.rh) > 0.5) {
      this.rh = h;
      this.updateRange();
    }
  }

  private get body() { return this.querySelector<HTMLElement>(".ctable-body"); }

  private fieldColumns() { return this.columns.filter((c) => !c.id.startsWith("$")).map((c) => c.id); }

  /** Query the sorted GUIDs again; in place keeps the scroll position and shows cached rows meanwhile. */
  private async reload(inPlace: boolean) {
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.requested.clear();
    if (this.rows.size > CACHE) this.rows.clear();
    this.loading = true;
    this.error = "";
    try {
      const res = await api.query({ filter: this.filter, sort: this.sort }, abort.signal);
      if (generation !== this.generation) return;
      const skip = new Set(this.exclude);
      const ids = skip.size ? res.ids.filter((id) => !skip.has(id)) : res.ids;
      this.total = res.total - (res.ids.length - ids.length);
      this.ids = ids;
      // Batches requested meanwhile were for the previous GUIDs.
      this.requested.clear();
      this.loading = false;
      this.truncated = res.truncated;
      if (!inPlace) {
        if (this.body) this.body.scrollTop = 0;
        this.active = this.navigable && ids.length ? 0 : -1;
      } else if (this.active >= ids.length) {
        this.active = ids.length - 1;
      }
      this.dispatchEvent(new CustomEvent("table-load", { detail: { total: this.total, truncated: this.truncated } }));
      await this.updateComplete;
      if (generation === this.generation) this.updateRange();
    } catch (e) {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.error = String((e as Error).message ?? e);
      this.ids = [];
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  private onScroll = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.updateRange());
  };

  private updateRange() {
    const body = this.body;
    if (!body || this.local) return;
    const rh = this.rh;
    const head = this.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0;
    const top = Math.max(0, body.scrollTop - head);
    const start = Math.max(0, Math.floor(top / rh) - OVERSCAN);
    const end = Math.min(this.ids.length, Math.ceil((top + body.clientHeight) / rh) + OVERSCAN);
    if (start !== this.range.start || end !== this.range.end) this.range = { start, end };
    if (this.loading) return; // the GUIDs are about to change; reload fetches when they arrive
    for (const b of batchesFor(start, end)) {
      if (!this.requested.has(b)) this.fetchBatch(b);
    }
  }

  private async fetchBatch(b: number) {
    const generation = this.generation;
    const signal = this.abort?.signal;
    this.requested.add(b);
    try {
      const res = await api.details(this.ids.slice(b * BATCH, (b + 1) * BATCH), this.allFields ? undefined : this.fieldColumns(), signal);
      if (generation !== this.generation) return;
      for (const row of res.artifacts) this.rows.set(row.guid, row);
      this.ctx = { ...this.ctx, related: { ...this.ctx.related, ...res.related } };
      for (const [folder, names] of Object.entries(res.typeNames ?? {})) this.typeNames[folder] = { ...this.typeNames[folder], ...names };
      this.dispatchEvent(new CustomEvent("rows-load", { detail: res.artifacts }));
      this.requestUpdate();
    } catch (e) {
      if (generation !== this.generation || signal?.aborted) return;
      this.requested.delete(b);
      this.error = String((e as Error).message ?? e);
    }
  }

  private toggleSort(col: string) {
    this.sort = promoteSort(this.sort, col);
    this.dispatchEvent(new CustomEvent("sort-change", { detail: this.sort }));
  }

  private pick(row: Row | undefined) {
    if (!row || this.disabled?.(row)) return;
    this.dispatchEvent(new CustomEvent("row-click", { detail: row }));
  }

  private get count() { return this.local ? this.localRows.length : this.ids.length; }

  /** Move the keyboard selection by delta rows, keeping it visible. */
  move(delta: number) {
    if (!this.count) return;
    this.active = Math.min(this.count - 1, Math.max(0, this.active + delta));
    const body = this.body;
    if (!body) return;
    const head = this.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0;
    const top = this.active * this.rh;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + this.rh > body.scrollTop + body.clientHeight - head) body.scrollTop = top + this.rh - body.clientHeight + head;
  }

  /** Pick the keyboard-selected row, if it is loaded and selectable. */
  pickActive() { this.pick(this.local ? this.localRows[this.active] : this.rows.get(this.ids[this.active])); }

  private setWidth(widths: Record<string, number>, col: string, px: number) {
    this.live = { ...widths, [col]: Math.round(Math.min(MAX_W, Math.max(MIN_W, px))) };
  }

  /** The first resize fixes every column at its current width, so only the dragged one moves. */
  private frozenWidths(): Record<string, number> {
    const widths = { ...(this.live ?? this.widths) };
    // Rounding down would clip cells that just fit.
    for (const th of this.querySelectorAll<HTMLElement>("thead th[data-col]")) widths[th.dataset.col!] ??= Math.ceil(th.getBoundingClientRect().width) + 1;
    return widths;
  }

  private commitWidths() {
    if (this.live) this.dispatchEvent(new CustomEvent("widths-change", { detail: this.live }));
  }

  private dragWidth = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const th = handle.parentElement!;
    const col = th.dataset.col!;
    const widths = this.frozenWidths();
    const startX = e.clientX, start = th.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    this.setWidth(widths, col, start);
    const move = (m: PointerEvent) => this.setWidth(widths, col, start + m.clientX - startX);
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      this.commitWidths();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
    e.preventDefault();
    e.stopPropagation();
  };

  /** Double-click on a column edge: fit the column to its widest rendered cell. */
  private fitWidth = (e: MouseEvent) => {
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLTableCellElement;
    const i = th.cellIndex;
    // A range measures the content itself; scrollWidth never reports less than the current column width.
    const range = document.createRange();
    const content = (el: Element) => { range.selectNodeContents(el); return range.getBoundingClientRect().width; };
    let w = content(th.querySelector(".th-sort, .th-label")!) + 32; // padding and the sort marker
    for (const tr of this.querySelectorAll<HTMLTableRowElement>("tbody tr:not(.placeholder)")) if (tr.cells[i]) w = Math.max(w, content(tr.cells[i]) + 20);
    this.setWidth(this.frozenWidths(), th.dataset.col!, Math.ceil(w) + 2);
    this.commitWidths();
  };

  override render() {
    const cols = this.columns;
    const rh = this.rh;
    const local = this.local;
    const n = this.count;
    const { start, end } = local ? { start: 0, end: n } : this.range;
    const widths = this.live ?? this.widths;
    const width = (c: TableColumn<Row>) => widths[c.id] ?? c.width;
    const fixed = cols.some((c) => width(c) !== undefined);
    // With every width set a filler column takes the rest of the line.
    this.filler = fixed && cols.every((c) => width(c) !== undefined);
    const min = fixed ? cols.reduce((sum, c) => sum + (width(c) ?? 120), 0) : 0;
    return html`<div class="ctable-body ${local ? "local" : ""}" @scroll=${this.onScroll}>
      <table class="grid ${fixed ? "fixed" : ""}" aria-rowcount=${n} style=${`${min ? `min-width:${min}px;` : ""}margin-top:${start * rh}px`}>
        ${fixed ? html`<colgroup>${cols.map((c) => html`<col style=${width(c) ? `width:${width(c)}px` : ""}>`)}${this.filler ? html`<col>` : nothing}</colgroup>` : nothing}
        <thead><tr>${cols.map((c) => this.th(c))}${this.filler ? html`<th class="filler"></th>` : nothing}</tr></thead>
        <tbody>${local
          ? repeat(this.localRows, (row) => this.rowKey(row), (row, i) => this.row(row, this.rowKey(row), i))
          : repeat(this.ids.slice(start, end), (id) => id, (id, i) => this.serverRow(id, start + i))}</tbody>
      </table>
      ${local ? nothing : html`<div class="ctable-spacer" style=${`height:${(n - end) * rh}px`}></div>`}
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}
      ${!n && !this.error && (this.loading || this.empty) ? html`<div class="empty-state">${this.loading ? "Searching…" : this.empty}</div>` : nothing}
      ${this.truncated ? html`<div class="ctable-note">Showing the first ${this.ids.length} of ${this.total}; refine the search to see the rest.</div>` : nothing}
    </div>`;
  }

  private th(c: TableColumn<Row>) {
    const level = this.sort.findIndex((l) => l.col === c.id);
    const aria = level === 0 ? (this.sort[0].dir === "asc" ? "ascending" : "descending") : "none";
    const sortable = c.sortable !== false && (!this.local || !!c.value);
    return html`<th data-col=${c.id} aria-sort=${aria}>${sortable
      ? html`<button type="button" class="th-sort" title="Sort by ${c.name}" @click=${() => this.toggleSort(c.id)}>${c.name}${level > 0
        ? html`<sup class="sort-level" title="Sort level ${level + 1}">${level + 1}</sup>` : nothing}</button>`
      : html`<span class="th-label">${c.name}</span>`}${this.resizable
      ? html`<span class="col-resize" title="Drag to resize; double-click to fit" @pointerdown=${this.dragWidth} @dblclick=${this.fitWidth} @click=${(e: Event) => e.stopPropagation()}></span>` : nothing}</th>`;
  }

  private serverRow(id: string, index: number) {
    const r = this.rows.get(id);
    if (r) return this.row(r, id, index);
    return html`<tr class="placeholder ${index === this.active ? "active" : ""}" data-guid=${id}><td colspan=${this.columns.length + (this.filler ? 1 : 0)} class="muted">…</td></tr>`;
  }

  private row(r: Row, key: string, index: number) {
    const off = this.disabled?.(r);
    const cls = [off ? "taken" : "", index === this.active ? "active" : "", this.selected?.(r) ? "selected" : "", this.rowClass?.(r) ?? ""].filter(Boolean).join(" ");
    return html`<tr class=${cls} data-guid=${key} aria-disabled=${off ? "true" : "false"} title=${off ?? nothing} @click=${() => this.pick(r)}>${this.columns.map((c) =>
      html`<td class=${c.cls ?? ""} title=${c.title?.(r, this.ctx) ?? nothing}>${c.render(r, this.ctx)}</td>`)}${this.filler ? html`<td></td>` : nothing}</tr>`;
  }
}
