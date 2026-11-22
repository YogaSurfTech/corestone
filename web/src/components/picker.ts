import { html, nothing } from "lit";
import { LightElement } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { Kind, PickOptions, Schema, Summary, TableFilter } from "./types";
import type { Table, TableColumn } from "./table/table";
import { folderColumn, hidColumn, titleColumn, typeColumn } from "./table/columns";
import { TableViews } from "./table/views";
import { fieldValue } from "./table/sorting";
import "./table/columns-dialog";
import { queryFields, type LockedCriterion } from "./query-field";
import type { QueryField } from "./query-model";
import { kindPlural } from "./artifact";
import { servicesFor, type Services } from "./services";
import "./table/table";
import "./query-field";
import "./type-icon";

// The artifact picker: a query over the artifacts, built like the overview's,
// from which one or several are chosen. It reads the artifacts through the
// table's provider and says what happened with events; the dialog around it
// is the page's.

/** A button besides picking a row; "add" shows a green ＋, "remove" a red ✕. The picker is cancelled, then it runs. */
export interface PickerAction { label: string; test: string; tone: "add" | "remove"; run: () => void }

/** What the picker offers. */
export interface PickerOptions extends PickOptions {
  /** Shown but not to be chosen, with the reason. */
  taken?: { guids: Set<string>; note: string };
  actions?: PickerAction[];
}

/** Where the picker keeps its view (columns, sorting, saved views), apart from the overview's. */
const VIEWS_KEY = "corestone.picker.table";
const DEFAULT_KINDS: Kind[] = ["entry", "document"];

/** Whether a type is one the picker offers: of its kinds and, when it names types, one of them ("<kind>/*": all of a kind). */
function offered(s: Schema, kinds: Kind[], types?: string[]): boolean {
  return kinds.includes(s.kind) && (!types?.length || types.some((t) => t === s.type || t === `${s.kind}/*`));
}

/** The criteria the picker is opened with, shown locked; their title says why they are there. */
function lockedCriteria(o: PickerOptions, schemas: Schema[]): LockedCriterion[] {
  const why = o.why ?? "Set by what opened the picker";
  const out: LockedCriterion[] = [];
  // (the kinds offered anyway are no restriction)
  const kinds = o.kinds ?? DEFAULT_KINDS;
  if (kinds.length !== DEFAULT_KINDS.length || kinds.some((k) => !DEFAULT_KINDS.includes(k))) out.push({ label: kinds.map((k) => kindPlural[k]).join(" or "), title: why });
  if (o.types?.length) {
    const name = (t: string) => {
      const kind = t.endsWith("/*") ? t.slice(0, -2) as Kind : null;
      return kind ? `all ${kindPlural[kind]?.toLowerCase() ?? kind}` : schemas.find((s) => s.type === t)?.displayName ?? t;
    };
    out.push({ label: `Type: ${o.types.map(name).join(", ")}`, title: why });
  }
  if (o.query) out.push({ label: o.query, title: why });
  return out;
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
    hidColumn({ width: 110 }),
    titleColumn(),
    typeColumn({ width: 110, cls: "muted small" }),
    // a row that cannot be picked says why in place of its folder
    folderColumn({ width: 150, cls: "muted small", render: (r) => taken?.guids.has(r.guid) ? taken.note : r.folder || "/" }),
  ];
}

/**
 * Fires `pick` (the artifact's summary) when one is chosen, `pick-many` (the
 * GUIDs) when several are, and `cancel` when it is closed without a choice.
 */
@customElement("corestone-picker")
export class Picker extends LightElement {
  @property({ attribute: false }) options!: PickerOptions;
  /** Choose several: rows get checkboxes (a click on a row ticks it), and "<verb> n" or
   *  "<verb> all" (every match of the search) ends the choice. */
  @property({ attribute: false }) multi?: { verb: string };
  /** The query typed or built here; the picker's own restriction comes on top. */
  @state() private q = "";
  @state() private filter: TableFilter = {};
  @state() private schemas: Schema[] = [];
  /** The fields a query can name: none that need a picker themselves. */
  @state() private fields: QueryField[] = [];
  @state() private total = -1;
  /** Choosing several: the chosen rows, in the order chosen. */
  @state() private chosen = new Set<string>();
  private readonly views = new TableViews(this, () => VIEWS_KEY);
  private columns: TableColumn[] = [];
  private services: Partial<Services> = {};
  override connectedCallback() {
    super.connectedCallback();
    this.services = servicesFor(this);
    this.columns = pickerColumns(this.options.taken, this.multi ? () => this.chosen : undefined);
    this.applyFilter();
    void this.loadFields();
    this.updateComplete.then(() => this.querySelector<HTMLInputElement>("corestone-query-field input[type=search]")?.focus());
  }

  /** The columns to choose from: the picker's own (not its checkboxes), and the fields of the types it offers, hidden until chosen. */
  private allColumns(): TableColumn[] {
    const fields = new Map<string, string>();
    for (const s of this.schemas) for (const f of s.fields ?? []) if (!fields.has(f.id)) fields.set(f.id, f.name || f.id);
    return [
      ...this.columns.filter((c) => c.id !== "$check"),
      ...[...fields].map(([id, name]): TableColumn => ({ id, name, hidden: true, cls: "small", render: (r) => String(fieldValue(r, id) ?? "") })),
    ];
  }

