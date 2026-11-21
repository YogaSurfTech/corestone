import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { Field, Kind, Schema, Summary, WorkflowValue } from "../types";
import { plainText, type RichText } from "@corestone/editor/model";

export const kindLabel: Record<Kind, string> = { entry: "Entry", document: "Document", link: "Link", comment: "Comment" };
export const kindPlural: Record<Kind, string> = { entry: "Entries", document: "Documents", link: "Links", comment: "Comments" };
export const collectionOf: Record<Kind, "entries" | "documents" | "links" | "comments"> = {
  entry: "entries", document: "documents", link: "links", comment: "comments",
};

export function label(s: Summary | undefined | null): string {
  if (!s) return "(missing)";
  return s.title || s.hid || s.guid.slice(0, 8);
}

/** "HID – title" where both exist, else the plain label. */
export function hidLabel(s: Summary | undefined | null): string {
  return s?.hid && s.title ? `${s.hid} – ${s.title}` : label(s);
}

// The pictogram of each kind, drawn on a grid of 16 in the colour of the text.
const KIND_PATHS: Record<Kind, string> = {
  // a card with a column of labels and lines of values
  entry: '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M6 3v10M8.5 6.5h3.5M8.5 9.5h3.5"/>',
  // a page with a folded corner
  document: '<path d="M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13M6.5 8.5h4M6.5 11.5h4"/>',
  // two things with an arrow from one up to the other
  link: '<circle cx="3" cy="13" r="1.7" fill="currentColor"/><circle cx="13" cy="3" r="1.7" fill="currentColor"/><path d="M5.4 10.6 10 6M7 5.8h3.2V9"/>',
  // a speech bubble
  comment: '<path d="M3.5 2.5h9A1.5 1.5 0 0 1 14 4v5.5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5V4a1.5 1.5 0 0 1 1.5-1.5z"/>',
};

const kindSvg = (kind: Kind) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_PATHS[kind]}</svg>`;

/** The markup of a kind's icon, for what is not rendered by Lit: its pictogram on a small tile in the kind's colour. */
export function kindMark(kind: Kind): string {
  return `<span class="kind-icon ${kind}">${kindSvg(kind)}</span>`;
}

export function kindIcon(kind: Kind, title: string = kindLabel[kind]): TemplateResult {
  return html`<span class="kind-icon ${kind}" role="img" aria-label=${title} title=${title}>${unsafeSVG(kindSvg(kind))}</span>`;
}

export function displayName(s: Schema | undefined, type: string): string {
  return s?.displayName || type;
}

export function folderCrumbs(folder: string): { name: string; path: string }[] {
  const out = [{ name: "Repository", path: "" }];
  const parts = folder.split("/").filter(Boolean);
  parts.forEach((p, i) => out.push({ name: p, path: parts.slice(0, i + 1).join("/") }));
  return out;
}

/** Whether a field value is rich text in blocks (a list of paragraphs with text, and tables); see internal/model/richtext.go. */
export function isRichText(v: unknown): v is RichText {
  return Array.isArray(v) && v.length > 0 && v.every((b) => !!b && typeof b === "object" && ("text" in b || "table" in b));
}

/** Whether a field value is a workflow field's: an object holding the state. */
export function isWorkflowValue(v: unknown): v is WorkflowValue {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as WorkflowValue).state === "string"
    && Object.keys(v).every((k) => k === "state" || k === "transition" || k === "previous");
}

/** The workflow fields among field values: field id and state. */
export function workflowStates(fields: Record<string, unknown> | undefined | null): [string, string][] {
  return Object.entries(fields ?? {}).flatMap(([id, v]) => (isWorkflowValue(v) ? [[id, v.state] as [string, string]] : []));
}

/** A field value as one text: rich text as it reads, a workflow as its state, other objects as JSON. */
export function showValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (isRichText(v)) return plainText(v);
  if (isWorkflowValue(v)) return v.state;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Only render links whose scheme cannot execute code (mirrors model.SafeURL). */
export function safeHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return null;
  return ["http", "https", "ftp", "ftps", "mailto"].includes(m[1].toLowerCase()) ? v.trim() : null;
}

/** The comment type a folder offers: "comment" when defined, else the first comment type. */
export function commentTypeOf(types: Schema[]): string | null {
  const comments = types.filter((t) => t.kind === "comment");
  return comments.find((t) => t.type === "comment")?.type ?? comments[0]?.type ?? null;
}

/** A stand-in definition to display a stored field its type does not define. */
export function undeclaredField(id: string, value: unknown): Field {
  return { id, name: id, type: typeof value === "object" && value !== null ? "json" : typeof value === "boolean" ? "boolean" : "text" };
}
