import { toggleMark } from "prosemirror-commands";
import type { Node } from "prosemirror-model";
import { AllSelection, Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { icon } from "./icons";
import { keymap } from "prosemirror-keymap";
import type { Feature } from "./feature";
import { popupMenu, type MenuItem } from "./menu";
import { schema } from "./schema";
import { synced } from "./structure";

// Code: a listing (a block of plain text in a fixed-width font, with a frame, optional line
// numbers and a copy button) and code within a line (a character format). One command makes
// both: part of a line selected becomes code within the line, otherwise the paragraphs at the
// cursor or in the selection become one listing.

/** The languages a listing can name (stored as the id; shown as the name). */
export const LANGS: [id: string, name: string][] = [
  ["bash", "Bash"], ["c", "C"], ["c++", "C++"], ["c#", "C#"], ["css", "CSS"], ["go", "Go"], ["html", "HTML"], ["java", "Java"],
  ["javascript", "JavaScript"], ["json", "JSON"], ["kotlin", "Kotlin"], ["markdown", "Markdown"], ["python", "Python"], ["rust", "Rust"],
  ["sql", "SQL"], ["typescript", "TypeScript"], ["xml", "XML"], ["yaml", "YAML"],
];
const LANG_ID = /^[a-z0-9][a-z0-9+#.-]{0,29}$/;
/** A stored language id, or null. */
export const langId = (v: unknown): string | null => (typeof v === "string" && LANG_ID.test(v) ? v : null);
const langName = (id: string) => LANGS.find((l) => l[0] === id)?.[1] ?? id;

/** Listings longer than this show line numbers unless switched off (shorter: unless switched on). */
export const NUMBERS_FROM = 10;
const INDENT = "  ";

const lineCount = (n: Node) => n.textContent.split("\n").length;
/** Whether a listing shows its line numbers: as set, else when it is long. */
export const numbered = (n: Node) => (n.attrs.numbers as boolean | null) ?? lineCount(n) > NUMBERS_FROM;

/** The listing the selection is in, with its position. */
export function codeAt(state: EditorState): { node: Node; pos: number } | null {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== schema.nodes.code_block || !$from.sameParent($to)) return null;
  return { node: $from.parent, pos: $from.before() };
}

/** The listing at a position inside it (or right before it). */
export function codeAround(state: EditorState, pos: number): { node: Node; pos: number } | null {
  const $p = state.doc.resolve(Math.min(Math.max(pos, 0), state.doc.content.size));
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type === schema.nodes.code_block) return { node: $p.node(d), pos: $p.before(d) };
  const after = $p.nodeAfter;
  return after?.type === schema.nodes.code_block ? { node: after, pos: $p.pos } : null;
}

/** Whether the Code button shows as pressed: in a listing, or in code within a line. */
export function codeActive(state: EditorState): boolean {
  if (codeAt(state)) return true;
  const { from, to, empty, $from } = state.selection;
  const type = schema.marks.code;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  let all = true, any = false;
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isText) { any = true; if (!type.isInSet(n.marks)) all = false; }
  });
  return any && all;
}

/** The lines of a block as plain text: a paragraph is a line (its line breaks further lines),
 *  list items a line each; null when it holds something that is not text (a table). */
function linesOf(n: Node): string[] | null {
  if (n.type === schema.nodes.code_block) return n.textContent.split("\n");
  if (n.type === schema.nodes.paragraph) return n.textBetween(0, n.content.size, "", (leaf) => (leaf.type === schema.nodes.hard_break ? "\n" : "")).split("\n");
  if (n.type === schema.nodes.bullet_list || n.type === schema.nodes.ordered_list || n.type === schema.nodes.list_item) {
    const out: string[] = [];
    for (let i = 0; i < n.childCount; i++) {
      const l = linesOf(n.child(i));
      if (!l) return null;
      out.push(...l);
    }
    return out;
  }
  return null;
}

/** A listing of these lines. */
function listing(lines: string[], attrs?: Record<string, unknown>): Node {
  const text = lines.join("\n");
  return schema.nodes.code_block.create(attrs ?? null, text ? schema.text(text) : undefined);
}

/** Turns the listing at pos back into normal text, a paragraph per line. */
export function codeToText(pos: number): Command {
  return (state, dispatch) => {
    const n = state.doc.nodeAt(pos);
    if (n?.type !== schema.nodes.code_block) return false;
    if (dispatch) {
      const paras = n.textContent.split("\n").map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : undefined));
      const tr = state.tr.replaceWith(pos, pos + n.nodeSize, paras);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView());
    }
    return true;
  };
}

