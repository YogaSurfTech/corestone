import { html, type TemplateResult } from "lit";
import { relTime } from "@corestone/ui";
import { navigate } from "../../router";
import { undeclaredField, workflowStates } from "../../components/artifact";
import { appIcon } from "../../components/icons";

import { type DocumentState } from "../state";
import { sideHead } from "./head";

// The properties sidebar: what the document is, and its fields.

/** The document's own properties and fields. */
export function propertiesPanel(ds: DocumentState, id: string): TemplateResult {
  const v = ds.view!;
  return html`${sideHead(ds, id, "Document properties")}
    <dl class="kv"><dt>Type</dt><dd>${v.meta.type}</dd><dt>Folder</dt><dd>${v.meta.folder || "/"}</dd><dt>GUID</dt><dd class="mono small">${v.meta.guid}</dd><dt>Modified</dt><dd>${relTime(v.meta.modifiedAt)}</dd>
      ${workflowStates(ds.fields).map(([w, st]) => html`<dt>${ds.schema?.fields?.find((f) => f.id === w)?.name || w}</dt><dd><span class="pill state">${st}</span></dd>`)}</dl>
    ${(ds.schema?.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${ds.fields[f.id]} .attachments=${v.attachments ?? []} .typeId=${v.meta.type} .folder=${v.meta.folder}
      @field-change=${(e: CustomEvent) => { const n = { ...ds.fields }; if (e.detail.value == null) delete n[e.detail.id]; else n[e.detail.id] = e.detail.value; ds.fields = n; ds.touch(); }}></corestone-field>`)}
    ${Object.keys(ds.fields).filter((k) => !ds.schema?.fields?.some((f) => f.id === k)).map((k) => html`<corestone-field .field=${undeclaredField(k, ds.fields[k])} .value=${ds.fields[k]} undeclared
      @field-change=${(e: CustomEvent) => { const n = { ...ds.fields }; delete n[e.detail.id]; ds.fields = n; ds.touch(); }}></corestone-field>`)}
    <button class="icon-btn" style="margin-top:8px" data-tip="Open as artifact detail" @click=${() => navigate({ guid: ds.guid, tab: "general" }, true)}>${appIcon("open")}<span class="vh">Open as artifact detail</span></button>`;
}
