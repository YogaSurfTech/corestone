// @corestone/editor: a rich-text editor that knows nothing about Corestone.
// Use it as <cs-richtext> (value property, "change" event) or through
// RichTextEditor directly. The stored form is described in ./model.ts.
import { RichTextEditor } from "./editor";
import type { RichText } from "./model";
import type { ItemLinks } from "./links";
import type { EntryFiles } from "./files";
import type { Palette } from "./toolbar";

export { RichTextEditor, type EditorOptions } from "./editor";
export { type ItemLinks } from "./links";
export { type EntryFiles } from "./files";
export { fromStorage, isTable, plainText, toStorage, type Block, type Cell, type FormulaRun, type ImageRun, type Marks, type Paragraph, type RichText, type Run, type Table } from "./model";
export { DEFAULT_PALETTE, DEFAULT_STRIPES, type Palette, type StripePreset } from "./toolbar";
export { FONTS, SIZES, SIZE_MAX, SIZE_MIN } from "./schema";

/** <cs-richtext>: set .value (and optionally .palette, readonly) and listen for "change" (detail: the value). */
export class RichTextElement extends HTMLElement {
  static observedAttributes = ["readonly"];
  private editor?: RichTextEditor;
  private pending: RichText | null = null;
  palette?: Palette;
  /** Links to items of the host application; without it only web links are offered. */
  items?: ItemLinks;
  /** The entry's files, for images, file links and formulas; without it none is offered. */
  files?: EntryFiles;
  private key?: string;
  /** Under which name a height dragged with the bottom edge is remembered in this browser
   *  (e.g. the field's type and name); without it the height is not remembered. */
  get sizeKey(): string | undefined { return this.key; }
  set sizeKey(v: string | undefined) {
    if (v === this.key) return;
    this.key = v;
    if (this.editor) this.editor.sizeKey = v;
  }

  get value(): RichText | null { return this.editor ? this.editor.value : this.pending; }
  set value(v: RichText | null) {
    this.pending = v;
    // the same value again (a host re-rendering) keeps the cursor and the undo history
    if (this.editor && !same(v, this.editor.value)) this.editor.value = v;
  }

  connectedCallback() {
    if (this.editor) return;
    this.editor = new RichTextEditor(this, {
      value: this.pending,
      palette: this.palette,
      readonly: this.hasAttribute("readonly"),
      items: () => this.items,
      files: () => this.files,
      sizeKey: this.key,
      onChange: (value) => { this.pending = value; this.dispatchEvent(new CustomEvent("change", { detail: value, bubbles: true })); },
    });
  }

  attributeChangedCallback(name: string) {
    if (name === "readonly") this.editor?.setReadonly(this.hasAttribute("readonly"));
  }

  disconnectedCallback() { this.editor?.destroy(); this.editor = undefined; }

  override focus() { this.editor?.focus(); }
}

/** Whether two values are the same text: empty is empty, however it is written. */
function same(a: RichText | null | undefined, b: RichText | null | undefined): boolean {
  const norm = (v: RichText | null | undefined) => (v == null || (Array.isArray(v) && !v.length) ? "" : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

if (!customElements.get("cs-richtext")) customElements.define("cs-richtext", RichTextElement);
