// @corestone/editor: a rich-text editor that knows nothing about Corestone.
// Use it as <cs-richtext> (value property, "change" event) or through
// RichTextEditor directly. The stored form is described in ./model.ts.
import { RichTextEditor } from "./editor";
import type { RichText } from "./model";
import type { Palette } from "./toolbar";

export { RichTextEditor, type EditorOptions } from "./editor";
export { fromStorage, plainText, toStorage, type Block, type Marks, type RichText, type Run } from "./model";
export { DEFAULT_PALETTE, type Palette } from "./toolbar";
export { FONTS, SIZES, SIZE_MAX, SIZE_MIN } from "./schema";

/** <cs-richtext>: set .value (and optionally .palette, readonly) and listen for "change" (detail: the value). */
export class RichTextElement extends HTMLElement {
  private editor?: RichTextEditor;
  private pending: RichText | null = null;
  palette?: Palette;

  get value(): RichText | null { return this.editor ? this.editor.value : this.pending; }
  set value(v: RichText | null) {
    this.pending = v;
    if (this.editor) this.editor.value = v;
  }

  connectedCallback() {
    if (this.editor) return;
    this.editor = new RichTextEditor(this, {
      value: this.pending,
      palette: this.palette,
      readonly: this.hasAttribute("readonly"),
      onChange: (value) => this.dispatchEvent(new CustomEvent("change", { detail: value, bubbles: true })),
    });
  }

  disconnectedCallback() { this.editor?.destroy(); this.editor = undefined; }

  override focus() { this.editor?.focus(); }
}

if (!customElements.get("cs-richtext")) customElements.define("cs-richtext", RichTextElement);
