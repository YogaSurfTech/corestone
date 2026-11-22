import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property } from "lit/decorators.js";
import { DropMenu, LightElement } from "@corestone/ui";
import type { Kind } from "./types";
import { kindMark } from "./artifact";

/** What the overview can show: "" is entries and documents together. */
const VIEWS: { kind: "" | Kind; name: string; icons: Kind[] }[] = [
  { kind: "", name: "Entries + Docs", icons: ["entry", "document"] },
  { kind: "entry", name: "Entries", icons: ["entry"] },
  { kind: "document", name: "Documents", icons: ["document"] },
  { kind: "link", name: "Links", icons: ["link"] },
  { kind: "comment", name: "Comments", icons: ["comment"] },
];

const icons = (kinds: Kind[]) => kinds.map(kindMark).join("");

/**
 * The overview's choice of what it shows, as one small button: it shows the
 * icon of the active view and opens a menu of all of them.
 * Event: kind-change (detail: the kind, "" for entries and documents).
 */
@customElement("corestone-kind-menu")
export class KindMenu extends LightElement {
  @property() kind = "";
  private readonly menu = new DropMenu({
    label: "Show", cls: "kind-pop", test: "kind-menu", align: "end",
    items: () => VIEWS.map((v) => ({
      label: v.name, icon: icons(v.icons), checked: v.kind === this.kind, test: "kind-" + (v.kind || "all"),
      run: () => { if (v.kind !== this.kind) this.dispatchEvent(new CustomEvent("kind-change", { detail: v.kind, bubbles: true })); },
    })),
  });

  override disconnectedCallback() {
    this.menu.close();
    super.disconnectedCallback();
  }

  private toggle(e: Event) { this.menu.toggle(e.currentTarget as HTMLElement, this); }

  override render() {
    const v = VIEWS.find((x) => x.kind === this.kind) ?? VIEWS[0];
    return html`<button type="button" class="btn sm kind-button" data-test="kind" data-kind=${v.kind || "all"} title=${"Showing: " + v.name}
      aria-label=${"Showing: " + v.name} aria-haspopup="menu" aria-expanded="false" @click=${this.toggle}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "ArrowDown" && !this.menu.isOpen) { e.preventDefault(); this.toggle(e); } }}>
      ${unsafeHTML(icons(v.icons))}<span class="caret">▾</span></button>`;
  }
}
