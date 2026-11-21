import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property } from "lit/decorators.js";
import { LightElement, Overlay, buildMenu } from "@corestone/ui";
import type { Kind } from "./types";
import { kindMark } from "./util";

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
  private overlay?: Overlay;
  private menu!: HTMLElement;
  /** The press on the button found the menu open (the overlay closes it on that press): the click must not open it again. */
  private pressedOpen = false;
  private pressed = (e: MouseEvent) => {
    this.pressedOpen = !!this.overlay?.isOpen && !!(e.target as Element).closest?.("[data-test=kind]") && this.contains(e.target as Node);
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("mousedown", this.pressed, true); // before the overlay's own listener
  }
  override disconnectedCallback() {
    this.overlay?.close();
    document.removeEventListener("mousedown", this.pressed, true);
    super.disconnectedCallback();
  }

  private get button(): HTMLButtonElement { return this.querySelector("[data-test=kind]") as HTMLButtonElement; }

  private toggle() {
    if (this.pressedOpen) { this.pressedOpen = false; return; }
    if (!this.overlay) {
      this.overlay = new Overlay({ root: this, onClose: () => this.button?.setAttribute("aria-expanded", "false"), onEscape: () => this.button.focus() });
      this.menu = this.overlay.panel("qb-pop menu-like kind-pop", "menu", "Show");
      this.menu.dataset.test = "kind-menu";
    }
    const items = buildMenu(VIEWS.map((v) => ({
      label: v.name, icon: icons(v.icons), checked: v.kind === this.kind,
      run: () => {
        this.overlay!.close();
        this.button.focus();
        if (v.kind !== this.kind) this.dispatchEvent(new CustomEvent("kind-change", { detail: v.kind, bubbles: true }));
      },
    })));
    items.forEach((b, i) => { b.dataset.kind = VIEWS[i].kind || "all"; });
    this.menu.replaceChildren(...items);
    const r = this.button.getBoundingClientRect();
    this.overlay.open(this.menu, { x: r.left, y: r.bottom + 4 });
    // the button stands at the right of the toolbar: the menu opens towards the left
    this.menu.style.left = "auto";
    this.menu.style.right = "0";
    this.button.setAttribute("aria-expanded", "true");
    (this.menu.querySelector("[aria-checked=true]") as HTMLElement | null)?.focus();
  }

  override render() {
    const v = VIEWS.find((x) => x.kind === this.kind) ?? VIEWS[0];
    return html`<button type="button" class="btn sm kind-button" data-test="kind" data-kind=${v.kind || "all"} title=${"Showing: " + v.name}
      aria-label=${"Showing: " + v.name} aria-haspopup="menu" aria-expanded="false" @click=${this.toggle}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "ArrowDown" && !this.overlay?.isOpen) { e.preventDefault(); this.toggle(); } }}>
      ${unsafeHTML(icons(v.icons))}<span class="caret">▾</span></button>`;
  }
}
