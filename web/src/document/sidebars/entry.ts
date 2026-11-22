import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { navigate } from "../../router";
import { showValue } from "../../components/artifact";
import { appIcon } from "../../components/icons";

import { type DocumentState } from "../state";
import { sideHead } from "./head";

// The entry sidebar: the placed entry the cursor is in; a new one is edited here until Save creates it.

/** The current entry: a stored one read-only, a new one with its form. */
export function entryPanel(ds: DocumentState, id: string): TemplateResult {
  if (ds.current && ds.entries.held.has(ds.current)) return heldPanel(ds, ds.current);
  const e = ds.current ? ds.entries.shown.get(ds.entries.real(ds.current)) : undefined;
  const meta = e && e !== "loading" ? e.view?.meta : undefined;
  const fields = (e && e !== "loading" ? (e.view?.data as Record<string, unknown> | undefined)?.fields : undefined) as Record<string, unknown> | undefined;
  return html`${sideHead(ds, id, "Current entry")}${meta ? html`<div><b>${meta.hid ?? ""}</b> ${meta.title}</div>
    <dl class="kv">${Object.entries(fields ?? {}).map(([k, val]) => html`<dt>${k}</dt><dd class="pre-line">${showValue(val)}</dd>`)}</dl>
    <button class="icon-btn" data-tip="Open the entry" @click=${() => navigate({ guid: meta.guid })}>${appIcon("open")}<span class="vh">Open entry</span></button>` : html`<div class="muted small">Click an entry in the document.</div>`}`;
}

/** A new entry in the entry sidebar: its title and fields, editable; what is missing marked. */
export function heldPanel(ds: DocumentState, key: string): TemplateResult {
  const h = ds.entries.held.get(key)!;
  const missing = new Set(ds.entries.missing(h).map((f) => f.id));
  const problems = ds.entries.problems.get(key) ?? [];
  return html`${sideHead(ds, "entry", "New entry")}
    <div class="held-entry ${ds.entries.flash ? "flash" : ""}">
      <div class="muted small"><corestone-type-icon kind="entry" .type=${h.schema.type} .folder=${h.folder} .schema=${h.schema}></corestone-type-icon>
        ${h.schema.displayName ?? h.schema.type} in ${h.folder || "/"} · created when the document is saved</div>
      ${missing.size || problems.length ? html`<div class="notice error" role="alert" data-test="held-problems">${missing.size
        ? `Fill in ${[...missing].map((id) => h.schema.fields?.find((f) => f.id === id)?.name ?? id).join(", ")}: the entry cannot be created without.`
        : problems.join(" ")}</div>` : nothing}
      <div class="field"><label for="held-title">Title</label><div class="value">
        <input id="held-title" type="text" .value=${live(h.title)} @input=${(e: Event) => ds.entries.edit(key, (x) => { x.title = (e.target as HTMLInputElement).value; })} /></div></div>
      ${(h.schema.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field class=${missing.has(f.id) ? "missing" : ""} .field=${f} .value=${h.fields[f.id]}
        .files=${ds.files.docFiles} .typeId=${h.schema.type} .folder=${h.folder}
        @field-change=${(e: CustomEvent) => ds.entries.edit(key, (x) => { if (e.detail.value == null) delete x.fields[e.detail.id]; else x.fields[e.detail.id] = e.detail.value; })}></corestone-field>`)}
    </div>`;
}
