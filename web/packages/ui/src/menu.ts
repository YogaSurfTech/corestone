import { button, el } from "./lib/dom";
import { Overlay, type Below, type Point } from "./overlay";

// Menus: items with icons, headings, submenus, check marks and hidden or disabled items. Arrow
// keys move through them, → opens a submenu, ← / Escape closes it.

export interface MenuEntry {
  label: string;
  /** Markup of an icon shown in front of the label (written by the caller, never from data). */
  icon?: string;
  /** What choosing the item does; an item with a submenu opens that instead. */
  run?: () => void;
  sub?: MenuEntry[];
  danger?: boolean;
  /** Given, the item is a check item in this state. */
  checked?: boolean;
  disabled?: boolean;
  /** Left out of the menu. */
  hidden?: boolean;
  /** A heading shown above this item, for the group that starts with it. */
  group?: string;
  /** The item's data-test hook. */
  test?: string;
}

/** The items of a menu; act runs a chosen item. */
export function buildMenu(items: MenuEntry[], act: (it: MenuEntry) => void = (it) => it.run?.()): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const it of items) {
    if (it.hidden) continue;
    if (it.group !== undefined) {
      const group = el("div", "group");
      group.textContent = it.group;
      out.push(group);
    }
    const b = button({ cls: "mi" + (it.danger ? " danger" : ""), text: it.label });
    if (it.test) b.dataset.test = it.test;
    if (it.icon) {
      const icon = el("span", "mi-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = it.icon;
      b.prepend(icon);
    }
    b.setAttribute("role", it.checked !== undefined ? "menuitemcheckbox" : "menuitem");
    if (it.checked !== undefined) b.setAttribute("aria-checked", String(it.checked));
    if (it.disabled) b.disabled = true;
    if (it.sub) {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      const sub = el("div", "sub");
      sub.setAttribute("role", "menu");
      sub.setAttribute("aria-label", it.label);
      sub.append(...buildMenu(it.sub, act));
      sub.hidden = true;
      const wrap = el("div", "has-sub");
      const show = (on: boolean) => {
        sub.hidden = !on;
        b.setAttribute("aria-expanded", String(on));
      };
      wrap.addEventListener("mouseenter", () => { closeSubs(wrap.parentElement!); show(true); });
      wrap.addEventListener("mouseleave", () => show(false));
      b.addEventListener("click", (e) => { e.preventDefault(); show(true); (sub.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus(); });
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); b.click(); }
      });
      sub.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); show(false); b.focus(); }
      });
      wrap.append(b, sub);
      out.push(wrap);
      continue;
    }
    b.addEventListener("mouseenter", () => closeSubs(b.parentElement!));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      act(it);
    });
    out.push(b);
  }
  // arrow keys move through the items of a menu
  for (const o of out) o.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const menu = (e.target as HTMLElement).closest("[role=menu]")!;
    const all = [...menu.children].map((c) => (c.matches("button") ? c : c.querySelector(":scope > button")) as HTMLButtonElement)
      .filter((x) => x && !x.disabled);
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
  });
  return out;
}

export interface DropMenuOptions {
  /** The accessible name of the menu. */
  label: string;
  /** The items, asked for at each opening. */
  items(): MenuEntry[];
  /** Classes of the panel, besides "ui-pop ui-menu". */
  cls?: string;
  /** The panel's data-test hook. */
  test?: string;
  align?: Below["align"];
}

/**
 * A menu that opens below the control it belongs to (a "New" or "⋯" button):
 * toggle() is that control's click. Choosing an item or Escape closes the menu
 * and gives the focus back to the control, whose aria-expanded follows.
 */
export class DropMenu {
  private overlay?: Overlay;
  private panel?: HTMLElement;
  private anchor?: HTMLElement;

  constructor(private readonly o: DropMenuOptions) {}

  get isOpen(): boolean { return !!this.overlay?.isOpen; }

  /** root: the positioned element the menu is placed in, by default the control's parent. */
  toggle(anchor: HTMLElement, root: HTMLElement = anchor.parentElement!): void {
    if (!this.overlay || !this.panel || this.panel.parentElement !== root) {
      // the first opening, or the page drew the control anew
      this.overlay?.close();
      this.panel?.remove();
      this.overlay = new Overlay({
        root,
        onClose: () => this.anchor?.setAttribute("aria-expanded", "false"),
        onEscape: () => this.anchor?.focus(),
      });
      this.panel = this.overlay.panel("ui-pop ui-menu" + (this.o.cls ? " " + this.o.cls : ""), "menu", this.o.label);
      if (this.o.test) this.panel.dataset.test = this.o.test;
    }
    if (!this.panel.hidden) { this.overlay.close(); return; }
    this.anchor = anchor;
    this.panel.replaceChildren(...buildMenu(this.o.items(), (it) => {
      this.close();
      anchor.focus();
      it.run?.();
    }));
    this.overlay.openBelow(this.panel, anchor, { align: this.o.align });
    anchor.setAttribute("aria-expanded", "true");
    (this.panel.querySelector<HTMLElement>("[aria-checked=true]") ?? this.panel.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
  }

  close(): void { this.overlay?.close(); }
}

/** Shows a menu of items at a point of the page, inside root; a click
 *  outside or Escape closes it (Escape calls back, to give the focus to the text again).
 *  Returns what closes it. */
export function popupMenu(root: HTMLElement, label: string, cls: string, items: MenuEntry[], at: Point,
  escaped: () => void, act: (it: MenuEntry) => void = (it) => it.run?.()): () => void {
  const menu = el("div", "cs-menu " + cls);
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  let outside: ((e: MouseEvent) => void) | undefined;
  const close = () => {
    menu.remove();
    if (outside) document.removeEventListener("mousedown", outside, true);
    outside = undefined;
  };
  menu.append(...buildMenu(items, (it) => { close(); act(it); }));
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
    escaped();
  });
  root.append(menu);
  const r = root.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - menu.offsetWidth))}px`;
  menu.style.top = `${at.y - r.top}px`;
  outside = (e) => { if (!menu.contains(e.target as Node)) close(); };
  document.addEventListener("mousedown", outside, true);
  (menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  return close;
}

/** Closes the open submenus of a menu (not the menu itself). */
function closeSubs(menu: HTMLElement) {
  menu.querySelectorAll<HTMLElement>(":scope > .has-sub > .sub").forEach((s) => { s.hidden = true; });
  menu.querySelectorAll(":scope > .has-sub > [aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}
