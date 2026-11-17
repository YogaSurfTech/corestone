import { Fragment, type Mark, type Node } from "prosemirror-model";
import { TableMap } from "prosemirror-tables";
import { BORDERS, FLAGS, GUID, ITEM_REF, STRIPES, safeFileName, safeHref, schema, stripeColors, type Align, type Borders, type Stripes } from "./schema";

// The stored form of rich text: JSON blocks whose text is a plain string
// or a list of formatted runs. This is what the server validates, indexes
// and keeps in Git; the editor's own model never leaves the browser.

export interface Marks {
  bold?: true; italic?: true; underline?: true; strike?: true; sub?: true; sup?: true;
  color?: string; // #rrggbb
  bg?: string;    // #rrggbb
  font?: string;  // one of FONTS
  size?: number;  // points
  href?: string;  // a link to a web address (http(s), mailto, ftp)
  ref?: string;   // a link to an item of the host application (GUID), or a section ("<GUID>#<section id>")
  xref?: true;    // with ref: a cross-reference, its text made when shown (text: the last one known)
  file?: string;  // a link to a file of the entry (its name)
}

/** A piece of text with its formatting; "\n" in it is a line break within the paragraph. */
export type Run = { text: string } & Marks;

/** An image in the text: a file of the entry; width in pixels (absent: its own size). */
export interface ImageRun { image: string; alt?: string; width?: number }

export const isImage = (r: Inline): r is ImageRun => "image" in r;

/** A diagram: a draw.io PNG of the entry with the diagram inside it; width as for images. */
export interface DiagramRun { diagram: string; alt?: string; width?: number }

export const isDiagram = (r: Inline): r is DiagramRun => "diagram" in r;

/** A formula: its LaTeX and the picture of it, a PNG file of the entry;
 *  display: on a line of its own, centred (absent: in the text). */
export interface FormulaRun { formula: string; png: string; display?: true }

export const isFormula = (r: Inline): r is FormulaRun => "formula" in r;

/** What a paragraph's text is made of. */
export type Inline = Run | ImageRun | DiagramRun | FormulaRun;

/** Runs that are not text (pictures: images, diagrams, formulas). */
const isObject = (r: Inline): r is ImageRun | DiagramRun | FormulaRun => isImage(r) || isDiagram(r) || isFormula(r);
export const MAX_FORMULA = 4000; // bytes of LaTeX, as the server allows

/** A paragraph; with list it is a list item (level 1 when absent). */
export interface Paragraph {
  text: string | Inline[];
  align?: Exclude<Align, "left">;
  list?: "ul" | "ol";
  level?: number;
}

/** A table: rows of cells. stripes shades every other row or column (colors: the first and
 *  second stripe's colour; absent: the theme's), borders draws only
 *  some lines (absent: the full grid), widths are the column widths in pixels (null:
 *  automatic). A formatted cell (a header cell, or one spanning several columns or rows)
 *  is an object with its content; the cells a span covers are left out (as in HTML).
 *  Cells hold anything but tables. */
export interface Table {
  stripes?: Stripes;
  colors?: [string, string];
  borders?: Borders;
  widths?: (number | null)[];
  table: Cell[][];
}
export type Cell = RichText | { content: RichText; header?: true; colspan?: number; rowspan?: number };

export type Block = Paragraph | Table;

/** A rich-text value: plain text (lines separated by "\n") or a list of blocks.
 *  The server validates the same form (internal/model/richtext.go). */
export type RichText = string | Block[];

export const MAX_LEVEL = 9;

export const isTable = (b: Block): b is Table => "table" in b;

/** Reads a stored value; plain text becomes one paragraph per line. */
export function fromStorage(value: RichText | null | undefined): Node {
  const blocks = blockNodes(value, false);
  // a table at the start or the end gets an empty line before / after it for the cursor (not stored)
  if (blocks[0]?.type === schema.nodes.table) blocks.unshift(schema.node("paragraph"));
  if (blocks[blocks.length - 1]?.type === schema.nodes.table) blocks.push(schema.node("paragraph"));
  return schema.node("doc", null, blocks.length ? blocks : [schema.node("paragraph")]);
}

