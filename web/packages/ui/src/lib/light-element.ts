import { LitElement } from "lit";

/** A Lit element that renders into itself, without a shadow root, so the page's stylesheet applies. */
export class LightElement extends LitElement {
  override createRenderRoot() { return this; }
}
