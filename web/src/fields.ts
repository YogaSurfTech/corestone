import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api } from "./api";
import { store } from "./store";
import type { Attachment, Field, Summary } from "./types";
import { label, safeHref } from "./util";

// Schema-driven field editor (design guide §4.6, §7.10): one element per
// field definition, rendering the right input for the field type and
// emitting "field-change" with the new value (null = unset).

export type FieldValue = unknown;

// Values in use per type and field, for extendable enumerations: their
// extra values live only in the artifacts. Shared briefly by all editors.
const usedValues = new Map<string, { at: number; values: Promise<string[]> }>();
function valuesInUse(type: string, field: string): Promise<string[]> {
  const key = type + "\n" + field;
  const hit = usedValues.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.values;
  const values = api.values(type, field).then((r) => r.values.map((v) => v.value)).catch(() => []);
  usedValues.set(key, { at: Date.now(), values });
  return values;
}

/** How a field relates to the entry's overlay base: shown from the base and locked, or set here over a base value. */
export interface OverlayState { from: string; state: "inherited" | "overridden"; baseValue: unknown }

@customElement("corestone-field")
export class FieldEditor extends LitElement {
  @property({ attribute: false }) field!: Field;
  @property({ attribute: false }) value: FieldValue = undefined;
  @property({ attribute: false }) overlay: OverlayState | null = null;
  @property({ attribute: false }) attachments: Attachment[] = [];
  @property({ type: Boolean }) readonly = false;
  /** The artifact type, so extendable enumerations can suggest the values in use. */
  @property({ attribute: false }) typeId = "";
  /** The field is stored but the type does not define it: shown read-only, may be removed. */
  @property({ type: Boolean }) undeclared = false;
  @state() private used: string[] = [];
  private usedKey = "";
  private refCache = new Map<string, Summary | null>();

  override createRenderRoot() { return this; }

  private emit(v: FieldValue) {
    this.value = v;
    this.dispatchEvent(new CustomEvent("field-change", { detail: { id: this.field.id, value: v }, bubbles: true }));
  }

  private overlayEvent(name: "overlay-unlock" | "overlay-revert") {
    this.dispatchEvent(new CustomEvent(name, { detail: { id: this.field.id }, bubbles: true }));
  }

  private overlayNote() {
    const o = this.overlay;
    if (!o) return nothing;
    return o.state === "inherited"
      ? html`<div class="inherited">inherited from base <b>${o.from}</b> ·
          <button type="button" data-test="override" @click=${() => this.overlayEvent("overlay-unlock")}>🔓 override</button></div>`
      : html`<div class="inherited overridden">overrides base <b>${o.from}</b> ·
          <button type="button" data-test="revert" title=${"Base value: " + (typeof o.baseValue === "object" ? JSON.stringify(o.baseValue) : String(o.baseValue))}
            @click=${() => this.overlayEvent("overlay-revert")}>↩ revert to base</button></div>`;
  }

  /** Inherited values are shown from the base and stay locked until overridden. */
  private get disabled() { return this.readonly || this.undeclared || this.overlay?.state === "inherited"; }

  override willUpdate() {
    const f = this.field;
    const key = f.type === "enum" && f.extendable && this.typeId ? this.typeId + "\n" + f.id : "";
    if (key !== this.usedKey) {
      this.usedKey = key;
      this.used = [];
      if (key) valuesInUse(this.typeId, f.id).then((v) => { if (this.usedKey === key) this.used = v; });
    }
  }

  /** Suggestions for an extendable enumeration: the options, then the other values in use. */
  private suggestions() {
    const opts = this.field.options ?? [];
    const known = new Set(opts.map((o) => o.value));
    return html`<datalist id=${"dl-" + this.field.id}>${opts.map((o) => html`<option value=${o.value}>${o.label || o.value}</option>`)}
      ${this.used.filter((v) => !known.has(v)).map((v) => html`<option value=${v}></option>`)}</datalist>`;
  }

