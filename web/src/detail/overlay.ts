import { html, nothing } from "lit";
import { splitter } from "@corestone/ui";
import { isWorkflowValue, label, showValue } from "../components/artifact";
import { OVERLAY_HELP } from "../components/fields";
import { type DetailState } from "./state";
import { applyBase, applyUnderlay, baseChangeRows, pickBase, toggleUnderlayField } from "./base-change";
import { openRef, sectionOf } from "./parts";

// The entry among its base and its overlays, with the previews of a base change and of a new base.

/** This entry with its direct neighbours: the base it overrides and the overlays overriding it. */
export function overlaySection(dt: DetailState) {
  const ov = dt.base.overlay!;
  const self = ov.chain[ov.chain.length - 1];
  const base = ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
  const sets = (fields: string[]) => html`<small>${fields.length ? "sets " + fields.join(", ") : "sets nothing"}</small>`;
  const node = (guid: string, hid: string | undefined, title: string | undefined, fields: string[]) => html`<div class="node" data-guid=${guid}>
    <corestone-ref guid=${guid} .text=${html`${hid ? html`<span class="hid">${hid}</span> ` : nothing}${title || (hid ? "" : guid.slice(0, 8))}`} @open-artifact=${openRef}></corestone-ref>
    ${sets(fields)}</div>`;
  const empty = !base && !ov.overlays.length;
  return sectionOf(dt, "overlay", () => html`${baseChangePreview(dt)}${underlayForm(dt)}${empty ? html`<div class="muted small">This entry is no overlay and has no overlays.</div>` : html`
    <div class="chain">
      ${base ? html`<div class="col">${node(base.guid, base.hid, base.title, base.fields)}</div><span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>` : nothing}
      <div class="col"><div class="node self"><b>this entry</b>${sets(self?.fields ?? [])}</div></div>
      ${ov.overlays.length ? html`<span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>
        <div class="col" data-test="overlays">${ov.overlays.map((o) => node(o.guid, o.hid, o.title, Object.keys(o.fields ?? {}).filter((id) => !isWorkflowValue(o.fields![id]))))}</div>` : nothing}
    </div>
    ${base ? html`<dl class="kv" style="margin-top:10px"><dt>Effective fields</dt><dd>${Object.entries(ov.fields).map(([k, v]) => html`<div><b>${k}</b>: ${showValue(v)} <span class="muted small">from ${ov.origin[k] === dt.guid ? "this entry" : dt.base.levelLabel(ov.origin[k])}</span></div>`)}</dd></dl>` : nothing}`}`,
    dt.historic ? nothing : html`${baseActions(dt, !!base)}<button class="btn sm" data-test="create-overlay" @click=${() => dt.createOverlay()}>＋ Create overlay</button>`);
}

/** One button for the base: the picker chooses a new one or, if there is one, removes it. */
export function baseActions(dt: DetailState, hasBase: boolean) {
  const blocked = dt.edit.dirty;
  return html`<button class="btn sm" data-test="change-base" ?disabled=${blocked}
    title=${blocked ? "Save or discard your changes first" : hasBase ? "Choose another base or remove it" : "Inherit the fields this entry does not set from another entry"}
    @click=${() => pickBase(dt)}>${hasBase ? "Change base…" : "Inherit from…"}</button>`;
}

