import { Schema, type Mark, type MarkSpec, type Node, type NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

// The editor's document model. Only what is listed here can exist in the
// editor: pasted HTML is reduced to these nodes and marks, everything else
// is dropped. The same limits are enforced again by the server.

/** The fonts offered; the first is the toolbar's label for "no font set". */
export const FONTS: { name: string; css: string }[] = [
  { name: "Arial", css: "Arial, Helvetica, sans-serif" },
  { name: "Times New Roman", css: "'Times New Roman', Times, serif" },
  { name: "Courier New", css: "'Courier New', Courier, monospace" },
  { name: "Georgia", css: "Georgia, serif" },
];

/** Font sizes in points: the smallest and largest allowed, and the ones offered in the list. */
export const SIZE_MIN = 6;
export const SIZE_MAX = 96;
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 36, 48];

export type Align = "left" | "center" | "right" | "justify";
const ALIGNS: Align[] = ["left", "center", "right", "justify"];

/** A CSS colour as #rrggbb, or null when it is not a plain colour. */
export function hexColor(css: string | null | undefined): string | null {
  if (!css) return null;
  const s = css.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + [...s.slice(1)].map((c) => c + c).join("");
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null; // transparent is no colour
  return "#" + [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
}

/** The offered font a CSS font-family starts with, if any. */
function fontOf(css: string): string | null {
  const first = css.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return FONTS.find((f) => f.name.toLowerCase() === first)?.name ?? null;
}

/** A CSS font size in points, within the allowed range. */
function sizeOf(css: string): number | null {
  const m = css.trim().match(/^([\d.]+)(pt|px)$/);
  if (!m) return null;
  const pt = m[2] === "px" ? Number(m[1]) * 0.75 : Number(m[1]);
  return pt >= SIZE_MIN && pt <= SIZE_MAX ? Math.round(pt * 2) / 2 : null;
}

const alignAttr = { align: { default: null as Align | null } };
const alignOf = (el: HTMLElement): { align: Align | null } => {
  const a = (el.style.textAlign || el.getAttribute("align") || "").toLowerCase() as Align;
  return { align: ALIGNS.includes(a) && a !== "left" ? a : null };
};
const alignStyle = (n: Node) => (n.attrs.align ? { style: `text-align:${n.attrs.align}` } : {});

// Groups: "block" is anything at the top; "cellblock" is what a table cell
// or a list item may hold (everything but tables: no tables in tables).
const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block cellblock",
    attrs: alignAttr,
    parseDOM: [{ tag: "p", getAttrs: (d) => alignOf(d as HTMLElement) },
      // headings and other blocks become plain paragraphs in a field
      { tag: "h1, h2, h3, h4, h5, h6, div, pre, blockquote", getAttrs: (d) => alignOf(d as HTMLElement) }],
    toDOM: (n) => ["p", alignStyle(n), 0],
  },
  bullet_list: { content: "list_item+", group: "block cellblock", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] },
  ordered_list: { content: "list_item+", group: "block cellblock", parseDOM: [{ tag: "ol" }], toDOM: () => ["ol", 0] },
  list_item: { content: "paragraph cellblock*", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
  // table (stripes, borders), table_row, table_cell, table_header (colspan, rowspan, colwidth);
  // a header cell is formatting: it looks like a header and is a <th> for screen readers
  ...tables(),
  text: { group: "inline" },
  // an image: a file of the entry (src), shown inline like a large character; width in pixels
  // (null: its own size, at most the text's width). pending: while a pasted image from
  // elsewhere is being stored, the address it came from (not stored).
  image: {
    inline: true, group: "inline", draggable: true, atom: true,
    attrs: { src: { default: null }, alt: { default: "" }, width: { default: null }, pending: { default: null } },
    parseDOM: [{ tag: "img", getAttrs: (d) => {
      const e = d as HTMLImageElement;
      const file = safeFileName(e.getAttribute("data-file"));
      const from = e.getAttribute("src") ?? "";
      if (!file && !from) return false;
      const w = Number(e.getAttribute("width")) || null;
      // always taken in through the importer: the file may belong to another entry
      return { src: null, alt: (e.getAttribute("alt") ?? "").slice(0, 1000), width: w && w >= 16 ? Math.min(Math.round(w), 4000) : null,
        pending: JSON.stringify({ file, from }) };
    } }],
    toDOM: (n) => ["img", { "data-file": n.attrs.src, alt: n.attrs.alt, width: n.attrs.width }],
  },
  // a formula: its LaTeX, and the picture of it (png, a PNG file of the entry; null while it is
  // being made); display: on a line of its own, centred. Pasted formulas get their picture again.
  formula: {
    inline: true, group: "inline", draggable: true, atom: true,
    attrs: { latex: { default: "" }, display: { default: false }, png: { default: null } },
    parseDOM: [{ tag: "img[data-latex]", priority: 60, getAttrs: (d) => {
      const latex = (d as HTMLElement).getAttribute("data-latex") ?? "";
      return latex.trim() ? { latex, display: (d as HTMLElement).hasAttribute("data-display"), png: null } : false;
    } }],
    toDOM: (n) => ["img", { "data-latex": n.attrs.latex, "data-display": n.attrs.display ? "" : null, alt: n.attrs.latex }],
  },
  hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
};

