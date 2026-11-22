import type { ReactiveController, ReactiveControllerHost } from "lit";
import { popupMenu, prefs, type MenuEntry } from "@corestone/ui";
import type { SortLevel } from "../types";
import type { TableColumn } from "./table";

// What a table shows: which columns, in which order, sorted how and how wide:
// its layout. A table keeps the layout it shows, and any number of saved views
// (named layouts) to switch to; one of them can be the view it starts with.
// All of it is kept in the browser, per table (and per kind of the overview).

/** Which columns, in which order, how wide, sorted how. */
export interface TableLayout {
  widths: Record<string, number>;
  sort: SortLevel[];
  /** Column ids in the order shown; columns not named keep their place after them. */
  order: string[];
  /** Shown (true) or hidden (false); columns not named follow their default. */
  visible: Record<string, boolean>;
}

export interface SavedView { name: string; layout: TableLayout }

interface Kept { layout: TableLayout; views: SavedView[]; active: string; start: string }

export const emptyLayout = (): TableLayout => ({ widths: {}, sort: [], order: [], visible: {} });

/** A layout from storage; anything unreadable is left out. */
export function readLayout(l: unknown): TableLayout {
  if (!l || typeof l !== "object") return emptyLayout();
  const o = l as Record<string, unknown>;
  const stored: unknown[] = Array.isArray(o.sort) ? o.sort : [];
  const sort: SortLevel[] = [];
  for (const value of stored) {
    if (typeof value !== "object" || value === null || !("col" in value) || !("dir" in value)) continue;
    if (typeof value.col !== "string" || !value.col || (value.dir !== "asc" && value.dir !== "desc") || sort.some((s) => s.col === value.col)) continue;
    sort.push({ col: value.col, dir: value.dir });
    if (sort.length === 3) break;
  }
  const record = <T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<string, T> : {};
  return {
    widths: record(o.widths, (x): x is number => typeof x === "number" && x > 0),
    sort,
    order: Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === "string") : [],
    visible: record(o.visible, (x): x is boolean => typeof x === "boolean"),
  };
}

function readKept(key: string): Kept {
  let v: Record<string, unknown> = {};
  try { v = prefs.json<Record<string, unknown>>(key, {}) ?? {}; } catch { /* nothing kept */ }
  const views = Array.isArray(v.views) ? v.views.flatMap((x) => x && typeof x === "object" && typeof (x as SavedView).name === "string" && (x as SavedView).name.trim()
    ? [{ name: (x as SavedView).name.trim(), layout: readLayout((x as SavedView).layout) }] : []) : [];
  const named = (n: unknown) => typeof n === "string" && views.some((x) => x.name === n) ? n : "";
  return { layout: readLayout(v.layout), views, active: named(v.active), start: named(v.start) };
}

/** Whether a column is shown in a layout: as chosen, else by its default. */
export function shown(c: Pick<TableColumn, "id" | "hidden">, l: TableLayout): boolean {
  return l.visible[c.id] ?? !c.hidden;
}

/** All columns in the layout's order: the ordered ones first, the others in their own order after them. */
export function ordered<C extends Pick<TableColumn, "id">>(cols: C[], l: TableLayout): C[] {
  const at = new Map(l.order.map((id, i) => [id, i]));
  return cols.map((c, i) => ({ c, i, o: at.get(c.id) })).sort((a, b) =>
    a.o !== undefined && b.o !== undefined ? a.o - b.o : a.o !== undefined ? -1 : b.o !== undefined ? 1 : a.i - b.i).map((x) => x.c);
}

/** The columns a layout shows, in its order; never none. */
export function arrange<C extends Pick<TableColumn, "id" | "hidden">>(cols: C[], l: TableLayout): C[] {
  const out = ordered(cols, l).filter((c) => shown(c, l));
  return out.length ? out : cols.slice(0, 1);
}

/** Tables whose start view was applied in this page: reloading the page starts with it again. */
const started = new Set<string>();

/**
 * The layout and saved views of one table, for the element that shows it: it
 * arranges the columns, answers the table's events and opens the header menu
 * and the dialog (the element renders `<corestone-columns-dialog>` while
 * `editing` is set).
 */
export class TableViews implements ReactiveController {
  private kept: Kept = { layout: emptyLayout(), views: [], active: "", start: "" };
  private loadedKey = "";
  /** The columns offered while the dialog is open. */
  editing: TableColumn[] | null = null;

