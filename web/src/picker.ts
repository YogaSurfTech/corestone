import { html, nothing } from "lit";
import { LightElement, prefs } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { store, type PickerDialog } from "./store";
import type { SortLevel, Summary, TableFilter } from "./components/types";
import type { Table, TableColumn } from "./components/table";
import "./components/table";
import { live } from "lit/directives/live.js";
import "./components/type-icon";

// The artifact picker: a search over the artifacts, from which one or several are chosen.

const PICKER_SORT_KEY = "corestone.pickerSort";

function pickerSort(): SortLevel[] {
  try {
    const v = prefs.json<unknown>(PICKER_SORT_KEY, []);
    return Array.isArray(v) ? v.filter((l) => typeof l?.col === "string" && (l.dir === "asc" || l.dir === "desc")).slice(0, 3) : [];
  } catch { return []; }
}

/** Picker columns; the last one names why a row cannot be picked. */
function pickerColumns(taken?: { guids: Set<string>; note: string }, chosen?: () => Set<string>): TableColumn[] {
  return [
    // choosing several: a checkbox per row (a click on the row ticks it)
    ...(chosen ? [{ id: "$check", name: "", width: 34, sortable: false, cls: "pick-check",
      // (the box only shows the state: a click goes through to the row, which ticks it; live: the
      // box always shows the chosen state, whatever the browser did to it)
      render: (r: Summary) => html`<input type="checkbox" tabindex="-1" aria-label="Choose ${r.hid || r.title}" .checked=${live(chosen().has(r.guid))}
        ?disabled=${!!taken?.guids.has(r.guid)} />` } satisfies TableColumn] : []),
    { id: "$hid", name: "ID", width: 110,
      render: (r) => r.hid ? html`<span class="hid">${r.hid}</span>` : html`<span class="muted mono">${r.guid.slice(0, 8)}</span>` },
    { id: "$title", name: "Title", title: (r) => r.title ?? "",
      render: (r) => html`<corestone-type-icon .kind=${r.kind} .type=${r.type} .folder=${r.folder}></corestone-type-icon>${r.title || html`<span class="muted">${r.kind}</span>`}` },
    { id: "$type", name: "Type", width: 110, cls: "muted small", render: (r, ctx) => ctx.typeName(r) },
    { id: "$folder", name: "Folder", width: 150, cls: "muted small", title: (r) => r.folder || "/",
      render: (r) => taken?.guids.has(r.guid) ? taken.note : r.folder || "/" },
  ];
}

@customElement("corestone-picker")
export class Picker extends LightElement {
  dialog!: PickerDialog;
  @state() private q = "";
  @state() private filter: TableFilter = {};
  @state() private total = -1;
  /** Choosing several (dialog.multi): the chosen rows, in the order chosen. */
  @state() private chosen = new Set<string>();
  private sort = pickerSort();
  private columns: TableColumn[] = [];
  private timer = 0;
  override connectedCallback() {
    super.connectedCallback();
    this.columns = pickerColumns(this.dialog.taken, this.multi ? () => this.chosen : undefined);
    this.applyFilter();
    this.updateComplete.then(() => this.querySelector<HTMLInputElement>("input")?.focus());
  }
  override disconnectedCallback() { window.clearTimeout(this.timer); super.disconnectedCallback(); }

  /** "<kind>/*" in types allows every type of a kind; other entries are type ids. */
  private applyFilter() {
    const kinds = this.dialog.kinds ?? ["entry", "document"];
    const types = this.dialog.types;
    // dialog.query narrows what is offered, in the query language
    this.filter = { q: this.q.trim(), kind: kinds, ...(types?.length ? { types } : {}), query: this.dialog.query || undefined };
  }