/** The editor's blocks for a stored value; inCell: inside a table cell (no tables there). */
function blockNodes(value: RichText | null | undefined, inCell: boolean): Node[] {
  if (typeof value === "string" || value == null) {
    const lines = (value ?? "").split("\n");
    return lines.map((l) => schema.node("paragraph", null, l ? schema.text(l) : undefined));
  }
  if (!Array.isArray(value)) return [];
  // flat paragraphs with list levels become the editor's nested lists
  interface Open { kind: "ul" | "ol"; node: "bullet_list" | "ordered_list"; items: Node[][] } // items: each item's children
  const top: Node[] = [];
  const stack: Open[] = [];
  const close = (to: number) => {
    while (stack.length > to) {
      const l = stack.pop()!;
      const list = schema.node(l.node, null, l.items.map((c) => schema.node("list_item", null, c)));
      if (stack.length) stack[stack.length - 1].items[stack[stack.length - 1].items.length - 1].push(list);
      else top.push(list);
    }
  };
  for (const b of value) {
    if (!b || typeof b !== "object") continue; // unknown entries are kept out rather than guessed at
    if (isTable(b)) {
      close(0);
      const t = inCell ? null : tableNode(b); // no tables in tables
      if (t) top.push(t);
      continue;
    }
    const p = schema.node("paragraph", { align: b.align ?? null }, inline(b.text));
    if (b.list !== "ul" && b.list !== "ol") {
      close(0);
      top.push(p);
      continue;
    }
    const level = Math.min(Math.max(Math.trunc(b.level ?? 1), 1), stack.length + 1, MAX_LEVEL); // a level cannot be skipped
    close(level);
    if (stack.length === level && stack[level - 1].kind !== b.list) close(level - 1); // another kind of list starts
    if (stack.length < level) stack.push({ kind: b.list, node: b.list === "ol" ? "ordered_list" : "bullet_list", items: [] });
    stack[level - 1].items.push([p]);
  }
  close(0);
  return top;
}

const span = (v: unknown) => (typeof v === "number" && v >= 1 ? Math.min(Math.trunc(v), 100) : 1);
const formatted = (c: Cell) => (c !== null && typeof c === "object" && !Array.isArray(c) ? c : null);

function tableNode(t: Table): Node | null {
  const rows = (Array.isArray(t.table) ? t.table : []).filter(Array.isArray).map((row) => {
    const cells = row.map((c) => {
      const sp = formatted(c);
      const content = blockNodes(sp ? sp.content : (c as RichText), true);
      const type = sp?.header === true ? schema.nodes.table_header : schema.nodes.table_cell;
      return type.create({ colspan: span(sp?.colspan), rowspan: span(sp?.rowspan) },
        content.length ? content : [schema.node("paragraph")]);
    });
    return cells.length ? schema.node("table_row", null, cells) : null;
  }).filter((r): r is Node => !!r);
  if (!rows.length) return null;
  const table = schema.node("table", {
    stripes: STRIPES.includes(t.stripes as Stripes) ? t.stripes : null,
    colors: stripeColors(t.colors),
    borders: BORDERS.includes(t.borders as Borders) ? t.borders : null,
  }, rows);
  const widths = Array.isArray(t.widths) ? t.widths : [];
  if (!widths.some((w) => typeof w === "number" && w > 0)) return table;
  // the widths go to the cells of their columns (the editor keeps them per cell)
  try {
    const map = TableMap.get(table);
    const out: Node[] = [];
    table.forEach((row, rowOffset) => {
      const cells: Node[] = [];
      row.forEach((cell, cellOffset) => {
        const rect = map.findCell(rowOffset + 1 + cellOffset);
        const cw = widths.slice(rect.left, rect.right).map((w) => (typeof w === "number" && w > 0 ? Math.round(w) : 0));
        const ok = cw.length === rect.right - rect.left && cw.some((w) => w > 0);
        cells.push(cell.type.create({ ...cell.attrs, colwidth: ok ? cw : null }, cell.content));
      });
      out.push(row.copy(Fragment.from(cells)));
    });
    return table.copy(Fragment.from(out));
  } catch {
    return table; // an irregular table: the editor repairs it, the widths are dropped
  }
}

