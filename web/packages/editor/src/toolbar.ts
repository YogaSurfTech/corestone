import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { Command, EditorState } from "prosemirror-state";
import {
  alignAt, clearFormatting, flagActive, indent, listAt, outdent, setAlign, setValue, toggleFlag, toggleList, valueAt,
} from "./commands";
import { icon } from "./icons";
import { FONTS, SIZE_MAX, SIZE_MIN, SIZES, hexColor, schema, type Align, type Flag } from "./schema";

// The toolbar of docs/design/Corestone editor toolbar demo.html, in the
// entry view (no paragraph styles, no Corestone functions): split buttons
// that repeat the last-used option, colour menus with a shared history, and
// tooltips that explain why a button is unavailable.

/** What the toolbar needs from the editor. */
export interface ToolbarHost {
  state(): EditorState;
  run(cmd: Command): void;
}

/** A colour palette, e.g. from company design guidelines. */
export interface Palette {
  colors: string[];
  names?: string[];
  /** false: only palette colours, no picker and no history. */
  allowCustom?: boolean;
}

export const DEFAULT_PALETTE: Palette = {
  colors: ["#1f2328", "#c62828", "#e65100", "#f9a825", "#2e7d32", "#1565c0", "#6a1b9a", "#ffffff"],
  allowCustom: true,
};

/** A button's tooltip text and, when unavailable, the reason. */
interface Tip { t: string; k?: string; dis?: () => string | null }
type El = HTMLElement & { _tip?: Tip | null };
type Btn = HTMLButtonElement & { _tip?: Tip | null };

const LAST_KEY = "cs-editor-last";
const HISTORY_KEY = "cs-editor-colors";
const load = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
const store = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const SOON = "Not part of this demo yet: links, images, tables, diagrams and formulas come with TSK-15.";

export class Toolbar {
  readonly el: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly updaters: ((s: EditorState) => void)[] = [];
  private last: Record<string, string> = load(LAST_KEY, {});
  private history: string[] = load(HISTORY_KEY, []);
  private readonly historyViews: (() => void)[] = [];

  constructor(private readonly host: ToolbarHost, private readonly palette: Palette = DEFAULT_PALETTE) {
    this.el = document.createElement("div");
    this.el.className = "cs-tb";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Formatting");
    this.tip = document.createElement("div");
    this.tip.className = "cs-tip";
    this.tip.setAttribute("role", "tooltip");
    this.el.append(this.tip);
    this.build();
    this.tooltips();
    // Clicking the toolbar must not take the focus (and the selection) from the text.
    this.el.addEventListener("mousedown", (e) => {
      if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
    });
    document.addEventListener("click", () => this.closeMenus());
  }

  /** Brings every button in line with the editor state. */
  update(state: EditorState) {
    for (const u of this.updaters) u(state);
    this.el.querySelectorAll<El>(".b, .f").forEach((b) => {
      const r = b._tip?.dis?.();
      if (r) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    });
  }

  private run(cmd: Command) { this.host.run(cmd); }
  private can(cmd: Command) { return cmd(this.host.state()); }

