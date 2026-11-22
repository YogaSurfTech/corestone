// The query field of the overview: a query typed as text, or built from
// criteria. "+" offers the fields; a criterion is a button that opens its
// editor, with NOT to switch on and off and the operator between two
// criteria to choose. The builder writes the query text, which is what runs.
import { html, nothing, render, type PropertyValues } from "lit";
import { LightElement, Overlay, buildMenu, errorText, prefs } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import type { EnumOption, Kind, QueryWarning, Schema } from "./types";
import { markIcon } from "./icons";
import { hidLabel } from "./artifact";
import "./enum-control";
import { COMPARES, JOINS, clauseLabel, toText, type Clause, type Compare, type Input, type Join, type QueryField, type QuerySource, type Value } from "./query-model";

const INPUT: Record<string, Input> = {
  enum: "enum", workflow: "enum", boolean: "bool", integer: "number", float: "number", currency: "number",
  date: "date", datetime: "date", reference: "artifact", references: "artifact", attachment: "empty", json: "empty",
};

/**
 * The fields a query can name here: the general ones of the kind shown and the
 * fields of its types (of the one type given). Entries and documents share
 * theirs; a link is asked for by its ends and its role, a comment by what it is
 * on. An end opens a query on the artifact there, with the fields of entries
 * and documents but none that would need a picker.
 */
export function queryFields(schemas: Schema[], folder: string, type: string, source: QuerySource, kind: Kind | "" = ""): QueryField[] {
  const general = (id: string, name: string, input: Input, more: Partial<QueryField> = {}): QueryField => ({ id, name, input, group: "General", ...more });
  const kinds: Kind[] = kind === "link" || kind === "comment" ? [kind] : ["entry", "document"];
  const own = schemas.filter((s) => kinds.includes(s.kind));
  const typeField = (name: string) => type ? [] : [general("type", name, "enum", { options: own.map((s) => ({ value: s.type, label: s.displayName ?? s.type })) })];
  const dates = [general("created", "Created", "date"), general("modified", "Modified", "date"), general("author", "Author", "text")];
  // the artifact at an end: an entry or a document, asked for without a picker
  const end = (id: string, name: string) => general(id, name, "query",
    { fields: () => queryFields(schemas, folder, "", source).filter((f) => f.input !== "artifact") });
  let out: QueryField[];
  if (kind === "link") {
    out = [end("source", "From"), ...typeField("Role"), end("target", "To"), ...dates];
  } else if (kind === "comment") {
    out = [end("subject", "On"), general("", "Text", "text"), ...(own.length > 1 ? typeField("Type") : []), ...dates];
  } else {
    out = [
      general("", "Text", "text"), ...typeField("Type"),
      general("title", "Title", "text"), general("hid", "ID", "text"), general("folder", "Folder", "text"),
      ...dates, general("finished", "Finished", "bool"),
      general("base", "Based on", "artifact", { picker: { title: "Based on: choose the base", kinds: ["entry"], query: "NOT ~base:NULL", why: "Only entries that another entry is based on" } }),
      general("~base", "Base of", "artifact", { picker: { title: "Base of: choose an entry that has a base", kinds: ["entry"], query: "NOT base:NULL", why: "Only entries that have a base" } }),
    ];
  }
  const taken = new Set(out.map((f) => f.id).concat("type", "kind", "guid", "valid", "source", "target", "subject"));
  for (const s of own) {
    if (type && s.type !== type) continue;
    for (const f of s.fields ?? []) {
      if (taken.has(f.id)) continue;
      taken.add(f.id);
      const field: QueryField = { id: f.id, name: f.name || f.id, input: INPUT[f.type] ?? "text", group: "Fields" };
      if (f.type === "enum" && f.source) {
        // a dynamic enumeration is written as the chosen artifact's HID
        field.load = () => source.enumOptions(s.type, f.id, folder).then((r) => r.map((o) => ({ value: o.hid ?? o.guid, label: hidLabel(o) })));
      } else if (f.type === "enum") {
        field.options = f.options ?? [];
      } else if (f.type === "workflow") {
        field.load = () => source.workflowStates(f.workflow ?? "", s.type, folder);
      } else if (field.input === "artifact") {
        field.picker = { title: `${field.name}: choose`, kinds: ["entry", "document"], types: f.targetTypes, why: `${field.name} can only refer to these types` };
      }
      out.push(field);
    }
  }
  return out;
}

