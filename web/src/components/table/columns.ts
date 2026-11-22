import { html } from "lit";
import type { Schema, Summary } from "../types";
import type { TableColumn } from "./table";
import "../type-icon";

// The columns every artifact has, shared by the tables of artifacts: the
// overview and the picker build their columns from these. What a table shows
// of them, in which order, is its view (views.ts).

type Column = TableColumn<Summary>;

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