  private build() {
    const S = () => this.host.state();
    // history
    this.add(this.button("undo", { t: "Undo", k: "Ctrl+Z", dis: () => (undoDepth(S()) ? null : "Nothing to undo yet.") }, () => this.run(undo)));
    this.add(this.button("redo", { t: "Redo", k: "Ctrl+Y", dis: () => (redoDepth(S()) ? null : "Nothing to redo.") }, () => this.run(redo)));
    this.add(this.button("clear", { t: "Remove formatting", k: "Ctrl+\\", dis: () => (this.can(clearFormatting) ? null : "No formatting at the cursor or in the selection.") },
      () => this.run(clearFormatting)));
    this.sep();
    // character formatting
    const flags: { i: Flag; t: string; k?: string }[] = [
      { i: "bold", t: "Bold", k: "Ctrl+B" }, { i: "italic", t: "Italic", k: "Ctrl+I" }, { i: "underline", t: "Underline", k: "Ctrl+U" },
      { i: "strike", t: "Strikethrough" }, { i: "sub", t: "Subscript", k: "Ctrl+," }, { i: "sup", t: "Superscript", k: "Ctrl+." },
    ];
    this.split("fmt", "Text format", flags.map((f) => ({ i: f.i, tip: { t: f.t, k: f.k }, run: () => this.run(toggleFlag(f.i)),
      pressed: (s: EditorState) => flagActive(s, f.i) })));
    this.colour("color", "fcolor", "Font color", "#c62828");
    this.colour("bg", "bcolor", "Background color", "#f9a825");
    this.font();
    this.size();
    this.sep();
    // layout
    this.split("list", "Lists & indent", [
      { i: "ul", tip: { t: "Bulleted list" }, run: () => this.run(toggleList(schema.nodes.bullet_list)), pressed: (s) => listAt(s) === "ul" },
      { i: "ol", tip: { t: "Numbered list" }, run: () => this.run(toggleList(schema.nodes.ordered_list)), pressed: (s) => listAt(s) === "ol" },
      { i: "outdent", tip: { t: "Decrease indent", k: "Shift+Tab", dis: () => (this.can(outdent) ? null : "Not in a list item.") }, run: () => this.run(outdent) },
      { i: "indent", tip: { t: "Increase indent", k: "Tab", dis: () => (this.can(indent) ? null : "Only list items after the first can be indented.") }, run: () => this.run(indent) },
    ]);
    const aligns: { i: string; a: Align; t: string; k: string }[] = [
      { i: "al", a: "left", t: "Align left", k: "Ctrl+L" }, { i: "ac", a: "center", t: "Center", k: "Ctrl+E" },
      { i: "ar", a: "right", t: "Align right", k: "Ctrl+R" }, { i: "aj", a: "justify", t: "Justify", k: "Ctrl+J" },
    ];
    this.split("align", "Alignment", aligns.map((x) => ({ i: x.i, tip: { t: x.t, k: x.k }, run: () => this.run(setAlign(x.a)),
      pressed: (s: EditorState) => alignAt(s) === x.a })));
    this.sep();
    this.split("ins", "Insert", ["link", "image", "table", "diagram", "formula"].map((i) => ({
      i, tip: { t: `Insert ${i}…`, dis: () => SOON }, run: () => undefined })));
  }

  // --- building blocks ---

  private add(el: HTMLElement) { this.el.insertBefore(el, this.tip); }
  private sep() { const s = document.createElement("span"); s.className = "sep"; this.add(s); }

  private button(name: string, tip: Tip, act: () => void): Btn {
    const b: Btn = document.createElement("button");
    b.type = "button";
    b.className = "b";
    b.innerHTML = icon(name);
    b.setAttribute("aria-label", tip.t);
    b.dataset.cmd = name;
    b._tip = tip;
    b.onclick = (e) => { e.stopPropagation(); if (b._tip?.dis?.()) return; act(); };
    return b;
  }

  private chevron(label: string, menu: HTMLElement): El {
    const c: Btn = document.createElement("button");
    c.type = "button";
    c.className = "c";
    c.innerHTML = icon("chev", 12);
    c.setAttribute("aria-label", "More: " + label);
    c.setAttribute("aria-expanded", "false");
    c._tip = { t: label + " options" };
    c.onclick = (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      this.closeMenus();
      if (open) { menu.classList.add("open"); c.setAttribute("aria-expanded", "true"); }
    };
    return c;
  }

  private wrap(main: HTMLElement, label: string, menu: HTMLElement, extra = "") {
    const w = document.createElement("div");
    w.className = "sp " + extra;
    w.append(main, this.chevron(label, menu), menu);
    this.add(w);
  }

  private closeMenus() {
    this.el.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open"));
    this.el.querySelectorAll(".c").forEach((c) => c.setAttribute("aria-expanded", "false"));
  }

  private remember(key: string, v: string) { this.last[key] = v; store(LAST_KEY, this.last); }

