import { NodeSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import type { EntryFiles } from "../core/files";
import type { Feature } from "../core/feature";
import { ImageView, isPicture, pictureForClipboard, type ImagesFeature } from "./images";
import { icon } from "../core/icons";
import { schema } from "../core/schema";
import { button, dataUrlToBlob, dialogHead, el } from "@corestone/ui";

// Diagrams: drawn in draw.io, kept as one PNG file of the entry with the
// diagram's source inside it (draw.io's "xmlpng"). The host serves draw.io (the
// editor is given its address); it runs in a sandboxed frame without access to
// the page, and the two talk through messages (draw.io's embed protocol).

const SCALE = 2; // the PNG has twice the pixels it is shown with, to stay sharp

/** The selected diagram, if any. */
export function selectedDiagram(state: EditorState) {
  const sel = state.selection;
  return sel instanceof NodeSelection && sel.node.type === schema.nodes.diagram ? { pos: sel.from, node: sel.node } : null;
}

/** A free name for a new diagram's file: "diagram.drawio.png", or numbered ("diagram-2.drawio.png"). */
async function freeName(files: EntryFiles): Promise<string> {
  const taken = new Set(await files.list().catch(() => [] as string[]));
  let name = "diagram.drawio.png";
  for (let n = 2; taken.has(name); n++) name = `diagram-${n}.drawio.png`;
  return name;
}

/** Whether a picture other than the one at pos shows the file (a copied diagram). */
function sharedElsewhere(doc: Node, src: string, pos: number | null): boolean {
  let shared = false;
  doc.descendants((n, p) => {
    if (shared) return false;
    if (p !== pos && isPicture(n) && n.attrs.src === src) shared = true;
    return undefined;
  });
  return shared;
}

const toDataUrl = (b: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(b);
});

function fromDataUrl(uri: string): Blob {
  const blob = dataUrlToBlob(uri);
  if (!blob) throw new Error("not a picture");
  return blob;
}

/** The diagram dialog: draw.io in a large panel, for a new diagram or the selected one. */
class DiagramUI {
  private readonly panel: HTMLElement;
  private frame?: HTMLIFrameElement;
  private listener?: (e: MessageEvent) => void;
  private startTimer?: number;

  constructor(private readonly view: () => EditorView, root: HTMLElement, private readonly files: () => EntryFiles | undefined,
    private readonly editorUrl: () => string | undefined, private readonly notice: (msg: string) => void) {
    this.panel = el("div", "cs-diagrampop");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Diagram");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.hidden = true;
    root.append(this.panel);
  }

  get open() { return !this.panel.hidden; }

  /** Opens draw.io with the selected diagram, or an empty one. */
  async edit() {
    const files = this.files(), url = this.editorUrl();
    if (!files || !url || this.open) return;
    const current = selectedDiagram(this.view().state);
    let png: string | null = null;
    if (current) {
      try {
        if (!files.get) throw new Error("the host cannot read files");
        png = await toDataUrl(await files.get(current.node.attrs.src));
      } catch (e) {
        this.notice(`The diagram could not be opened${e instanceof Error && e.message ? ": " + e.message : "."}`);
        return;
      }
    }
    this.show(url, files, png, current?.node.attrs.src ?? null, current?.pos ?? null);
  }