/** A file name of the entry's file store, or null: the server's rules (one path segment,
 *  not reserved, no control characters, at most 255 bytes). */
export function safeFileName(v: string | null | undefined): string | null {
  if (!v) return null;
  const bytes = new TextEncoder().encode(v).length;
  if (v === "." || v === ".." || bytes > 255 || v.trim() !== v || /[/\\]/.test(v) || v.startsWith(":") || v.startsWith(".corestone")
    || GUID.test(v) || /[\u0000-\u001f\u007f-\u009f\ufffd]/.test(v)) return null;
  return v;
}

export const STRIPES = ["rows", "columns"] as const;
export const BORDERS = ["outside", "rows", "columns", "none"] as const; // absent: the full grid
export type Stripes = (typeof STRIPES)[number];
export type Borders = (typeof BORDERS)[number];
const oneOf = <T extends string>(v: string | null, all: readonly T[]): T | null => (all.includes(v as T) ? (v as T) : null);

function tables() {
  const nodes = tableNodes({ tableGroup: "block", cellContent: "cellblock+", cellAttributes: {} });
  nodes.table = {
    ...nodes.table,
    attrs: { stripes: { default: null }, colors: { default: null }, borders: { default: null } },
    parseDOM: [{ tag: "table", getAttrs: (d) => {
      const e = d as HTMLElement;
      return { stripes: oneOf(e.getAttribute("data-stripes"), STRIPES), colors: stripeColors(e.getAttribute("data-colors")?.split(" ")),
        borders: oneOf(e.getAttribute("data-borders"), BORDERS) };
    } }],
    toDOM: (n) => ["table", { class: tableClass(n), style: tableStyle(n), "data-stripes": n.attrs.stripes,
      "data-colors": n.attrs.colors?.join(" ") ?? null, "data-borders": n.attrs.borders }, ["tbody", 0]],
  };
  return nodes;
}

/** Two stripe colours, or null. */
export function stripeColors(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const c = v.map((x) => (typeof x === "string" ? hexColor(x) : null));
  return c[0] && c[1] ? [c[0], c[1]] : null;
}

/** A readable text colour on a background: dark ink on light colours, white on dark ones. */
export function inkOn(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55 ? "#1f2328" : "#ffffff";
}

/** The stripe colours of a table as CSS variables (with readable text on them). */
export function tableStyle(n: Node): string {
  const c = n.attrs.colors as [string, string] | null;
  return c ? `--cs-s1: ${c[0]}; --cs-s1-ink: ${inkOn(c[0])}; --cs-s2: ${c[1]}; --cs-s2-ink: ${inkOn(c[1])}` : "";
}

