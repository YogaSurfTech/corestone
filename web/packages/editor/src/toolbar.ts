import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { NodeSelection, type Command, type EditorState } from "prosemirror-state";
import {
  alignAt, clearFormatting, flagActive, indent, linkAt, listAt, outdent, setAlign, setValue, toggleFlag, toggleList, valueAt,
} from "./commands";
import { isInTable } from "prosemirror-tables";
import { icon } from "./icons";
import { FONTS, SIZE_MAX, SIZE_MIN, SIZES, hexColor, schema, type Align, type Flag } from "./schema";
import { codeActive, codeAt, toggleCode } from "./code";
import { canPlace, demoteBlocked, demoteSection, makeHeading, makeNormal, promoteBlocked, promoteSection, selectedText, styleAt } from "./structure";

// The toolbar of docs/design/Corestone editor toolbar demo.html: in a field
// without paragraph styles and entries, in a document with them; split buttons
// that repeat the last-used option, colour menus with a shared history, and
// tooltips that explain why a button is unavailable.

/** What the toolbar needs from the editor. */
export interface ToolbarHost {
  state(): EditorState;
  run(cmd: Command): void;
  /** Opens the link popover for the selection. */
  link(): void;
  /** Whether the entry's files are available (images, file links). */
  files(): boolean;
  /** Opens the image picker, at the mouse pointer when the toolbar was clicked. */
  image(at?: { x: number; y: number }): void;
  /** Opens the table size grid, at the mouse pointer when the toolbar was clicked. */
  table(at?: { x: number; y: number }): void;
  /** Opens the formula dialog (for the selected formula, or a new one). */
  formula(at?: { x: number; y: number }): void;
  /** Whether diagrams can be drawn (the entry's files and draw.io are there). */
  diagrams(): boolean;
  /** Opens draw.io for a new diagram. */
  diagram(): void;
  /** In a document: placing entries and cross-references (absent in a field). */
  structure?: {
    /** Lets the user pick entries and places them at the cursor. */
    entry(): void;
    /** Makes an entry of the selected text, of an entry type (absent: the host cannot). */
    convert?(type: string): void;
    /** The entry types convert offers (each with its name and an icon element), and the name
     *  the last one used is remembered under (e.g. the document's type). */
    entryTypes?(): { remember: string; types: EntryTypeChoice[] };
    /** Turns the selected placed entry into text (absent: the host cannot). */
    unmark?(): void;
    /** Opens the cross-reference picker. */
    xref(at?: { x: number; y: number }): void;
    /** Inserts a table of contents at the cursor. */
    toc(): void;
  };
}

/** A colour palette, e.g. from company design guidelines. */
export interface Palette {
  /** Font colours. */
  colors: string[];
  /** Background (marker) colours, in the same order: a light tint of each font colour, so the
   *  same swatch gives dark ink on a light marker; a light font colour (white) gets a dark marker.
   *  No marker should equal a font colour, or text can be made unreadable (blacked out).
   *  Missing ones are derived from the font colours. */
  backgrounds?: string[];
  names?: string[];
  /** false: only palette colours, no picker and no history. */
  allowCustom?: boolean;
  /** The colour pairs offered for striped tables (first and second stripe). */
  stripes?: StripePreset[];
}

export interface StripePreset { name: string; colors: [string, string] }

/** The colours a table dialog offers: the marker swatches, the picker and history when the
 *  palette allows them, and the stripe presets. */
export interface ColorChoices {
  swatches: string[];
  custom: boolean;
  recent(): string[];
  addRecent(v: string): void;
  presets: StripePreset[];
}

export const DEFAULT_STRIPES: StripePreset[] = [
  { name: "Grey", colors: ["#ffffff", "#f3f4f6"] },
  { name: "Blue", colors: ["#ffffff", "#e3f2fd"] },
  { name: "Green", colors: ["#ffffff", "#e8f5e9"] },
  { name: "Yellow", colors: ["#ffffff", "#fffde7"] },
  { name: "Red", colors: ["#ffffff", "#ffebee"] },
  { name: "Grey and blue", colors: ["#f3f4f6", "#e3f2fd"] },
];