  /** The types of the folder the picker is opened for: their fields can be asked for. */
  private async loadFields() {
    const s = this.services;
    if (!s.types || !s.query) return;
    const kinds = this.options.kinds ?? DEFAULT_KINDS;
    const folder = this.options.folder ?? "";
    const schemas = (await s.types.types(folder)).filter((t) => offered(t, kinds, this.options.types));
    // one type: its fields, and no field "Type"
    const only = schemas.length === 1 && this.options.types?.length === 1 && this.options.types[0] === schemas[0].type ? schemas[0].type : "";
    this.schemas = schemas;
    this.fields = queryFields(schemas, folder, only, s.query).filter((f) => f.input !== "artifact");
  }

  /** "<kind>/*" in types allows every type of a kind; other entries are type ids. */
  private applyFilter() {
    const kinds = this.options.kinds ?? DEFAULT_KINDS;
    const types = this.options.types;
    // options.query narrows what is offered, in the query language; what is asked here comes on top
    const query = [this.options.query, this.q.trim()].filter(Boolean).map((q) => `(${q})`).join(" AND ");
    this.filter = { kind: kinds, ...(types?.length ? { types } : {}), query: query || undefined };
  }

  /** In the query field's text: the arrow down moves into the list. */
  private onFieldKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" || !(e.target as Element).matches("input[data-test=search]")) return;
    e.preventDefault();
    this.querySelector<HTMLElement>("corestone-table")?.focus();
  }

  /** In the list: the keys move and pick. */
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

  private done(guids: string[]) {
    if (guids.length) this.dispatchEvent(new CustomEvent("pick-many", { detail: guids }));
  }

  private pick(s: Summary) {
    this.dispatchEvent(new CustomEvent("pick", { detail: s }));
  }

  private toggle(s: Summary) {
    const next = new Set(this.chosen);
    if (!next.delete(s.guid)) next.add(s.guid);
    this.chosen = next;
  }

  /** All matching rows that can be chosen, in the table's order. */
  private allMatches(): string[] {
    const taken = this.options.taken;
    return (this.querySelector<Table>("corestone-table")?.matchingKeys ?? []).filter((g) => !taken?.guids.has(g));
  }

  private cancel() {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  override render() {
    const exclude = this.options.exclude;
    // Shown but not selectable, with a reason (e.g. an entry already in the document).
    const taken = this.options.taken;
    // Optional actions besides picking, e.g. creating or removing a base.
    const actions = this.options.actions ?? [];
    return html`<h2>${this.options.title}</h2>
      <corestone-query-field class="picker-query" keepKey="" historyKey="corestone.picker.history" placeholder="Search or query: priority:high"
        .value=${this.q} .folder=${this.options.folder ?? ""} .fields=${this.fields} .source=${this.services.query}
        .locked=${lockedCriteria(this.options, this.schemas)} @keydown=${this.onFieldKey}
        @query-change=${(e: CustomEvent<{ text: string }>) => { this.q = e.detail.text; this.applyFilter(); }}></corestone-query-field>
      <corestone-table class="picker-results" tabindex="0" aria-label="Matching artifacts" @keydown=${this.onKey} navigable allFields .columns=${[...this.columns.filter((c) => c.id === "$check"), ...this.views.arrange(this.allColumns())]} .filter=${this.filter} .sort=${this.views.layout.sort} .widths=${this.views.layout.widths} resizable .exclude=${exclude ? [exclude] : []}
        .disabled=${taken ? (r: Summary) => taken.guids.has(r.guid) ? taken.note : undefined : undefined} empty="No matching artifacts"
        .selected=${this.multi ? (r: Summary) => this.chosen.has(r.guid) : undefined}
        @sort-change=${this.views.setSort} @widths-change=${this.views.setWidths}
        @header-menu=${(e: CustomEvent<{ col: string; x: number; y: number }>) => this.views.headerMenu(e, this.allColumns())}
        @table-load=${(e: CustomEvent<{ total: number }>) => (this.total = e.detail.total)}
        @row-click=${(e: CustomEvent<Summary>) => {
          if (this.multi) { this.toggle(e.detail); return; }
          this.pick(e.detail); }}></corestone-table>
      <div class="picker-count muted small" data-test="picker-count">${this.total < 0 ? "" : `${this.total} ${this.total === 1 ? "match" : "matches"}`}</div>
      ${actions.length || this.multi ? html`<div class="foot">${actions.map((a) => html`<button class="btn picker-action ${a.tone}" data-test=${a.test}
          @click=${() => { this.cancel(); a.run(); }}><span class="act-icon" aria-hidden="true">${a.tone === "add" ? "＋" : "✕"}</span>${a.label}</button>`)}
        <span class="grow"></span>
        ${this.multi ? this.multiButtons(this.multi.verb) : nothing}</div>` : nothing}
      ${this.views.editing ? html`<corestone-columns-dialog .views=${this.views} .columns=${this.views.editing}></corestone-columns-dialog>` : nothing}`;
  }

  private multiButtons(verb: string) {
    const taken = this.options.taken?.guids;
    // (the count of all matches less those that cannot be chosen; the table knows which)
    const all = this.total < 0 ? 0 : this.total;
    const n = this.chosen.size;
    return html`<button class="btn" data-test="pick-all" ?disabled=${!all}
        title=${`Every match of the search, in the order shown${taken?.size ? " (without those that cannot be chosen)" : ""}`}
        @click=${() => this.done(this.allMatches())}>${verb} all</button>
      <button class="btn primary" data-test="pick-chosen" ?disabled=${!n} @click=${() => this.done([...this.chosen])}>${verb}${n ? ` ${n}` : ""}</button>`;
  }
}