/** The Code button. In a listing: back to normal text. Part of one paragraph selected: code
 *  within the line, on or off. Otherwise (nothing selected, a whole paragraph, or several):
 *  those paragraphs become one listing; their formatting is dropped and pictures are left out. */
export const toggleCode: Command = (state, dispatch) => {
  const at = codeAt(state);
  if (at) return codeToText(at.pos)(state, dispatch);
  const sel = state.selection;
  if (!(sel instanceof TextSelection) && !(sel instanceof AllSelection)) return false;
  const { $from, $to, empty } = sel;
  const one = sel instanceof TextSelection && $from.sameParent($to);
  const whole = one && $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;
  if (!empty && one && !whole) return toggleMark(schema.marks.code)(state, dispatch);
  // the blocks the selection covers, at the nearest level where a listing may stand (not inside a list)
  let depth = $from.sharedDepth($to.pos);
  if ($from.node(depth).isTextblock) depth--;
  while (depth > 0 && !/\b(block|cellblock)\b/.test($from.node(depth).type.spec.content ?? "")) depth--;
  const parent = $from.node(depth);
  const startIndex = $from.index(depth), endIndex = $to.indexAfter(depth);
  if (endIndex <= startIndex) return false;
  // (everything selected, Ctrl+A: the selection's ends are the parent's own)
  const start = $from.depth > depth ? $from.before(depth + 1) : $from.pos, end = $to.depth > depth ? $to.after(depth + 1) : $to.pos;
  const lines: string[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const l = linesOf(parent.child(i));
    if (!l) return false;
    lines.push(...l);
  }
  if (!parent.canReplaceWith(startIndex, endIndex, schema.nodes.code_block)) return false;
  if (dispatch) {
    const node = listing(lines);
    const tr = state.tr.replaceWith(start, end, node);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize - 1)).scrollIntoView());
  }
  return true;
};

/** The Code button from the keyboard: it first takes over the browser's selection where the
 *  editor has not seen it change yet (the key right after Shift+arrow), so it acts on what is
 *  selected now. */
export const toggleCodeKey: Command = (state, dispatch, view) => {
  const dom = view?.dom.ownerDocument.getSelection();
  if (view && dom?.anchorNode && dom.focusNode && view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode) && state.selection instanceof TextSelection) {
    try {
      const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset), head = view.posAtDOM(dom.focusNode, dom.focusOffset);
      if (anchor !== state.selection.anchor || head !== state.selection.head) {
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
        return toggleCode(view.state, view.dispatch);
      }
    } catch { /* not a place in the text: the editor's own selection stands */ }
  }
  return toggleCode(state, dispatch);
};

/** Sets a listing's language (null: none). */
export function setCodeLang(pos: number, lang: string | null): Command {
  return (state, dispatch) => {
    const n = state.doc.nodeAt(pos);
    if (n?.type !== schema.nodes.code_block) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, null, { ...n.attrs, lang }));
    return true;
  };
}

/** Shows or hides a listing's line numbers. The choice is kept only where it differs from
 *  what the listing's length gives, so an untouched listing follows its length. */
export function setCodeNumbers(pos: number, on: boolean): Command {
  return (state, dispatch) => {
    const n = state.doc.nodeAt(pos);
    if (n?.type !== schema.nodes.code_block) return false;
    const auto = lineCount(n) > NUMBERS_FROM;
    dispatch?.(state.tr.setNodeMarkup(pos, null, { ...n.attrs, numbers: on === auto ? null : on }));
    return true;
  };
}

/** The start of the line the cursor is in, within its listing, and the line's text up to the cursor. */
function lineStart(state: EditorState): { start: number; before: string } {
  const { $from } = state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset);
  const nl = before.lastIndexOf("\n");
  return { start: $from.start() + nl + 1, before: before.slice(nl + 1) };
}

const inCode = (cmd: Command): Command => (state, dispatch, view) => (codeAt(state) ? cmd(state, dispatch, view) : false);

