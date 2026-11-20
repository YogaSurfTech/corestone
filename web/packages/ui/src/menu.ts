import { button, el } from "./lib/dom";
import type { Point } from "./overlay";

// Menus: items with submenus, check marks and hidden or disabled items. Arrow
// keys move through them, → opens a submenu, ← / Escape closes it.

export interface MenuEntry {
  label: string;
  /** What choosing the item does; an item with a submenu opens that instead. */
  run?: () => void;
  sub?: MenuEntry[];
  danger?: boolean;
  /** Given, the item is a check item in this state. */
  checked?: boolean;
  disabled?: boolean;
  /** Left out of the menu. */
  hidden?: boolean;
}

/** The items of a menu; act runs a chosen item. */
export function buildMenu(items: MenuEntry[], act: (it: MenuEntry) => void = (it) => it.run?.()): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const it of items) {
    if (it.hidden) continue;
    const b = button({ cls: "mi" + (it.danger ? " danger" : ""), text: it.label });
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
