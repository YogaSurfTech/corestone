// Files of an entry, as both the entry view and the document view handle them.
import type { EntryFiles } from "@corestone/editor";
import { api } from "./api";

/** The server's limit for one attachment (internal/httpapi maxAttachment). */
export const MAX_ATTACHMENT = 32 << 20;

/** A name for a new file of the entry: its own name made safe, a dated name for pasted
 *  images (which all arrive as "image.png"), numbered when the name is taken. */
export function freeFileName(file: File, taken: Set<string>): string {
  // eslint-disable-next-line no-control-regex
  let name = (file.name || "").replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().replace(/^[.:]+/, "");
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? file.type.split("/")[1] ?? "bin").toLowerCase().replace("jpeg", "jpg");
  if (!name || /^image\.[a-z]+$/i.test(name)) {
    const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
    name = `image-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  }
  let stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  const suffix = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  while (new TextEncoder().encode(stem + suffix).length > 200) stem = stem.slice(0, -1);
  let out = stem + suffix;
  for (let n = 2; taken.has(out) || out.startsWith(".corestone"); n++) out = `${stem}-${n}${suffix}`;
  return out;
}

/** Where a view keeps the files of the artifact it shows, for createFiles. */
export interface FileState {
  /** The files that wait for Save, and the names of the stored files Save removes. */
  pending(): { files: File[]; removed: string[] };
  setPending(files: File[], removed: string[]): void;
  /** The names of the files the server has. */
  stored(): string[];
  /** The address of a stored file. */
  url(name: string): string;
  /** Called when the artifact got an unsaved change. */
  touched(): void;
  /** Called after a file was added, to show it. */
  added?(): void;
  /** Whether a file may take the place of one of its name, and files may be removed. Without it files are only added. */
  inPlace?: boolean;
}

/**
 * The files of an artifact as the editor sees them (pictures and file links
 * in rich text): what is added or removed waits in the view for Save, and a
 * waiting file is shown from the browser.
 */
export function createFiles(s: FileState): EntryFiles {
  const blobUrls = new WeakMap<File, string>();
  const waiting = (name: string) => s.pending().files.find((f) => f.name === name);
  const files: EntryFiles = {
    add: async (file, replace) => {
      if (file.size > MAX_ATTACHMENT) throw new Error(`it is larger than ${MAX_ATTACHMENT >> 20} MiB`);
      // replace: under its own name, in place of the stored or pending file (Save overwrites it)
      const name = replace && s.inPlace ? file.name : freeFileName(file, new Set(await files.list()));
      const f = name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
      const p = s.pending();
      s.setPending([...p.files.filter((x) => x.name !== name), f], p.removed.filter((n) => n !== name));
      s.added?.();
      s.touched();
      return name;
    },
    url: (name) => {
      const p = waiting(name);
      if (!p) return s.url(name);
      let u = blobUrls.get(p);
      if (!u) { u = URL.createObjectURL(p); blobUrls.set(p, u); }
      return u;
    },
    list: async () => {
      const p = s.pending();
      return [...new Set([...s.stored().filter((n) => !p.removed.includes(n)), ...p.files.map((f) => f.name)])];
    },
    // a file's bytes: a pending one from the browser, else from the server
    get: async (name) => waiting(name) ?? api.fileBlob(s.url(name)),
  };
  // a pending file is dropped, a stored one is removed with Save
  if (s.inPlace) files.remove = (name) => {
    const p = s.pending();
    if (p.files.some((f) => f.name === name)) s.setPending(p.files.filter((f) => f.name !== name), p.removed);
    else if (s.stored().includes(name) && !p.removed.includes(name)) {
      s.setPending(p.files, [...p.removed, name]);
      s.touched();
    }
  };
  return files;
}