type Open =
  | { kind: "fields" }
  | { kind: "join"; index: number }
  | { kind: "editor"; field: QueryField; index: number | null };

/** A criterion that is set and cannot be changed here; its title says why. */
export interface LockedCriterion { label: string; title: string }

/** The criteria used last, newest first; pinned ones are never forgotten. */
const REMEMBERED = 15;
interface Remembered { clause: Clause; pinned: boolean }
/** What makes two criteria the same: field, NOT and value, not the operator in front. */
const sameAs = (c: Clause) => toText([{ ...c, join: "AND" }]);

@customElement("corestone-query-field")
export class QueryFieldElement extends LightElement {
  /** The query that runs (the route's). */
  @property() value = "";
  @property({ attribute: false }) fields: QueryField[] = [];
  /** Where its data comes from. */
  @property({ attribute: false }) source!: QuerySource;
  /** The folder of the view: where the icons of enumeration values are looked up. */
  @property() folder = "";
  /** Where the criteria of the query that runs are kept, so a reload shows them again; none: they are not kept. */
  @property() keepKey = "corestone.query";
  /** Where the criteria used last are remembered. */
  @property() historyKey = "corestone.query.history";
  @property() placeholder = "Search or query: priority:high";
  /** Criteria shown before the query, which always apply and cannot be changed or removed. */
  @property({ attribute: false }) locked: LockedCriterion[] = [];
  /** The criteria the value was built from, when they are known (the query of an end being edited again). */
  @property({ attribute: false }) builtFrom: Clause[] | null = null;

  @state() private text = "";
  @state() private clauses: Clause[] = [];
  @state() private error = "";
  @state() private warnings: QueryWarning[] = [];
  @state() private open: Open | null = null;
  /** What is typed to find a field in the list. */
  @state() private find = "";
  @state() private history: Remembered[] = [];
  // the editor's draft
  @state() private options: EnumOption[] | null = null;
  @state() private draft: { not: boolean; empty: boolean; text: string; values: Set<string>; compare: Compare; a: string; b: string;
    query: { text: string; clauses: Clause[] | null } } = this.blank();
  /** The fields of the artifact at an end, while its query is edited. */
  private endFields: QueryField[] = [];
  private timer = 0;
  private checks = 0;
  private checked: string | null = null;

  private blank() { return { not: false, empty: false, text: "", values: new Set<string>(), compare: "=" as Compare, a: "", b: "", query: { text: "", clauses: null as Clause[] | null } }; }

  override connectedCallback() {
    super.connectedCallback();
    const kept = prefs.json<Remembered[]>(this.historyKey, []);
    this.history = Array.isArray(kept) ? kept.filter((h) => h?.clause?.field && h.clause.value) : [];
  }

  private keep(history: Remembered[]) {
    // the pinned ones stay; of the others the newest fifteen
    let free = REMEMBERED;
    this.history = history.filter((h) => h.pinned || free-- > 0);
    prefs.setJson(this.historyKey, this.history);
  }

