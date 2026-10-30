import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, ApiError } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { Kind, Schema, Summary, Workflow } from "./types";
import { compare, fieldSortValue, fieldValue, workflowKey, workflowSortValue, type SortValue } from "./sorting";
import { fmtTime, kindIcon, kindLabel, relTime } from "./util";
import "./type-icon";
import "./enum-control";
import { overviewDefinitions, schemaKey } from "./overview-definitions";

// Artifact overview (design guide §7.4): every artifact matching the
// navigation context in a table whose columns come from the schemas.

const LIMIT = 1000; // rows loaded per view; sorting happens on these in the client
const DEFAULT_COL_W = 150, MIN_COL_W = 48, MAX_COL_W = 1200;

/** A table column. Built-in ids start with "$" so they never collide with schema field ids. */
interface Column {
  id: string;
  name: string;
  value: (row: Summary) => SortValue; // what the column sorts by
  render: (row: Summary) => TemplateResult | string;
  cls?: string;
  title?: (row: Summary) => string;
}

/** Column widths and sort order, remembered in the browser for every view. */
interface SortLevel { col: string; dir: "asc" | "desc" }
interface TableLayout { widths: Record<string, number>; sort: SortLevel[] }

function loadLayout(): TableLayout {
  try {
    const l = JSON.parse(localStorage.getItem("corestone.table") ?? "{}");
    const stored: unknown[] = Array.isArray(l.sort) ? l.sort : l.sort ? [l.sort] : [];
    const sort: SortLevel[] = [];
    for (const value of stored) {
      if (typeof value !== "object" || value === null || !("col" in value) || !("dir" in value)) continue;
      if (typeof value.col !== "string" || !value.col || (value.dir !== "asc" && value.dir !== "desc") || sort.some((s) => s.col === value.col)) continue;
      sort.push({ col: value.col, dir: value.dir });
      if (sort.length === 3) break;
    }
    return { widths: l.widths && typeof l.widths === "object" ? l.widths : {}, sort };
  } catch { return { widths: {}, sort: [] }; }
}

