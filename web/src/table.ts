import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { api } from "./api";
import { store } from "./store";
import { BATCH, batchesFor, promoteSort } from "./table-model";
import type { SortLevel, Summary, TableFilter } from "./types";

/** What a cell can use besides its row: pointed-at artifacts and type names. */
export interface TableContext {
  related: Record<string, Summary>;
  typeName: (s: Pick<Summary, "folder" | "type">) => string;
}

export interface TableColumn {
  /** An overview column id ("$hid", "$title", …) or a field id; the server sorts by it. */
  id: string;
  name: string;
  /** CSS grid track, e.g. "96px" or "minmax(120px, 1fr)". */
  width?: string;
  cls?: string;
  /** False for columns without an order (buttons). */
  sortable?: boolean;
  render: (row: Summary, ctx: TableContext) => unknown;
  title?: (row: Summary, ctx: TableContext) => string;
}

/** Rows rendered beyond the visible ones in each direction. */
const OVERSCAN = 10;
/** Cached rows kept across reloads before the cache starts over. */
const CACHE = 5000;

/**
 * A server-sorted, lazily loaded table: the server returns every matching
 * GUID in order, rows are fetched in batches while they scroll into view,
 * and only the visible rows are rendered (fixed row height).
 *
 * Events: row-click (detail: Summary), sort-change (detail: SortLevel[]),
 * table-load (detail: { total, truncated }).
 */
@customElement("corestone-table")
export class Table extends LitElement {
  @property({ attribute: false }) columns: TableColumn[] = [];
  @property({ attribute: false }) filter: TableFilter = {};
  @property({ attribute: false }) sort: SortLevel[] = [];
  /** GUIDs left out of the list (e.g. the artifact a picker was opened from). */
  @property({ attribute: false }) exclude: string[] = [];
  /** Shown but not selectable rows return the reason, used as tooltip. */
  @property({ attribute: false }) disabled?: (row: Summary) => string | undefined;
  @property() empty = "Nothing to show";
  @property({ type: Number }) rowHeight = 32;