  private show(url: string, files: EntryFiles, png: string | null, previous: string | null, pos: number | null) {
    let dirty = false, saving = false;
    const { head, x } = dialogHead(previous ? "Diagram" : "New diagram", icon("close", 18));
    const ask = el("span", "ask");
    ask.hidden = true;
    const askText = el("span", "");
    askText.textContent = "Discard the changes?";
    const discard = button({ cls: "lb danger", text: "Discard" });
    const keep = button({ cls: "lb", text: "Keep editing" });
    ask.append(askText, discard, keep);
    x.before(ask);

    const frame = document.createElement("iframe");
    frame.title = "draw.io";
    // a frame of its own: no access to this page, its cookies or the host's API
    frame.setAttribute("sandbox", "allow-scripts allow-modals allow-downloads allow-popups");
    const params = new URLSearchParams({ embed: "1", proto: "json", spin: "1", saveAndExit: "1", noSaveBtn: "1", noExitBtn: "1",
      stealth: "1", pwa: "0", lang: "en", libraries: "1", dark: isDark(this.panel) ? "1" : "0" });
    frame.src = `${url}${url.includes("?") ? "&" : "?"}${params}`;
    this.frame = frame;

    const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage(JSON.stringify(msg), "*");
    const close = () => this.close();
    x.addEventListener("click", () => { if (dirty && !saving) { ask.hidden = false; keep.focus(); } else close(); });
    keep.addEventListener("click", () => { ask.hidden = true; });
    discard.addEventListener("click", close);

    this.listener = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || typeof e.data !== "string") return;
      let msg: { event?: string; xml?: string; data?: string; exit?: boolean };
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.event) {
        case "init":
          window.clearTimeout(this.startTimer);
          post(png ? { action: "load", autosave: 1, xmlpng: png } : { action: "load", autosave: 1, xml: "" });
          break;
        case "autosave":
          dirty = true;
          break;
        case "save":
          saving = true;
          post({ action: "export", format: "xmlpng", xml: msg.xml, scale: SCALE, border: 8, spinKey: "saving" });
          break;
        case "export":
          void this.store(files, msg.data ?? "", previous, pos).then((ok) => { if (ok) close(); else saving = false; });
          break;
        case "exit":
          close();
          break;
      }
    };
    window.addEventListener("message", this.listener);
    this.panel.addEventListener("keydown", this.escape);
    const box = el("div", "box");
    box.append(head, frame);
    this.panel.replaceChildren(box);
    this.panel.hidden = false;
    this.startTimer = window.setTimeout(() => {
      this.notice("The diagram editor did not start.");
      close();
    }, 30000);
    frame.focus();
  }

  private readonly escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !(e.target as HTMLElement).closest(".head")) return;
    e.preventDefault();
    (this.panel.querySelector("button.x") as HTMLElement | null)?.click();
  };

  /** Keeps the exported PNG as a new file of the entry and puts it into the text. */
  private async store(files: EntryFiles, uri: string, previous: string | null, pos: number | null): Promise<boolean> {
    try {
      const blob = fromDataUrl(uri);
      const bitmap = await createImageBitmap(blob);
      const width = Math.max(16, Math.min(4000, Math.round(bitmap.width / SCALE)));
      bitmap.close();
      const view = this.view();
      // a changed diagram stays in its file (the history keeps the old one); a new one, or one
      // whose file another copy shows, gets a file of its own
      const replace = !!previous && !sharedElsewhere(view.state.doc, previous, pos);
      const name = await files.add(new File([blob], replace ? previous! : await freeName(files), { type: "image/png" }), replace);
      const old = pos != null ? view.state.doc.nodeAt(pos) : null;
      const tr = view.state.tr;
      if (old && old.type === schema.nodes.diagram && old.attrs.src === previous) {
        // the same place, the old alternative text; the width as drawn (the picture may have grown)
        tr.setNodeMarkup(pos!, null, { ...old.attrs, src: name, width });
      } else {
        tr.replaceSelectionWith(schema.nodes.diagram.create({ src: name, width }));
      }
      view.dispatch(tr.scrollIntoView());
      view.focus();
      return true;
    } catch (e) {
      this.notice(`The diagram could not be kept${e instanceof Error && e.message ? ": " + e.message : "."}`);
      return false;
    }
  }

  close() {
    if (this.panel.hidden) return;
    window.clearTimeout(this.startTimer);
    if (this.listener) window.removeEventListener("message", this.listener);
    this.listener = undefined;
    this.panel.removeEventListener("keydown", this.escape);
    this.frame?.remove();
    this.frame = undefined;
    this.panel.hidden = true;
    this.view().focus();
  }

  destroy() { this.close(); }
}

/** Whether the page is shown dark: the colour scheme it sets, or the system's when it follows it. */
function isDark(at: HTMLElement): boolean {
  const scheme = getComputedStyle(at).colorScheme.trim();
  if (scheme === "dark") return true;
  if (scheme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Diagrams: pictures drawn in draw.io (at the address the host names; none: no diagrams). */
export const diagramsFeature = (address: () => string | undefined): Feature => (ctx) => {
  const ui = new DiagramUI(ctx.view, ctx.root, ctx.files, address, ctx.notice);
  /** Whether diagrams can be drawn: the entry's files and draw.io are there. */
  const on = () => !!ctx.files() && !!address();
  return {
    id: "diagrams",
    nodeViews: { diagram: (node, view, getPos) => new ImageView(node, view, getPos, ctx.files) },
    nodes: { diagram: { selector: ".cs-img",
      // a diagram is a picture: its menu is the picture's, with "Edit diagram…"
      menu: (hit) => {
        const images = ctx.feature("images") as ImagesFeature | undefined;
        if (!images) return false;
        images.openMenu(hit.at!, on() ? () => { void ui.edit(); } : undefined);
      },
      open: () => { if (!on()) return false; void ui.edit(); } } },
    // (a copied diagram carries the address of its PNG, with the diagram inside)
    clipboard: { diagram: (n) => pictureForClipboard(n, ctx.files, "data-diagram") },
    toolbar: [{ group: "ins", id: "diagram",
      tip: { text: "Diagram…", disabled: () => (on() ? null
        : ctx.files() ? "Diagrams are not available: draw.io is not installed on this server." : "Diagrams are kept with a saved item; not available here.") },
      run: () => { void ui.edit(); } }],
    setReadonly: (on) => { if (on) ui.close(); },
    destroy: () => ui.destroy(),
  };
};
