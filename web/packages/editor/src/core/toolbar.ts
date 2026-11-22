import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { ButtonBar, customColor, prefs, recentSwatches, setTip, swatch, tint, type ColorChoices, type Palette, type StripePreset, type Tip } from "@corestone/ui";
import type { Command, EditorState } from "prosemirror-state";
import {
  alignAt, clearFormatting, flagActive, indent, listAt, outdent, setAlign, setValue, toggleFlag, toggleList, valueAt,
} from "./commands";
import { icon } from "./icons";
import { FONTS, SIZE_MAX, SIZE_MIN, SIZES, schema, type Align, type Flag } from "./schema";
import type { ToolbarGroup, ToolbarItem, ToolbarKit } from "./feature";

// The toolbar of docs/design/Corestone editor toolbar demo.html: in a field
// without paragraph styles and entries, in a document with them; split buttons
// that repeat the last-used option, colour menus with a shared history, and
// tooltips that explain why a button is unavailable.

/** What the toolbar needs from the editor. */
export interface ToolbarHost {
  state(): EditorState;
  run(cmd: Command): void;
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

type Btn = HTMLButtonElement;

const LAST_KEY = "cs-editor-last";
const HISTORY_KEY = "cs-editor-colors";
const load = prefs.json;
const store = prefs.setJson;


export class Toolbar {
  readonly el: HTMLElement;
  /** The bar's mechanics: buttons, split buttons with their menus, tooltips, the choices used last. */
  private readonly bar: ButtonBar<EditorState>;
  private history: string[] = load(HISTORY_KEY, []);
  private pointer?: { x: number; y: number };
  private readonly historyViews: (() => void)[] = [];

  /** items: the buttons the editor's features add to the groups, in their order; groups: the groups features build themselves. */
  constructor(private readonly host: ToolbarHost, private readonly palette: Palette = DEFAULT_PALETTE, private readonly items: ToolbarItem[] = [],
    private readonly groups: ToolbarGroup[] = []) {
    this.bar = new ButtonBar<EditorState>({ cls: "cs-tb", label: "Formatting", chevron: icon("chev", 12), state: () => this.host.state(), lastKey: LAST_KEY, tipCls: "cs-tip" });
    this.el = this.bar.el;
    this.build();
    // where the last click on the toolbar was (none for keyboard use), for panels that open there
    this.el.addEventListener("click", (e) => { this.pointer = e.detail ? { x: e.clientX, y: e.clientY } : undefined; }, true);
  }

  /** Brings every button in line with the editor state. */
  update(state: EditorState) { this.bar.update(state); }

  private run(cmd: Command) { this.host.run(cmd); }
  private can(cmd: Command) { return cmd(this.host.state()); }

