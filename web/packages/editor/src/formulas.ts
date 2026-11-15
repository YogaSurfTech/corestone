import type { Node } from "prosemirror-model";
import { NodeSelection, Plugin, type Command, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { EntryFiles } from "./files";
import { icon } from "./icons";
import { buildMenu, type MenuItem } from "./menu";
import { MAX_FORMULA } from "./model";
import { schema } from "./schema";

// Formulas: LaTeX in the text, shown as a picture of it, a PNG file of the entry
// (one per formula). MathJax makes the picture; it is loaded only to write a
// formula or to make a picture again (a pasted formula, another way to show it),
// never to read one.

const SCALE = 2; // the PNG has twice the pixels it is shown with, to stay sharp
const EM = 16; // the font size, in pixels, MathJax makes the picture for (see mathjax.ts)

type MathJax = typeof import("./mathjax");
let mathjax: Promise<MathJax> | undefined;
const loadMathJax = () => (mathjax ??= import("./mathjax").catch((e) => { mathjax = undefined; throw e; }));

/** The file name of a formula's picture: "formula-" and its LaTeX made safe (letters and
 *  digits, the rest as "_"). Each formula gets a file of its own (the host numbers names
 *  already taken), so a changed formula never changes the picture of another. */
export function formulaFile(latex: string): string {
  const words = latex.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
  return words ? `formula-${words}.png` : "formula.png";
}

/** The picture of a formula as PNG. One in the text has as much room below its baseline as
 *  above, so that centred on the line its baseline sits on the text's. */
export async function formulaPng(latex: string, display: boolean): Promise<Blob> {
  const r = (await loadMathJax()).render(latex, display);
  const above = r.baseline, below = r.height - r.baseline;
  const half = Math.max(above, below);
  const h = display ? r.height : 2 * half, top = display ? 0 : half - above;
  const img = await svgImage(r.svg);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(r.width * SCALE));
  c.height = Math.max(1, Math.ceil(h * SCALE));
  c.getContext("2d")!.drawImage(img, 0, top * SCALE, r.width * SCALE, r.height * SCALE);
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("no picture"))), "image/png"));
}

async function svgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How a formula shows: its picture as a mask in the colour of the text (so it suits light
 *  and dark themes), at half the picture's pixels; its LaTeX while there is no picture. */
export class FormulaView implements NodeView {
  dom: HTMLElement;
  private shown = "";

  constructor(private node: Node, private readonly files: () => EntryFiles | undefined) {
    this.dom = el("span", "cs-formula");
    this.dom.setAttribute("role", "img");
    this.render();
  }