function inline(text: string | Inline[] | undefined): Fragment {
  const out: Node[] = [];
  const add = (t: string, marks: Mark[]) => {
    t.split("\n").forEach((part, i) => {
      if (i > 0) out.push(schema.node("hard_break"));
      if (part) out.push(schema.text(part, marks));
    });
  };
  if (typeof text === "string") add(text, []);
  else if (Array.isArray(text)) for (const r of text) {
    if (!r || typeof r !== "object") continue;
    if (isImage(r) || isDiagram(r)) {
      const src = safeFileName(isImage(r) ? r.image : r.diagram);
      const w = typeof r.width === "number" && r.width >= 16 ? Math.min(Math.round(r.width), 4000) : null;
      const type = isImage(r) ? schema.nodes.image : schema.nodes.diagram;
      if (src) out.push(type.create({ src, alt: typeof r.alt === "string" ? r.alt : "", width: w }));
    } else if (isFormula(r)) {
      if (typeof r.formula === "string" && r.formula.trim()) {
        out.push(schema.nodes.formula.create({ latex: r.formula, display: r.display === true, png: safeFileName(r.png) }));
      }
    } else if ((r as Run).xref === true && typeof (r as Run).ref === "string" && ITEM_REF.test((r as Run).ref!)) {
      out.push(schema.nodes.xref.create({ ref: (r as Run).ref, label: typeof r.text === "string" ? r.text.slice(0, 500) : "" }));
    } else if (typeof r.text === "string") add(r.text, marksOf(r));
  }
  return Fragment.from(out);
}

function marksOf(m: Marks): Mark[] {
  const out: Mark[] = [];
  if (typeof m.ref === "string" && ITEM_REF.test(m.ref)) out.push(schema.marks.link.create({ ref: m.ref }));
  else if (safeFileName(m.file)) out.push(schema.marks.link.create({ file: m.file }));
  else if (safeHref(m.href)) out.push(schema.marks.link.create({ href: safeHref(m.href) }));
  for (const f of FLAGS) if (m[f]) out.push(schema.marks[f].create());
  for (const k of ["color", "bg", "font", "size"] as const) {
    if (m[k] !== undefined && m[k] !== null) out.push(schema.marks[k].create({ value: m[k] }));
  }
  return out;
}

/** The stored form of the editor's document: plain text when nothing is formatted, else blocks. */
export function toStorage(doc: Node): RichText {
  const v = storeBlocks(doc);
  if (typeof v === "string") return v;
  // the empty lines the editor keeps before / after a table at the start or the end
  const empty = (b: Block | undefined) => !!b && !isTable(b) && b.text === "" && !b.align && !b.list;
  if (empty(v[0]) && v[1] && isTable(v[1])) v.shift();
  if (empty(v[v.length - 1]) && v.length > 1 && isTable(v[v.length - 2])) v.pop();
  return v;
}

/** The stored form of a node's blocks (the document's, or a table cell's). */
function storeBlocks(parent: Node): RichText {
  const out = blockList(parent);
  // nothing but unformatted lines: plain text, as a plain text field stores it
  const plain = (b: Block): b is Paragraph & { text: string } =>
    !isTable(b) && typeof b.text === "string" && !b.text.includes("\n") && !b.align && !b.list;
  if (out.every(plain)) return out.map((b) => (b as Paragraph).text as string).join("\n");
  return out;
}

/** The stored blocks of a node's children, or of a list of nodes (paragraphs, lists, tables). */
function blockList(parent: Node | Node[]): Block[] {
  const out: Block[] = [];
  const walk = (n: Node, list: "ul" | "ol" | null, level: number) => {
    if (n.type === schema.nodes.paragraph) {
      const b: Paragraph = { text: storeInline(n) };
      if (n.attrs.align) b.align = n.attrs.align;
      if (list) {
        b.list = list;
        if (level > 1) b.level = level;
      }
      out.push(b);
    } else if (n.type === schema.nodes.bullet_list || n.type === schema.nodes.ordered_list) {
      const kind = n.type === schema.nodes.ordered_list ? "ol" : "ul";
      // the items' paragraphs are at this list's level, lists inside them one deeper;
      // a further paragraph inside an item becomes an item of its own (lists are flat)
      n.forEach((li) => li.forEach((c) => walk(c, kind, level + 1)));
    } else if (n.type === schema.nodes.table) {
      out.push(storeTable(n));
    }
  };
  if (Array.isArray(parent)) parent.forEach((n) => walk(n, null, 0));
  else parent.forEach((n) => walk(n, null, 0));
  return out;
}