  private build() {
    const S = () => this.host.state();
    // history
    this.add(this.button("undo", { text: "Undo", shortcut: "Ctrl+Z", disabled: () => (undoDepth(S()) ? null : "Nothing to undo yet.") }, () => this.run(undo)));
    this.add(this.button("redo", { text: "Redo", shortcut: "Ctrl+Y", disabled: () => (redoDepth(S()) ? null : "Nothing to redo.") }, () => this.run(redo)));
    this.add(this.button("clear", { text: "Remove formatting", shortcut: "Ctrl+\\", disabled: () => (this.can(clearFormatting) ? null : "No formatting at the cursor or in the selection.") },
      () => this.run(clearFormatting)));
    this.sep();
    // paragraph style (documents): the main button repeats the last used (at first H), like the other groups
    if (this.added("style").length) this.split("heading", "Heading level", this.added("style"), "heading");
    // the groups features build themselves (documents: entries)
    for (const build of this.groups) build(this.kit);
    if (this.added("style").length || this.groups.length) this.sep();
    // character formatting
    const flags: { i: Flag; t: string; k?: string }[] = [
      { i: "bold", t: "Bold", k: "Ctrl+B" }, { i: "italic", t: "Italic", k: "Ctrl+I" }, { i: "underline", t: "Underline", k: "Ctrl+U" },
      { i: "strike", t: "Strikethrough" }, { i: "sub", t: "Subscript", k: "Ctrl+," }, { i: "sup", t: "Superscript", k: "Ctrl+." },
    ];
    const inCode = (s: EditorState) => !!s.selection.$from.parent.type.spec.code && s.selection.$from.sameParent(s.selection.$to);
    const noFormat = () => (inCode(S()) ? "A code listing has no formatting of its own." : null);
    this.split("fmt", "Text format", [...flags.map((f) => ({ i: f.i as string, tip: { text: f.t, shortcut: f.k, disabled: noFormat }, run: () => this.run(toggleFlag(f.i)),
      pressed: (s: EditorState) => flagActive(s, f.i) })), ...this.added("fmt")]);
    this.colour("color", "fcolor", "Font color", "#c62828");
    this.colour("bg", "bcolor", "Background color", "#fff59d");
    this.font();
    this.size();
    this.sep();
    // layout
    this.split("list", "Lists & indent", [
      { i: "ul", tip: { text: "Bulleted list" }, run: () => this.run(toggleList(schema.nodes.bullet_list)), pressed: (s) => listAt(s) === "ul" },
      { i: "ol", tip: { text: "Numbered list" }, run: () => this.run(toggleList(schema.nodes.ordered_list)), pressed: (s) => listAt(s) === "ol" },
      { i: "outdent", tip: { text: "Decrease indent", shortcut: "Shift+Tab", disabled: () => (this.can(outdent) ? null : "Not in a list item.") }, run: () => this.run(outdent) },
      { i: "indent", tip: { text: "Increase indent", shortcut: "Tab", disabled: () => (this.can(indent) ? null : "Only list items after the first can be indented.") }, run: () => this.run(indent) },
    ]);
    const aligns: { i: string; a: Align; t: string; k: string }[] = [
      { i: "al", a: "left", t: "Align left", k: "Ctrl+L" }, { i: "ac", a: "center", t: "Center", k: "Ctrl+E" },
      { i: "ar", a: "right", t: "Align right", k: "Ctrl+R" }, { i: "aj", a: "justify", t: "Justify", k: "Ctrl+J" },
    ];
    this.split("align", "Alignment", aligns.map((x) => ({ i: x.i, tip: { text: x.t, shortcut: x.k }, run: () => this.run(setAlign(x.a)),
      pressed: (s: EditorState) => alignAt(s) === x.a })));
    this.sep();
    this.split("ins", "Insert", this.added("ins"));
  }

  // --- building blocks ---

  /** The bar's building blocks, for a feature that builds a group of its own. */
  private readonly kit: ToolbarKit = {
    state: () => this.host.state(),
    button: (name, tip, act) => this.button(name, tip, act),
    add: (el) => this.add(el),
    group: (main, label, menu) => this.wrap(main, label, menu),
    last: (key) => this.bar.last(key),
    remember: (key, value) => this.remember(key, value),
    closeMenus: () => this.closeMenus(),
    onUpdate: (f) => this.bar.onUpdate(f),
    refresh: () => this.update(this.host.state()),
  };

  /** The buttons the features add to a group. */
  private added(group: ToolbarItem["group"]) {
    return this.items.filter((it) => it.group === group).map((it) => ({ i: it.id, tip: it.tip, run: () => it.run(this.pointer), pressed: it.pressed }));
  }

  private add(el: HTMLElement) { this.bar.add(el); }
  private sep() { this.bar.sep(); }
  private button(name: string, tip: Tip, act: () => void): Btn { return this.bar.button(name, icon(name), tip, act); }
  private wrap(main: HTMLElement, label: string, menu: HTMLElement, extra = "") { this.bar.group(main, label, menu, extra); }
  private closeMenus() { this.bar.closeMenus(); }
  private remember(key: string, v: string) { this.bar.remember(key, v); }