  constructor(private readonly host: ReactiveControllerHost, private readonly key: () => string) {
    host.addController(this);
  }

  hostConnected() { this.load(); }
  hostUpdate() { this.load(); }

  /** (Re)reads what is kept for the table's key, when the key changed. */
  private load() {
    const key = this.key();
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    this.kept = readKept(key);
    this.editing = null;
    // the view the table starts with: once per page
    if (!started.has(key)) {
      started.add(key);
      const start = this.kept.views.find((v) => v.name === this.kept.start);
      if (start) this.kept = { ...this.kept, layout: structuredClone(start.layout), active: start.name };
    }
  }

  private save(next: Partial<Kept>) {
    this.kept = { ...this.kept, ...next };
    prefs.setJson(this.loadedKey, this.kept);
    this.host.requestUpdate();
  }

  get layout(): TableLayout { return this.kept.layout; }
  get views(): readonly SavedView[] { return this.kept.views; }
  get active(): string { return this.kept.active; }
  get start(): string { return this.kept.start; }

  arrange<C extends Pick<TableColumn, "id" | "hidden">>(cols: C[]): C[] { return arrange(cols, this.kept.layout); }

  setLayout(layout: TableLayout) { this.save({ layout }); }
  setSort = (e: CustomEvent<SortLevel[]>) => this.save({ layout: { ...this.kept.layout, sort: e.detail } });
  setWidths = (e: CustomEvent<Record<string, number>>) => this.save({ layout: { ...this.kept.layout, widths: e.detail } });

  /** Shows a saved view. */
  use(name: string) {
    const v = this.kept.views.find((x) => x.name === name);
    if (v) this.save({ layout: structuredClone(v.layout), active: name });
  }

  /** The layout is applied, and kept in the saved view of that name (a new one when there is none). */
  apply(layout: TableLayout, view = "") {
    const name = view.trim();
    if (!name) { this.save({ layout, active: "" }); return; }
    const views = this.kept.views.some((v) => v.name === name)
      ? this.kept.views.map((v) => v.name === name ? { name, layout: structuredClone(layout) } : v)
      : [...this.kept.views, { name, layout: structuredClone(layout) }];
    this.save({ layout, views, active: name });
  }

  /** The view the table starts with ("": the layout last shown). */
  setStart(name: string) { this.save({ start: name }); }

  remove(name: string) {
    this.save({ views: this.kept.views.filter((v) => v.name !== name), active: this.kept.active === name ? "" : this.kept.active,
      start: this.kept.start === name ? "" : this.kept.start });
  }

  /** Opens the dialog for these columns. */
  edit(cols: TableColumn[]) { this.editing = cols; this.host.requestUpdate(); }
  closeEditor = () => { this.editing = null; this.host.requestUpdate(); };

  /** The menu of a right click on a column header: sorting by it, hiding it, the saved views, the dialog. */
  headerMenu(e: CustomEvent<{ col: string; x: number; y: number }>, all: TableColumn[]) {
    const { col, x, y } = e.detail;
    const l = this.kept.layout;
    const c = all.find((k) => k.id === col);
    const sortBy = (dir: "asc" | "desc") => this.setLayout({ ...l, sort: [{ col, dir }, ...l.sort.filter((s) => s.col !== col)].slice(0, 3) });
    const items: MenuEntry[] = [
      ...(c && c.sortable !== false ? [
        { label: `Sort ascending by ${c.name}`, test: "col-sort-asc", run: () => sortBy("asc") },
        { label: `Sort descending by ${c.name}`, test: "col-sort-desc", run: () => sortBy("desc") },
      ] : []),
      ...(c ? [{ label: `Hide ${c.name || "this column"}`, test: "col-hide", disabled: this.arrange(all).length < 2,
        run: () => this.setLayout({ ...l, visible: { ...l.visible, [col]: false } }) }] : []),
      ...this.kept.views.map((v, i) => ({ label: v.name, checked: v.name === this.kept.active, group: i ? undefined : "Views", test: "col-view", run: () => this.use(v.name) })),
      { label: "Columns and sorting…", test: "col-dialog", run: () => this.edit(all) },
    ];
    popupMenu(document.body, "Columns", "ui-pop ui-menu header-menu", items, { x, y }, () => {});
  }
}
