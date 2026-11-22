import { html, nothing } from "lit";
import { fmtSize } from "@corestone/ui";
import { api } from "../api";
import type { Attachment } from "../components/types";
import type { TableColumn } from "../components/table/table";
import { type DetailState } from "./state";
import { sectionOf } from "./parts";

// The files stored with the artifact.

export function attachmentSection(dt: DetailState) {
  const h = dt.historic;
  type Row = Attachment & { file?: File };
  const staged = new Set(dt.files.added.map((f) => f.name));
  const att: Row[] = [...(dt.view?.attachments ?? []).filter((a) => h || !staged.has(a.name)),
    ...(h ? [] : dt.files.added.map((f) => ({ name: f.name, path: "", etag: "", size: f.size, file: f })))];
  const url = (a: Attachment) => h ? api.versionFileUrl(dt.guid, h.etag, h.commit.sha, a.name) : api.fileUrl(dt.guid, a.name);
  const removing = (a: Row) => !a.file && dt.files.removed.includes(a.name);
  const remove = (a: Row) => a.file
    ? dt.files.drop(a.file)
    : dt.files.toggleRemoval(a.name);
  return sectionOf(dt, "attachments", () => html`
    ${!att.length ? html`<div class="muted small">Files stored in the artifact's GUID directory appear here.</div>` : nothing}
    ${!att.length ? nothing : html`<corestone-table class="detail-table" .items=${att} .rowKey=${(a: Row) => (a.file ? "pending:" : "") + a.name}
      .rowClass=${(a: Row) => `attach-row ${a.file ? "pending-add" : ""} ${removing(a) ? "pending-remove" : ""}`} .columns=${[
      { id: "name", name: "Name", value: (a) => a.name, render: (a) => a.file ? html`<span title="Stored with the next Save">${a.name}</span>` : html`<a href=${url(a)} target="_blank" rel="noopener">${a.name}</a>` },
      { id: "size", name: "Size", width: 100, value: (a) => a.size, render: (a) => html`<span class="size">${fmtSize(a.size)}</span>` },
      ...(h ? [] : [{ id: "remove", name: "", width: 60, sortable: false, render: (a: Row) => removing(a)
        ? html`<button class="btn sm" title="Keep attachment" aria-label="Keep attachment" @click=${() => remove(a)}>↺</button>`
        : html`<button class="btn sm" title="Remove attachment" aria-label="Remove attachment" @click=${() => remove(a)}>✕</button>` }]),
    ] satisfies TableColumn<Row>[]}></corestone-table>`}`,
    h ? nothing : html`<label class="btn sm">＋ Upload<input type="file" multiple hidden @change=${(e: Event) => dt.files.upload(e)} /></label>`);
}