@customElement("corestone-overview")
export class Overview extends LitElement {
  private unsub?: () => void;
  private s!: State;
  @state() private rows: Summary[] = [];
  @state() private total = 0;
  @state() private below = 0; // artifacts including subfolders, when the view shows the folder itself
  @state() private loading = false;
  @state() private error = "";
  @state() private schemas: Record<string, Schema> = {};
  @state() private rowSchemas: Record<string, Schema> = {};
  @state() private workflows: Record<string, Workflow> = {};
  @state() private endpoints: Record<string, Summary> = {};
  @state() private menu = false;
  @state() private layout = loadLayout();
  private sorted?: { rows: Summary[]; key: unknown[]; out: Summary[] };
  private key = "";
  private loads = 0;
  private rowsKind = ""; // the kind this.rows were loaded for; columns follow the route
  private lastTick = -1;

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      const r = s.route;
      const key = JSON.stringify([r.folder, r.q, r.subtree, r.kind, r.type, s.refreshTick]);
      if (key !== this.key || s.refreshTick !== this.lastTick) {
        this.key = key;
        this.lastTick = s.refreshTick;
        this.load();
      }
      this.requestUpdate();
    });
    document.addEventListener("click", this.closeMenu);
  }
  override disconnectedCallback() { this.unsub?.(); document.removeEventListener("click", this.closeMenu); super.disconnectedCallback(); }
  private closeMenu = () => { if (this.menu) this.menu = false; };

  private async load() {
    const r = this.s.route;
    const load = ++this.loads;
    this.loading = true;
    this.error = "";
    try {
      const params: Record<string, string | number | boolean | undefined> = {
        q: r.q, path: r.folder, subtree: r.subtree, type: r.type,
        kind: r.kind || "entry,document", limit: LIMIT, sort: r.q ? "" : r.kind === "comment" ? "created" : "path",
      };
      const direct = !params.subtree;
      const [res, types, deep] = await Promise.all([
        api.search(params), api.types(r.folder),
        // the tree counts subfolders; say so here when the two numbers differ
        direct ? api.search({ ...params, subtree: true, limit: 1 }).catch(() => null) : null,
      ]);
      const map: Record<string, Schema> = {};
      for (const t of types.types) map[t.type] = t;
      const linkEnds = res.artifacts.filter((row) => row.kind === "link").flatMap((row) => [row.source, row.target]);
      const subjects = res.artifacts.filter((row) => row.kind === "comment").map((row) => row.subject);
      const [definitions, endpoints, subjectRows] = await Promise.all([
        overviewDefinitions(res.artifacts, r.folder, types.types),
        this.summaries(linkEnds, (guid) => store.toast(`Link endpoint ${guid} was not found`, "error")),
        this.summaries(subjects),
      ]);
      // Comments on links show the link as From → role → To.
      const linkSubjects = subjectRows.filter((s) => s.kind === "link");
      const [subjectEnds, subjectDefs] = linkSubjects.length ? await Promise.all([
        this.summaries(linkSubjects.flatMap((s) => [s.source, s.target])),
        overviewDefinitions(linkSubjects, r.folder, types.types),
      ]) : [[], { schemas: {} }];
      if (load !== this.loads) return;
      this.rowsKind = r.kind ?? "";
      this.endpoints = Object.fromEntries([...endpoints, ...subjectRows, ...subjectEnds].map((endpoint) => [endpoint.guid, endpoint]));
      this.rows = res.artifacts;
      this.total = res.total;
      this.below = deep ? deep.total : res.total;
      this.schemas = map;
      this.rowSchemas = { ...subjectDefs.schemas, ...definitions.schemas };
      this.workflows = definitions.workflows;
    } catch (e) {
      if (load !== this.loads) return;
      this.error = String((e as Error).message ?? e);
      this.rows = [];
    } finally {
      if (load === this.loads) this.loading = false;
    }
  }

  private endpointLabel(guid?: string): string {
    return guid ? this.endpoints[guid]?.hid || guid : "";
  }

  /** Summaries of distinct artifacts; missing ones are left out (and reported through onMissing). */
  private async summaries(guids: (string | undefined)[], onMissing?: (guid: string) => void): Promise<Summary[]> {
    const found = await Promise.all([...new Set(guids.filter((guid): guid is string => !!guid))].map(async (guid) => {
      try { return (await api.get(guid)).meta; }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        onMissing?.(guid);
        return null;
      }
    }));
    return found.filter((s): s is Summary => s !== null);
  }

  /** Opens an artifact from a cell without selecting the row. */
  private open(e: MouseEvent, guid: string) {
    e.stopPropagation();
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ guid, folder: this.s.route.folder, tab: "" });
  }

  /** What a comment is about: the subject's kind, or a reply to another comment. */
  private commentKind(row: Summary): { kind: Kind | null; title: string } {
    if (row.parent) {
      const author = this.rows.find((r) => r.guid === row.parent)?.author;
      return { kind: "comment", title: author ? `Reply to ${author}'s comment` : "Reply to a comment" };
    }
    const subject = row.subject ? this.endpoints[row.subject] : undefined;
    if (!subject) return { kind: null, title: "Subject no longer exists" };
    const article = subject.kind === "entry" ? "an" : "a";
    return { kind: subject.kind, title: `Comment on ${article} ${kindLabel[subject.kind].toLowerCase()}` };
  }

  private subjectLabel(row: Summary): string {
    const s = row.subject ? this.endpoints[row.subject] : undefined;
    if (!s) return row.subject ?? "";
    if (s.kind !== "link") return [s.hid, s.title].filter(Boolean).join(" ") || s.guid;
    return `${this.endpointLabel(s.source)} → ${this.rowSchemas[schemaKey(s)]?.displayName ?? s.type} → ${this.endpointLabel(s.target)}`;
  }

  private subject(row: Summary) {
    const s = row.subject ? this.endpoints[row.subject] : undefined;
    if (!s) return html`<span class="muted mono" title="This artifact no longer exists">${row.subject ?? "—"}</span>`;
    if (s.kind === "link") return html`${this.endpoint(s.source)} <a class="muted" href=${"/artifact/" + s.guid} @click=${(e: MouseEvent) => this.open(e, s.guid)}>→ ${this.rowSchemas[schemaKey(s)]?.displayName ?? s.type} →</a> ${this.endpoint(s.target)}`;
    return html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon><a href=${"/artifact/" + s.guid} @click=${(e: MouseEvent) => this.open(e, s.guid)}>${s.hid ? html`<span class="hid">${s.hid}</span> ` : nothing}${s.title || s.guid}</a>`;
  }

  private endpoint(guid?: string) {
    if (!guid) return html`<span class="muted">—</span>`;
    const s = this.endpoints[guid];
    return html`${s ? html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>` : nothing}<a href=${"/artifact/" + guid} @click=${(e: MouseEvent) => this.open(e, guid)}>${this.endpointLabel(guid)}</a>`;
  }

  /** Link and comment rows show what they connect instead of generic artifact identity. */
  private columns(): Column[] {
    const type = (row: Summary) => this.rowSchemas[schemaKey(row)]?.displayName ?? row.type;
    const links = this.s.route.kind === "link";
    const comments = this.s.route.kind === "comment";
    const kindOrder: Record<Kind, number> = { entry: 1, document: 2, link: 3, comment: 4 };
    const created: Column = { id: "$created", name: "Created", cls: "muted", value: (row) => row.createdAt ? Date.parse(row.createdAt) || null : null,
      title: (row) => fmtTime(row.createdAt), render: (row) => relTime(row.createdAt) };
    const author: Column = { id: "$author", name: "Author", value: (row) => row.author || null, render: (row) => row.author || "\u2014" };
    return [
      ...(links ? [
        { id: "$source", name: "From", value: (row: Summary) => this.endpointLabel(row.source), render: (row: Summary) => this.endpoint(row.source) },
        { id: "$role", name: "Role", value: type, render: type },
        { id: "$target", name: "To", value: (row: Summary) => this.endpointLabel(row.target), render: (row: Summary) => this.endpoint(row.target) },
      ] : comments ? [
        { id: "$kind", name: "Kind", cls: "kind-cell", value: (row) => { const k = this.commentKind(row).kind; return k ? kindOrder[k] : null; },
          render: (row) => { const { kind, title } = this.commentKind(row); return kind ? kindIcon(kind, title) : html`<span class="muted" title=${title}>?</span>`; } },
        { id: "$subject", name: "On", value: (row) => this.subjectLabel(row), title: (row) => this.subjectLabel(row), render: (row) => this.subject(row) },
        { id: "$excerpt", name: "Comment", value: (row) => row.excerpt || null, title: (row) => row.excerpt ?? "", render: (row) => row.excerpt ?? "" },
        author,
        ...(new Set(this.rows.map((row) => row.type)).size > 1 ? [{ id: "$type", name: "Type", value: type, render: type }] : []),
      ] satisfies Column[] : [
      { id: "$hid", name: "ID", value: (row) => row.hid || row.guid,
        render: (row) => row.hid ? html`<span class="hid">${row.hid}</span>` : html`<span class="muted mono">${row.guid.slice(0, 8)}</span>` },
      { id: "$title", name: "Title", value: (row) => row.title || row.kind, title: (row) => row.title ?? "",
        render: (row) => html`<corestone-type-icon .kind=${row.kind} .type=${row.type} .folder=${row.folder} .schema=${this.rowSchemas[schemaKey(row)] ?? null}></corestone-type-icon>${row.title || html`<span class="muted">${row.kind}</span>`}` },
      { id: "$type", name: "Type", value: type, render: type },
      { id: "$state", name: "State", value: (row) => workflowSortValue(row, this.rowSchemas[schemaKey(row)], (id) => this.workflows[workflowKey(row, id)]),
        render: (row) => html`${Object.entries(row.workflows ?? {}).map(([w, st]) => html`<span class="pill state" title=${w}>${st}</span> `)}` },
      ] satisfies Column[]),
      ...this.fieldColumns().map((c): Column => ({ ...c,
        value: (row) => fieldSortValue(row, c.id, this.rowSchemas[schemaKey(row)], (id) => this.workflows[workflowKey(row, id)]),
        render: (row) => {
          const field = this.rowSchemas[schemaKey(row)]?.fields?.find((f) => f.id === c.id);
          const value = fieldValue(row, c.id);
          return field?.type === "enum" ? html`<corestone-enum .options=${field.options ?? []} .value=${row.fields?.[c.id]}
            .folder=${row.folder} .readonly=${true}></corestone-enum>` : String(value ?? "");
        } })),
      ...(links ? [
        author,
        created,
        { id: "$modified", name: "Updated", cls: "muted", value: (row) => row.modifiedAt ? Date.parse(row.modifiedAt) || null : null,
          title: (row) => fmtTime(row.modifiedAt), render: (row) => relTime(row.modifiedAt) },
      ] satisfies Column[] : comments ? [
        created,
        { id: "$details", name: "", value: () => null, render: (row) => html`<button class="btn sm" data-test="comment-details"
          title="Open this comment on its own" @click=${(e: MouseEvent) => this.open(e, row.guid)}>Details</button>` },
      ] satisfies Column[] : [
      { id: "$folder", name: "Folder", cls: "muted", value: (row) => row.folder, render: (row) => row.folder || "/" },
      { id: "$social", name: "Social", cls: "social", value: (row) => row.links, title: () => "links · comments",
        render: (row) => `⇄ ${row.links} · ✎ ${row.comments}` },
      { id: "$modified", name: "Modified", cls: "muted", value: (row) => (row.modifiedAt ? Date.parse(row.modifiedAt) || null : null), render: (row) => relTime(row.modifiedAt) },
      ] satisfies Column[]),
    ];
  }

  /** The columns the schemas of the listed artifacts declare for the overview. */
  private fieldColumns(): { id: string; name: string }[] {
    const cols = new Map<string, string>();
    const wanted = new Set<string>();
    for (const row of this.rows) {
      const s = this.rowSchemas[schemaKey(row)];
      const pres = (s?.presentation?.columns as string[] | undefined) ?? [];
      for (const c of pres) wanted.add(c);
      if (this.s.route.kind === "link" || this.s.route.kind === "comment") for (const field of s?.fields ?? []) wanted.add(field.id);
    }
    for (const id of wanted) {
      for (const s of Object.values(this.rowSchemas)) {
        const f = s.fields?.find((x) => x.id === id);
        if (f) cols.set(id, f.name || id);
      }
      if (!cols.has(id)) cols.set(id, id);
    }
    return [...cols].map(([id, name]) => ({ id, name }));
  }

  /** The rows in the chosen order; ties keep the server's order. */
  private sortedRows(cols: Column[]): Summary[] {
    const levels = this.layout.sort.flatMap((sort) => {
      const col = cols.find((c) => c.id === sort.col);
      return col ? [{ col, dir: sort.dir === "asc" ? 1 : -1 }] : [];
    });
    if (!levels.length) return this.rows;
    const key = [JSON.stringify(this.layout.sort), this.rowSchemas, this.workflows, this.endpoints];
    if (this.sorted?.rows === this.rows && this.sorted.key.every((k, i) => k === key[i])) return this.sorted.out;
    const out = this.rows.map((row) => ({ row, values: levels.map((level) => level.col.value(row)) })).sort((a, b) => {
      for (let i = 0; i < levels.length; i++) {
        const result = compare(a.values[i], b.values[i], levels[i].dir);
        if (result) return result;
      }
      return 0;
    }).map((x) => x.row);
    this.sorted = { rows: this.rows, key, out };
    return out;
  }

  private saveLayout(layout: TableLayout) {
    this.layout = layout;
    localStorage.setItem("corestone.table", JSON.stringify(layout));
  }

  /** Promote a column, retaining two tie-breakers; only the primary toggles direction. */
  private toggleSort(col: string) {
    const levels = this.layout.sort;
    const previous = levels.find((level) => level.col === col);
    const dir = levels[0]?.col === col ? (levels[0].dir === "asc" ? "desc" : "asc") : previous?.dir ?? "asc";
    this.saveLayout({ ...this.layout, sort: [{ col, dir }, ...levels.filter((level) => level.col !== col)].slice(0, 3) });
  }

  private setWidth(widths: Record<string, number>, col: string, px: number, persist = true) {
    const next = { ...widths, [col]: Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, px))) };
    if (persist) this.saveLayout({ ...this.layout, widths: next });
    else this.layout = { ...this.layout, widths: next };
  }

  /** The first resize fixes every visible column at its current width, so only the dragged one moves. */
  private frozenWidths(): Record<string, number> {
    const widths = { ...this.layout.widths };
    for (const th of this.querySelectorAll<HTMLElement>("table.grid th[data-col]")) widths[th.dataset.col!] ??= Math.ceil(th.getBoundingClientRect().width) + 1; // rounding down would clip cells that just fit
    return widths;
  }

  private dragWidth = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const th = handle.parentElement!;
    const col = th.dataset.col!;
    const widths = this.frozenWidths();
    const startX = e.clientX, start = th.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    this.setWidth(widths, col, start, false);
    const move = (m: PointerEvent) => this.setWidth(widths, col, start + m.clientX - startX, false);
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      this.saveLayout(this.layout);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
    e.preventDefault();
    e.stopPropagation();
  };

  /** Double-click on a column edge: fit the column to its widest cell. */
  private fitWidth = (e: MouseEvent) => {
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLTableCellElement;
    const i = th.cellIndex;
    // A range measures the content itself; scrollWidth never reports less than the current column width.
    const range = document.createRange();
    const content = (el: Element) => { range.selectNodeContents(el); return range.getBoundingClientRect().width; };
    let w = content(th.querySelector(".th-sort")!) + 32; // padding and the sort marker
    for (const tr of this.querySelectorAll<HTMLTableRowElement>("table.grid tbody tr")) if (tr.cells[i]) w = Math.max(w, content(tr.cells[i]) + 20);
    this.setWidth(this.frozenWidths(), th.dataset.col!, Math.ceil(w) + 2);
  };

  private context(): string {
    const r = this.s.route;
    if (r.q) return `Search “${r.q}”`;
    if (r.type) return `${this.schemas[r.type]?.displayName ?? r.type} · all ${r.kind === "document" ? "documents" : "entries"}`;
    return r.folder ? r.folder.split("/").pop()! : "Repository";
  }

  override render() {
    if (!this.s) return nothing;
    const r = this.s.route;
    const cols = this.columns();
    const rows = this.rowsKind === (r.kind ?? "") ? this.sortedRows(cols) : [];
    const { widths } = this.layout;
    const sort = this.layout.sort.find((level) => cols.some((col) => col.id === level.col));
    // Once any visible column has a width, the layout is fixed and a filler column takes the rest.
    const fixed = cols.some((c) => widths[c.id]);
    const total = cols.reduce((sum, c) => sum + (widths[c.id] ?? DEFAULT_COL_W), 0);
    const sel = r.guid;
    return html`
      <div class="toolbar">
        <div class="relative">
          <button class="btn primary" data-test="new" @click=${(e: Event) => { e.stopPropagation(); this.menu = !this.menu; }}>＋ New</button>
          ${this.menu ? this.newMenu() : nothing}
        </div>
        <span class="title">${this.context()}</span>
        <span class="hint">${this.loading ? "loading…" : html`${this.total} artifact${this.total === 1 ? "" : "s"}${r.subtree ? " incl. subfolders"
          : this.below > this.total ? html` here, <a href="#" data-test="show-subtree" @click=${(e: Event) => { e.preventDefault(); navigate({ subtree: true }); }}>${this.below} incl. subfolders</a>` : ""}${
          this.rows.length < this.total ? html` · <span data-test="partial">showing ${this.rows.length}${sort ? ", sorted within these" : ""}</span>` : nothing}`}</span>
        <span class="grow"></span>
        <div class="chips">
          ${[["", "Entries + Docs"], ["entry", "Entries"], ["document", "Documents"], ["link", "Links"], ["comment", "Comments"]].map(([k, name]) => html`
            <button class="chip ${r.kind === k ? "on" : ""}" @click=${() => navigate({ kind: k, type: k ? r.type : r.type })}>${name}</button>`)}
        </div>
        ${r.folder && !r.q && !r.type ? html`<button class="btn sm" data-test="move-folder" title="Move or rename this folder" @click=${this.moveFolder}>Move folder…</button>` : nothing}
        <button class="btn sm" title="Reload" aria-label="Reload overview" @click=${() => store.refresh()}>↻</button>
      </div>
      ${this.error ? html`<div class="notice error">${this.error}</div>` : nothing}
      <div class="table-wrap">
        ${!this.loading && !this.rows.length ? html`<div class="empty-state"><div class="big">Nothing here yet</div>
          ${r.q ? "No artifacts match your search." : html`Create your first artifact with <b>＋ New</b>, or pick another folder.`}</div>` : html`
        <table class="grid ${fixed ? "fixed" : ""}" style=${fixed ? `min-width:${total}px` : ""}>
          ${fixed ? html`<colgroup>${cols.map((c) => html`<col style=${`width:${widths[c.id] ?? DEFAULT_COL_W}px`}>`)}<col></colgroup>` : nothing}
          <thead><tr>${cols.map((c) => html`<th data-col=${c.id} aria-sort=${sort?.col === c.id ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
            <button class="th-sort" title="Sort by ${c.name}" @click=${() => this.toggleSort(c.id)}>${c.name}</button>
            <span class="col-resize" title="Drag to resize; double-click to fit" @pointerdown=${this.dragWidth} @dblclick=${this.fitWidth} @click=${(e: Event) => e.stopPropagation()}></span></th>`)}
            ${fixed ? html`<th class="filler"></th>` : nothing}</tr></thead>
          <tbody>${rows.map((row) => html`<tr class=${row.guid === sel || (r.kind === "comment" && !!sel && row.subject === sel) ? "selected" : ""} data-guid=${row.guid}
            @click=${() => row.kind === "comment" && row.subject ? navigate({ guid: row.subject, folder: r.folder, tab: "comments" }) : navigate({ guid: row.guid, folder: r.folder })}>
            ${cols.map((c) => html`<td class=${c.cls ?? ""} title=${c.title?.(row) ?? nothing}>${c.render(row)}</td>`)}${fixed ? html`<td></td>` : nothing}</tr>`)}</tbody>
        </table>`}
      </div>`;
  }

  private moveFolder = () => {
    const from = this.s.route.folder;
    store.prompt(`Move folder ${from}`, { text: "New location of the folder and everything below it.", value: from, confirmLabel: "Move", folder: true, ignore: from }).then((to) => {
      if (to === null || to.trim() === from) return;
      api.moveFolder(from, to.trim()).then((res) => {
        store.toast(`Moved ${res.moved} file${res.moved === 1 ? "" : "s"} to ${to.trim() || "/"}`, "success");
        store.refresh();
        navigate({ folder: to.trim().replace(/^\/+|\/+$/g, ""), guid: null });
      }).catch((e) => store.toast(e.message, "error"));
    });
  };

  private newMenu() {
    const r = this.s.route;
    const open = (opts: Record<string, unknown>) => { this.menu = false; store.set({ dialog: { kind: "new", folder: r.folder, ...opts } }); };
    // Only the kinds that have types here: a kind without types is not available in this folder.
    const kinds = new Set(Object.values(this.schemas).map((s) => s.kind));
    const items: [Kind, string, string][] = [["entry", "new-entry", "Entry…"], ["document", "new-document", "Document…"], ["link", "new-link", "Link between artifacts…"], ["comment", "new-comment", "Comment…"]];
    return html`<div class="menu" @click=${(e: Event) => e.stopPropagation()}>
      <div class="group">in ${r.folder || "/"}</div>
      ${items.filter(([k]) => kinds.has(k)).map(([k, test, name]) => html`<button class="item" data-test=${test} @click=${() => open({ kinds: [k] })}>${name}</button>`)}
      ${kinds.size ? nothing : html`<div class="item muted" data-test="no-types">No types are defined in this folder.</div>`}
      <div class="group">any</div>
      <button class="item" data-test="new-any" @click=${() => open({})}>Choose a type…</button>
    </div>`;
  }
}
