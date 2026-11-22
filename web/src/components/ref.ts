import { html, nothing } from "lit";
import { LightElement } from "@corestone/ui";
import { customElement, property } from "lit/decorators.js";
import type { Summary } from "./types";
import "./type-icon";

/** The address of an artifact in the application. */
export const artifactHref = (guid: string) => "/artifact/" + guid;

/**
 * A reference to an artifact: a link with its HID and title, with its type's
 * icon in front where asked for. A plain click fires `open-artifact` (the
 * GUID, bubbling) and the page decides where it opens; a click with a
 * modifier key or the middle button is the browser's, which opens the link's
 * address in a new tab or window.
 */
@customElement("corestone-ref")
export class Ref extends LightElement {
  /** The artifact, where it is known. */
  @property({ attribute: false }) artifact?: Summary | null;
  /** Its GUID, where only that is known. */
  @property() guid = "";
  /** Shown in place of HID and title. */
  @property({ attribute: false }) text?: unknown;
  /** Show the type's icon in front. */
  @property({ type: Boolean }) icon = false;
  /** The class of the link. */
  @property() look = "";

  private open = (e: MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    this.dispatchEvent(new CustomEvent("open-artifact", { detail: this.artifact?.guid ?? this.guid, bubbles: true }));
  };

  override render() {
    const a = this.artifact;
    const guid = a?.guid ?? this.guid;
    return html`${this.icon && a ? html`<corestone-type-icon .kind=${a.kind} .type=${a.type} .folder=${a.folder}></corestone-type-icon>` : nothing}<a
      class=${this.look} href=${artifactHref(guid)} @click=${this.open}>${this.text ?? html`${a?.hid ? html`<span class="hid">${a.hid}</span> ` : nothing}${a?.title || (a?.hid ? "" : guid.slice(0, 8))}`}</a>`;
  }
}