  private remember(clause: Clause) {
    const key = sameAs(clause);
    const old = this.history.find((h) => sameAs(h.clause) === key);
    this.keep([{ clause: { ...clause, join: "AND" }, pinned: !!old?.pinned }, ...this.history.filter((h) => h !== old)]);
  }
  override disconnectedCallback() {
    this.overlay?.close();
    window.clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  // --- what opens below the field: one panel (the fields with the history, or a criterion's
  // editor) and the menu of operators, both panels of one overlay of @corestone/ui

  private overlay?: Overlay;
  private panel!: HTMLElement;
  private menu!: HTMLElement;
  /** The control a panel opens below. */
  private anchor: HTMLElement | null = null;
  private opening = false;
  /** The built list of fields, kept while it holds the same fields: its items keep the focus. */
  private fieldMenu: { key: string; items: HTMLElement[] } | null = null;

  private show(open: Open, anchor: HTMLElement | null) {
    this.anchor = anchor ?? this.anchor;
    this.open = open;
  }

  override updated() {
    if (!this.overlay) {
      this.overlay = new Overlay({
        root: this,
        onClose: () => { if (!this.opening && this.open) this.open = null; },
        onEscape: () => this.querySelector<HTMLElement>("[data-test=query-add]")?.focus(),
      });
      this.panel = this.overlay.panel("ui-pop qb-pop", "dialog", "Criterion");
      this.menu = this.overlay.panel("ui-pop ui-menu", "menu", "Operator");
    }
    const o = this.open;
    if (!o) {
      if (this.overlay.isOpen) this.overlay.close();
      return;
    }
    const target = o.kind === "join" ? this.menu : this.panel;
    if (o.kind === "join") {
      const items = buildMenu(JOINS.map((j) => ({
        label: j, checked: this.clauses[o.index]?.join === j, test: "query-join-" + j.toLowerCase(),
        run: () => this.built(this.clauses.map((c, i) => (i === o.index ? { ...c, join: j as Join } : c))),
      })));
      this.menu.replaceChildren(...items);
    } else {
      this.panel.classList.toggle("qb-two", o.kind === "fields");
      // the query of an end has menus of its own, which hang out of the panel
      this.panel.classList.toggle("qb-has-end", o.kind === "editor" && o.field.input === "query");
      render(o.kind === "editor" ? this.editor(o.field) : this.fieldList(), this.panel);
    }
    if (target.hidden) {
      this.opening = true;
      this.overlay.openBelow(target, this.anchor?.isConnected ? this.anchor : this);
      this.opening = false;
      if (o.kind === "join") (this.menu.querySelector("[aria-checked=true]") as HTMLElement | null)?.focus();
    }
  }

  override willUpdate(changed: PropertyValues) {
    if (!changed.has("value")) return;
    if (this.clauses.length && toText(this.clauses) === this.value) return; // our own query came back
    // the criteria of a built query survive a reload; any other text is text
    const kept = this.builtFrom ? { text: toText(this.builtFrom), clauses: this.builtFrom }
      : this.keepKey ? prefs.json<{ text: string; clauses: Clause[] } | null>(this.keepKey, null) : null;
    this.clauses = this.value && kept?.text === this.value && Array.isArray(kept.clauses) ? kept.clauses : [];
    if (this.text !== this.value || this.clauses.length) this.text = this.value; // never wipe text being typed
    if (this.value !== this.checked) void this.check(this.value);
  }

  /** Have the server read the query: its problems show below the field. False if it cannot be read. */
  private async check(text: string): Promise<boolean | null> {
    const check = ++this.checks;
    let error = "";
    let warnings: QueryWarning[] = [];
    if (text.trim()) {
      try {
        warnings = await this.source.check(text);
      } catch (e) {
        error = errorText(e);
      }
    }
    if (check !== this.checks) return null; // changed meanwhile
    this.checked = text;
    this.error = error;
    this.warnings = warnings;
    return !error;
  }

  /** Run the query once it can be read; a half-typed one leaves the table as it is. */
  private async run(replace: boolean) {
    window.clearTimeout(this.timer);
    const text = this.text;
    if (!(await this.check(text))) return;
    // the criteria are kept with the text that runs, so a reload finds them for the query it shows
    if (this.clauses.length && toText(this.clauses) === text) this.keepCriteria({ text, clauses: this.clauses });
    const clauses = this.clauses.length && toText(this.clauses) === text ? this.clauses : null;
    this.dispatchEvent(new CustomEvent("query-change", { detail: { text, replace, clauses } }));
  }

  /** Keep the criteria of the query that runs, where they are kept. */
  private keepCriteria(kept: { text: string; clauses: Clause[] } | null) {
    if (this.keepKey) prefs.setJson(this.keepKey, kept);
  }

  /** The criteria changed: write the text and run it. */
  private built(clauses: Clause[]) {
    this.clauses = clauses;
    this.text = toText(clauses);
    if (!clauses.length) this.keepCriteria(null);
    this.open = null;
    void this.run(false);
  }

  private asText = () => {
    this.clauses = [];
    this.keepCriteria(null);
    void this.updateComplete.then(() => this.querySelector<HTMLInputElement>("[data-test=search]")?.focus());
  };

  // --- the editor of one criterion

  private edit(field: QueryField, index: number | null, anchor: HTMLElement | null = null) {
    const d = this.blank();
    const v = index === null ? null : this.clauses[index].value;
    d.not = index !== null && this.clauses[index].not;
    if (v?.kind === "empty") d.empty = true;
    else if (v?.kind === "text") d.text = v.text;
    else if (v?.kind === "enum") d.values = new Set(v.values.map((o) => o.value));
    else if (v?.kind === "bool") d.values = new Set([String(v.value)]);
    else if (v?.kind === "range") { d.compare = v.compare; d.a = v.a; d.b = v.b; }
    else if (v?.kind === "query") d.query = { text: v.text, clauses: v.clauses };
    this.draft = d;
    this.endFields = field.input === "query" ? field.fields?.() ?? [] : [];
    this.options = field.options ?? null;
    this.show({ kind: "editor", field, index }, anchor);
    if (field.input === "enum" && !field.options && field.load) {
      field.load().then((o) => { if (this.open?.kind === "editor" && this.open.field === field) this.options = o; },
        (e) => { this.options = []; this.source.failed(e); });
    }
    void this.updateComplete.then(() => {
      (this.querySelector<HTMLElement>(".qb-editor .enum-search input") ?? this.querySelector<HTMLElement>(".qb-editor :is(input, select, button):not(.qb-not)"))?.focus();
    });
  }

  /** The field of a criterion, as offered here; a field that is gone keeps what the criterion knows. */
  private fieldOf(c: Clause): QueryField {
    return this.fields.find((f) => f.id === c.field.id) ?? { ...c.field, group: "Fields" };
  }

  private draftValue(field: QueryField): Value | null {
    const d = this.draft;
    if (d.empty || field.input === "empty") return { kind: "empty" };
    switch (field.input) {
      case "text": return d.text.trim() ? { kind: "text", text: d.text.trim() } : null;
      case "enum": {
        const values = (this.options ?? []).filter((o) => d.values.has(o.value)).map((o) => ({ value: o.value, label: o.label ?? o.value }));
        return values.length ? { kind: "enum", values } : null;
      }
      case "number": case "date":
        if (!d.a.trim() || (d.compare === "between" && !d.b.trim())) return null;
        return { kind: "range", compare: d.compare, a: d.a.trim(), b: d.compare === "between" ? d.b.trim() : "" };
      case "query": return d.query.text.trim() ? { kind: "query", text: d.query.text.trim(), clauses: d.query.clauses } : null;
    }
    return null;
  }

  private apply(value: Value | null, target = this.open) {
    if (target?.kind !== "editor" || !value) return;
    const { field, index } = target;
    const clause: Clause = index === null
      ? { field: { id: field.id, name: field.name, input: field.input }, not: this.draft.not, join: "AND", value }
      : { ...this.clauses[index], not: this.draft.not, value };
    this.remember(clause);
    this.place(clause, index);
  }

  /** Put a criterion into the query: in place of the one at index, or as a new one at the end. */
  private place(clause: Clause, index: number | null) {
    if (!this.clauses.length && this.text.trim()) {
      // text is being typed: the criterion joins it as text; in brackets, as words side by side
      // would otherwise bind looser than AND ("a b AND c" is "a OR (b AND c)")
      const text = this.text.trim();
      this.text = `${/\s/.test(text) ? `(${text})` : text} AND ${toText([clause])}`;
      this.open = null;
      void this.run(false);
      return;
    }
    this.built(index === null ? [...this.clauses, clause] : this.clauses.map((c, i) => (i === index ? clause : c)));
  }

  private pick(field: QueryField) {
    const p = field.picker;
    if (!p) return;
    const target = this.open; // the picker is a dialog of its own: a click in it closes this editor
    void this.source.pick(p).then((s) => { if (s) this.apply({ kind: "artifact", id: s.hid ?? s.guid, label: s.hid ?? s.title ?? s.guid }, target); });
  }

  private editor(field: QueryField) {
    const d = this.draft;
    const set = (patch: Partial<typeof d>) => { this.draft = { ...d, ...patch }; };
    const value = this.draftValue(field);
    // (Enter in the query of an end runs that query; Add takes it)
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target as Element).closest("corestone-enum, .qb-nested")) { e.preventDefault(); this.apply(this.draftValue(field)); } };
    const input = (key: "a" | "b", label: string) => field.input === "number"
      ? html`<input type="number" step="any" aria-label=${label} data-test="query-value" .value=${d[key]} @input=${(e: Event) => set({ [key]: (e.target as HTMLInputElement).value })} />`
      : html`<span class="qb-date"><input type="text" aria-label=${label} data-test="query-value" placeholder="2026-11-17, 2026-11 or 2026" .value=${d[key]} @input=${(e: Event) => set({ [key]: (e.target as HTMLInputElement).value })} />
          <button class="btn sm qb-cal" type="button" data-test="query-calendar" title="Pick a day" aria-label="${label}: pick a day"
            @click=${(e: Event) => {
              // the browser's own date picker, opened from a button that looks the same everywhere
              const day = (e.currentTarget as HTMLElement).nextElementSibling as HTMLInputElement;
              try { day.showPicker(); } catch { day.focus(); }
            }}>${markIcon("calendar")}</button>
          <input type="date" class="qb-day" tabindex="-1" aria-hidden="true" .value=${/^\d{4}-\d\d-\d\d$/.test(d[key]) ? d[key] : ""} @change=${(e: Event) => set({ [key]: (e.target as HTMLInputElement).value })} /></span>`;
    let body;
    switch (field.input) {
      case "text":
        body = html`<input type="text" data-test="query-value" aria-label=${field.name} placeholder=${field.id ? "Text or words" : "Words in title, ID or text"} .value=${d.text} ?disabled=${d.empty}
          @input=${(e: Event) => set({ text: (e.target as HTMLInputElement).value })} />`;
        break;
      case "enum":
        body = this.options === null ? html`<div class="muted small">Loading…</div>` : !this.options.length ? html`<div class="muted small">No values.</div>`
          : html`<corestone-enum multiple expanded .options=${this.options} .value=${[...d.values]} .folder=${this.folder} .label=${field.name}
              @enum-change=${(e: CustomEvent<string[] | null>) => set({ values: new Set(e.detail ?? []), empty: false })}></corestone-enum>`;
        break;
      case "bool":
        body = html`<div class="qb-row">${[true, false].map((b) => html`<button class="btn sm" data-test=${b ? "query-yes" : "query-no"} @click=${() => this.apply({ kind: "bool", value: b })}>${b ? "Yes" : "No"}</button>`)}</div>`;
        break;
      case "number": case "date":
        body = html`<div class="qb-row"><select aria-label="Comparison" data-test="query-compare" ?disabled=${d.empty} @change=${(e: Event) => set({ compare: (e.target as HTMLSelectElement).value as Compare })}>
            ${COMPARES.map(([c, name]) => html`<option value=${c} ?selected=${c === d.compare}>${name}</option>`)}</select>
          ${input("a", d.compare === "between" ? "From" : "Value")}${d.compare === "between" ? html`<span class="muted">and</span>${input("b", "To")}` : nothing}</div>`;
        break;
      case "artifact":
        body = html`<div class="qb-row"><button class="btn sm" data-test="query-pick" @click=${() => this.pick(field)}>Choose…</button></div>`;
        break;
      case "query":
        // the artifact at the end matches a query of its own, built the same way
        body = html`<div class="muted small">The artifact there matches:</div>
          <corestone-query-field class="qb-nested" data-test="query-end" keepKey="" historyKey="corestone.query.ends.history" placeholder="Search or query: type:req"
            .value=${d.query.text} .builtFrom=${d.query.clauses} .folder=${this.folder} .fields=${this.endFields} .source=${this.source}
            @query-change=${(e: CustomEvent<{ text: string; clauses: Clause[] | null }>) => { e.stopPropagation(); set({ query: { text: e.detail.text, clauses: e.detail.clauses } }); }}></corestone-query-field>`;
        break;
      default:
        body = nothing;
    }
    const canBeEmpty = !!field.id && field.input !== "bool" && field.input !== "empty" && field.input !== "query";
    return html`<div class="qb-editor" data-test="query-editor" @keydown=${onKey}>
      <div class="qb-row qb-head"><span class="qb-title">${field.name}</span>
        <button class="qb-not standalone ${d.not ? "on" : ""}" data-test="query-editor-not" aria-pressed=${d.not ? "true" : "false"}
          title=${d.not ? "Not: switched on. The criterion finds what does not match." : "Not: switched off"} @click=${() => set({ not: !d.not })}>NOT</button></div>
      ${body}
      ${canBeEmpty ? html`<label class="qb-option"><input type="checkbox" data-test="query-empty" .checked=${d.empty} @change=${(e: Event) => set({ empty: (e.target as HTMLInputElement).checked })} />is empty</label>` : nothing}
      ${field.input === "empty" ? html`<div class="muted small">This field can only be asked for being empty.</div>` : nothing}
      ${field.input === "bool" || (field.input === "artifact" && !d.empty) ? nothing
        : html`<div class="qb-row end"><button class="btn sm primary" data-test="query-apply" ?disabled=${!value} @click=${() => this.apply(value)}>${this.open?.kind === "editor" && this.open.index !== null ? "Change" : "Add"}</button></div>`}
    </div>`;
  }

  // --- render

  private fieldList() {
    // a field stays if its name holds what is typed, anywhere in it
    const find = this.find.trim().toLowerCase();
    const found = this.fields.filter((f) => f.name.toLowerCase().includes(find));
    // the list is a menu of @corestone/ui: the arrow keys move through it
    const key = found.map((f) => f.id).join("\n");
    if (this.fieldMenu?.key !== key) {
      const items = buildMenu(found.map((f) => ({ label: f.name, run: () => this.edit(f, null) })));
      items.forEach((b, i) => { b.dataset.field = found[i].id; b.dataset.group = found[i].group; });
      this.fieldMenu = { key, items };
    }
    const items = this.fieldMenu.items;
    return html`
     <div class="menu-like qb-col" data-test="query-fields" role="menu" aria-label="Fields">
      <input type="search" class="qb-find" data-test="query-find" placeholder="Find a field…" aria-label="Find a field" .value=${this.find}
        @input=${(e: Event) => { this.find = (e.target as HTMLInputElement).value; }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && found.length) { e.preventDefault(); this.edit(found[0], null); }
          if (e.key === "ArrowDown") { e.preventDefault(); items[0]?.focus(); }
        }} />
      ${found.length ? nothing : html`<div class="muted small qb-none">No field with this name.</div>`}
      ${(["General", "Fields"] as const).map((g) => {
        const group = items.filter((b) => b.dataset.group === g);
        return group.length ? html`<div class="group">${g}</div>${group}` : nothing;
      })}
     </div>
     ${this.history.length ? html`<div class="menu-like qb-col qb-history" data-test="query-history">
      <div class="group">History</div>
      ${[...this.history.filter((h) => h.pinned), ...this.history.filter((h) => !h.pinned)].map((h) => html`<div class="qb-kept">
        <button class="item" data-test="query-history-item" title="Add this criterion again" @click=${() => { this.remember(h.clause); this.place({ ...h.clause, join: "AND" }, null); }}>${h.clause.not ? "NOT " : ""}${clauseLabel(h.clause)}</button>
        <button class="qb-pin ${h.pinned ? "on" : ""}" data-test="query-pin" aria-pressed=${h.pinned ? "true" : "false"}
          title=${h.pinned ? "Pinned: it is kept. Click to let it go with the others." : "Pin: keep it, however many follow"} aria-label="Pin"
          @click=${() => this.keep(this.history.map((x) => (x === h ? { ...x, pinned: !x.pinned } : x)))}>${markIcon("pin", 13)}</button>
      </div>`)}
     </div>` : nothing}`;
  }

  override render() {
    const built = this.clauses.length > 0;
    return html`
      <div class="qf-box ${this.error ? "invalid" : ""}">
        ${this.locked.map((l) => html`<span class="qb-clause qb-locked" data-test="query-locked" title=${l.title}>${markIcon("lock", 12)}<span class="qb-label">${l.label}</span></span>`)}
        <button class="qf-btn" data-test="query-add" title="Add a criterion" aria-label="Add a criterion"
          @click=${(e: Event) => {
            // a second click closes the list: the press already closed it, so it is not opened again
            if (this.open?.kind === "fields") { this.open = null; return; } // a second click closes the list
            this.find = "";
            this.show({ kind: "fields" }, e.currentTarget as HTMLElement);
            void this.updateComplete.then(() => this.querySelector<HTMLInputElement>("[data-test=query-find]")?.focus());
          }}>＋</button>
        ${built ? html`<div class="qb-clauses" data-test="query-clauses">${this.clauses.map((c, i) => html`
            ${i ? html`<button class="qb-join ${c.join.toLowerCase()}" data-test="query-join" title="How the two criteria are joined"
              @click=${(e: Event) => this.show({ kind: "join", index: i }, e.currentTarget as HTMLElement)}>${c.join}</button>` : nothing}
            <span class="qb-clause">
              <button class="qb-not ${c.not ? "on" : ""}" data-test="query-not" aria-pressed=${c.not ? "true" : "false"} title=${c.not ? "Not: switched on" : "Not: switched off"}
                @click=${() => this.built(this.clauses.map((x, j) => (j === i ? { ...x, not: !x.not } : x)))}>NOT</button>
              <button class="qb-label" data-test="query-clause" title="Change" @click=${(e: Event) => this.edit(this.fieldOf(c), i, (e.currentTarget as HTMLElement).parentElement)}>${clauseLabel(c)}</button>
              <button class="qb-remove" data-test="query-remove" aria-label="Remove the criterion" title="Remove" @click=${() => this.built(this.clauses.filter((_, j) => j !== i))}>×</button>
            </span>`)}</div>
          <button class="qf-btn" data-test="query-as-text" title="Edit as text. A text cannot be turned back into criteria." @click=${this.asText}>Aa</button>
          <button class="qf-btn" data-test="query-clear" title="Clear" aria-label="Clear the query" @click=${() => this.built([])}>×</button>`
        : html`<input type="search" placeholder=${this.placeholder} .value=${this.text} data-test="search" aria-label="Search or query"
            aria-invalid=${this.error ? "true" : "false"}
            title="Words find title, ID and text. A query names fields: type:task AND priority:high, status:(open review), NOT finished:true, folder:specs/*"
            @input=${(e: Event) => { this.text = (e.target as HTMLInputElement).value; window.clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.run(true), 250); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this.run(false); }} />`}
      </div>
      ${!this.open && (this.error || this.warnings.length) ? html`<div class="query-notes">
        ${this.error ? html`<div class="query-note error" role="alert" data-test="query-error">${this.error}</div>` : nothing}
        ${this.warnings.map((w) => html`<div class="query-note" data-test="query-warning">${w.message}</div>`)}
      </div>` : nothing}`;
  }
}