  /** A split button: the main part repeats the last-used item, ▾ shows them all. */
  private split(key: string, label: string, items: { i: string; tip: Tip; run: () => void; pressed?: (s: EditorState) => boolean }[]) {
    const menu = document.createElement("div");
    menu.className = "pop";
    let current = items.find((x) => x.i === this.last[key]) ?? items[0];
    const main = this.button(current.i, current.tip, () => current.run());
    const show = () => {
      main.innerHTML = icon(current.i);
      main.dataset.cmd = current.i;
      main.setAttribute("aria-label", current.tip.t);
      main._tip = current.tip;
    };
    const buttons = items.map((it) => {
      const b = this.button(it.i, it.tip, () => {
        it.run();
        current = it;
        this.remember(key, it.i);
        show();
        this.closeMenus();
        this.update(this.host.state());
      });
      menu.append(b);
      return b;
    });
    this.wrap(main, label, menu);
    this.updaters.push((s) => {
      items.forEach((it, n) => { if (it.pressed) buttons[n].setAttribute("aria-pressed", String(it.pressed(s))); });
      if (current.pressed) main.setAttribute("aria-pressed", String(current.pressed(s)));
      else main.removeAttribute("aria-pressed");
    });
  }

  /** Font or background colour: the main button applies the last colour, ▾ opens palette, picker and history. */
  private colour(mark: "color" | "bg", name: string, label: string, fallback: string) {
    const type = schema.marks[mark];
    let c = this.last[mark] ?? fallback;
    const main = this.button(name, { t: label }, () => this.run(setValue(type, c)));
    const draw = () => {
      main.innerHTML = `<span class="cw">${icon(name)}<i style="background:${c}"></i></span>`;
      main._tip = { t: `${label} (${c})` };
    };
    draw();
    const menu = document.createElement("div");
    menu.className = "pop cgrid";
    const pick = (v: string | null) => {
      this.run(setValue(type, v));
      if (v) { c = v; this.remember(mark, v); draw(); }
      this.closeMenus();
    };
    const swatch = (v: string, name?: string) => {
      const s: Btn = document.createElement("button");
      s.type = "button";
      s.className = "sw";
      s.style.background = v;
      s.setAttribute("aria-label", name ?? v);
      s._tip = { t: name ? `${name} (${v})` : v };
      s.onclick = (e) => { e.stopPropagation(); pick(v); };
      return s;
    };
    this.palette.colors.forEach((v, n) => menu.append(swatch(v, this.palette.names?.[n])));
    const custom = this.palette.allowCustom !== false;
    if (custom) {
      const picker: El = document.createElement("label");
      picker.className = "b";
      picker.innerHTML = icon("pick") + '<input type="color" tabindex="-1">';
      picker._tip = { t: "Custom color…" };
      const input = picker.querySelector("input")!;
      input.onchange = () => { const v = hexColor(input.value); if (v) { this.addHistory(v); pick(v); } };
      picker.onclick = (e) => e.stopPropagation();
      menu.append(picker);
      const slots: Btn[] = [];
      for (let k = 0; k < 8; k++) {
        const h: Btn = document.createElement("button");
        h.type = "button";
        h.onclick = (e) => { e.stopPropagation(); if (this.history[k]) pick(this.history[k]); };
        slots.push(h);
        menu.append(h);
      }
      const bin = this.button("trash", { t: "Clear color history",
        dis: () => (this.history.length ? null : "No colors in the history yet. Colors you pick with the color picker appear here.") },
      () => { this.history = []; store(HISTORY_KEY, this.history); this.historyViews.forEach((f) => f()); });
      menu.append(bin);
      const render = () => slots.forEach((h, k) => {
        const v = this.history[k];
        h.className = "sw" + (v ? "" : " empty");
        h.style.background = v ?? "";
        h.setAttribute("aria-label", v ? "Recent color " + v : "Empty slot");
        h._tip = v ? { t: "Recent: " + v } : null;
        h.disabled = !v;
      });
      this.historyViews.push(render);
      render();
    }
    const none = this.button("none", { t: mark === "color" ? "Automatic color" : "No background",
      dis: () => (valueAt(this.host.state(), type) ? null : "No color set here.") }, () => pick(null));
    none.classList.add("none");
    menu.append(none);
    this.wrap(main, label, menu);
  }

  private addHistory(v: string) {
    if (this.palette.colors.includes(v)) return;
    this.history = [...this.history.filter((x) => x !== v), v].slice(-8);
    store(HISTORY_KEY, this.history);
    this.historyViews.forEach((f) => f());
  }

