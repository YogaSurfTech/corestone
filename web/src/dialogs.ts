import { html, nothing } from "lit";
import { LightElement, boxGrip, boxSizeStyle } from "@corestone/ui";
import { customElement } from "lit/decorators.js";
import { store, type Choice, type Dialog, type State } from "./store";
import { themeChoice } from "./components/theme-choice";
import "./components/folder-field";
import "./components/picker";
import type { Summary } from "./components/types";
import { StoreController } from "./store-controller";


/** Where the size a dialog was last dragged to is kept: the picker, or a dialog by its resizable name. */
const sizeKey = (name: string) => name === "picker" ? "corestone.pickerSize" : `corestone.dialogSize.${name}`;
/** No dialog is dragged smaller than this. */
const MIN_SIZE = { w: 360, h: 260 };

// The modal dialogs' shell: it shows the dialog the store holds (the "New"
// flow of new-dialog.ts, a confirmation, a prompt, the account) and above it
// the artifact picker of picker.ts.

/** Closes the artifact picker and tells it that nothing was chosen. */
function closePicker() {
  const p = store.state.picker;
  store.set({ picker: null });
  if (p?.multi) p.done([]); else p?.done(null);
}

@customElement("corestone-dialogs")
export class Dialogs extends LightElement {
  private readonly watch = new StoreController(this);
  private get s(): State { return this.watch.state; }
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }
  override disconnectedCallback() { window.removeEventListener("keydown", this.onKey); super.disconnectedCallback(); }
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (this.s?.picker) closePicker();
    else if (this.s?.dialog) this.dismiss();
  };

  /** Closes the current dialog and tells it that nothing was chosen. */
  private dismiss() {
    const d = this.s?.dialog;
    store.set({ dialog: null });
    if (d?.kind === "confirm") d.done("cancel");
    else if (d?.kind === "prompt") d.done(null);
  }

  override updated() {
    // A freshly opened prompt gets the keyboard, with its suggestion selected.
    const input = this.querySelector<HTMLInputElement>(".dialog input[data-test=prompt]");
    if (input && document.activeElement !== input && !this.querySelector(".picker-layer")) { input.focus(); input.select(); }
  }

  override render() {
    const d = this.s?.dialog;
    const p = this.s?.picker;
    const resizable = d?.kind === "confirm" ? d.resizable : undefined;
    let body;
    switch (d?.kind) {
      case "new": body = html`<corestone-new-dialog .dialog=${d}></corestone-new-dialog>`; break;
      case "confirm": body = this.confirm(d); break;
      case "prompt": body = this.prompt(d); break;
      case "account": body = html`<corestone-account-dialog></corestone-account-dialog>`; break;
      default: body = nothing;
    }
    return html`${d ? html`<div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.dismiss(); }}>
        <div class="dialog ${d.kind === "prompt" || d.kind === "account" ? d.kind : ""} ${resizable ? "resizable" : ""}" role="dialog" aria-modal="true"
          style=${resizable ? boxSizeStyle(sizeKey(resizable)) : ""}>${body}
          ${resizable ? boxGrip(sizeKey(resizable), "resize-grip", "dialog-resize", MIN_SIZE) : nothing}</div></div>` : nothing}
      ${p ? html`<div class="backdrop picker-layer" @click=${(e: Event) => { if (e.target === e.currentTarget) closePicker(); }}>
        <div class="dialog picker" role="dialog" aria-modal="true" style=${boxSizeStyle(sizeKey("picker"))}>
          <corestone-picker .options=${p} .multi=${p.multi}
            @pick=${(e: CustomEvent<Summary>) => { store.set({ picker: null }); if (!p.multi) p.done(e.detail); }}
            @pick-many=${(e: CustomEvent<string[]>) => { store.set({ picker: null }); if (p.multi) p.done(e.detail); }}
            @cancel=${closePicker}></corestone-picker>
          ${boxGrip(sizeKey("picker"), "resize-grip", "picker-resize", MIN_SIZE)}</div></div>` : nothing}`;
  }

  private prompt(d: Extract<Dialog, { kind: "prompt" }>) {
    const submit = (e: Event) => {
      e.preventDefault();
      const value = this.querySelector<HTMLInputElement>(".dialog input[data-test=prompt]")?.value ?? "";
      store.set({ dialog: null });
      d.done(value);
    };
    return html`<h2>${d.title}</h2>
      ${d.text ? html`<p class="hint">${d.text}</p>` : nothing}
      <form class="prompt-form" @submit=${submit}>
        ${d.folder
          ? html`<corestone-folder-field test="prompt" .value=${d.value ?? ""} .ignore=${d.ignore ?? ""}></corestone-folder-field>`
          : html`<input type="text" data-test="prompt" .value=${d.value ?? ""} placeholder=${d.placeholder ?? ""} aria-label=${d.title}>`}
        ${d.theme ? themeChoice(this.s.theme, (t) => store.setTheme(t)) : nothing}
        <div class="foot"><button type="button" class="btn" @click=${() => this.dismiss()}>Cancel</button>
        <button type="submit" class="btn primary">${d.confirmLabel ?? "OK"}</button></div>
      </form>`;
  }

  private confirm(d: Extract<Dialog, { kind: "confirm" }>) {
    const choose = (choice: Choice) => { store.set({ dialog: null }); d.done(choice); };
    return html`<h2>${d.title}</h2>
      <p>${d.text}</p>
      ${d.body ? html`<div class="dialog-body">${d.body}</div>` : nothing}
      <div class="foot"><button class="btn" data-test="dialog-cancel" @click=${() => this.dismiss()}>Cancel</button>
      ${d.altLabel ? html`<button class="btn" data-test="dialog-alt" @click=${() => choose("alt")}>${d.altLabel}</button>` : nothing}
      ${d.noConfirm ? nothing : html`<button class="btn ${d.danger ? "danger" : "primary"}" data-test="dialog-confirm" @click=${() => choose("confirm")}>${d.confirmLabel ?? "OK"}</button>`}</div>`;
  }
}
