import { Fragment, type Mark, type Node } from "prosemirror-model";
import { TableMap } from "prosemirror-tables";
import { BORDERS, FLAGS, GUID, STRIPES, safeHref, schema, stripeColors, type Align, type Borders, type Stripes } from "./schema";

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
  ref?: string;   // a link to an item of the host application (GUID)
}

/** A piece of text with its formatting; "\n" in it is a line break within the paragraph. */
export type Run = { text: string } & Marks;

/** A paragraph; with list it is a list item (level 1 when absent). */
export interface Paragraph {
  text: string | Run[];
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

function inline(text: string | Run[] | undefined): Fragment {
  const out: Node[] = [];
  const add = (t: string, marks: Mark[]) => {
    t.split("\n").forEach((part, i) => {
      if (i > 0) out.push(schema.node("hard_break"));
      if (part) out.push(schema.text(part, marks));
    });
  };
  if (typeof text === "string") add(text, []);
  else if (Array.isArray(text)) for (const r of text) if (r && typeof r.text === "string") add(r.text, marksOf(r));
  return Fragment.from(out);
}

function marksOf(m: Marks): Mark[] {
  const out: Mark[] = [];
  if (typeof m.ref === "string" && GUID.test(m.ref)) out.push(schema.marks.link.create({ ref: m.ref }));
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
  parent.forEach((n) => walk(n, null, 0));
  // nothing but unformatted lines: plain text, as a plain text field stores it
  const plain = (b: Block): b is Paragraph & { text: string } =>
    !isTable(b) && typeof b.text === "string" && !b.text.includes("\n") && !b.align && !b.list;
  if (out.every(plain)) return out.map((b) => (b as Paragraph).text as string).join("\n");
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
function storeInline(p: Node): string | Run[] {
  const runs: Run[] = [];
  p.forEach((c) => {
    const prev = runs[runs.length - 1];
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
  if (runs.length === 1 && Object.keys(runs[0]).length === 1) return runs[0].text;
  return runs;
}

function sameMarks(run: Run, b: Marks): boolean {
  const { text: _, ...a } = run;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** The plain text of a value, as search sees it: one line per paragraph, list items with
 *  their marker, numbered lists numbered across levels as the editor shows them (1.2.3.),
 *  a table row per line with its cells separated by " | ".
 *  The server computes the same (RichTextPlain in internal/model/richtext.go). */
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
    const text = typeof b.text === "string" ? b.text : b.text.map((r) => r.text).join("");
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
