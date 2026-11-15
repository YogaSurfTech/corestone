import type { Node } from "prosemirror-model";
import { NodeSelection, Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { icon } from "./icons";
import { buildMenu, type MenuItem } from "./menu";
import { safeFileName, schema } from "./schema";

// Images and file links: files of the entry the text belongs to. The host
// application keeps the files (the editor knows nothing of where); new ones
// are handed to it, and it says under which name they are kept and where
// they can be seen.

/** The entry's files, as the host application offers them. */
export interface EntryFiles {
  /** Takes a new file (pasted, dropped or chosen); resolves with the name it is kept under.
   *  replace: keep it under its own name, in place of a file of that name (a changed diagram;
   *  the history keeps the old content). */
  add(file: File, replace?: boolean): Promise<string>;
  /** Where a file can be seen (for images) or opened. */
  url(name: string): string;
  /** The names of the entry's files, to pick one. */
  list(): Promise<string[]>;
  /** Removes a file no longer shown (a formula's old picture); Save removes a stored one. */
  remove?(name: string): Promise<void> | void;
  /** A file's content (to edit a diagram: draw.io reads the diagram from its PNG). */
  get?(name: string): Promise<Blob>;
}

/** Image and diagram nodes: pictures that are files of the entry. */
export const isPicture = (n: Node | null | undefined) => !!n && (n.type === schema.nodes.image || n.type === schema.nodes.diagram);

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const isImageName = (n: string) => IMAGE.test(n);
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif" };
export const isImageFile = (f: File) => f.type in MIME_EXT;

/** Inserts an image of the entry at the selection. */
export function insertImage(src: string, alt = ""): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith(schema.nodes.image.create({ src, alt })).scrollIntoView());
    return true;
  };
}

/** Inserts a link to a file of the entry, its name as text. */
export function insertFileLink(name: string): Command {
  return (state, dispatch) => {
    const mark = schema.marks.link.create({ file: name });
    dispatch?.(state.tr.replaceSelectionWith(schema.text(name, [mark]), false).removeStoredMark(schema.marks.link).scrollIntoView());
    return true;
  };
}

/** How an image shows in the editor: from the host's address for the file, with a handle
 *  to resize it while it is selected. */
export class ImageView implements NodeView {
  dom: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly handle: HTMLElement;

  constructor(private node: Node, private readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly files: () => EntryFiles | undefined) {
    this.dom = el("span", node.type === schema.nodes.diagram ? "cs-img cs-diagram" : "cs-img");
    this.img = document.createElement("img");
    this.img.draggable = false;
    this.handle = el("span", "handle");
    this.handle.title = "Drag to resize";
    this.handle.addEventListener("mousedown", (e) => this.resize(e));
    this.dom.append(this.img, this.handle);
    this.render();
  }

