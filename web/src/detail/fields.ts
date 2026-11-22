import { html, nothing } from "lit";
import { undeclaredField } from "../components/artifact";
import { type DetailState } from "./state";
import { openRef, sectionOf } from "./parts";
import { workflowField } from "./workflows";

// The fields of the artifact, as its schema defines them, and those stored without a definition.

export function fieldsSection(dt: DetailState) {
  const d = dt.edit.draft!;
  const fields = dt.schema?.fields ?? [];
  const known = new Set(fields.map((f) => f.id));
  const extra = Object.keys(d.fields).filter((k) => !known.has(k));
  return sectionOf(dt, "fields", () => html`
    ${!fields.length && !extra.length ? html`<div class="muted small">No fields defined for this type. Add a schema to describe it.</div>` : nothing}
    ${fields.map((f) => { if (f.type === "workflow") return workflowField(dt, f); const ov = dt.base.overlayState(f.id); return html`<corestone-field .field=${f} .value=${ov?.state === "inherited" ? ov.baseValue : d.fields[f.id]} .attachments=${dt.view?.attachments ?? []} .files=${dt.files.entryFiles} .typeId=${dt.view?.meta.type ?? ""} .folder=${dt.view?.meta.folder ?? ""}
      .overlay=${ov} .readonly=${!!dt.historic} .changed=${dt.changed("fields." + f.id)} @focusin=${() => dt.edit.touched()}
      @overlay-unlock=${(e: CustomEvent) => dt.edit.setOwnField(e.detail.id, structuredClone(ov?.baseValue))}
      @overlay-revert=${(e: CustomEvent) => dt.edit.setOwnField(e.detail.id, undefined)}
      @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; dt.edit.draft = { ...d, fields: next }; dt.edit.touched(); }}
      @open-artifact=${openRef}></corestone-field>`; })}
    ${extra.map((k) => html`<corestone-field .field=${undeclaredField(k, d.fields[k])} .value=${d.fields[k]} undeclared .files=${dt.files.entryFiles} .readonly=${!!dt.historic} .changed=${dt.changed("fields." + k)}
      @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; dt.edit.draft = { ...d, fields: next }; dt.edit.touched(); }}></corestone-field>`)}`);
}
