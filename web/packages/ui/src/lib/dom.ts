// Elements built by hand, for the code that does not render through Lit.

/** An element with a class. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K];
export function el(tag: string, cls?: string): HTMLElement;
export function el(tag: string, cls = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export interface ButtonOptions {
  cls?: string;
  /** The visible text; for a button that shows markup (an icon), use html. */
  text?: string;
  html?: string;
  /** Tooltip and accessible name, for a button without text. */
  label?: string;
  /** Runs on click; the click's default action is prevented. */
  run?: () => void;
}

/** A button of type "button". */
export function button(o: ButtonOptions = {}): HTMLButtonElement {
  const b = el("button", o.cls);
  b.type = "button";
  if (o.label) { b.title = o.label; b.setAttribute("aria-label", o.label); }
  if (o.html !== undefined) b.innerHTML = o.html;
  else if (o.text !== undefined) b.textContent = o.text;
  const run = o.run;
  if (run) b.addEventListener("click", (e) => { e.preventDefault(); run(); });
  return b;
}
