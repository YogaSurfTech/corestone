import { html, nothing } from "lit";
import { DropMenu, errorText, fmtTime, LightElement, type MenuEntry, prefs, relTime } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State, toastError } from "./store";
import type { Kind, Schema, SortLevel, Summary, TableFilter } from "./types";
import { queryFields } from "./components/query-field";
import type { QueryField } from "./components/query-model";
import { fieldValue } from "./components/sorting";
import { hasSource, knownOptions, withMissing } from "./components/options";
import { kindIcon, kindLabel, workflowStates } from "./components/util";
import type { TableColumn, TableContext } from "./components/table";
import "./components/table";
import "./components/type-icon";
import "./components/enum-control";
import "./components/kind-menu";

// Artifact overview (design guide §7.4): every artifact matching the
// navigation context in a server-sorted, lazily loaded table whose columns
// come from the schemas of the rows seen so far.

type Column = TableColumn<Summary>;

/** Column widths and sort order, remembered in the browser for every view. */
interface TableLayout { widths: Record<string, number>; sort: SortLevel[] }

function loadLayout(): TableLayout {
  try {
    const l = prefs.json<Record<string, unknown>>("corestone.table", {});
    const stored: unknown[] = Array.isArray(l.sort) ? l.sort : l.sort ? [l.sort] : [];
    const sort: SortLevel[] = [];
    for (const value of stored) {
      if (typeof value !== "object" || value === null || !("col" in value) || !("dir" in value)) continue;
      if (typeof value.col !== "string" || !value.col || (value.dir !== "asc" && value.dir !== "desc") || sort.some((s) => s.col === value.col)) continue;
      sort.push({ col: value.col, dir: value.dir });
      if (sort.length === 3) break;
    }
    return { widths: l.widths && typeof l.widths === "object" ? l.widths as Record<string, number> : {}, sort };
  } catch { return { widths: {}, sort: [] }; }
}

const schemaKey = (row: Pick<Summary, "folder" | "type">) => JSON.stringify([row.folder, row.type]);

/** The total when the table could not be loaded: its own notice says why. */
const FAILED = -2;