  private render() {
    const { latex, display, png } = this.node.attrs as { latex: string; display: boolean; png: string | null };
    this.dom.classList.toggle("display", display);
    this.dom.classList.toggle("pending", !png);
    this.dom.setAttribute("aria-label", latex);
    this.dom.title = latex;
    const url = png ? this.files()?.url(png) ?? "" : "";
    if (url === this.shown && this.dom.firstChild) return;
    this.shown = url;
    const text = () => {
      this.dom.classList.add("source");
      this.dom.style.cssText = "";
      this.dom.textContent = latex;
    };
    if (!url) { text(); return; }
    const glyph = el("span", "glyph");
    const img = new Image();
    img.onload = () => {
      if (this.shown !== url) return;
      this.dom.classList.remove("source");
      // sized in em (the picture is made for a 16 px font), so a formula follows the text's size
      const em = (px: number) => `${px / SCALE / EM}em`;
      glyph.style.width = em(img.naturalWidth);
      glyph.style.height = em(img.naturalHeight);
      // a formula in the text has its baseline in the middle of its picture
      glyph.style.verticalAlign = display ? "" : em(-img.naturalHeight / 2);
      glyph.style.setProperty("--cs-formula", `url("${CSS.escape(url)}")`);
      this.dom.replaceChildren(glyph);
    };
    img.onerror = () => { if (this.shown === url) text(); };
    img.src = url;
    if (!this.dom.firstChild) text();
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() { this.dom.classList.add("selected"); }
  deselectNode() { this.dom.classList.remove("selected"); }
  ignoreMutation() { return true; }
}

/** Formulas without a picture (new, changed, pasted, or shown another way) get one, a new
 *  file of the entry. Those that cannot be made are left out, with a notice. */
export function formulaPictures(files: () => EntryFiles | undefined, notice: (msg: string) => void) {
  const done = new Map<string, string | null>(); // key → file name (null: failed)
  const started = new Set<string>();
  const keyOf = (n: Node) => JSON.stringify([n.attrs.latex, n.attrs.display]);

  const make = async (latex: string, display: boolean): Promise<string> => {
    const f = files();
    if (!f) throw new Error("no file store");
    return f.add(new File([await formulaPng(latex, display)], formulaFile(latex), { type: "image/png" }));
  };

  const finish = (view: EditorView, key: string) => {
    const name = done.get(key);
    const tr = view.state.tr;
    const found: { pos: number; node: Node }[] = [];
    view.state.doc.descendants((n, pos) => {
      if (n.type === schema.nodes.formula && !n.attrs.png && keyOf(n) === key) found.push({ pos, node: n });
    });
    for (const { pos, node } of found.reverse()) {
      if (name) tr.setNodeMarkup(pos, null, { ...node.attrs, png: name });
      else tr.delete(pos, pos + node.nodeSize);
    }
    if (found.length) view.dispatch(tr.setMeta("addToHistory", false));
  };

  return new Plugin({
    view: (view) => {
      const check = (v: EditorView) => {
        const todo = new Map<string, Node>();
        v.state.doc.descendants((n) => { if (n.type === schema.nodes.formula && !n.attrs.png) todo.set(keyOf(n), n); });
        for (const [key, n] of todo) {
          if (done.has(key)) { finish(v, key); continue; }
          if (started.has(key)) continue;
          started.add(key);
          make(n.attrs.latex, n.attrs.display).then((name) => done.set(key, name), (e) => {
            done.set(key, null);
            notice(files() ? `A formula could not be shown${e instanceof Error && e.message ? ": " + e.message : ""}; it was left out.`
              : "Formulas are kept with a saved item; the formula was left out.");
          }).finally(() => { started.delete(key); finish(v, key); done.delete(key); });
        }
      };
      check(view);
      return { update: (v, prev) => { if (v.state.doc !== prev.doc) check(v); } };
    },
  });
}

/** Inserts a formula at the selection, or replaces the selected one; its picture follows. */
export function setFormula(latex: string, display: boolean): Command {
  return (state, dispatch) => {
    const node = schema.nodes.formula.create({ latex, display, png: null });
    dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** The selected formula, if any. */
export function selectedFormula(state: EditorState): { pos: number; node: Node } | null {
  const sel = state.selection;
  return sel instanceof NodeSelection && sel.node.type === schema.nodes.formula ? { pos: sel.from, node: sel.node } : null;
}

/** The formula dialog (LaTeX with a live preview) and the formula menu. */
export class FormulaUI {
  private readonly dialog: HTMLElement;
  private readonly menu: HTMLElement;
  private outside?: (e: MouseEvent) => void;
  private previewUrl = "";
  private timer?: number;

  constructor(private readonly view: () => EditorView, private readonly root: HTMLElement) {
    this.dialog = el("div", "cs-formulapop");
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-label", "Formula");
    this.menu = el("div", "cs-menu cs-formulamenu");
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-label", "Formula");
    for (const p of [this.dialog, this.menu]) {
      p.hidden = true;
      p.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest("textarea")) e.preventDefault(); });
      p.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.view().focus();
      });
    }
    root.append(this.dialog, this.menu);
  }

  /** Writes a new formula, or the selected one. */
  edit(at?: { x: number; y: number }) {
    const view = this.view();
    const current = selectedFormula(view.state);
    let display = current ? !!current.node.attrs.display : false;

    const head = el("div", "head");
    const title = el("span", "title");
    title.textContent = "Formula";
    const x = button("x", "Close", icon("close", 18));
    x.addEventListener("click", (e) => { e.preventDefault(); this.close(); this.view().focus(); });
    head.append(title, x);

    const src = el("textarea", "latex") as HTMLTextAreaElement;
    src.value = current?.node.attrs.latex ?? "";
    src.rows = 3;
    src.spellcheck = false;
    src.placeholder = "LaTeX, e.g. E = mc^2";
    src.setAttribute("aria-label", "LaTeX");

    const kinds = el("div", "choice");
    kinds.setAttribute("role", "radiogroup");
    kinds.setAttribute("aria-label", "Placement");
    const kindButtons = ([["inline", "In the text", false], ["display", "On a line of its own", true]] as const).map(([i, label, d]) => {
      const b = button("opt", label, icon(`f-${i}`, 20));
      b.setAttribute("role", "radio");
      b.addEventListener("click", (e) => { e.preventDefault(); display = d; mark(); preview(); });
      return b;
    });
    const mark = () => kindButtons.forEach((b, i) => b.setAttribute("aria-checked", String((i === 1) === display)));
    mark();
    kinds.append(...kindButtons);

    const shown = el("div", "preview");
    shown.setAttribute("aria-live", "polite");
    const msg = el("div", "msg");
    msg.setAttribute("role", "alert");
    const ok = button("lb apply", "", "Apply");
    ok.removeAttribute("title");
    ok.removeAttribute("aria-label");
    // greyed out (but still hoverable, for its tooltip: why it cannot be applied)
    const canApply = (yes: boolean, why = "") => {
      ok.setAttribute("aria-disabled", String(!yes));
      if (yes || !why) ok.removeAttribute("title"); else ok.title = why;
    };
    const foot = el("div", "foot");
    foot.append(kinds, ok);

    const showError = (text: string) => {
      const b = document.createElement("strong");
      b.textContent = "ERROR:";
      msg.replaceChildren(b, " " + text);
    };
    /** Checks the LaTeX as it is now and shows it (or MathJax's message); true when it can be shown. */
    const check = async (): Promise<boolean> => {
      window.clearTimeout(this.timer);
      const latex = src.value;
      if (!latex.trim()) { shown.replaceChildren(); msg.textContent = ""; canApply(false, "Write a formula first."); return false; }
      let valid = false;
      try {
        const r = (await loadMathJax()).render(latex, display);
        if (src.value !== latex) return false;
        // the preview in the colour of the dialog's text (an image cannot inherit it)
        const color = getComputedStyle(this.dialog).color;
        const svg = r.svg.replace(/currentColor/g, color);
        URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const img = document.createElement("img");
        img.src = this.previewUrl;
        img.alt = latex;
        img.style.width = `${r.width}px`;
        shown.replaceChildren(img);
        msg.textContent = "";
        valid = true;
      } catch (e) {
        if (src.value !== latex) return false;
        // MathJax's TeX errors are not Error objects, but carry a message
        const m = (e as { message?: unknown } | null)?.message;
        showError(typeof m === "string" && m ? m : "This formula cannot be shown.");
      }
      canApply(valid, msg.textContent ?? "");
      return valid;
    };
    const preview = () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void check(), 120);
    };
    // Apply checks the text as it is now (not what the preview showed a moment ago)
    const apply = async () => {
      const latex = src.value.trim();
      if (!latex || !(await check()) || src.value.trim() !== latex || this.dialog.hidden) return;
      if (new TextEncoder().encode(latex).length > MAX_FORMULA) { showError(`A formula has at most ${MAX_FORMULA} bytes.`); return; }
      this.close();
      const v = this.view();
      if (current && selectedFormula(v.state)?.pos !== current.pos) {
        v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, current.pos)));
      }
      setFormula(latex, display)(v.state, v.dispatch);
      v.focus();
    };
    src.addEventListener("input", preview);
    src.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void apply(); } });
    ok.addEventListener("click", (e) => { e.preventDefault(); void apply(); });
    canApply(false);

    this.dialog.replaceChildren(head, msg, src, shown, foot); // the error above the LaTeX
    this.open(this.dialog, at ?? this.cursorPoint());
    src.focus();
    preview();
  }

  /** The menu of the selected formula. */
  openMenu(at: { x: number; y: number }) {
    const view = this.view();
    const f = selectedFormula(view.state);
    if (!f) return;
    const items: MenuItem[] = [
      { label: "Edit formula…", run: () => this.edit(at) },
      { label: "On a line of its own", check: () => !!f.node.attrs.display,
        cmd: (state, dispatch) => {
          dispatch?.(state.tr.setNodeMarkup(f.pos, null, { ...f.node.attrs, display: !f.node.attrs.display, png: null }));
          return true;
        } },
      { label: "Delete", danger: true, cmd: (state, dispatch) => { dispatch?.(state.tr.delete(f.pos, f.pos + f.node.nodeSize)); return true; } },
    ];
    this.menu.replaceChildren(...buildMenu(items, view.state, (it) => {
      this.close();
      const v = this.view();
      if (it.cmd) { it.cmd(v.state, v.dispatch); v.focus(); }
      it.run?.();
    }));
    this.open(this.menu, at);
    (this.menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  }

  private open(panel: HTMLElement, at: { x: number; y: number }) {
    this.close();
    panel.hidden = false;
    const r = this.root.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - panel.offsetWidth))}px`;
    panel.style.top = `${at.y - r.top}px`;
    this.outside = (e) => { if (!panel.contains(e.target as globalThis.Node)) this.close(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  private cursorPoint() {
    const view = this.view();
    const c = view.coordsAtPos(view.state.selection.head);
    return { x: c.left, y: c.bottom + 4 };
  }

  close() {
    this.dialog.hidden = this.menu.hidden = true;
    window.clearTimeout(this.timer);
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
  }

  destroy() { this.close(); URL.revokeObjectURL(this.previewUrl); }
}

function button(cls: string, label: string, html: string): HTMLButtonElement {
  const b = el("button", cls) as HTMLButtonElement;
  b.type = "button";
  if (label) { b.title = label; b.setAttribute("aria-label", label); }
  b.innerHTML = html;
  return b;
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
