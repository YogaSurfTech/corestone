import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { splitListItem } from "prosemirror-schema-list";
import { DOMSerializer } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { clearFormatting, indent, keepAlign, outdent, setAlign, toggleFlag } from "./commands";
import { documentFromStorage, documentTitle, documentToStorage, fromStorage, toStorage, type DocNode, type RichText } from "./model";
import { DocumentUI } from "./docui";
import { codeFeature } from "./code";
import { nodeUnder, type EditorFeature, type FeatureContext, type NodeActions } from "./feature";
import { PlacementView, moveSection, renameEntries, revealSection, structureFeature, structureKey, type DocumentHost, type OutlineItem } from "./structure";
import type { EntryFiles } from "./files";
import { imagesFeature } from "./features/images";
import { fileLinksFeature } from "./features/file-links";
import { diagramsFeature } from "./diagrams";
import { formulasFeature } from "./formulas";
import { linksFeature, type ItemLinks } from "./links";
import { tablesFeature } from "./tables";
import { contentsFeature } from "./features/contents";
import { schema } from "./schema";
import { DEFAULT_PALETTE, Toolbar } from "./toolbar";
import type { Palette } from "@corestone/ui";

export interface EditorOptions {
  /** The stored value: plain text or paragraphs; in a document, its content. */
  value?: RichText | DocNode[] | null;
  palette?: Palette;
  readonly?: boolean;
  /** Called after every change with the stored form. */
  onChange?: (value: RichText | DocNode[]) => void;
  /** Makes the editor a document's (sections, placed entries, numbers): what the host does
   *  for it. Fixed when the editor is made. */
  document?: () => DocumentHost | undefined;
  /** In a document: its title, shown as the first line of the editor; without it the document
   *  starts with its introduction (the host shows the title elsewhere). */
  title?: string;
  /** In a document: called with the sections whenever they change. */
  onOutline?: (sections: OutlineItem[]) => void;
  /** Links to items of the host application (asked each time, so the host may set it later). */
  items?: () => ItemLinks | undefined;
  /** The entry's files, for images and file links (asked each time, like items). */
  files?: () => EntryFiles | undefined;
  /** The address of the draw.io web app, for diagrams (asked each time; absent: no diagrams). */
  diagrams?: () => string | undefined;
}


/** A rich-text editor with its toolbar, in a host element. */
export class RichTextEditor {
  readonly view: EditorView;
  private readonly toolbar: Toolbar;
  private readonly root: HTMLElement;
  private readonly: boolean;
  /** Short messages at the bottom of the editor. */
  private readonly note = document.createElement("div");
  private noteTimer?: number;
  private readonly doc?: DocumentUI;
  /** The features, in the order their plugins and toolbar buttons take. */
  private readonly features: EditorFeature[];