  private onInput(e: Event) {
    this.q = (e.target as HTMLInputElement).value;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.applyFilter(), 150);
  }

  private onKey(e: KeyboardEvent) {
    const table = this.querySelector<Table>("corestone-table");
    if (!table) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); table.move(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "PageDown" || e.key === "PageUp") { e.preventDefault(); table.move(e.key === "PageDown" ? 10 : -10); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // choosing several: Enter takes the chosen ones (or the active row when none is chosen yet)
      if (this.multi && this.chosen.size) this.done([...this.chosen]);
      else table.pickActive();
    }
  }

  /** dialog.multi: { verb } — rows are chosen with checkboxes (a click on a row ticks it), then
   *  "<verb> n" or "<verb> all" (every match of the search); the caller gets their GUIDs. */
  private get multi(): { verb: string } | undefined { return this.dialog.multi; }

  private done(guids: string[]) {
    if (!guids.length) return;
    store.set({ picker: null });
    if (this.dialog.multi) this.dialog.done(guids);
  }

  private pick(s: Summary) {
    store.set({ picker: null });
    if (!this.dialog.multi) this.dialog.done(s);
  }

  private toggle(s: Summary) {
    const next = new Set(this.chosen);
    if (!next.delete(s.guid)) next.add(s.guid);
    this.chosen = next;
  }

  /** All matching rows that can be chosen, in the table's order. */
  private allMatches(): string[] {
    const taken = this.dialog.taken;
    return (this.querySelector<Table>("corestone-table")?.matchingKeys ?? []).filter((g) => !taken?.guids.has(g));
  }

  /** Closes the picker without a choice. */
  private cancel() {
    store.set({ picker: null });
    if (this.dialog.multi) this.dialog.done([]); else this.dialog.done(null);
  }

  override render() {
    const exclude = this.dialog.exclude;
    // Shown but not selectable, with a reason (e.g. an entry already in the document).
    const taken = this.dialog.taken;
    // Optional actions besides picking, e.g. creating or removing a base.
    const actions = this.dialog.actions ?? [];
    return html`<h2>${this.dialog.title}</h2>
      <input type="search" placeholder="Search by title, HID or text…" aria-label="Search" .value=${this.q} @input=${this.onInput} @keydown=${this.onKey} />
      <corestone-table class="picker-results" navigable allFields .columns=${this.columns} .filter=${this.filter} .sort=${this.sort} .exclude=${exclude ? [exclude] : []}
        .disabled=${taken ? (r: Summary) => taken.guids.has(r.guid) ? taken.note : undefined : undefined} empty="No matching artifacts"
        .selected=${this.multi ? (r: Summary) => this.chosen.has(r.guid) : undefined}
        @sort-change=${(e: CustomEvent<SortLevel[]>) => { this.sort = e.detail; prefs.setJson(PICKER_SORT_KEY, e.detail); }}
        @table-load=${(e: CustomEvent<{ total: number }>) => (this.total = e.detail.total)}
        @row-click=${(e: CustomEvent<Summary>) => {
          if (this.multi) { this.toggle(e.detail); return; }
          this.pick(e.detail); }}></corestone-table>
      <div class="picker-count muted small" data-test="picker-count">${this.total < 0 ? "" : `${this.total} ${this.total === 1 ? "match" : "matches"}`}</div>
      <div class="foot">${actions.map((a) => html`<button class="btn picker-action ${a.tone}" data-test=${a.test}
          @click=${() => { this.cancel(); a.run(); }}><span class="act-icon" aria-hidden="true">${a.tone === "add" ? "＋" : "✕"}</span>${a.label}</button>`)}
        <span class="grow"></span>
        ${this.multi ? this.multiButtons(this.multi.verb) : nothing}
        <button class="btn" @click=${() => this.cancel()}>Cancel</button></div>`;
  }

  private multiButtons(verb: string) {
    const taken = this.dialog.taken?.guids;
    // (the count of all matches less those that cannot be chosen; the table knows which)
    const all = this.total < 0 ? 0 : this.total;
    const n = this.chosen.size;
    return html`<button class="btn" data-test="pick-all" ?disabled=${!all}
        title=${`Every match of the search, in the order shown${taken?.size ? " (without those that cannot be chosen)" : ""}`}
        @click=${() => this.done(this.allMatches())}>${verb} all</button>
      <button class="btn primary" data-test="pick-chosen" ?disabled=${!n} @click=${() => this.done([...this.chosen])}>${verb}${n ? ` ${n}` : ""}</button>`;
  }
}