/** The classes that show a table's style (the editor's table view sets them too). */
export function tableClass(n: Node): string {
  return ["cs-table", n.attrs.stripes ? `cs-s-${n.attrs.stripes}` : "", n.attrs.borders ? `cs-b-${n.attrs.borders}` : ""].filter(Boolean).join(" ");
}

const flag = (tags: string[], style: [string, string] | null, dom: string): MarkSpec => ({
  parseDOM: [...tags.map((tag) => ({ tag })),
    ...(style ? [{ style: style[0], getAttrs: (v: string) => (v.includes(style[1]) ? null : false) }] : [])],
  toDOM: () => [dom, 0],
});
const valued = (style: string, read: (css: string) => string | number | null, css: (v: string) => string): MarkSpec => ({
  attrs: { value: {} },
  parseDOM: [{ style, getAttrs: (v) => { const value = read(v as string); return value === null ? false : { value }; } }],
  toDOM: (m: Mark) => ["span", { style: css(String(m.attrs.value)) }, 0],
});

/** A web address the editor links to: http(s), mailto or ftp only (no javascript: and the like). */
export function safeHref(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t || /\s/.test(t) || t.length > 2048) return null;
  if (/^(https?:\/\/|mailto:|ftp:\/\/)/i.test(t)) return t;
  if (/^www\.[^/]+\.[a-z]{2,}/i.test(t)) return "https://" + t; // typed without the scheme
  return null;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const marks: Record<string, MarkSpec> = {
  // first, so a link encloses the other formatting of its text
  link: {
    // a web address, an item (GUID) of the host application, or a file of the entry
    attrs: { href: { default: null }, ref: { default: null }, file: { default: null } },
    inclusive: false, // typing at the end of a link does not extend it
    parseDOM: [{ tag: "a", getAttrs: (d) => {
      const el = d as HTMLElement;
      const ref = el.getAttribute("data-ref");
      if (ref && GUID.test(ref)) return { href: null, ref, file: null };
      const file = safeFileName(el.getAttribute("data-file"));
      if (file) return { href: null, ref: null, file };
      const href = safeHref(el.getAttribute("href"));
      return href ? { href, ref: null, file: null } : false;
    } }],
    toDOM: (m: Mark) => m.attrs.ref
      ? ["a", { "data-ref": m.attrs.ref, class: "cs-item" }, 0]
      : m.attrs.file
        ? ["a", { "data-file": m.attrs.file, class: "cs-file", title: m.attrs.file }, 0]
        : ["a", { href: m.attrs.href, title: m.attrs.href, rel: "noopener noreferrer", target: "_blank" }, 0],
  },
  bold: { parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (d) => ((d as HTMLElement).style.fontWeight !== "normal" ? null : false) },
    { style: "font-weight", getAttrs: (v) => (/^(bold(er)?|[6-9]\d\d)$/.test(v as string) ? null : false) }], toDOM: () => ["strong", 0] },
  italic: flag(["i", "em"], ["font-style", "italic"], "em"),
  underline: flag(["u"], ["text-decoration", "underline"], "u"),
  strike: flag(["s", "del", "strike"], ["text-decoration", "line-through"], "s"),
  sub: { excludes: "sub sup", parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },
  sup: { excludes: "sub sup", parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
  color: valued("color", hexColor, (v) => `color:${v}`),
  bg: valued("background-color", hexColor, (v) => `background-color:${v}`),
  font: valued("font-family", fontOf, (v) => `font-family:${FONTS.find((f) => f.name === v)?.css ?? v}`),
  size: valued("font-size", sizeOf, (v) => `font-size:${v}pt`),
};

export const schema = new Schema({ nodes, marks });

/** The marks that are on or off (no value). */
export const FLAGS = ["bold", "italic", "underline", "strike", "sub", "sup"] as const;
export type Flag = (typeof FLAGS)[number];