/** Leaves the listing: the cursor goes to the paragraph after it (a new one if there is none). */
const leave: Command = (state, dispatch) => {
  const at = codeAt(state)!;
  const end = at.pos + at.node.nodeSize;
  if (dispatch) {
    const tr = state.tr;
    const next = tr.doc.nodeAt(end);
    if (next?.type !== schema.nodes.paragraph) tr.insert(end, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
  }
  return true;
};

/** The keys inside a listing: Enter starts a line (keeping the indent), on an empty last line it
 *  leaves the listing; Tab and Shift+Tab indent; Backspace in an empty listing makes it normal
 *  text; the down arrow on the last line of the last block leaves it. */
export const codeKeys: Record<string, Command> = Object.fromEntries(Object.entries<Command>({
  "Enter": inCode((state, dispatch) => {
    const { $from, $to, empty } = state.selection;
    const text = $from.parent.textContent;
    // an empty last line: it goes, and the cursor leaves the listing
    if (empty && $to.parentOffset === text.length && text.endsWith("\n")) {
      if (dispatch) {
        const tr = state.tr.delete($to.pos - 1, $to.pos);
        const end = tr.mapping.map($to.after());
        if (tr.doc.nodeAt(end)?.type !== schema.nodes.paragraph) tr.insert(end, schema.nodes.paragraph.create());
        dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
      }
      return true;
    }
    const indent = lineStart(state).before.match(/^[ \t]*/)![0];
    dispatch?.(state.tr.insertText("\n" + indent).scrollIntoView());
    return true;
  }),
  "Shift-Enter": inCode((state, dispatch) => { dispatch?.(state.tr.insertText("\n").scrollIntoView()); return true; }),
  "Mod-Enter": inCode(leave),
  "Tab": inCode((state, dispatch) => { dispatch?.(state.tr.insertText(INDENT).scrollIntoView()); return true; }),
  "Shift-Tab": inCode((state, dispatch) => {
    const { start } = lineStart(state);
    const lead = state.doc.textBetween(start, Math.min(start + INDENT.length, state.selection.$from.end())).match(/^ {1,2}|^\t/);
    if (lead && dispatch) dispatch(state.tr.delete(start, start + lead[0].length));
    return true;
  }),
  "Backspace": inCode((state, dispatch) => {
    const at = codeAt(state)!;
    if (!state.selection.empty || at.node.content.size) return false;
    return codeToText(at.pos)(state, dispatch);
  }),
  // the very start and end of the text, where a listing stands there (the browser's own
  // Ctrl+Home / Ctrl+End does not get past the listing's numbers and buttons)
  "Mod-Home": (state, dispatch) => {
    if (state.doc.firstChild?.type !== schema.nodes.code_block) return false;
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1)).scrollIntoView());
    return true;
  },
  "Mod-End": (state, dispatch) => {
    if (state.doc.lastChild?.type !== schema.nodes.code_block) return false;
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)).scrollIntoView());
    return true;
  },
  "ArrowDown": inCode((state, dispatch) => {
    const { $to, empty } = state.selection;
    if (!empty || $to.parent.textBetween($to.parentOffset, $to.parent.content.size).includes("\n")) return false;
    if (state.doc.resolve($to.after()).nodeAfter) return false; // something follows: the cursor goes there by itself
    return leave(state, dispatch);
  }),
// (each takes over the browser's cursor first: a key right after a click acts where the cursor now is)
}).map(([key, cmd]) => [key, synced(cmd)]));

/** The menu of the listing at pos: copy, line numbers, language, back to normal text. */
export function codeMenu(pos: number, copy: () => void): MenuItem[] {
  const at = (state: EditorState) => { const n = state.doc.nodeAt(pos); return n?.type === schema.nodes.code_block ? n : null; };
  const lang = (id: string | null, name: string): MenuItem => ({ label: name, cmd: setCodeLang(pos, id), check: (s) => ((at(s)?.attrs.lang as string | null) ?? null) === id });
  return [
    { label: "Copy", run: copy },
    { label: "Line numbers", check: (s) => { const n = at(s); return !!n && numbered(n); },
      cmd: (state, dispatch) => { const n = at(state); return !!n && setCodeNumbers(pos, !numbered(n))(state, dispatch); } },
    { label: "Language", sub: [lang(null, "None"), ...LANGS.map(([id, name]) => lang(id, name))] },
    { label: "Turn into normal text", cmd: codeToText(pos) },
  ];
}