  /** A split button: the main part repeats the last-used item, ▾ shows them all. */
  private split(key: string, label: string, items: { i: string; tip: Tip; run: () => void; pressed?: (s: EditorState) => boolean }[], main0?: string) {
    this.bar.split(key, label, items.map((it) => ({ id: it.i, icon: icon(it.i), tip: it.tip, run: it.run, pressed: it.pressed })), main0);
  }

  /** Font or background colour: the main button applies the last colour, ▾ opens palette, picker and history. */
  private colour(mark: "color" | "bg", name: string, label: string, fallback: string) {
    const type = schema.marks[mark];
    const colors = this.colors(mark);
    let c = this.bar.last(mark) ?? fallback;
    // a font colour remembered as background from before markers had their own colours: its marker
    const ink = this.palette.colors.indexOf(c);
    if (mark === "bg" && ink >= 0 && colors[ink] !== c) c = colors[ink];
    const main = this.button(name, { text: label }, () => this.run(setValue(type, c)));
    const draw = () => {
      main.innerHTML = `<span class="cw">${icon(name)}<i style="background:${c}"></i></span>`;
      setTip(main, { text: `${label} (${c})` });
    };
    draw();
    const menu = document.createElement("div");
    menu.className = "pop cgrid";
    const pick = (v: string | null) => {
      this.run(setValue(type, v));
      if (v) { c = v; this.remember(mark, v); draw(); }
      this.closeMenus();
    };
    colors.forEach((v, n) => { const name = this.palette.names?.[n]; menu.append(swatch(v, pick, name ?? v, name ? `${name} (${v})` : v)); });
    if (this.palette.allowCustom !== false) {
      menu.append(customColor("b", icon("pick"), (v) => { this.addHistory(v); pick(v); }));
      const recent = recentSwatches(8, () => this.history, pick);
      menu.append(...recent.slots);
      const bin = this.button("trash", { text: "Clear color history",
        disabled: () => (this.history.length ? null : "No colors in the history yet. Colors you pick with the color picker appear here.") },
      () => { this.history = []; store(HISTORY_KEY, this.history); this.historyViews.forEach((f) => f()); });
      menu.append(bin);
      this.historyViews.push(recent.render);
    }
    const none = this.button("none", { text: mark === "color" ? "Automatic color" : "No background",
      disabled: () => (valueAt(this.host.state(), type) ? null : "No color set here.") }, () => pick(null));
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
      setTip(o, { text: f.css ? f.name : "The field's default font" });
      o.onclick = (e) => { e.stopPropagation(); this.run(setValue(type, f.css ? f.name : null)); this.closeMenus(); };
      menu.append(o);
    }
    main.onclick = (e) => { e.stopPropagation(); (main.nextElementSibling as HTMLElement).click(); };
    this.wrap(main, "Font", menu, "gap");
    this.bar.onUpdate((s) => {
      const v = valueAt(s, type) as string | null;
      main.innerHTML = '<span class="fn"></span>';
      main.firstElementChild!.textContent = v ?? "Default";
      main.style.fontFamily = FONTS.find((f) => f.name === v)?.css ?? "";
      setTip(main, { text: "Font: " + (v ?? "default") });
    });
  }

  /** The size of the selection in points: type any value or pick one. */
  private size() {
    const type = schema.marks.size;
    const input = document.createElement("input");
    input.className = "sz";
    input.setAttribute("aria-label", "Font size");
    input.placeholder = "–";
    setTip(input, { text: `Font size in points (${SIZE_MIN}–${SIZE_MAX}): type a value or pick one` });
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
    this.bar.onUpdate((s) => {
      if (document.activeElement === input) return; // never overwrite what is being typed
      const v = valueAt(s, type);
      input.value = v === null ? "" : String(v);
      input.classList.remove("bad");
    });
  }
}
