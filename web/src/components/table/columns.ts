import { html } from "lit";
import { prefs } from "@corestone/ui";
import type { Schema, SortLevel, Summary } from "../types";
import type { TableColumn } from "./table";
import "../type-icon";

// What the tables of artifacts share: the columns every artifact has, and the
// layout (column widths and sort order) each table remembers in the browser.
// The overview and the picker build their columns from these.

type Column = TableColumn<Summary>;

/** Column widths and sort order, remembered in the browser per table. */
export interface TableLayout { widths: Record<string, number>; sort: SortLevel[] }

/** The layout kept under key; anything unreadable is left out. */
export function loadLayout(key: string): TableLayout {
  try {
    const l = prefs.json<Record<string, unknown>>(key, {});
    const stored: unknown[] = Array.isArray(l.sort) ? l.sort : l.sort ? [l.sort] : [];
    const sort: SortLevel[] = [];
    for (const value of stored) {
      if (typeof value !== "object" || value === null || !("col" in value) || !("dir" in value)) continue;
      if (typeof value.col !== "string" || !value.col || (value.dir !== "asc" && value.dir !== "desc") || sort.some((s) => s.col === value.col)) continue;
      sort.push({ col: value.col, dir: value.dir });
      if (sort.length === 3) break;
    }
    return { widths: l.widths && typeof l.widths === "object" && !Array.isArray(l.widths) ? l.widths as Record<string, number> : {}, sort };
  } catch { return { widths: {}, sort: [] }; }
}

export function saveLayout(key: string, layout: TableLayout) {
  prefs.setJson(key, layout);
}

/** The ID: the HID, or the start of the GUID when there is none. */
export function hidColumn(more: Partial<Column> = {}): Column {
  return { id: "$hid", name: "ID",
    render: (row) => row.hid ? html`<span class="hid">${row.hid}</span>` : html`<span class="muted mono">${row.guid.slice(0, 8)}</span>`, ...more };
}

/** The title, after the icon of its type (schemaOf: the type's schema when known; undefined: the icon looks it up). */
export function titleColumn(schemaOf: (row: Summary) => Schema | null | undefined = () => undefined, more: Partial<Column> = {}): Column {
  return { id: "$title", name: "Title", title: (row) => row.title ?? "",
    render: (row) => html`<corestone-type-icon .kind=${row.kind} .type=${row.type} .folder=${row.folder} .schema=${schemaOf(row)}></corestone-type-icon>${row.title || html`<span class="muted">${row.kind}</span>`}`, ...more };
}

/** The type, by its display name. */
export function typeColumn(more: Partial<Column> = {}): Column {
  return { id: "$type", name: "Type", render: (row, ctx) => ctx.typeName(row), ...more };
}

/** The folder ("/": the repository root). */
export function folderColumn(more: Partial<Column> = {}): Column {
  return { id: "$folder", name: "Folder", cls: "muted", title: (row) => row.folder || "/", render: (row) => row.folder || "/", ...more };
}