/** Copies a listing's text (without line numbers) to the clipboard. */
export async function copyCode(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The line numbers of the numbered listings: a number at the start of every line, placed in
 *  the column left of the text. They belong to their lines, so they stay right where long
 *  lines wrap (in print); they are not part of the text and are never copied. */
export function codeNumbers(): Plugin {
  const build = (doc: Node) => {
    const decos: Decoration[] = [];
    doc.descendants((n, pos) => {
      if (n.type !== schema.nodes.code_block) return !n.isTextblock;
      if (!numbered(n)) return false;
      let at = pos + 1;
      n.textContent.split("\n").forEach((line, i) => {
        const no = i + 1;
        decos.push(Decoration.widget(at, () => {
          const s = document.createElement("span");
          s.className = "ln";
          s.contentEditable = "false";
          s.setAttribute("aria-hidden", "true");
          s.dataset.n = String(no); // shown by CSS: not text, so it is never selected or copied
          return s;
        }, { side: -1, key: `ln${no}`, ignoreSelection: true }));
        at += line.length + 1;
      });
      return false;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    state: { init: (_, state) => build(state.doc), apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old) },
    props: { decorations(state) { return this.getState(state); } },
  });
}

/** A listing: the text in a frame, its line numbers in a column left of it (a small × above
 *  them hides them), and its language and a copy button at the top right. */
export class CodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly lang: HTMLElement;

  constructor(private node: Node, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
    this.dom = document.createElement("div");
    this.dom.className = "cs-code";
    const off = document.createElement("button");
    off.type = "button";
    off.className = "off";
    off.contentEditable = "false";
    off.textContent = "×";
    off.title = "Hide the line numbers";
    off.tabIndex = -1;
    off.addEventListener("mousedown", (e) => e.preventDefault());
    off.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined && this.view.editable) setCodeNumbers(pos, false)(this.view.state, this.view.dispatch);
    });
    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    this.contentDOM.spellcheck = false;
    pre.append(this.contentDOM);
    const tools = document.createElement("div");
    tools.className = "tools";
    tools.contentEditable = "false";
    this.lang = document.createElement("span");
    this.lang.className = "lang";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.title = "Copy";
    copy.setAttribute("aria-label", "Copy the code");
    copy.innerHTML = icon("copy", 15);
    copy.addEventListener("mousedown", (e) => e.preventDefault());
    copy.addEventListener("click", (e) => {
      e.preventDefault();
      void copyCode(this.node.textContent).then((ok) => {
        copy.classList.toggle("done", ok);
        copy.title = ok ? "Copied" : "Copying is not allowed here";
        window.setTimeout(() => { copy.classList.remove("done"); copy.title = "Copy"; }, 1500);
      });
    });
    tools.append(this.lang, copy);
    this.dom.append(off, pre, tools);
    this.render();
  }

  private render() {
    const n = this.node;
    const lang = langId(n.attrs.lang);
    this.lang.textContent = lang ? langName(lang) : "";
    this.lang.hidden = !lang;
    if (lang) this.dom.dataset.lang = lang; else delete this.dom.dataset.lang;
    this.dom.classList.toggle("numbered", numbered(n));
    // the width of the numbers' column: the digits of the last number
    this.dom.style.setProperty("--cs-digits", String(Math.max(2, String(lineCount(n)).length)));
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  // the × and the copy button are the view's own: not the text's
  stopEvent(e: Event) { return !this.contentDOM.contains(e.target as globalThis.Node) && e.type !== "contextmenu"; }
  ignoreMutation(m: { target: globalThis.Node }) { return !this.contentDOM.contains(m.target); }
}

/** Code listings and code within a line: the listing's view, keys and line numbers, its menu, and the Code button. */
export const codeFeature: Feature = (ctx) => {
  let closeMenu: (() => void) | undefined;
  /** The menu of the listing at pos: at a point, or below the cursor. */
  const openMenu = (pos: number, at?: { x: number; y: number }) => {
    closeMenu?.();
    const view = ctx.view();
    const c = view.coordsAtPos(view.state.selection.head);
    closeMenu = popupMenu(ctx.root, "Code", "cs-codemenu",
      codeMenu(pos, () => { void copyCode(view.state.doc.nodeAt(pos)?.textContent ?? ""); }), view.state, at ?? { x: c.left, y: c.bottom + 4 },
      (it) => {
        if (it.cmd) it.cmd(ctx.view().state, ctx.view().dispatch);
        else it.run?.();
        ctx.view().focus();
      }, () => ctx.view().focus());
  };
  return {
    id: "code",
    nodeViews: { code_block: (node, view, getPos) => new CodeView(node, view, getPos) },
    plugins: [keymap(codeKeys), codeNumbers()],
    keys: { "Mod-Alt-c": toggleCodeKey },
    toolbar: [{ group: "fmt", id: "code",
      // part of a line selected becomes code within the line, otherwise the paragraphs become a listing
      tip: { text: "Code", shortcut: "Ctrl+Alt+C", disabled: () => (toggleCode(ctx.view().state) ? null : "Code is made of text: not of a heading, a table or a placed entry.") },
      run: () => ctx.run(toggleCode), pressed: codeActive }],
    contextMenu(e) {
      const view = ctx.view();
      if (!e) {
        const code = codeAt(view.state);
        if (code) openMenu(code.pos);
        return !!code;
      }
      const el = (e.target as HTMLElement).closest(".cs-code");
      const at = el && view.dom.contains(el) ? codeAround(view.state, view.posAtDOM(el, 0)) : null;
      if (!at) return false;
      // the cursor goes into the listing, unless the selection is in it already
      if (codeAt(view.state)?.pos !== at.pos) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos + 1)));
      openMenu(at.pos, { x: e.clientX, y: e.clientY });
      return true;
    },
  };
};