  /** The font of the selection; picking one sets it, "Default" removes it. */
  private font() {
    const type = schema.marks.font;
    const main: Btn = document.createElement("button");
    main.type = "button";
    main.className = "b fontsel";
    const menu = document.createElement("div");
    menu.className = "pop col";
    const options: { name: string; css: string | null }[] = [{ name: "Default", css: null }, ...FONTS];
    for (const f of options) {
      const o: Btn = document.createElement("button");
      o.type = "button";
      o.className = "f";
      o.textContent = f.name;
      if (f.css) o.style.fontFamily = f.css;
      o._tip = { t: f.css ? f.name : "The field's default font" };
      o.onclick = (e) => { e.stopPropagation(); this.run(setValue(type, f.css ? f.name : null)); this.closeMenus(); };
      menu.append(o);
    }
    main.onclick = (e) => { e.stopPropagation(); (main.nextElementSibling as HTMLElement).click(); };
    this.wrap(main, "Font", menu, "gap");
    this.updaters.push((s) => {
      const v = valueAt(s, type) as string | null;
      main.innerHTML = '<span class="fn"></span>';
      main.firstElementChild!.textContent = v ?? "Default";
      main.style.fontFamily = FONTS.find((f) => f.name === v)?.css ?? "";
      main._tip = { t: "Font: " + (v ?? "default") };
    });
  }

  /** The size of the selection in points: type any value or pick one. */
  private size() {
    const type = schema.marks.size;
    const input = document.createElement("input") as HTMLInputElement & { _tip?: Tip };
    input.className = "sz";
    input.setAttribute("aria-label", "Font size");
    input.placeholder = "–";
    input._tip = { t: `Font size in points (${SIZE_MIN}–${SIZE_MAX}): type a value or pick one` };
    const apply = () => {
      const raw = input.value.trim();
      if (!raw) { this.run(setValue(type, null)); return; }
      const n = Math.round(Number(raw) * 2) / 2;
      if (!Number.isFinite(n) || n < SIZE_MIN || n > SIZE_MAX) { input.classList.add("bad"); return; }
      input.classList.remove("bad");
      this.run(setValue(type, n));
    };
    input.onchange = apply;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } };
    const menu = document.createElement("div");
    menu.className = "pop col";
    menu.style.minWidth = "80px";
    for (const v of [null, ...SIZES]) {
      const o = document.createElement("button");
      o.type = "button";
      o.className = "f";
      o.textContent = v === null ? "Default" : String(v);
      o.onclick = (e) => { e.stopPropagation(); this.run(setValue(type, v)); this.closeMenus(); };
      menu.append(o);
    }
    this.wrap(input, "Font size", menu);
    this.updaters.push((s) => {
      if (document.activeElement === input) return; // never overwrite what is being typed
      const v = valueAt(s, type);
      input.value = v === null ? "" : String(v);
      input.classList.remove("bad");
    });
  }

  /** Tooltips after 0.5 s on hover or focus; unavailable buttons say why. */
  private tooltips() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: El | null = null;
    const hide = () => { clearTimeout(timer); target = null; this.tip.classList.remove("on"); };
    const show = (el: El) => {
      const it = el._tip;
      if (!it) return;
      const r = it.dis?.();
      this.tip.innerHTML = "";
      if (r) { const b = document.createElement("b"); b.textContent = "Unavailable"; this.tip.append(b); }
      this.tip.append(it.t + (it.k ? ` · ${it.k}` : ""));
      if (r) { this.tip.append(document.createElement("br"), r); }
      const rc = el.getBoundingClientRect();
      this.tip.classList.add("on");
      const w = this.tip.offsetWidth;
      this.tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, rc.left + rc.width / 2 - w / 2)) + "px";
      this.tip.style.top = rc.bottom + 8 + "px";
    };
    const later = (el: El) => {
      if (el === target) return;
      clearTimeout(timer);
      this.tip.classList.remove("on");
      target = el;
      timer = setTimeout(() => { if (target === el) show(el); }, 500);
    };
    const find = (e: Event) => (e.target as HTMLElement).closest<El>(".b, .c, .sz, .sw, .f");
    this.el.addEventListener("mouseover", (e) => { const el = find(e); if (el?._tip) later(el); else hide(); });
    this.el.addEventListener("mouseleave", hide);
    this.el.addEventListener("focusin", (e) => { const el = find(e); if (el?._tip) later(el); });
    this.el.addEventListener("focusout", hide);
    addEventListener("scroll", hide, true);
  }
}