@customElement("corestone-overview")
export class Overview extends LightElement {
  private unsub?: () => void;
  private s!: State;
  @state() private total = -1; // -1 until the table has loaded
  @state() private below = -1; // artifacts including subfolders, when the view shows the folder itself
  @state() private error = "";
  @state() private schemas: Record<string, Schema> = {};
  /** The schema of every (folder, type) among the loaded rows; null when the type is not defined there. */
  @state() private rowSchemas: Record<string, Schema | null> = {};
  @state() private layout = loadLayout();
  private folderTypes = new Map<string, Promise<Schema[]>>();
  private key = "";
  private loads = 0;
  private lastTick = -1;

  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      const r = s.route;
      const key = JSON.stringify([r.folder, r.q, r.subtree, r.kind, r.type]);
      if (key !== this.key || s.refreshTick !== this.lastTick) {
        // A commit may change definitions: resolve them again; the table reloads its rows itself.
        if (s.refreshTick !== this.lastTick) this.folderTypes.clear();
        if (key !== this.key) { this.rowSchemas = {}; this.total = -1; }
        this.key = key;
        this.lastTick = s.refreshTick;
        this.load();
      }
      this.requestUpdate();
    });
  }
  override disconnectedCallback() { this.unsub?.(); this.newMenu.close(); super.disconnectedCallback(); }

  /** The fields the query builder offers: kept while the types, folder and type stay the same. */
  private offered: { key: unknown[]; fields: QueryField[] } | null = null;
  private queryFields(): QueryField[] {
    const r = this.s.route;
    const key = [this.schemas, r.folder, r.type];
    if (!this.offered || this.offered.key.some((k, i) => k !== key[i])) this.offered = { key, fields: queryFields(Object.values(this.schemas), r.folder, r.type) };
    return this.offered.fields;
  }

  private filter(): TableFilter {
    const r = this.s.route;
    return {
      query: r.q || undefined, path: r.folder, subtree: !!r.subtree, type: r.type || undefined,
      kind: r.kind ? [r.kind as Kind] : ["entry", "document"],
    };
  }

  private typesAt(folder: string): Promise<Schema[]> {
    let types = this.folderTypes.get(folder);
    if (!types) {
      types = api.types(folder).then((t) => t.types, () => []);
      this.folderTypes.set(folder, types);
    }
    return types;
  }

  /** The types defined here and, for a folder without subfolders shown, how many artifacts lie below. */
  private async load() {
    const r = this.s.route;
    const load = ++this.loads;
    this.error = "";
    try {
      const [types, deep] = await Promise.all([
        this.typesAt(r.folder),
        // the tree counts subfolders; say so here when the two numbers differ
        r.subtree ? null : api.query({ filter: { ...this.filter(), subtree: true }, limit: 1 }).catch(() => null),
      ]);
      if (load !== this.loads) return;
      this.schemas = Object.fromEntries(types.map((t) => [t.type, t]));
      this.below = deep ? deep.total : -1;
    } catch (e) {
      if (load !== this.loads) return;
      this.error = errorText(e);
    }
  }

  /** Resolve the definitions of newly loaded rows at their own folders. */
  private onRows = async (e: CustomEvent<Summary[]>) => {
    const missing = e.detail.filter((row) => !(schemaKey(row) in this.rowSchemas));
    if (!missing.length) return;
    const key = this.key;
    const folders = [...new Set(missing.map((row) => row.folder))];
    const lists = new Map(await Promise.all(folders.map(async (f) => [f, await this.typesAt(f)] as const)));
    if (key !== this.key) return;
    const next = { ...this.rowSchemas };
    for (const row of missing) next[schemaKey(row)] = lists.get(row.folder)?.find((t) => t.type === row.type) ?? null;
    this.rowSchemas = next;
  };

  /** Opens an artifact from a cell without selecting the row. */
  private open(e: MouseEvent, guid: string) {
    e.stopPropagation();
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ guid, folder: this.s.route.folder, tab: "" });
  }

  private schemaOf(row: Pick<Summary, "folder" | "type">) { return this.rowSchemas[schemaKey(row)] ?? undefined; }

  /** A row's workflow fields with their states, in the order of the type's fields; fields the type does not define come last. */
  private statesOf(row: Summary): [{ id: string; name: string }, string][] {
    const fields = this.schemaOf(row)?.fields ?? [];
    const rank = (id: string) => { const i = fields.findIndex((f) => f.id === id); return i < 0 ? fields.length : i; };
    return workflowStates(row.fields).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([id, st]) => [{ id, name: fields.find((f) => f.id === id)?.name || id }, st]);
  }

  private typeName(row: Pick<Summary, "folder" | "type">, ctx: TableContext) { return this.schemaOf(row)?.displayName ?? ctx.typeName(row); }

  /** What a comment is about: the subject's kind, or a reply to another comment. */
  private commentKind(row: Summary, ctx: TableContext): { kind: Kind | null; title: string } {
    if (row.parent) {
      const author = ctx.related[row.parent]?.author;
      return { kind: "comment", title: author ? `Reply to ${author}'s comment` : "Reply to a comment" };
    }
    const subject = row.subject ? ctx.related[row.subject] : undefined;
    if (!subject) return { kind: null, title: "Subject no longer exists" };
    const article = subject.kind === "entry" ? "an" : "a";
    return { kind: subject.kind, title: `Comment on ${article} ${kindLabel[subject.kind].toLowerCase()}` };
  }

  private endpointLabel(guid: string | undefined, ctx: TableContext): string {
    return guid ? ctx.related[guid]?.hid || guid : "";
  }

  private subjectLabel(row: Summary, ctx: TableContext): string {
    const s = row.subject ? ctx.related[row.subject] : undefined;
    if (!s) return row.subject ?? "";
    if (s.kind !== "link") return [s.hid, s.title].filter(Boolean).join(" ") || s.guid;
    return `${this.endpointLabel(s.source, ctx)} → ${ctx.typeName(s)} → ${this.endpointLabel(s.target, ctx)}`;
  }

  private subject(row: Summary, ctx: TableContext) {
    const s = row.subject ? ctx.related[row.subject] : undefined;
    if (!s) return html`<span class="muted mono" title="This artifact no longer exists">${row.subject ?? "—"}</span>`;
    if (s.kind === "link") return html`${this.endpoint(s.source, ctx)} <a class="muted" href=${"/artifact/" + s.guid} @click=${(e: MouseEvent) => this.open(e, s.guid)}>→ ${ctx.typeName(s)} →</a> ${this.endpoint(s.target, ctx)}`;
    return html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon><a href=${"/artifact/" + s.guid} @click=${(e: MouseEvent) => this.open(e, s.guid)}>${s.hid ? html`<span class="hid">${s.hid}</span> ` : nothing}${s.title || s.guid}</a>`;
  }

  private endpoint(guid: string | undefined, ctx: TableContext) {
    if (!guid) return html`<span class="muted">—</span>`;
    const s = ctx.related[guid];
    return html`${s ? html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>` : nothing}<a href=${"/artifact/" + guid} @click=${(e: MouseEvent) => this.open(e, guid)}>${this.endpointLabel(guid, ctx)}</a>`;
  }

  /** Link and comment rows show what they connect instead of generic artifact identity. */
  private columns(): Column[] {
    const type = (row: Summary, ctx: TableContext) => this.typeName(row, ctx);
    const links = this.s.route.kind === "link";
    const comments = this.s.route.kind === "comment";
    const created: Column = { id: "$created", name: "Created", cls: "muted", title: (row) => fmtTime(row.createdAt), render: (row) => relTime(row.createdAt) };
    const author: Column = { id: "$author", name: "Author", render: (row) => row.author || "\u2014" };
    return [
      ...(links ? [
        { id: "$source", name: "From", render: (row, ctx) => this.endpoint(row.source, ctx) },
        { id: "$role", name: "Role", render: type },
        { id: "$target", name: "To", render: (row, ctx) => this.endpoint(row.target, ctx) },
      ] satisfies Column[] : comments ? [
        { id: "$type", name: "Type", cls: "kind-cell", title: type,
          render: (row) => html`<corestone-type-icon .kind=${row.kind} .type=${row.type} .folder=${row.folder} .schema=${this.schemaOf(row) ?? null}></corestone-type-icon>` },
        { id: "$kind", name: "Kind", cls: "kind-cell",
          render: (row, ctx) => { const { kind, title } = this.commentKind(row, ctx); return kind ? kindIcon(kind, title) : html`<span class="muted" title=${title}>?</span>`; } },
        { id: "$subject", name: "On", title: (row, ctx) => this.subjectLabel(row, ctx), render: (row, ctx) => this.subject(row, ctx) },
        { id: "$excerpt", name: "Comment", title: (row) => row.excerpt ?? "", render: (row) => row.excerpt ?? "" },
        author,
      ] satisfies Column[] : [
        { id: "$hid", name: "ID",
          render: (row) => row.hid ? html`<span class="hid">${row.hid}</span>` : html`<span class="muted mono">${row.guid.slice(0, 8)}</span>` },
        { id: "$title", name: "Title", title: (row) => row.title ?? "",
          render: (row) => html`<corestone-type-icon .kind=${row.kind} .type=${row.type} .folder=${row.folder} .schema=${this.schemaOf(row) ?? null}></corestone-type-icon>${row.title || html`<span class="muted">${row.kind}</span>`}` },
        { id: "$type", name: "Type", render: type },
        { id: "$state", name: "State",
          render: (row) => html`${this.statesOf(row).map(([w, st]) => html`<span class="pill state" data-field=${w.id} title=${w.name}>${st}</span> `)}` },
      ] satisfies Column[]),
      ...this.fieldColumns().map((c): Column => ({ ...c,
        render: (row) => {
          const field = this.schemaOf(row)?.fields?.find((f) => f.id === c.id);
          const value = fieldValue(row, c.id);
          const options = field && hasSource(field) ? withMissing(knownOptions(row.type, field.id, row.folder, () => this.requestUpdate()) ?? [], row.fields?.[c.id]) : field?.options ?? [];
          return field?.type === "enum" ? html`<corestone-enum .options=${options} .value=${row.fields?.[c.id]}
            .folder=${row.folder} .readonly=${true}></corestone-enum>` : String(value ?? "");
        } })),
      ...(links ? [
        author,
        created,
        { id: "$modified", name: "Updated", cls: "muted", title: (row) => fmtTime(row.modifiedAt), render: (row) => relTime(row.modifiedAt) },
      ] satisfies Column[] : comments ? [
        created,
        { id: "$details", name: "", sortable: false, render: (row) => html`<button class="btn sm" data-test="comment-details"
          title="Open this comment on its own" @click=${(e: MouseEvent) => this.open(e, row.guid)}>Details</button>` },
      ] satisfies Column[] : [
        { id: "$folder", name: "Folder", cls: "muted", render: (row) => row.folder || "/" },
        { id: "$social", name: "Social", cls: "social", title: () => "links · comments", render: (row) => `⇄ ${row.links} · ✎ ${row.comments}` },
        { id: "$modified", name: "Modified", cls: "muted", render: (row) => relTime(row.modifiedAt) },
      ] satisfies Column[]),
    ];
  }

  /** The columns the schemas of the loaded rows declare for the overview. */
  private fieldColumns(): { id: string; name: string }[] {
    const schemas = Object.values(this.rowSchemas).filter((s): s is Schema => !!s);
    const all = this.s.route.kind === "link" || this.s.route.kind === "comment";
    const wanted = new Set<string>();
    for (const s of schemas) {
      for (const c of (s.presentation?.columns as string[] | undefined) ?? []) wanted.add(c);
      if (all) for (const field of s.fields ?? []) wanted.add(field.id);
    }
    return [...wanted].map((id) => {
      const f = schemas.flatMap((s) => s.fields ?? []).find((x) => x.id === id);
      return { id, name: f?.name || id };
    });
  }

  private saveLayout(layout: TableLayout) {
    this.layout = layout;
    prefs.setJson("corestone.table", layout);
  }

  /** What the count counts: "Task entries", "entries and docs", "links". */
  private counted(n: number): string {
    const r = this.s.route;
    const one = n === 1;
    const kind = r.kind === "document" ? (one ? "document" : "documents") : r.kind === "link" ? (one ? "link" : "links")
      : r.kind === "comment" ? (one ? "comment" : "comments") : r.kind === "entry" || r.type ? (one ? "entry" : "entries")
      : one ? "entry or doc" : "entries and docs";
    return r.type ? `${this.schemas[r.type]?.displayName ?? r.type} ${kind}` : kind;
  }

  override render() {
    if (!this.s) return nothing;
    const r = this.s.route;
    const cols = this.columns();
    // Built-in columns of other views cannot sort this one; field ids always can.
    const sort = this.layout.sort.filter((l) => !l.col.startsWith("$") || cols.some((c) => c.id === l.col && c.sortable !== false));
    const sel = r.guid;
    const total = this.total;
    return html`
      <div class="toolbar">
        <div class="relative">
          <button class="btn primary" data-test="new" aria-haspopup="menu" aria-expanded="false"
            @click=${(e: Event) => this.newMenu.toggle(e.currentTarget as HTMLElement)}>＋ New</button>
        </div>
        <corestone-query-field class="query-field" .value=${r.q} .folder=${r.folder} .fields=${this.queryFields()}
          @query-change=${(e: CustomEvent<{ text: string; replace: boolean }>) => navigate({ q: e.detail.text, guid: null }, e.detail.replace)}></corestone-query-field>
        <span class="hint" data-test="count">${total === FAILED ? "not searched" : total < 0 ? "loading…" : html`${total} ${this.counted(total)}${r.subtree ? " incl. subfolders"
          : this.below > total ? html` here, <a href="#" data-test="show-subtree" @click=${(e: Event) => { e.preventDefault(); navigate({ subtree: true }); }}>${this.below} incl. subfolders</a>` : ""}`}</span>
        <corestone-kind-menu .kind=${r.kind} @kind-change=${(e: CustomEvent<string>) => navigate({ kind: e.detail, type: r.type })}></corestone-kind-menu>
        ${r.folder && !r.q && !r.type ? html`<button class="btn sm" data-test="move-folder" title="Move or rename this folder" @click=${this.moveFolder}>Move folder…</button>` : nothing}
        <button class="btn sm" title="Reload" aria-label="Reload overview" @click=${() => store.refresh()}>↻</button>
      </div>
      ${this.error ? html`<div class="notice error">${this.error}</div>` : nothing}
      ${total === 0 ? html`<div class="empty-state"><div class="big">Nothing here yet</div>
        ${r.q ? "No artifacts match your search." : html`Create your first artifact with <b>＋ New</b>, or pick another folder.`}</div>` : nothing}
      <corestone-table class="table-wrap" ?hidden=${total === 0} resizable allFields empty=""
        .columns=${cols} .filter=${this.filter()} .sort=${sort} .widths=${this.layout.widths}
        .selected=${(row: Summary) => row.guid === sel || (r.kind === "comment" && !!sel && row.subject === sel)}
        @table-load=${(e: CustomEvent<{ total: number }>) => (this.total = e.detail.total)}
        @table-error=${() => (this.total = FAILED)}
        @rows-load=${this.onRows}
        @sort-change=${(e: CustomEvent<SortLevel[]>) => this.saveLayout({ ...this.layout, sort: e.detail })}
        @widths-change=${(e: CustomEvent<Record<string, number>>) => this.saveLayout({ ...this.layout, widths: e.detail })}
        @row-click=${(e: CustomEvent<Summary>) => { const row = e.detail; if (row.kind === "comment" && row.subject) navigate({ guid: row.subject, folder: r.folder, tab: "comments" }); else navigate({ guid: row.guid, folder: r.folder }); }}></corestone-table>`;
  }

  private moveFolder = () => {
    const from = this.s.route.folder;
    store.prompt(`Move folder ${from}`, { text: "New location of the folder and everything below it.", value: from, confirmLabel: "Move", folder: true, ignore: from }).then((to) => {
      if (to === null || to.trim() === from) return;
      api.moveFolder(from, to.trim()).then((res) => {
        store.toast(`Moved ${res.moved} file${res.moved === 1 ? "" : "s"} to ${to.trim() || "/"}`, "success");
        store.refresh();
        navigate({ folder: to.trim().replace(/^\/+|\/+$/g, ""), guid: null });
      }).catch(toastError);
    });
  };

  /** What can be made here: only the kinds that have types in this folder. */
  private readonly newMenu = new DropMenu({
    label: "New", cls: "new-pop",
    items: (): MenuEntry[] => {
      const folder = this.s.route.folder;
      const open = (opts: Record<string, unknown>) => store.set({ dialog: { kind: "new", folder, ...opts } });
      const kinds = new Set(Object.values(this.schemas).map((s) => s.kind));
      const all: [Kind, string, string][] = [["entry", "new-entry", "Entry…"], ["document", "new-document", "Document…"], ["link", "new-link", "Link between artifacts…"], ["comment", "new-comment", "Comment…"]];
      const items: MenuEntry[] = all.filter(([k]) => kinds.has(k)).map(([k, test, label]) => ({ label, test, run: () => open({ kinds: [k] }) }));
      if (!items.length) items.push({ label: "No types are defined in this folder.", test: "no-types", disabled: true });
      items[0].group = `in ${folder || "/"}`;
      return [...items, { label: "Choose a type…", test: "new-any", group: "any", run: () => open({}) }];
    },
  });
}