  override render() {
    const f = this.field;
    return html`<div class="field ${this.disabled ? "locked" : ""}" data-field=${f.id}>
      <label for=${"f-" + f.id}>${f.name || f.id}${f.required ? html`<span class="req" title="required">*</span>` : nothing}</label>
      <div class="value">
        ${this.input()}
        ${f.description ? html`<div class="help">${f.description}</div>` : nothing}
        ${this.overlayNote()}
        ${this.undeclared ? html`<div class="inherited undeclared">not defined for this type ·
          <button type="button" data-test="remove-field" @click=${() => this.emit(null)}>✕ remove</button></div>` : nothing}
      </div>
    </div>`;
  }

  private text(type: string, extra: Record<string, unknown> = {}): TemplateResult {
    const v = this.value == null ? "" : String(this.value);
    return html`<input id=${"f-" + this.field.id} type=${type} .value=${v} ?disabled=${this.disabled}
      placeholder=${(extra.placeholder as string) ?? ""} step=${(extra.step as string) ?? nothing}
      @input=${(e: Event) => this.emit((e.target as HTMLInputElement).value || null)} />`;
  }

  private input(): TemplateResult {
    const f = this.field;
    const id = "f-" + f.id;
    switch (f.type) {
      case "boolean":
        return html`<div class="check"><input id=${id} type="checkbox" .checked=${this.value === true} ?disabled=${this.disabled}
          @change=${(e: Event) => this.emit((e.target as HTMLInputElement).checked)} /><span class="muted small">${this.value === true ? "yes" : "no"}</span></div>`;
      case "integer":
        return html`<input id=${id} type="number" step="1" .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled}
          @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t === "" ? null : parseInt(t, 10)); }} />`;
      case "float":
      case "currency":
        return html`<div style="display:flex;gap:6px;align-items:center">
          <input id=${id} type="number" step="any" .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled}
            @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t === "" ? null : parseFloat(t)); }} />
          ${f.type === "currency" ? html`<span class="muted">${f.currency ?? ""}</span>` : nothing}</div>`;
      case "date":
        return this.text("date");
      case "time":
        return this.text("time");
      case "datetime": {
        const v = this.value ? String(this.value).replace(/Z$|[+-]\d\d:\d\d$/, "").slice(0, 16) : "";
        return html`<input id=${id} type="datetime-local" .value=${v} ?disabled=${this.disabled}
          @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t ? new Date(t).toISOString() : null); }} />`;
      }
      case "multiline":
      case "richtext":
        return html`<textarea id=${id} .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled} rows=${f.type === "richtext" ? 6 : 3}
          @input=${(e: Event) => this.emit((e.target as HTMLTextAreaElement).value || null)}></textarea>`;
      case "enum":
        return this.enumInput();
      case "hyperlink":
        return html`<div style="display:flex;gap:6px">${this.text("url", { placeholder: "https://" })}
          ${safeHref(this.value) ? html`<a class="btn sm" href=${safeHref(this.value)!} target="_blank" rel="noopener noreferrer">open</a>`
            : this.value ? html`<span class="error small" title="only http(s), ftp and mailto links are rendered">unsafe link</span>` : nothing}</div>`;
      case "reference":
        return this.refInput(false);
      case "references":
        return this.refInput(true);
      case "attachment":
        return html`<select id=${id} ?disabled=${this.disabled} @change=${(e: Event) => this.emit((e.target as HTMLSelectElement).value || null)}>
          <option value="">— none —</option>
          ${this.attachments.map((a) => html`<option value=${a.name} ?selected=${this.value === a.name}>${a.name}</option>`)}
          ${this.value && !this.attachments.some((a) => a.name === this.value) ? html`<option value=${String(this.value)} selected>${String(this.value)} (missing)</option>` : nothing}
        </select>`;
      case "json":
        return html`<textarea id=${id} class="mono" rows="4" ?disabled=${this.disabled} .value=${this.value == null ? "" : JSON.stringify(this.value, null, 2)}
          @change=${(e: Event) => { const t = (e.target as HTMLTextAreaElement).value.trim(); if (!t) return this.emit(null);
            try { this.emit(JSON.parse(t)); (e.target as HTMLElement).classList.remove("error"); } catch { (e.target as HTMLElement).classList.add("error"); store.toast("Invalid JSON in " + (f.name || f.id), "error"); } }}></textarea>`;
      case "workflow":
        return html`<span class="pill state">${this.value ?? "—"}</span> <span class="muted small">managed through transitions</span>`;
      case "hid":
      case "text":
      default:
        return this.text("text");
    }
  }