  private render() {
    const { src, alt, width, pending } = this.node.attrs;
    const url = src ? this.files()?.url(src) : null;
    if (url) { if (this.img.getAttribute("src") !== url) this.img.src = url; } else this.img.removeAttribute("src");
    this.img.alt = alt;
    this.img.title = alt || src || "";
    this.img.dataset.file = src ?? "";
    this.img.style.width = width ? `${width}px` : "";
    this.dom.classList.toggle("pending", !!pending);
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() { this.dom.classList.add("selected"); }
  deselectNode() { this.dom.classList.remove("selected"); }
  stopEvent(e: Event) { return e.target === this.handle; }
  ignoreMutation() { return true; }

  /** Dragging the handle sets the width (the height follows). */
  private resize(e: MouseEvent) {
    if (!this.view.editable || e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = this.img.getBoundingClientRect().width;
    const max = this.view.dom.clientWidth;
    const move = (ev: MouseEvent) => {
      this.img.style.width = `${Math.round(Math.max(16, Math.min(max, startW + ev.clientX - startX)))}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const pos = this.getPos();
      const w = Math.round(parseFloat(this.img.style.width));
      if (pos == null || !w || w === this.node.attrs.width) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, width: w }));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
}

/** Images pasted from elsewhere (another entry, a web page, Word) are stored as files of
 *  this entry; the ones that cannot be fetched are left out, with a notice. */
export function imageImporter(files: () => EntryFiles | undefined, notice: (msg: string) => void) {
  const done = new Map<string, string | null>(); // pending key → stored name (null: failed)
  const started = new Set<string>();

  const take = async (key: string): Promise<string> => {
    const f = files();
    if (!f) throw new Error("no file store");
    const { file, from } = JSON.parse(key) as { file: string | null; from: string };
    const name = safeFileName(file);
    // one of this entry's own files
    if (name && (!from || sameUrl(from, f.url(name))) && (await f.list()).includes(name)) return name;
    if (!from) throw new Error("no source");
    const blob = await download(from);
    const ext = MIME_EXT[blob.type];
    if (!ext) throw new Error("not an image");
    return f.add(new File([blob], name ?? nameFrom(from, ext), { type: blob.type }));
  };

  const finish = (view: EditorView, key: string) => {
    const name = done.get(key);
    const tr = view.state.tr;
    const found: { pos: number; node: Node }[] = [];
    view.state.doc.descendants((n, pos) => { if (isPicture(n) && n.attrs.pending === key) found.push({ pos, node: n }); });
    for (const { pos, node } of found.reverse()) {
      if (name) tr.setNodeMarkup(pos, null, { ...node.attrs, src: name, pending: null });
      else tr.delete(pos, pos + node.nodeSize);
    }
    if (found.length) view.dispatch(tr.setMeta("addToHistory", false));
  };

  return new Plugin({
    view: () => ({
      update: (view, prev) => {
        if (view.state.doc === prev.doc) return;
        const keys = new Set<string>();
        view.state.doc.descendants((n) => { if (isPicture(n) && n.attrs.pending) keys.add(n.attrs.pending); });
        for (const key of keys) {
          if (done.has(key)) { finish(view, key); continue; }
          if (started.has(key)) continue;
          started.add(key);
          take(key).then((name) => done.set(key, name), () => {
            done.set(key, null);
            notice(files() ? "An image could not be copied from where it came from; it was left out." : "Images cannot be stored here; the image was left out.");
          }).finally(() => finish(view, key));
        }
      },
    }),
  });
}

/** The bytes of an image address. The page's security policy lets the editor fetch only
 *  from its own server: data: addresses are decoded, blob: ones (images of this page)
 *  redrawn; images of other sites cannot be read (and are left out). */
async function download(from: string): Promise<Blob> {
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(from);
  if (data) {
    const body = data[2] ? Uint8Array.from(atob(data[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(data[3]));
    return new Blob([body], { type: data[1] });
  }
  if (from.startsWith("blob:")) {
    const img = new Image();
    img.src = from;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png"));
  }
  const res = await fetch(from, { credentials: "same-origin" });
  if (!res.ok) throw new Error(String(res.status));
  return res.blob();
}

const sameUrl = (a: string, b: string) => {
  try { return new URL(a, location.href).href === new URL(b, location.href).href; } catch { return false; }
};

/** A file name for an image from an address: its last path segment, or "image.<ext>". */
function nameFrom(from: string, ext: string): string {
  try {
    const u = new URL(from, location.href);
    const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    if (u.protocol.startsWith("http") && safeFileName(last) && IMAGE.test(last)) return last;
  } catch { /* a data: address or garbage */ }
  return `image.${ext}`;
}

/** Stores files the user pasted, dropped or chose, and puts them into the text: images as
 *  images, other files as file links. */
export async function addFiles(view: EditorView, files: EntryFiles, list: File[], notice: (msg: string) => void, pos?: number) {
  for (const f of list) {
    let name: string;
    try {
      name = await files.add(f);
    } catch (e) {
      notice(`${f.name || "The file"} could not be added${e instanceof Error && e.message ? ": " + e.message : "."}`);
      continue;
    }
    if (pos != null) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))));
      pos = undefined;
    }
    (isImageFile(f) ? insertImage(name) : insertFileLink(name))(view.state, view.dispatch);
  }
  view.focus();
}

/** The panels for files: the picker (the entry's files, or a new one), the image menu and
 *  the alternative text, and short notices. */
export class FileUI {
  private readonly picker: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly altPop: HTMLElement;
  private readonly note: HTMLElement;
  private outside?: (e: MouseEvent) => void;
  private noteTimer?: number;

  constructor(private readonly view: () => EditorView, private readonly root: HTMLElement, private readonly files: () => EntryFiles | undefined) {
    this.picker = el("div", "cs-filepop");
    this.picker.setAttribute("role", "dialog");
    this.menu = el("div", "cs-menu cs-imagemenu");
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("aria-label", "Image");
    this.altPop = el("div", "cs-altpop");
    this.altPop.setAttribute("role", "dialog");
    this.altPop.setAttribute("aria-label", "Alternative text");
    this.note = el("div", "cs-notice");
    this.note.setAttribute("role", "status");
    for (const p of [this.picker, this.menu, this.altPop]) {
      p.hidden = true;
      p.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest("input, label")) e.preventDefault(); });
      p.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
        this.view().focus();
      });
    }
    this.note.hidden = true;
    root.append(this.picker, this.menu, this.altPop, this.note);
  }

  /** A short message at the bottom of the editor. */
  notice(msg: string) {
    this.note.textContent = msg;
    this.note.hidden = false;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.note.hidden = true; }, 6000);
  }

  /** Lets the user pick a file of the entry or add a new one. images: only images. */
  async pick(opts: { images: boolean; at?: { x: number; y: number }; chosen: (name: string, file?: File) => void }) {
    const files = this.files();
    if (!files) return;
    let names: string[] = [];
    try { names = (await files.list()).filter((n) => !opts.images || isImageName(n)); } catch { /* none to show */ }
    const head = el("div", "head");
    const title = el("span", "title");
    title.textContent = opts.images ? "Insert image" : "Link to a file";
    const x = el("button", "x") as HTMLButtonElement;
    x.type = "button";
    x.title = "Close";
    x.setAttribute("aria-label", "Close");
    x.innerHTML = icon("close", 18);
    x.addEventListener("click", (e) => { e.preventDefault(); this.close(); this.view().focus(); });
    head.append(title, x);
    const upload = el("label", "lb apply upload");
    upload.innerHTML = icon("upload", 16) + "<span>Upload…</span>";
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    if (opts.images) input.accept = Object.keys(MIME_EXT).join(",");
    input.addEventListener("change", () => {
      const list = [...(input.files ?? [])];
      this.close();
      const view = this.view();
      void (async () => {
        for (const f of list) {
          try { opts.chosen(await files.add(f), f); } catch (e) {
            this.notice(`${f.name} could not be added${e instanceof Error && e.message ? ": " + e.message : "."}`);
          }
        }
        view.focus();
      })();
    });
    upload.append(input);
    const list = el("div", "list");
    if (!names.length) {
      const none = el("div", "none");
      none.textContent = opts.images ? "No images in this entry yet." : "No files in this entry yet.";
      list.append(none);
    }
    for (const n of names) {
      const b = el("button", "file") as HTMLButtonElement;
      b.type = "button";
      b.title = n;
      if (isImageName(n)) {
        const t = document.createElement("img");
        t.src = files.url(n);
        t.alt = "";
        b.append(t);
      } else b.innerHTML = icon("file", 16);
      const s = el("span", "name");
      s.textContent = n;
      b.append(s);
      b.addEventListener("click", (e) => { e.preventDefault(); this.close(); opts.chosen(n); this.view().focus(); });
      list.append(b);
    }
    this.picker.setAttribute("aria-label", title.textContent);
    this.picker.replaceChildren(head, list, upload);
    this.open(this.picker, opts.at ?? this.cursorPoint());
    (list.querySelector("button") as HTMLElement | null ?? upload).focus();
  }

  /** The menu of the selected image or diagram; editDiagram: opens draw.io (absent: diagrams are off). */
  openMenu(at: { x: number; y: number }, editDiagram?: () => void) {
    const view = this.view();
    const sel = view.state.selection;
    if (!(sel instanceof NodeSelection) || !isPicture(sel.node)) return;
    const node = sel.node, pos = sel.from;
    const diagram = node.type === schema.nodes.diagram;
    const set = (attrs: Record<string, unknown>): Command => (state, dispatch) => {
      dispatch?.(state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...attrs }));
      return true;
    };
    const items: MenuItem[] = [
      ...(diagram ? [{ label: "Edit diagram…", run: () => editDiagram?.(), disabled: !editDiagram || !node.attrs.src }] : []),
      { label: "Alternative text…", run: () => this.editAlt(at) },
      { label: "Original size", cmd: set({ width: null }), disabled: !node.attrs.width },
      { label: diagram ? "Open picture" : "Open image", run: () => { const u = node.attrs.src && this.files()?.url(node.attrs.src); if (u) window.open(u, "_blank", "noopener"); },
        disabled: !node.attrs.src || !this.files() },
      { label: "Delete", danger: true, cmd: (state, dispatch) => { dispatch?.(state.tr.delete(pos, pos + node.nodeSize)); return true; } },
    ];
    this.menu.setAttribute("aria-label", diagram ? "Diagram" : "Image");
    this.menu.replaceChildren(...buildMenu(items, view.state, (it) => {
      this.close();
      const v = this.view();
      if (it.cmd) { it.cmd(v.state, v.dispatch); v.focus(); }
      it.run?.();
    }));
    this.open(this.menu, at);
    (this.menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
  }

  /** The alternative text of the selected image (read aloud, shown when it cannot load). */
  editAlt(at?: { x: number; y: number }) {
    const view = this.view();
    const sel = view.state.selection;
    if (!(sel instanceof NodeSelection) || !isPicture(sel.node)) return;
    const pos = sel.from, node = sel.node;
    const input = el("input", "alt") as HTMLInputElement;
    input.value = node.attrs.alt;
    input.maxLength = 1000;
    input.placeholder = node.type === schema.nodes.diagram ? "What the diagram shows" : "What the image shows";
    input.setAttribute("aria-label", "Alternative text");
    const ok = el("button", "lb apply") as HTMLButtonElement;
    ok.type = "button";
    ok.textContent = "Apply";
    const apply = () => {
      this.close();
      const v = this.view();
      v.dispatch(v.state.tr.setNodeMarkup(pos, null, { ...node.attrs, alt: input.value.trim() }));
      v.focus();
    };
    ok.addEventListener("click", (e) => { e.preventDefault(); apply(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    this.altPop.replaceChildren(input, ok);
    this.open(this.altPop, at ?? this.cursorPoint());
    input.focus();
    input.select();
  }

  private open(panel: HTMLElement, at: { x: number; y: number }) {
    this.close();
    panel.hidden = false;
    const r = this.root.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - panel.offsetWidth))}px`;
    panel.style.top = `${at.y - r.top}px`;
    this.outside = (e) => { if (!panel.contains(e.target as globalThis.Node)) this.close(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  private cursorPoint() {
    const view = this.view();
    const c = view.coordsAtPos(view.state.selection.head);
    return { x: c.left, y: c.bottom + 4 };
  }

  close() {
    this.picker.hidden = this.menu.hidden = this.altPop.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
  }

  destroy() { this.close(); window.clearTimeout(this.noteTimer); }
}

/** Whether the selection is an image. */
export const imageSelected = (state: EditorState) =>
  state.selection instanceof NodeSelection && state.selection.node.type === schema.nodes.image;

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