/** The new base: title, the fields that move, and the resulting chain. Effective values stay. */
export function underlayForm(dt: DetailState) {
  const u = dt.base.underlay;
  if (!u || !dt.view) return nothing;
  const own = dt.base.ownFields();
  const ids = Object.keys(own);
  const base = dt.view.meta.base;
  const name = (id: string) => dt.schema?.fields?.find((f) => f.id === id)?.name || id;
  const show = (v: unknown) => html`<span class="pre-line">${showValue(v)}</span>`;
  return html`<div class="base-change" data-test="underlay">
    <button class="dialog-close" data-test="cancel-underlay" title="Close" aria-label="Close" @click=${() => { dt.base.underlay = null; }}>✕</button>
    <div class="title">Create a new base for this entry</div>
    <label class="underlay-title small">Title of the new base
      <input type="text" data-test="underlay-title" .value=${u.title} @input=${(e: Event) => { dt.base.underlay = { ...u, title: (e.target as HTMLInputElement).value }; }}></label>
    ${ids.length ? html`<div class="small">Fields that move into the new base:</div>
      <div class="underlay-fields">${ids.map((id) => html`<label class="small" data-field=${id}>
        <input type="checkbox" .checked=${u.fields.has(id) || dt.base.mustMove(id)} ?disabled=${dt.base.mustMove(id)}
          @change=${(e: Event) => toggleUnderlayField(dt, id, (e.target as HTMLInputElement).checked)}>
        <span><b>${name(id)}</b>: ${show(own[id])}${dt.base.mustMove(id) ? html` <span class="muted">(required: a base without a base of its own must set it)</span>` : nothing}</span></label>`)}</div>`
      : html`<div class="muted small">This entry sets no fields itself; the new base starts empty.</div>`}
    <div class="chain small" data-test="underlay-chain">${base ? html`<span>${dt.base.levelLabel(base)}</span><span class="arrow">→ overlaid by</span>` : nothing}
      <span><b>new base</b></span><span class="arrow">→ overlaid by</span><span>this entry</span></div>
    <div class="muted small">The moved values are inherited from the new base, so this entry's effective values stay the same.${base ? ` The new base inherits from ${dt.base.levelLabel(base)}.` : ""}</div>
    <div class="buttons">
      <button class="btn sm primary" data-test="apply-underlay" ?disabled=${dt.edit.busy} @click=${() => applyUnderlay(dt)}>Create base</button>
    </div></div>`;
}

export function baseChangePreview(dt: DetailState) {
  const c = dt.base.change;
  if (!c || !dt.view || !dt.base.overlay) return nothing;
  const cycle = !!c.next?.chain.some((l) => l.guid === dt.guid);
  const same = !!c.to && c.to.guid === dt.view.meta.base;
  const rows = cycle || same ? [] : baseChangeRows(dt);
  const changed = rows.filter((r) => r.changed);
  const ownCount = Object.keys(dt.base.ownFields()).length;
  const overlays = dt.base.overlay.overlays.length;
  const show = (v: unknown) => v === undefined || v === "" ? html`<span class="muted">—</span>` : html`<span class="pre-line">${showValue(v)}</span>`;
  return html`<div class="base-change" data-test="base-change">
    <button class="dialog-close" data-test="cancel-base" title="Close" aria-label="Close" @click=${() => { dt.base.change = null; }}>✕</button>
    <div class="title">${c.to ? html`Change the base to <b>${label(c.to)}</b>` : html`Remove the base <b>${dt.base.levelLabel(dt.view.meta.base ?? "")}</b>`}</div>
    ${cycle ? html`<div class="notice error">${label(c.to)} inherits from this entry, so it cannot become its base (cycle).</div>`
      : same ? html`<div class="muted small">This already is the base; nothing changes.</div>` : html`
      ${!c.to ? html`<label class="keep small"><input type="checkbox" data-test="keep-values" .checked=${c.keep}
        @change=${(e: Event) => { dt.base.change = { ...c, keep: (e.target as HTMLInputElement).checked }; }}> Keep the inherited values in this entry</label>` : nothing}
      ${changed.length ? html`<div class="resizable-area"><div class="base-diff-wrap" data-test="base-diff-wrap" style=${dt.base.diffHeight.value ? `height:${dt.base.diffHeight.value}px;max-height:none` : ""}>
        <table class="base-diff" data-test="base-diff"><thead><tr><th>Field</th><th>Now</th><th>After the change</th></tr></thead>
        <tbody>${changed.map((r) => html`<tr data-field=${r.id}><td>${r.name}</td>
          <td>${show(r.before)} ${r.beforeFrom ? html`<small class="muted">from ${r.beforeFrom}</small>` : nothing}</td>
          <td>${show(r.after)} ${r.afterFrom ? html`<small class="muted">from ${r.afterFrom}</small>` : nothing}</td></tr>`)}</tbody></table></div>${splitter(dt.base.diffHeight, "height-grip", "baseDiff-resize")}</div>`
        : html`<div class="muted small" data-test="base-no-change">No effective value changes.</div>`}
      <div class="muted small">${ownCount === 1 ? "1 value set in this entry stays" : `${ownCount} values set in this entry stay`} as ${ownCount === 1 ? "it is" : "they are"}.${
        overlays ? ` ${overlays === 1 ? "Its overlay inherits" : `Its ${overlays} overlays inherit`} the new values too.` : ""}</div>`}
    <div class="buttons">
      <button class="btn sm primary" data-test="apply-base" ?disabled=${cycle || same || dt.edit.busy} @click=${() => applyBase(dt)}>${c.to ? "Change base" : "Remove base"}</button>
    </div></div>`;
}