  private enumInput(): TemplateResult {
    const f = this.field;
    const opts = f.options ?? [];
    if (f.multiple) {
      const cur = Array.isArray(this.value) ? (this.value as string[]) : [];
      const toggle = (v: string, on: boolean) => {
        const next = on ? [...new Set([...cur, v])] : cur.filter((x) => x !== v);
        this.emit(next.length ? next : null);
      };
      return html`<div class="multi">${opts.map((o) => html`<label><input type="checkbox" .checked=${cur.includes(o.value)} ?disabled=${this.disabled}
        @change=${(e: Event) => toggle(o.value, (e.target as HTMLInputElement).checked)} />${o.label || o.value}</label>`)}
        ${cur.filter((v) => !opts.some((o) => o.value === v)).map((v) => html`<label><input type="checkbox" checked ?disabled=${this.disabled}
          @change=${(e: Event) => toggle(v, (e.target as HTMLInputElement).checked)} />${v}</label>`)}
        ${f.extendable && !this.disabled ? html`<input type="text" placeholder="add value…" style="width:140px" list=${"dl-" + f.id} @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); const t = e.target as HTMLInputElement; if (t.value.trim()) { toggle(t.value.trim(), true); t.value = ""; } }
        }} />${this.suggestions()}` : nothing}</div>`;
    }
    const v = this.value == null ? "" : String(this.value);
    const known = opts.some((o) => o.value === v);
    if (f.extendable) {
      return html`<input id=${"f-" + f.id} type="text" list=${"dl-" + f.id} .value=${v} ?disabled=${this.disabled}
        @input=${(e: Event) => this.emit((e.target as HTMLInputElement).value || null)} />${this.suggestions()}`;
    }
    return html`<select id=${"f-" + f.id} ?disabled=${this.disabled} @change=${(e: Event) => this.emit((e.target as HTMLSelectElement).value || null)}>
      <option value="" ?selected=${v === ""}>— select —</option>
      ${opts.map((o) => html`<option value=${o.value} ?selected=${o.value === v} style=${o.color ? `color:${o.color}` : ""}>${o.label || o.value}</option>`)}
      ${v && !known ? html`<option value=${v} selected>${v} (not in options)</option>` : nothing}
    </select>`;
  }

  private refInput(multiple: boolean): TemplateResult {
    const cur: string[] = multiple ? (Array.isArray(this.value) ? (this.value as string[]) : []) : this.value ? [String(this.value)] : [];
    for (const g of cur) {
      if (!this.refCache.has(g)) {
        this.refCache.set(g, null);
        api.get(g).then((v) => { this.refCache.set(g, v.meta); this.requestUpdate(); }).catch(() => { this.refCache.set(g, null); });
      }
    }
    const pick = () => {
      store.set({ picker: { kind: "pick", title: `Select ${this.field.name || this.field.id}`, types: this.field.targetTypes, onPick: (s: Summary) => {
        if (multiple) this.emit([...new Set([...cur, s.guid])]);
        else this.emit(s.guid);
      } } });
    };
    const remove = (g: string) => (multiple ? this.emit(cur.filter((x) => x !== g).length ? cur.filter((x) => x !== g) : null) : this.emit(null));
    return html`<div>
      ${cur.map((g) => html`<span class="ref-chip"><a href=${"/artifact/" + g} @click=${(e: Event) => { e.preventDefault(); this.dispatchEvent(new CustomEvent("open-artifact", { detail: g, bubbles: true })); }}>${label(this.refCache.get(g)) === "(missing)" ? g.slice(0, 8) + "…" : label(this.refCache.get(g))}</a>
        ${this.disabled ? nothing : html`<button type="button" title="Remove reference" aria-label="Remove reference" @click=${() => remove(g)}>✕</button>`}</span>`)}
      ${this.disabled ? nothing : html`<button type="button" class="btn sm" @click=${pick}>${multiple || !cur.length ? "＋ Select…" : "Change…"}</button>`}
    </div>`;
  }
}

/** Builds the initial values of an empty form from defaults. */
export function defaultValues(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined && f.default !== null) out[f.id] = f.default;
  return out;
}
