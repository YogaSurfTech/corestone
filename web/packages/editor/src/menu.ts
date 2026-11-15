import type { Command, EditorState } from "prosemirror-state";

// Context menus (tables, images): items with submenus, check marks and items shown only
// where they apply; arrow keys move through them, → opens a submenu, ← / Escape closes it.

export interface MenuItem {
  label: string;
  cmd?: Command;
  run?: () => void;
  sub?: MenuItem[];
  danger?: boolean;
  check?: (s: EditorState) => boolean;
  /** Shown only where cmd applies (otherwise shown disabled). */
  onlyIf?: boolean;
  disabled?: boolean;
}

/** The items of a menu; act runs a chosen item. */
export function buildMenu(items: MenuItem[], state: EditorState, act: (it: MenuItem) => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const it of items) {
    if (it.onlyIf && it.cmd && !it.cmd(state)) continue; // merge and split only where they apply
    const b = el("button", "mi" + (it.danger ? " danger" : "")) as HTMLButtonElement;
    b.type = "button";
    b.textContent = it.label;
    b.setAttribute("role", it.check ? "menuitemcheckbox" : "menuitem");
    if (it.check) b.setAttribute("aria-checked", String(it.check(state)));
    if (it.disabled || (it.cmd && !it.cmd(state))) b.disabled = true;
    if (it.sub) {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      const sub = el("div", "sub");
      sub.setAttribute("role", "menu");
      sub.setAttribute("aria-label", it.label);
      sub.append(...buildMenu(it.sub, state, act));
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

/** Closes the open submenus of a menu (not the menu itself). */
function closeSubs(menu: HTMLElement) {
  menu.querySelectorAll<HTMLElement>(":scope > .has-sub > .sub").forEach((s) => { s.hidden = true; });
  menu.querySelectorAll(":scope > .has-sub > [aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