  constructor(host: HTMLElement, private readonly opts: EditorOptions = {}) {
    const items = () => opts.items?.();
    const files = () => opts.files?.();
    this.readonly = !!opts.readonly;
    this.root = document.createElement("div");
    this.root.className = "cs-editor";
    this.root.classList.toggle("readonly", this.readonly);
    // the toolbar's own inputs are internal: their change events are not the editor's
    this.root.addEventListener("change", (e) => e.stopPropagation());
    const ctx: FeatureContext = {
      view: () => this.view, root: this.root, readonly: () => this.readonly, run: (cmd) => this.run(cmd),
      notice: (m) => this.notice(m), files, items,
      colors: () => this.toolbar.colorChoices(), feature: (id) => this.features.find((f) => f.id === id),
    };
    // (files before links: pasted files are files even when an address comes with them)
    this.features = [codeFeature, fileLinksFeature, linksFeature, tablesFeature, imagesFeature, diagramsFeature(() => opts.diagrams?.()), formulasFeature,
      // a document: its structure (its keys go before the text's own, so it is the last with plugins), and what it generates from it
      ...(opts.document ? [structureFeature(() => opts.document?.()), contentsFeature(() => opts.document?.())] : [])].map((make) => make(ctx));
    this.toolbar = new Toolbar({ state: () => this.view.state, run: (cmd) => this.run(cmd),       structure: opts.document ? { entry: () => { void this.doc?.insertEntry(); },
        // (offered when the host can make entries and give their text)
        ...(opts.document?.()?.convertToEntry && opts.document?.()?.entryAsText && opts.document?.()?.entryTypes
          ? { convert: (type: string) => { void this.doc?.convert(type); }, unmark: () => { void this.doc?.unmark(); },
            entryTypes: () => opts.document?.()?.entryTypes?.() ?? { remember: "", types: [] } } : {}) } : undefined },
      opts.palette ?? DEFAULT_PALETTE, this.features.flatMap((f) => f.toolbar ?? []));
    this.root.classList.toggle("cs-document", !!opts.document);
    const area = document.createElement("div");
    area.className = "cs-area";
    // (the text area always grows with the text: the whole text is visible)
    this.root.append(this.toolbar.el, area);
    host.append(this.root);
    this.note.className = "cs-notice";
    this.note.setAttribute("role", "status");
    this.note.hidden = true;
    this.root.append(this.note);
    const docHost = () => opts.document?.();
    if (opts.document) this.doc = new DocumentUI(() => this.view, this.root, docHost, (m) => this.notice(m));
    // what copied nodes carry to the clipboard (e.g. a picture the address of its file)
    const base = DOMSerializer.fromSchema(schema);
    const clipboardSerializer = new DOMSerializer({ ...base.nodes, ...Object.assign({}, ...this.features.map((f) => f.clipboard)) }, base.marks);
    this.view = new EditorView(area, {
      state: this.state(opts.value, files),
      nodeViews: {
        placement: (node, _view, _getPos, decorations) => new PlacementView(node, docHost, decorations),
        ...Object.assign({}, ...this.features.map((f) => f.nodeViews)) },
      clipboardSerializer,
      editable: () => !this.readonly,
      dispatchTransaction: (tr) => {
        this.view.updateState(this.view.state.apply(tr));
        this.toolbar.update(this.view.state);
        for (const f of this.features) f.update?.(this.view);
        if (tr.docChanged) {
          if (!tr.getMeta("cs-host")) opts.onChange?.(this.value); // not the host's own change
          if (opts.onOutline) opts.onOutline(this.outline());
        }
      },
      handleDOMEvents: {
        // links open on a click when reading, and on Ctrl/⌘+click while editing
        click: (view, e) => {
          return this.features.some((f) => f.click?.(view, e));
        },
        // the right mouse button on selected cells keeps them selected (to merge them)
        mousedown: (view, e) => {
          if (e.button === 2) return !!(e.target as HTMLElement).closest(".selectedCell");
          // Shift+click on a picture, diagram or formula extends the text selection over it (the
          // browser would select it alone)
          const atom = e.shiftKey && e.button === 0 ? (e.target as HTMLElement).closest(".cs-img, .cs-formula") : null;
          if (!atom || !area.contains(atom)) return false;
          const at = view.posAtDOM(atom, 0);
          const n = view.state.doc.nodeAt(at);
          if (!n?.isInline) return false;
          const anchor = view.state.selection.anchor;
          e.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, anchor <= at ? at + n.nodeSize : at)));
          view.focus();
          return true;
        },
        // the menu of what the pointer is on, on the right mouse button; elsewhere the browser's own menu
        contextmenu: (view, e) => {
          if (this.readonly) return false;
          // a node with a menu of its own (a placed entry, a picture, a formula, …)
          if (this.onNode(view, e, "menu")) return true;
          // a feature's menu for what the pointer is on (a code listing, a table)
          if (this.features.some((f) => f.contextMenu?.(e))) { e.preventDefault(); return true; }
          return false;
        },
        // a double click opens what it is on: a placed entry, a diagram, a formula
        dblclick: (view, e) => this.onNode(view, e, "open"),
        focus: (view) => { for (const f of this.features) f.update?.(view); return false; },
        blur: () => { for (const f of this.features) f.blur?.(); return false; },
      },
      transformPastedHTML: (html) => this.features.reduce((h, f) => f.transformPasted?.(h) ?? h, html),
      handleDrop: (view, e, _slice, moved) => {
        if (moved || this.readonly) return false;
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (!this.pasted(view, e.dataTransfer, true, at?.pos)) return false;
        e.preventDefault();
        return true;
      },
      handlePaste: (view, e) => this.pasted(view, e.clipboardData, false),
    });
    this.toolbar.update(this.view.state);
  }

  /** Pasted or dropped data a feature takes (files become pictures and links). */
  private pasted(view: EditorView, data: DataTransfer | null, drop: boolean, pos?: number): boolean {
    return !!data && this.features.some((f) => f.paste?.(view, data, drop, pos));
  }

  /** A short message at the bottom of the editor. */
  private notice(msg: string) {
    this.note.textContent = msg;
    this.note.hidden = false;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.note.hidden = true; }, 6000);
  }

  /** The stored form of the current text (a document's content in a document). */
  get value(): RichText | DocNode[] { return this.opts.document ? documentToStorage(this.view.state.doc) : toStorage(this.view.state.doc); }

  /** Replaces the text (and the undo history); a document keeps its title. */
  set value(v: RichText | DocNode[] | null) {
    const titled = this.view.state.doc.firstChild?.type === schema.nodes.doc_title;
    this.view.updateState(this.state(v, undefined, titled ? this.title : undefined));
    this.toolbar.update(this.view.state);
  }

  /** In a document: its title, the first line of the editor. */
  get title(): string { return documentTitle(this.view.state.doc); }

  /** In a document: changes the title in place (the cursor and the undo history stay); for the
   *  host, so no change is reported. */
  setTitle(title: string) {
    const t = title.replace(/[\r\n]+/g, " ");
    const node = this.view.state.doc.firstChild;
    if (!this.opts.document || node?.type !== schema.nodes.doc_title || node.textContent === t) return;
    this.view.dispatch(this.view.state.tr.replaceWith(1, 1 + node.content.size, t ? schema.text(t) : [])
      .setMeta("addToHistory", false).setMeta("cs-host", true));
  }

  /** In a document: replaces the title and the content (and the undo history). */
  setDocument(content: DocNode[] | null, title: string) {
    this.view.updateState(this.state(content, undefined, title));
    this.toolbar.update(this.view.state);
  }

  /** Read-only shows the text without the toolbar. */
  setReadonly(on: boolean) {
    if (on === this.readonly) return;
    this.readonly = on;
    this.root.classList.toggle("readonly", on);
    this.toolbarHost?.classList.toggle("readonly", on);
    if (on) this.doc?.close();
    for (const f of this.features) f.setReadonly?.(on);
    this.view.setProps({}); // editable is asked again
  }

  /** Shows the toolbar again for what the host now offers (e.g. diagrams); in a document also
   *  the placed entries and cross-references (e.g. once the host knows their names). */
  refresh() {
    this.toolbar.update(this.view.state);
    if (this.opts.document) this.view.dispatch(this.view.state.tr.setMeta("cs-refresh", true));
  }

  /** In a document: puts the GUIDs the save gave new entries in place of their keys (in place:
   *  the cursor and the undo history stay). */
  renameEntries(names: Map<string, string>) {
    if (this.opts.document) renameEntries(names)(this.view.state, this.view.dispatch);
  }

  /** In a document: its sections, in order. */
  outline(): OutlineItem[] { return structureKey.getState(this.view.state)?.sections ?? []; }

  /** In a document: puts the cursor into a section's heading and scrolls there. */
  revealSection(id: string): boolean { return revealSection(this.view, id); }

  /** In a document: moves a section into a parent (null: the top level), before the parent's
   *  index-th section. */
  moveSection(id: string, parentId: string | null, index: number): boolean {
    if (this.readonly) return false;
    return moveSection(id, parentId, index)(this.view.state, this.view.dispatch);
  }

  focus() { this.view.focus(); }
  /** Takes the toolbar out of the editor so the host can place it (e.g. in its own bar). It
   *  keeps the editor's looks; it goes when the editor goes. */
  detachToolbar(): HTMLElement {
    if (!this.toolbarHost) {
      const h = document.createElement("div");
      h.className = this.root.className + " cs-tbhost";
      h.append(this.toolbar.el);
      this.root.classList.add("cs-tbaway");
      this.toolbarHost = h;
    }
    return this.toolbarHost;
  }
  private toolbarHost?: HTMLElement;

  destroy() { this.toolbarHost?.remove(); for (const f of this.features) f.destroy?.(); window.clearTimeout(this.noteTimer); this.doc?.destroy(); this.view.destroy(); this.root.remove(); }

  /** The menu of what the cursor is in, from the keyboard: a code listing's, else a table's. */
  private contextKey(): boolean {
    if (this.readonly) return false;
    return this.features.some((f) => f.contextMenu?.());
  }

  /** What happens on the nodes that have a menu or open (by node type); the features' once they are features. */
  private readonly nodes: Record<string, NodeActions> = {
    placement: { selector: ".cs-placement", openReadonly: true,
      menu: (hit) => { if (!this.doc) return false; this.doc.openMenu(hit.at!); },
      // (only with the pointer: Enter on a selected entry is the text's)
      open: (hit) => { if (!hit.at) return false; this.opts.document?.()?.openEntry(hit.node.attrs.guid, hit.newTab); } },
  };

  /** The actions on nodes of every type: the features' and the ones above. */
  private get allNodes(): Record<string, NodeActions> { return Object.assign({}, this.nodes, ...this.features.map((f) => f.nodes)); }

  /** A pointer event on a node with an action of that kind: the node is selected and the action runs. */
  private onNode(view: EditorView, e: MouseEvent, kind: "menu" | "open"): boolean {
    const found = nodeUnder(view, e, this.allNodes, kind);
    if (!found) return false;
    const { actions, hit } = found;
    if (this.readonly && !(kind === "open" && actions.openReadonly)) return false;
    if (!this.readonly) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hit.pos)));
    if (actions[kind]!(hit) === false) return false;
    e.preventDefault();
    return true;
  }

  private run(cmd: Command) {
    cmd(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  private state(value: RichText | DocNode[] | null | undefined, files: () => EntryFiles | undefined = () => this.opts.files?.(), title: string | undefined = this.opts.title): EditorState {
    const isDoc = !!this.opts.document;
    const keys: Record<string, Command> = {
      "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
      "Mod-b": toggleFlag("bold"), "Mod-i": toggleFlag("italic"), "Mod-u": toggleFlag("underline"),
      "Mod-,": toggleFlag("sub"), "Mod-.": toggleFlag("sup"), "Mod-\\": clearFormatting,
      "Mod-l": setAlign("left"), "Mod-e": setAlign("center"), "Mod-r": setAlign("right"), "Mod-j": setAlign("justify"),
      // a new paragraph or list item keeps the alignment of the one it was split from (below: Enter)
      // in a list: indent (in a table the tables' keys follow: the next / previous cell)
      "Tab": indent, "Shift-Tab": outdent,
      // the table menu from the keyboard
      "ContextMenu": () => this.contextKey(), "Shift-F10": () => this.contextKey(),
      // Enter on a selected formula or diagram opens it
      "Enter": (state, dispatch) => {
        const sel = state.selection;
        const actions = sel instanceof NodeSelection ? this.allNodes[sel.node.type.name] : undefined;
        if (!this.readonly && actions?.open && actions.open({ node: (sel as NodeSelection).node, pos: sel.from, newTab: false }) !== false) return true;
        return keepAlign(chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter))(state, dispatch);
      },
      "Shift-Enter": (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
        return true;
      },
    };
    // a feature's key: the editor's own command for it first, the feature's when that does not apply
    for (const f of this.features) for (const [key, cmd] of Object.entries(f.keys ?? {})) keys[key] = keys[key] ? chainCommands(keys[key], cmd) : cmd;
    const state = EditorState.create({ doc: isDoc ? documentFromStorage(value as DocNode[], title) : fromStorage(value as RichText),
      plugins: [history(), ...this.features.flatMap((f) => f.plugins ?? []),
        keymap(keys), keymap(baseKeymap)] });
    // what the features repair in a loaded text, outside the undo history
    return this.features.reduce((st, f) => { const fix = f.normalize?.(st); return fix ? st.apply(fix.setMeta("addToHistory", false)) : st; }, state);
  }
}
