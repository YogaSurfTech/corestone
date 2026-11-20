import { button, el } from "./lib/dom";

export interface Point { x: number; y: number }

export interface OverlayOptions {
  /** The element the panels are placed in and kept inside of; it must be a positioned element. */
  root: HTMLElement;
  /**
   * The controls in a panel that take the focus when clicked (a selector, "input, select").
   * A click anywhere else in the panel leaves the focus where it is. Without it clicks are left alone.
   */
  keepFocus?: string;
  /** Asked first when Escape is pressed in a panel; true means it was used up (a popup inside closed). */
  escape?(): boolean;
  /** Called after Escape closed the panel, to give the focus back. */
  onEscape?(): void;
  /** Called whenever the panels close, also before another one opens. */
  onClose?(): void;
}

/**
 * A group of floating panels (menus, small dialogs) inside one element, of
 * which one is open at a time. A click outside the open panel or Escape in it
 * closes it.
 */
export class Overlay {
  private readonly panels: HTMLElement[] = [];
  private outside?: (e: MouseEvent) => void;

  constructor(private readonly o: OverlayOptions) {}

  /** Adds a panel to the group; it stays hidden until it is opened. */
  panel(cls: string, role: "dialog" | "menu", label?: string): HTMLElement {
    const p = el("div", cls);
    p.setAttribute("role", role);
    if (label) p.setAttribute("aria-label", label);
    p.hidden = true;
    const keep = this.o.keepFocus;
    if (keep !== undefined) p.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest(keep)) e.preventDefault(); });
    p.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (this.o.escape?.()) return;
      this.close();
      this.o.onEscape?.();
    });
    this.panels.push(p);
    this.o.root.append(p);
    return p;
  }

  /** Shows a panel with its top left corner at a point of the window, moved left as far as needed to stay inside the root. */
  open(panel: HTMLElement, at: Point): void {
    this.close();
    panel.hidden = false;
    const r = this.o.root.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - panel.offsetWidth))}px`;
    panel.style.top = `${at.y - r.top}px`;
    this.outside = (e) => { if (!panel.contains(e.target as Node)) this.close(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  get isOpen(): boolean { return this.panels.some((p) => !p.hidden); }

  close(): void {
    for (const p of this.panels) p.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
    this.o.onClose?.();
  }
}

/**
 * The head of a small dialog: its title and a close button showing the given
 * markup (an icon). With `close`, a click on the button calls it.
 */
export function dialogHead(title: string, closeIcon: string, close?: () => void): { head: HTMLElement; x: HTMLButtonElement } {
  const head = el("div", "head");
  const text = el("span", "title");
  text.textContent = title;
  const x = button({ cls: "x", label: "Close", html: closeIcon, run: close });
  head.append(text, x);
  return { head, x };
}
