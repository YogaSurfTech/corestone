import { Fragment, type Mark, type Node } from "prosemirror-model";
import { FLAGS, schema, type Align } from "./schema";

// The stored form of rich text: JSON blocks whose text is a plain string
// or a list of formatted runs. This is what the server validates, indexes
// and keeps in Git; the editor's own model never leaves the browser.

export interface Marks {
  bold?: true; italic?: true; underline?: true; strike?: true; sub?: true; sup?: true;
  color?: string; // #rrggbb
  bg?: string;    // #rrggbb
  font?: string;  // one of FONTS
  size?: number;  // points
}

/** A piece of text with one formatting, or a line break inside a paragraph. */
export type Run = { text: string; marks?: Marks } | { type: "break" };

export type Block =
  | { type: "paragraph"; align?: Exclude<Align, "left">; text: string | Run[] }
  | { type: "list"; ordered?: true; items: { blocks: Block[] }[] };

/** A rich-text value: a list of blocks. */
export type RichText = Block[];

/** Reads a stored value; a plain string (an older value) becomes one paragraph per line. */
export function fromStorage(value: RichText | string | null | undefined): Node {
  if (typeof value === "string" || value == null) {
    const lines = (value ?? "").split("\n");
    return schema.node("doc", null, lines.map((l) => schema.node("paragraph", null, l ? schema.text(l) : undefined)));
  }
  const blocks = value.map(blockNode).filter((n): n is Node => !!n);
  return schema.node("doc", null, blocks.length ? blocks : [schema.node("paragraph")]);
}

function blockNode(b: Block): Node | null {
  switch (b?.type) {
    case "paragraph":
      return schema.node("paragraph", { align: b.align ?? null }, inline(b.text));
    case "list": {
      const items = (b.items ?? []).map((it) => {
        const inner = (it.blocks ?? []).map(blockNode).filter((n): n is Node => !!n);
        // a list item starts with a paragraph
        if (!inner.length || inner[0].type !== schema.nodes.paragraph) inner.unshift(schema.node("paragraph"));
        return schema.node("list_item", null, inner);
      });
      return items.length ? schema.node(b.ordered ? "ordered_list" : "bullet_list", null, items) : null;
    }
    default:
      return null; // unknown blocks are kept out rather than guessed at
  }
}

function inline(text: string | Run[] | undefined): Fragment {
  if (typeof text === "string") return text ? Fragment.from(schema.text(text)) : Fragment.empty;
  const out: Node[] = [];
  for (const r of text ?? []) {
    if ("type" in r) {
      if (r.type === "break") out.push(schema.node("hard_break"));
    } else if (r.text) {
      out.push(schema.text(r.text, marksOf(r.marks)));
    }
  }
  return Fragment.from(out);
}

function marksOf(m: Marks | undefined): Mark[] {
  if (!m) return [];
  const out: Mark[] = [];
  for (const f of FLAGS) if (m[f]) out.push(schema.marks[f].create());
  for (const k of ["color", "bg", "font", "size"] as const) {
    if (m[k] !== undefined && m[k] !== null) out.push(schema.marks[k].create({ value: m[k] }));
  }
  return out;
}

/** The stored form of the editor's document. */
export function toStorage(doc: Node): RichText {
  const out: RichText = [];
  doc.forEach((n) => { const b = storeBlock(n); if (b) out.push(b); });
  return out;
}

function storeBlock(n: Node): Block | null {
  if (n.type === schema.nodes.paragraph) {
    const b: Block = { type: "paragraph", text: storeInline(n) };
    if (n.attrs.align) b.align = n.attrs.align;
    return b;
  }
  if (n.type === schema.nodes.bullet_list || n.type === schema.nodes.ordered_list) {
    const items: { blocks: Block[] }[] = [];
    n.forEach((li) => {
      const blocks: Block[] = [];
      li.forEach((c) => { const b = storeBlock(c); if (b) blocks.push(b); });
      items.push({ blocks });
    });
    return n.type === schema.nodes.ordered_list ? { type: "list", ordered: true, items } : { type: "list", items };
  }
  return null;
}

/** A paragraph's text: a plain string when nothing is formatted, else runs. */
function storeInline(p: Node): string | Run[] {
  const runs: Run[] = [];
  p.forEach((c) => {
    if (c.type === schema.nodes.hard_break) { runs.push({ type: "break" }); return; }
    const marks: Marks = {};
    for (const m of c.marks) {
      if ((FLAGS as readonly string[]).includes(m.type.name)) (marks as Record<string, unknown>)[m.type.name] = true;
      else (marks as Record<string, unknown>)[m.type.name] = m.attrs.value;
    }
    const prev = runs[runs.length - 1];
    const text = c.text ?? "";
    // neighbours with the same formatting are one run
    if (prev && !("type" in prev) && sameMarks(prev.marks, marks)) prev.text += text;
    else runs.push(Object.keys(marks).length ? { text, marks } : { text });
  });
  if (!runs.length) return "";
  if (runs.length === 1 && !("type" in runs[0]) && !runs[0].marks) return runs[0].text;
  return runs;
}

function sameMarks(a: Marks | undefined, b: Marks): boolean {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/** The plain text of a value, as search sees it: paragraphs and list items on lines of their own. */
export function plainText(value: RichText | string | null | undefined): string {
  if (typeof value === "string" || value == null) return value ?? "";
  const lines: string[] = [];
  const walk = (bs: Block[], prefix: string) => {
    for (const b of bs) {
      if (b.type === "paragraph") {
        lines.push(prefix + (typeof b.text === "string" ? b.text
          : b.text.map((r) => ("type" in r ? "\n" : r.text)).join("")));
      } else if (b.type === "list") {
        b.items.forEach((it, i) => walk(it.blocks, prefix + (b.ordered ? `${i + 1}. ` : "• ")));
      }
    }
  };
  walk(value, "");
  return lines.join("\n");
}
