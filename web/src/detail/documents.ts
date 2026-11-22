import { html } from "lit";
import { navigate } from "../router";
import type { Summary } from "../components/types";
import { label } from "../components/artifact";
import type { TableColumn } from "../components/table/table";
import { type DetailState } from "./state";
import { openCell, sectionOf } from "./parts";

// The documents that embed the entry.

/** The documents embedding this entry; each opens scrolled to the entry's block. */
export function documentSection(dt: DetailState) {
  return sectionOf(dt, "documents", () => !dt.documents.length
    ? html`<div class="muted small">This entry is not used in any document.</div>`
    : html`<corestone-table class="detail-table" data-test="documents" .items=${dt.documents} .rowClass=${() => "open-row"} .columns=${[
      { id: "document", name: "Document", value: (d) => d.hid || label(d), render: (d) => openCell(dt, d, "entry:" + dt.guid) },
      { id: "type", name: "Type", width: 140, value: (d) => d.type, render: (d) => html`<span class="muted small">${d.type}</span>` },
      { id: "folder", name: "Folder", width: 150, value: (d) => d.folder, render: (d) => html`<span class="muted small">${d.folder || "/"}</span>` },
    ] satisfies TableColumn<Summary>[]} @row-click=${(e: CustomEvent<Summary>) => navigate({ guid: e.detail.guid, tab: "entry:" + dt.guid })}></corestone-table>`);
}