function storeTable(n: Node): Table {
  const map = TableMap.get(n);
  const widths: (number | null)[] = Array(map.width).fill(null);
  const rows: Cell[][] = [];
  n.forEach((row, rowOffset) => {
    const cells: Cell[] = [];
    row.forEach((cell, cellOffset) => {
      const rect = map.findCell(rowOffset + 1 + cellOffset);
      ((cell.attrs.colwidth as number[] | null) ?? []).forEach((w, i) => {
        if (w > 0 && widths[rect.left + i] === null) widths[rect.left + i] = w;
      });
      const content = storeBlocks(cell);
      const { colspan, rowspan } = cell.attrs as { colspan: number; rowspan: number };
      const header = cell.type === schema.nodes.table_header;
      cells.push(header || colspan > 1 || rowspan > 1
        ? { content, ...(header ? { header: true as const } : {}), ...(colspan > 1 ? { colspan } : {}), ...(rowspan > 1 ? { rowspan } : {}) }
        : content);
    });
    rows.push(cells);
  });
  // the rows last, so that in the file they follow on lines of their own
  const t = {} as Table;
  if (n.attrs.stripes) t.stripes = n.attrs.stripes;
  if (n.attrs.stripes && n.attrs.colors) t.colors = n.attrs.colors;
  if (n.attrs.borders) t.borders = n.attrs.borders;
  if (widths.some((w) => w !== null)) t.widths = widths;
  t.table = rows;
  return t;
}

/** A paragraph's text: a plain string when nothing is formatted, else runs. */
function storeInline(p: Node): string | Inline[] {
  const runs: Inline[] = [];
  p.forEach((c) => {
    const last = runs[runs.length - 1];
    const prev = last && !isObject(last) ? last : undefined;
    if (c.type === schema.nodes.formula) {
      if (!c.attrs.png) return; // its picture is still being made
      const f: FormulaRun = { formula: c.attrs.latex, png: c.attrs.png };
      if (c.attrs.display) f.display = true;
      runs.push(f);
      return;
    }
    if (c.type === schema.nodes.image || c.type === schema.nodes.diagram) {
      if (!c.attrs.src) return; // still being stored
      const img: ImageRun | DiagramRun = c.type === schema.nodes.image ? { image: c.attrs.src } : { diagram: c.attrs.src };
      if (c.attrs.alt) img.alt = c.attrs.alt;
      if (c.attrs.width) img.width = c.attrs.width;
      runs.push(img);
      return;
    }
    if (c.type === schema.nodes.xref) {
      runs.push({ text: c.attrs.label || c.attrs.ref, ref: c.attrs.ref, xref: true });
      return;
    }
    if (c.type === schema.nodes.hard_break) {
      // a line break joins the run before it
      if (prev) prev.text += "\n";
      else runs.push({ text: "\n" });
      return;
    }
    const marks: Marks = {};
    for (const m of c.marks) {
      if (m.type === schema.marks.link) {
        if (m.attrs.ref) marks.ref = m.attrs.ref;
        else if (m.attrs.file) marks.file = m.attrs.file;
        else marks.href = m.attrs.href;
        continue;
      }
      if ((FLAGS as readonly string[]).includes(m.type.name)) (marks as Record<string, unknown>)[m.type.name] = true;
      else (marks as Record<string, unknown>)[m.type.name] = m.attrs.value;
    }
    const text = c.text ?? "";
    // neighbours with the same formatting are one run
    if (prev && sameMarks(prev, marks)) prev.text += text;
    else runs.push({ text, ...marks });
  });
  if (!runs.length) return "";
  const only = runs[0];
  if (runs.length === 1 && !isObject(only) && Object.keys(only).length === 1) return only.text;
  return runs;
}

