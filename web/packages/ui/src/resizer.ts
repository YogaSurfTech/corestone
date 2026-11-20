import { html, type TemplateResult } from "lit";
import { drag } from "./lib/drag";
import { prefs } from "./lib/prefs";

export interface ResizerOptions {
  /** The key the size is remembered under. */
  key: string;
  /** The size when none is remembered, and after a double click. */
  fallback: number;
  min: number;
  max: number;
  /** x: a bar dragged left and right; y: one dragged up and down. */
  axis: "x" | "y";
  /** What one press of an arrow key changes. */
  step: number;
  /** The size for a pointer position; box is the bar's parent as the drag began. */
  at(m: PointerEvent, box: DOMRect): number;
  /** The size grows to the left (or upwards): the arrow keys work the other way round. */
  reverse?: boolean;
  /** Called whenever the size changed. */
  changed(): void;
}

/**
 * A size the user sets with a bar: by dragging it, with the arrow keys, or
 * back to the default with a double click. The size is kept between min and
 * max and remembered in the browser.
 */
export class Resizer {
  value: number;

  constructor(readonly o: ResizerOptions) {
    this.value = Number(prefs.text(o.key)) || o.fallback;
  }

  set(value: number, remember = true): void {
    this.value = Math.min(this.o.max, Math.max(this.o.min, value));
    if (remember) prefs.setText(this.o.key, String(Math.round(this.value)));
    this.o.changed();
  }

  readonly reset = (): void => this.set(this.o.fallback);

  readonly pointerdown = (e: PointerEvent): void => {
    const box = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    drag(e, {
      cls: "dragging",
      move: (m) => this.set(this.o.at(m, box), false),
      end: () => this.set(this.value),
    });
    e.preventDefault();
  };

  readonly keydown = (e: KeyboardEvent): void => {
    const [less, more] = this.o.axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const dir = e.key === less ? -1 : e.key === more ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    this.set(this.value + dir * this.o.step * (this.o.reverse ? -1 : 1));
  };
}

/** The bar of a resizer: a separator that takes the keyboard focus. */
export function splitter(r: Resizer, cls: string, test: string): TemplateResult {
  return html`<div class=${cls} data-test=${test} role="separator" aria-orientation=${r.o.axis === "x" ? "vertical" : "horizontal"} tabindex="0" title="Drag to resize; double-click to reset"
    aria-valuemin=${r.o.min} aria-valuemax=${r.o.max} aria-valuenow=${Math.round(r.value)}
    @pointerdown=${r.pointerdown} @keydown=${r.keydown} @dblclick=${r.reset}></div>`;
}
