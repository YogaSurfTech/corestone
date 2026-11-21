// Files of an entry, as both the entry view and the document view handle them.

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