function sameMarks(run: Run, b: Marks): boolean {
  const { text: _, ...a } = run;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** The plain text of a value, as search sees it: one line per paragraph, list items with
 *  their marker, numbered lists numbered across levels as the editor shows them (1.2.3.),
 *  a table row per line with its cells separated by " | ", formulas as their LaTeX.
 *  The server computes the same (RichTextPlain in internal/model/richtext.go). */
/** The names of the files a text uses: pictures, diagrams and formulas. */
export function fileNames(value: RichText | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (rt: RichText | null | undefined) => {
    if (!Array.isArray(rt)) return;
    for (const b of rt) {
      if (isTable(b)) { for (const row of b.table) for (const c of row) walk(typeof c === "object" && c !== null && "content" in c ? c.content : c as RichText); continue; }
      if (!Array.isArray(b.text)) continue;
      for (const r of b.text) {
        if (isImage(r)) out.add(r.image);
        else if (isDiagram(r)) out.add(r.diagram);
        else if (isFormula(r)) out.add(r.png);
        else if ((r as Run).file) out.add((r as Run).file!);
      }
    }
  };
  walk(value);
  return [...out];
}

/** The same text with file names changed (pictures, diagrams, formulas, file links). */
export function renameFiles(value: RichText, names: Map<string, string>): RichText {
  if (!Array.isArray(value) || !names.size) return value;
  const n = (x: string) => names.get(x) ?? x;
  const cell = (c: Cell): Cell => (typeof c === "object" && c !== null && "content" in c ? { ...c, content: renameFiles(c.content, names) } : renameFiles(c as RichText, names));
  return value.map((b): Block => {
    if (isTable(b)) return { ...b, table: b.table.map((row) => row.map(cell)) };
    if (!Array.isArray(b.text)) return b;
    return { ...b, text: b.text.map((r): Inline => isImage(r) ? { ...r, image: n(r.image) } : isDiagram(r) ? { ...r, diagram: n(r.diagram) }
      : isFormula(r) ? { ...r, png: n(r.png) } : (r as Run).file ? { ...r, file: n((r as Run).file!) } : r) };
  });
}

export function plainText(value: RichText | null | undefined): string {
  if (typeof value === "string" || value == null) return value ?? "";
  const lines: string[] = [];
  const stack: { kind: "ul" | "ol"; count: number }[] = [];
  for (const b of value) {
    if (isTable(b)) {
      stack.length = 0;
      const cell = (c: Cell) => plainText(formatted(c)?.content ?? (c as RichText)).replace(/\n+/g, " ");
      for (const row of b.table ?? []) lines.push((row ?? []).map(cell).join(" | "));
      continue;
    }
    const text = typeof b.text === "string" ? b.text : b.text.map((r) => (isFormula(r) ? r.formula : isObject(r) ? "" : r.text)).join("");
    if (!b.list) {
      stack.length = 0;
      lines.push(text);
      continue;
    }
    const level = Math.min(Math.max(Math.trunc(b.level ?? 1), 1), stack.length + 1);
    if (level < stack.length) stack.length = level;
    if (level > stack.length) stack.push({ kind: b.list, count: 0 });
    else if (stack[level - 1].kind !== b.list) stack[level - 1] = { kind: b.list, count: 0 };
    stack[level - 1].count++;
    const marker = b.list === "ol" ? stack.filter((l) => l.kind === "ol").map((l) => l.count).join(".") + ". " : "• ";
    lines.push("  ".repeat(level - 1) + marker + text);
  }
  return lines.join("\n");
}

// --- documents (docs/design/Corestone documents.md) ---

/** A section of a document: its permanent id, its title (plain text) and its children,
 *  content first, then subsections. */
export interface SectionNode { section: string; title: string; children: DocNode[] }
/** An entry placed in a document; view: how it is shown; pin: the commit it is shown at. */
export interface EntryNode { entry: string; view?: string; pin?: string }
/** A generated list. */
export interface TocNode { toc: "sections" | "figures" | "tables"; depth?: number }
/** A part of a document's content. */
export type DocNode = Block | SectionNode | EntryNode | TocNode;

export const isSectionNode = (n: DocNode): n is SectionNode => typeof n === "object" && n !== null && "section" in n;
export const isEntryNode = (n: DocNode): n is EntryNode => typeof n === "object" && n !== null && "entry" in n;
export const isTocNode = (n: DocNode): n is TocNode => typeof n === "object" && n !== null && "toc" in n;

const SECTION_ID = /^[a-z0-9]{8}$/;
const TOC_KINDS = ["sections", "figures", "tables"];

/** A new section id: 8 random characters a-z, 0-9. */
export function newSectionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const r = crypto.getRandomValues(new Uint8Array(8));
  return [...r].map((b) => chars[b % 36]).join("");
}

/** Reads a document's stored content and title into the editor's document (its root). */
export function documentFromStorage(content: DocNode[] | null | undefined, title?: string): Node {
  const children = docChildren(Array.isArray(content) ? content : [], true);
  if (title === undefined) return schema.node("docroot", null, children);
  const t = title.replace(/[\r\n]+/g, " ");
  return schema.node("docroot", null, [schema.node("doc_title", null, t ? schema.text(t) : undefined), ...children]);
}