  @state() private ids: string[] = [];
  @state() private total = 0;
  @state() private truncated = false;
  @state() private loading = false;
  @state() private error = "";
  @state() private range = { start: 0, end: 0 };
  @state() private active = -1;
  private rows = new Map<string, Summary>();
  private ctx: TableContext = { related: {}, typeName: (s) => this.typeNames[s.folder]?.[s.type] ?? s.type };
  private typeNames: Record<string, Record<string, string>> = {};
  private requested = new Set<number>();
  private generation = 0;
  private abort?: AbortController;
  private queryKey = "";
  private tick = -1;
  private frame = 0;
  private unsub?: () => void;
  private observer?: ResizeObserver;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this.tick = store.state.refreshTick;
    // Commits (own or remote) bump the tick: reload in place.
    this.unsub = store.subscribe((s) => {
      if (s.refreshTick !== this.tick) {
        this.tick = s.refreshTick;
        this.reload(true);
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
    if (changed.has("filter") || changed.has("sort") || changed.has("exclude") || changed.has("columns")) {
      const key = JSON.stringify([this.filter, this.sort, this.exclude, this.fieldColumns()]);
      if (key !== this.queryKey) {
        this.queryKey = key;
        this.reload(false);
      }
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
      this.truncated = res.truncated;
      if (!inPlace) {
        if (this.body) this.body.scrollTop = 0;
        this.active = ids.length ? 0 : -1;
      } else if (this.active >= ids.length) {
        this.active = ids.length - 1;
      }
      this.dispatchEvent(new CustomEvent("table-load", { detail: { total: this.total, truncated: this.truncated } }));
      await this.updateComplete;
      this.updateRange();
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
    if (!body) return;
    const rh = this.rowHeight;
    const start = Math.max(0, Math.floor(body.scrollTop / rh) - OVERSCAN);
    const end = Math.min(this.ids.length, Math.ceil((body.scrollTop + body.clientHeight) / rh) + OVERSCAN);
    if (start !== this.range.start || end !== this.range.end) this.range = { start, end };
    for (const b of batchesFor(start, end)) {
      if (!this.requested.has(b)) this.fetchBatch(b);
    }
  }

  private async fetchBatch(b: number) {
    const generation = this.generation;
    const signal = this.abort?.signal;
    this.requested.add(b);
    try {
      const res = await api.details(this.ids.slice(b * BATCH, (b + 1) * BATCH), this.fieldColumns(), signal);
      if (generation !== this.generation) return;
      for (const row of res.artifacts) this.rows.set(row.guid, row);
      this.ctx = { ...this.ctx, related: { ...this.ctx.related, ...res.related } };
      for (const [folder, names] of Object.entries(res.typeNames ?? {})) this.typeNames[folder] = { ...this.typeNames[folder], ...names };
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

  private pick(row: Summary | undefined) {
    if (!row || this.disabled?.(row)) return;
    this.dispatchEvent(new CustomEvent("row-click", { detail: row }));
  }

  /** Move the keyboard selection by delta rows, keeping it visible. */
  move(delta: number) {
    if (!this.ids.length) return;
    this.active = Math.min(this.ids.length - 1, Math.max(0, this.active + delta));
    const body = this.body;
    if (!body) return;
    const head = this.querySelector<HTMLElement>(".ctable-head")?.offsetHeight ?? 0;
    const top = this.active * this.rowHeight;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + this.rowHeight > body.scrollTop + body.clientHeight - head) body.scrollTop = top + this.rowHeight - body.clientHeight + head;
  }

  /** Pick the keyboard-selected row, if it is loaded and selectable. */
  pickActive() { this.pick(this.rows.get(this.ids[this.active])); }

  override render() {
    const cols = this.columns;
    const rh = this.rowHeight;
    const { start, end } = this.range;
    const template = cols.map((c) => c.width ?? "minmax(120px, 1fr)").join(" ");
    return html`<div class="ctable-body" role="grid" aria-rowcount=${this.ids.length} style=${`--rh:${rh}px;--cols:${template}`} @scroll=${this.onScroll}>
      <div class="ctable-head" role="row">${cols.map((c) => {
        const level = this.sort.findIndex((l) => l.col === c.id);
        const aria = level === 0 ? (this.sort[0].dir === "asc" ? "ascending" : "descending") : "none";
        return html`<div class="ctable-th" role="columnheader" data-col=${c.id} aria-sort=${aria}>${c.sortable === false
          ? html`<span class="th-label">${c.name}</span>`
          : html`<button type="button" class="th-sort" title="Sort by ${c.name}" @click=${() => this.toggleSort(c.id)}>${c.name}${level > 0
            ? html`<sup class="sort-level" title="Sort level ${level + 1}">${level + 1}</sup>` : nothing}</button>`}</div>`;
      })}</div>
      <div class="ctable-rows" style=${`height:${this.ids.length * rh}px`}>
        <div class="ctable-window" style=${`transform:translateY(${start * rh}px)`}>
          ${repeat(this.ids.slice(start, end), (id) => id, (id, i) => this.row(id, start + i))}
        </div>
      </div>
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}
      ${!this.ids.length && !this.error ? html`<div class="empty-state">${this.loading ? "Searching…" : this.empty}</div>` : nothing}
      ${this.truncated ? html`<div class="ctable-note">Showing the first ${this.ids.length} of ${this.total}; refine the search to see the rest.</div>` : nothing}
    </div>`;
  }

  private row(id: string, index: number) {
    const r = this.rows.get(id);
    const cls = index === this.active ? "active" : "";
    if (!r) return html`<div class="row placeholder ${cls}" role="row" data-guid=${id}><div class="cell muted">…</div></div>`;
    const off = this.disabled?.(r);
    return html`<div class="row ${off ? "taken" : ""} ${cls}" role="row" data-guid=${id} aria-disabled=${off ? "true" : "false"} title=${off ?? ""}
      @click=${() => this.pick(r)}>${this.columns.map((c) => html`<div class="cell ${c.cls ?? ""}" role="gridcell" title=${c.title?.(r, this.ctx) ?? nothing}>${c.render(r, this.ctx)}</div>`)}</div>`;
  }
}
