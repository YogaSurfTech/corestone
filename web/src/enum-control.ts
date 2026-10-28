import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { EnumOption } from "./types";
import { iconUrl } from "./type-icon";

export function enumLabel(option: EnumOption, folder: string) {
  const p = option.presentation;
  return html`<span class="enum-label" style=${styleMap({ color: p?.color })}>
    ${p?.icon ? html`<img class="enum-marker" src=${iconUrl(p.icon, folder)} width="16" height="16" alt="" style=${styleMap({ backgroundColor: p.backgroundColor })} />`
      : p?.backgroundColor ? html`<span class="enum-marker" style=${styleMap({ backgroundColor: p.backgroundColor })}></span>` : nothing}
    <span>${option.label || option.value}</span></span>`;
}

@customElement("corestone-enum")
export class EnumControl extends LitElement {
  @property({ attribute: false }) options: EnumOption[] = [];
  @property({ attribute: false }) suggestions: string[] = [];
  @property({ attribute: false }) value: unknown;
  @property() folder = "";
  @property() label = "";
  @property({ type: Boolean }) multiple = false;
  @property({ type: Boolean }) extendable = false;
  @property({ type: Boolean }) readonly = false;
  @state() private open = false;
  @state() private query = "";

  override createRenderRoot() { return this; }
  private outside = (e: PointerEvent) => { if (!e.composedPath().includes(this)) this.close(true); };
  override connectedCallback() { super.connectedCallback(); document.addEventListener("pointerdown", this.outside); }
  override disconnectedCallback() { document.removeEventListener("pointerdown", this.outside); super.disconnectedCallback(); }
  private selected(): string[] {
    return Array.isArray(this.value) ? this.value.filter((v): v is string => typeof v === "string")
      : typeof this.value === "string" && this.value ? [this.value] : [];
  }
  private option(value: string) { return this.options.find((o) => o.value === value) ?? { value }; }
  private emit(values: string[]) {
    if (this.readonly) return;
    this.value = this.multiple ? (values.length ? values : null) : values[0] ?? null;
    this.dispatchEvent(new CustomEvent("enum-change", { detail: this.value, bubbles: true }));
  }
  private search(value: string) {
    this.query = value;
    this.dispatchEvent(new CustomEvent("enum-query", { detail: value, bubbles: true }));
  }
  private choose(value: string) {
    if (this.readonly) return;
    const selected = this.selected();
    this.emit(this.multiple ? selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value] : [value]);
    this.search("");
    if (!this.multiple) {
      this.close(false);
      this.querySelector<HTMLButtonElement>(".enum-trigger")?.focus();
    }
  }
  private add() {
    const value = this.query.trim();
    if (!this.readonly && this.extendable && value) {
      if (!this.selected().includes(value)) this.emit(this.multiple ? [...this.selected(), value] : [value]);
      this.search("");
    }
  }
  private close(commit: boolean) {
    if (!this.open) return;
    if (commit) this.add();
    this.open = false;
    this.search("");
  }
  private keydown(e: KeyboardEvent) {
    if (this.readonly) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(false); this.querySelector<HTMLButtonElement>(".enum-trigger")?.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.open = true;
      void this.updateComplete.then(() => {
        const options = [...this.querySelectorAll<HTMLButtonElement>(".enum-option")];
        const index = options.findIndex((o) => o === document.activeElement);
        options[(index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      });
    }
  }
  override render() {
    const selected = this.selected();
    if (this.readonly) return html`<span class="enum-readonly">${selected.length
      ? selected.map((v) => enumLabel(this.option(v), this.folder)) : html`<span class="muted">—</span>`}</span>`;
    const options: EnumOption[] = [...this.options, ...[...new Set([...selected, ...this.suggestions])]
      .filter((v) => !this.options.some((o) => o.value === v)).map((value) => ({ value }))];
    const filtered = options.filter((o) => `${o.label || ""} ${o.value}`.toLowerCase().includes(this.query.trim().toLowerCase()));
    return html`<div class="enum-control" @keydown=${this.keydown}
      @focusout=${(e: FocusEvent) => { if (!this.contains(e.relatedTarget as Node | null)) this.close(true); }}>
      <div class="enum-selection">
        ${selected.map((v) => html`<span class="enum-chip">${enumLabel(this.option(v), this.folder)}
          ${this.multiple ? html`<button type="button" class="enum-remove" aria-label=${"Remove " + (this.option(v).label || v)}
            @click=${() => this.emit(this.selected().filter((x) => x !== v))}>×</button>` : nothing}</span>`)}
        <button type="button" class="enum-trigger" aria-label=${this.label || "Select value"} aria-haspopup="listbox" aria-expanded=${this.open}
          @click=${() => { if (this.open) this.close(true); else this.open = true; }}>
          ${selected.length ? nothing : html`<span class="muted">Select…</span>`}<span>▾</span></button>
      </div>
      ${this.open ? html`<div class="enum-dropdown">
        <div class="enum-search"><input type="search" aria-label=${"Search " + this.label} placeholder=${this.extendable ? "Search or add value…" : "Search…"}
          .value=${this.query} @input=${(e: Event) => this.search((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (this.extendable) this.add(); else if (filtered[0]) this.choose(filtered[0].value); } }} />
          ${this.extendable ? html`<button type="button" class="btn sm" aria-label="Add value" title="Add value" @click=${this.add}>+</button>` : nothing}</div>
        <div class="enum-options" role="listbox" aria-label=${this.label} aria-multiselectable=${this.multiple ? "true" : "false"}>
          ${!this.multiple ? html`<button type="button" class="enum-option" data-value="" role="option" aria-selected=${!selected.length}
            @click=${() => { this.emit([]); this.close(false); }}>— none —</button>` : nothing}
          ${filtered.map((o) => html`<button type="button" class="enum-option" data-value=${o.value} role="option" aria-selected=${selected.includes(o.value)}
            @click=${() => this.choose(o.value)}>${this.multiple ? html`<span aria-hidden="true">${selected.includes(o.value) ? "☑" : "☐"}</span>` : nothing}${enumLabel(o, this.folder)}</button>`)}
          ${!filtered.length ? html`<span class="muted small">No matching values</span>` : nothing}
        </div></div>` : nothing}
    </div>`;
  }
}