/** The title of the editor's document. */
export function documentTitle(doc: Node): string {
  return doc.firstChild?.type === schema.nodes.doc_title ? doc.firstChild.textContent : "";
}

/** The editor's nodes for a stored list: content first, then sections (anything else after a
 *  section is kept out). root: the document's own list (an empty one gets a paragraph). */
function docChildren(list: DocNode[], root: boolean): Node[] {
  const content: Node[] = [];
  const sections: Node[] = [];
  let run: Block[] = [];
  const flush = () => { if (run.length) { content.push(...blockNodes(run, false)); run = []; } };
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    if (isSectionNode(n)) {
      flush();
      const title = typeof n.title === "string" ? n.title.replace(/[\r\n]+/g, " ").slice(0, 500) : "";
      const id = typeof n.section === "string" && SECTION_ID.test(n.section) ? n.section : newSectionId();
      sections.push(schema.node("section", { id }, [
        schema.node("section_title", null, title ? schema.text(title) : undefined),
        ...docChildren(Array.isArray(n.children) ? n.children : [], false)]));
      continue;
    }
    if (sections.length) continue; // content after a section: not allowed (the server refuses it)
    if (isEntryNode(n)) {
      flush();
      if (typeof n.entry === "string" && GUID.test(n.entry)) {
        content.push(schema.node("placement", { guid: n.entry, view: typeof n.view === "string" ? n.view : null, pin: typeof n.pin === "string" ? n.pin : null }));
      }
      continue;
    }
    if (isTocNode(n)) {
      flush();
      content.push(schema.node("toc", { kind: TOC_KINDS.includes(n.toc) ? n.toc : "sections", depth: typeof n.depth === "number" ? n.depth : null }));
      continue;
    }
    run.push(n);
  }
  flush();
  if (root && !content.length && !sections.length) content.push(schema.node("paragraph"));
  return [...content, ...sections];
}

/** The stored content of the editor's document. */
export function documentToStorage(doc: Node): DocNode[] {
  const out = storeChildren(doc, doc.firstChild?.type === schema.nodes.doc_title ? 1 : 0);
  // an empty document (the one empty line the editor keeps to type in) is stored empty
  if (out.length === 1 && !isSectionNode(out[0]) && !isEntryNode(out[0]) && !isTocNode(out[0]) && !isTable(out[0])
    && (out[0] as Paragraph).text === "" && !(out[0] as Paragraph).list) return [];
  return out;
}

function storeChildren(parent: Node, from: number): DocNode[] {
  const out: DocNode[] = [];
  let run: Node[] = [];
  const flush = () => { if (run.length) { out.push(...blockList(run)); run = []; } };
  parent.forEach((n, _o, i) => {
    if (i < from) return;
    if (n.type === schema.nodes.section) {
      flush();
      out.push({ section: n.attrs.id, title: n.firstChild?.textContent ?? "", children: storeChildren(n, 1) });
    } else if (n.type === schema.nodes.placement) {
      flush();
      const e: EntryNode = { entry: n.attrs.guid };
      if (n.attrs.view) e.view = n.attrs.view;
      if (n.attrs.pin) e.pin = n.attrs.pin;
      out.push(e);
    } else if (n.type === schema.nodes.toc) {
      flush();
      const t: TocNode = { toc: n.attrs.kind };
      if (n.attrs.depth) t.depth = n.attrs.depth;
      out.push(t);
    } else {
      run.push(n);
    }
  });
  flush();
  return out;
}

/** The plain text of a document's content, for previews: titles and paragraphs, one per line. */
export function documentText(content: DocNode[] | null | undefined): string {
  const lines: string[] = [];
  const walk = (list: DocNode[]) => {
    let run: Block[] = [];
    const flush = () => { if (run.length) { lines.push(plainText(run)); run = []; } };
    for (const n of list) {
      if (isSectionNode(n)) { flush(); lines.push(n.title); walk(n.children ?? []); }
      else if (isEntryNode(n) || isTocNode(n)) flush();
      else run.push(n);
    }
    flush();
  };
  walk(Array.isArray(content) ? content : []);
  return lines.join("\n");
}