export const DEFAULT_PALETTE: Palette = {
  colors: ["#1f2328", "#c62828", "#e65100", "#f9a825", "#2e7d32", "#1565c0", "#6a1b9a", "#ffffff"],
  backgrounds: ["#e6e8eb", "#ffcdd2", "#ffe0b2", "#fff59d", "#c8e6c9", "#bbdefb", "#e1bee7", "#57606a"],
  allowCustom: true,
  stripes: DEFAULT_STRIPES,
};

/** A button's tooltip text and, when unavailable, the reason. */
interface Tip { t: string; k?: string; dis?: () => string | null }
/** An entry type "Convert selection to entry" can make. */
export interface EntryTypeChoice { id: string; name: string; icon: () => HTMLElement }
type El = HTMLElement & { _tip?: Tip | null };
type Btn = HTMLButtonElement & { _tip?: Tip | null };

/** The marker for a font colour: a light tint (three quarters white), or for a light
 *  colour a dark shade (three fifths black), so the ink stays readable on it. */
function tint(c: string): string {
  const n = parseInt(c.slice(1), 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.8;
  const mix = (v: number) => Math.round(light ? v * 0.4 : v + (255 - v) * 0.75).toString(16).padStart(2, "0");
  return "#" + rgb.map(mix).join("");
}

const LAST_KEY = "cs-editor-last";
const HISTORY_KEY = "cs-editor-colors";
const load = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
};
const store = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };


export class Toolbar {
  readonly el: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly updaters: ((s: EditorState) => void)[] = [];
  private last: Record<string, string> = load(LAST_KEY, {});
  private history: string[] = load(HISTORY_KEY, []);
  private pointer?: { x: number; y: number };
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
    // where the last click on the toolbar was (none for keyboard use), for panels that open there
    this.el.addEventListener("click", (e) => { this.pointer = e.detail ? { x: e.clientX, y: e.clientY } : undefined; }, true);
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
      // the reason also as the button's own hover text (when the tooltip is not shown)
      if (r) b.title = "Unavailable: " + r;
      else b.removeAttribute("title");
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
    // structure (documents): paragraph style and entries
    const st = this.host.structure;
    if (st) {
      // paragraph style and heading level: ¶ (normal text), then H− (one level up), H (heading), H+
      // (one level deeper); the main button repeats the last used (at first H), like the other groups
      const noStyle = () => (styleAt(S()) ? null : "Only paragraphs of the text have a style, not lists, tables or the title.");
      this.split("heading", "Heading level", [
        { i: "para", tip: { t: "Normal text", k: "Ctrl+Alt+0", dis: noStyle }, run: () => this.run(makeNormal), pressed: (s) => styleAt(s) === "normal" },
        { i: "hminus", tip: { t: "Heading one level up", k: "Shift+Tab", dis: () => promoteBlocked(S()) }, run: () => this.run(promoteSection) },
        { i: "heading", tip: { t: "Heading", k: "Ctrl+Alt+1", dis: noStyle }, run: () => this.run(makeHeading), pressed: (s) => styleAt(s) === "heading" },
        { i: "hplus", tip: { t: "Heading one level deeper", k: "Tab", dis: () => demoteBlocked(S()) }, run: () => this.run(demoteSection) },
      ], "heading");
      // entries: insert; and one button that makes an entry of the selected text, or (a placed
      // entry selected) turns that entry into text
      const insert = { i: "entry", tip: { t: "Insert entries…", dis: () => (this.can(canPlace) ? null : "Place the cursor in the text first.") }, run: () => st.entry() };
      if (st.convert && st.unmark && st.entryTypes) this.entriesGroup(st as Required<NonNullable<ToolbarHost["structure"]>>, insert);
      else this.add(this.button(insert.i, insert.tip, insert.run));
      this.sep();
    }
    // character formatting
    const flags: { i: Flag; t: string; k?: string }[] = [
      { i: "bold", t: "Bold", k: "Ctrl+B" }, { i: "italic", t: "Italic", k: "Ctrl+I" }, { i: "underline", t: "Underline", k: "Ctrl+U" },
      { i: "strike", t: "Strikethrough" }, { i: "sub", t: "Subscript", k: "Ctrl+," }, { i: "sup", t: "Superscript", k: "Ctrl+." },
    ];
    const noFormat = () => (codeAt(S()) ? "A code listing has no formatting of its own." : null);
    this.split("fmt", "Text format", [...flags.map((f) => ({ i: f.i as string, tip: { t: f.t, k: f.k, dis: noFormat }, run: () => this.run(toggleFlag(f.i)),
      pressed: (s: EditorState) => flagActive(s, f.i) })),
    // code: part of a line selected becomes code within the line, otherwise the paragraphs become a listing
    { i: "code", tip: { t: "Code", k: "Ctrl+Alt+C", dis: () => (this.can(toggleCode) ? null : "Code is made of text: not of a heading, a table or a placed entry.") },
      run: () => this.run(toggleCode), pressed: (s: EditorState) => codeActive(s) }]);
    this.colour("color", "fcolor", "Font color", "#c62828");
    this.colour("bg", "bcolor", "Background color", "#fff59d");
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
    this.split("ins", "Insert", [
      { i: "link", tip: { t: "Link…", k: "Ctrl+K" }, run: () => this.host.link(), pressed: (s: EditorState) => !!linkAt(s) },
      { i: "table", tip: { t: "Table…", dis: () => (isInTable(S()) ? "No tables in tables. Right-click the table for rows, columns and its properties." : null) },
        run: () => this.host.table(this.pointer) },
      { i: "image", tip: { t: "Image…", dis: () => (this.host.files() ? null : "Images are kept with a saved item; not available here.") },
        run: () => this.host.image(this.pointer) },
      { i: "diagram", tip: { t: "Diagram…", dis: () => (this.host.diagrams() ? null
        : this.host.files() ? "Diagrams are not available: draw.io is not installed on this server." : "Diagrams are kept with a saved item; not available here.") },
        run: () => this.host.diagram() },
      { i: "formula", tip: { t: "Formula…", dis: () => (this.host.files() ? null : "Formulas are kept with a saved item; not available here.") },
        run: () => this.host.formula(this.pointer) },
      ...(st ? [{ i: "xref", tip: { t: "Cross-reference…" }, run: () => st.xref(this.pointer) },
        { i: "toc", tip: { t: "Table of contents", dis: () => (this.can(canPlace) ? null : "Place the cursor in the text first.") }, run: () => st.toc() }] : []),
    ]);
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

