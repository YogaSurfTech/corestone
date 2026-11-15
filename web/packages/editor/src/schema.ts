import { Schema, type Mark, type MarkSpec, type Node, type NodeSpec } from "prosemirror-model";

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

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    attrs: alignAttr,
    parseDOM: [{ tag: "p", getAttrs: (d) => alignOf(d as HTMLElement) },
      // headings and other blocks become plain paragraphs in a field
      { tag: "h1, h2, h3, h4, h5, h6, div, pre, blockquote", getAttrs: (d) => alignOf(d as HTMLElement) }],
    toDOM: (n) => ["p", alignStyle(n), 0],
  },
  bullet_list: { content: "list_item+", group: "block", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] },
  ordered_list: { content: "list_item+", group: "block", parseDOM: [{ tag: "ol" }], toDOM: () => ["ol", 0] },
  list_item: { content: "paragraph block*", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
  text: { group: "inline" },
  hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
};

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

const marks: Record<string, MarkSpec> = {
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
