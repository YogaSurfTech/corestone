import { html, type TemplateResult } from "lit";
import type { Field, Kind, Schema, Summary } from "./types";

export const kindLabel: Record<Kind, string> = { entry: "Entry", document: "Document", link: "Link", comment: "Comment" };
export const kindPlural: Record<Kind, string> = { entry: "Entries", document: "Documents", link: "Links", comment: "Comments" };
export const collectionOf: Record<Kind, "entries" | "documents" | "links" | "comments"> = {
  entry: "entries", document: "documents", link: "links", comment: "comments",
};

export function label(s: Summary | undefined | null): string {
  if (!s) return "(missing)";
  return s.title || s.hid || s.guid.slice(0, 8);
}

export function kindIcon(kind: Kind): TemplateResult {
  const letter = { entry: "E", document: "D", link: "L", comment: "C" }[kind];
  return html`<span class="kind-icon ${kind}" title=${kindLabel[kind]}>${letter}</span>`;
}

export function displayName(s: Schema | undefined, type: string): string {
  return s?.displayName || type;
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function folderCrumbs(folder: string): { name: string; path: string }[] {
  const out = [{ name: "Repository", path: "" }];
  const parts = folder.split("/").filter(Boolean);
  parts.forEach((p, i) => out.push({ name: p, path: parts.slice(0, i + 1).join("/") }));
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let seq = 0;
export function blockId(): string {
  return "b" + Date.now().toString(36) + (seq++).toString(36);
}

export function stop(e: Event) {
  e.stopPropagation();
}

/** Only render links whose scheme cannot execute code (mirrors model.SafeURL). */
export function safeHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return null;
  return ["http", "https", "ftp", "ftps", "mailto"].includes(m[1].toLowerCase()) ? v.trim() : null;
}

/** Image sources: same-origin paths, http(s) URLs or attachment names; never data:/javascript:. */
export function safeImageSrc(src: string | undefined, fallback: (name: string) => string): string | null {
  if (!src) return null;
  if (/^\s*(javascript|data|vbscript):/i.test(src)) return null;
  if (/^https?:\/\//i.test(src) || src.startsWith("/")) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  return fallback(src);
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