  /** The Entries group: Insert entries…, a convert button per entry type the host offers (its
   *  icon, its name on hover) and Turn into text. The main button repeats the last used (the
   *  last type, remembered per host name); a convert with a placed entry selected turns that
   *  entry into text instead. The type buttons follow the host's list (it may come later). */
  private entriesGroup(st: Required<NonNullable<ToolbarHost["structure"]>>, insert: { i: string; tip: Tip; run: () => void }) {
    const S = () => this.host.state();
    const onEntry = (s: EditorState) => s.selection instanceof NodeSelection && s.selection.node.type === schema.nodes.placement;
    const whyNot = () => { const r = selectedText(S()); return typeof r === "string" ? r : null; };
    type Item = { key: string; tip: Tip; run: () => void; icon: () => Node };
    const svg = (name: string) => () => { const t = document.createElement("template"); t.innerHTML = icon(name); return t.content; };
    const unmark: Item = { key: "unmark", icon: svg("unentry"), run: () => st.unmark(),
      tip: { t: "Turn the entry into text", dis: () => (onEntry(S()) ? null : "Select a placed entry first.") } };
    const ins: Item = { key: "insert", icon: svg(insert.i), tip: insert.tip, run: insert.run };
    let offer = st.entryTypes();
    const convert = (t: EntryTypeChoice): Item => ({ key: "to:" + t.id, icon: t.icon, run: () => st.convert(t.id), tip: { t: `Convert selection to ${t.name}`, dis: whyNot } });
    const lastType = () => offer.types.find((t) => t.id === this.last["entrytype:" + offer.remember]) ?? offer.types[0];
    // the main button: insert, the last type's convert, or turn into text
    // (s absent: while the toolbar is built, before the editor has a state)
    const mainItem = (s?: EditorState): Item => {
      const used = this.last.entries;
      // convert and turn into text are one action that follows the selection: a placed entry
      // selected turns into text, otherwise the selection converts (to the last type)
      if (used === "unmark" || used === "convert") return (s && onEntry(s)) || !lastType() ? unmark : convert(lastType()!);
      return ins;
    };
    const menu = document.createElement("div");
    menu.className = "pop";
    const main = this.button("entry", ins.tip, () => shown.run());
    let shown = ins;
    const show = (it: Item) => {
      shown = it;
      main.replaceChildren(it.icon());
      main.dataset.cmd = it.key;
      main.setAttribute("aria-label", it.tip.t);
      main._tip = it.tip;
    };
    const fill = () => {
      const items = [ins, ...offer.types.map(convert), unmark];
      menu.replaceChildren(...items.map((it) => {
        const b = this.button(it.key, it.tip, () => {
          it.run();
          this.remember("entries", it.key === "insert" ? "insert" : it.key === "unmark" ? "unmark" : "convert");
          if (it.key.startsWith("to:")) this.remember("entrytype:" + offer.remember, it.key.slice(3));
          this.closeMenus();
          this.update(S());
        });
        b.replaceChildren(it.icon());
        return b;
      }));
    };
    fill();
    show(mainItem());
    this.wrap(main, "Entries", menu);
    let known = JSON.stringify(offer.types.map((t) => t.id)) + offer.remember;
    this.updaters.push((s) => {
      const next = st.entryTypes();
      const sig = JSON.stringify(next.types.map((t) => t.id)) + next.remember;
      if (sig !== known) { known = sig; offer = next; fill(); }
      const it = mainItem(s);
      if (it.key !== shown.key) show(it);
    });
  }

  /** A split button: the main part repeats the last-used item, ▾ shows them all. */
  private split(key: string, label: string, items: { i: string; tip: Tip; run: () => void; pressed?: (s: EditorState) => boolean }[], main0?: string) {
    const menu = document.createElement("div");
    menu.className = "pop";
    let current = items.find((x) => x.i === this.last[key]) ?? items.find((x) => x.i === main0) ?? items[0];
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
    const colors = this.colors(mark);
    let c = this.last[mark] ?? fallback;
    // a font colour remembered as background from before markers had their own colours: its marker
    const ink = this.palette.colors.indexOf(c);
    if (mark === "bg" && ink >= 0 && colors[ink] !== c) c = colors[ink];
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
    colors.forEach((v, n) => menu.append(swatch(v, this.palette.names?.[n])));
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

  /** The swatches of the font or the background colour menu. */
  private colors(mark: "color" | "bg"): string[] {
    if (mark === "color") return this.palette.colors;
    return this.palette.colors.map((c, i) => this.palette.backgrounds?.[i] ?? tint(c));
  }

  /** The colours for the table dialog, with the same limits as the marker colour. */
  colorChoices(): ColorChoices {
    const custom = this.palette.allowCustom !== false;
    return {
      swatches: this.colors("bg"),
      custom,
      recent: () => (custom ? this.history : []),
      addRecent: (v) => { if (custom) this.addHistory(v); },
      presets: this.palette.stripes ?? DEFAULT_STRIPES,
    };
  }

  private addHistory(v: string) {
    if (this.colors("color").includes(v) || this.colors("bg").includes(v)) return;
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
