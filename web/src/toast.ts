import { html, nothing } from "lit";
import { LightElement } from "@corestone/ui";
import { customElement } from "lit/decorators.js";
import { store, type State } from "./store";
import { StoreController } from "./store-controller";

@customElement("corestone-toasts")
export class Toasts extends LightElement {
  private readonly watch = new StoreController(this);
  private get s(): State { return this.watch.state; }
  override render() {
    if (!this.s?.toasts.length) return nothing;
    return html`<div class="toasts">${this.s.toasts.map((t) => html`
      <div class="toast ${t.level}" role="status">
        <span class="text">${t.text}</span>
        ${t.action ? html`<button class="btn sm" @click=${() => { t.action!.run(); store.dismiss(t.id); }}>${t.action.label}</button>` : nothing}
        <button class="btn sm icon" @click=${() => store.dismiss(t.id)} aria-label="Dismiss">✕</button>
      </div>`)}</div>`;
  }
}
