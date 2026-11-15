import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { splitListItem } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { clearFormatting, indent, keepAlign, outdent, setAlign, toggleFlag } from "./commands";
import { fromStorage, toStorage, type RichText } from "./model";
import { columnResizing, fixTables, tableEditing } from "prosemirror-tables";
import { LinkUI, openLink, type ItemLinks } from "./links";
import { StyledTableView, TableUI, flattenNestedTables, nextCell, prevCell, tableAt, tableEdges } from "./tables";
import { safeHref, schema } from "./schema";
import { DEFAULT_PALETTE, Toolbar, type Palette } from "./toolbar";

export interface EditorOptions {
  /** The stored value: plain text or paragraphs. */
  value?: RichText | null;
  palette?: Palette;
  readonly?: boolean;
  /** Called after every change with the stored form. */
  onChange?: (value: RichText) => void;
  /** Links to items of the host application (asked each time, so the host may set it later). */
  items?: () => ItemLinks | undefined;
}

/** A rich-text editor with its toolbar, in a host element. */
export class RichTextEditor {
  readonly view: EditorView;
  private readonly toolbar: Toolbar;
  private readonly root: HTMLElement;
  private readonly: boolean;
  private readonly links: LinkUI;
  private readonly tables: TableUI;

  constructor(host: HTMLElement, opts: EditorOptions = {}) {
    const items = () => opts.items?.();
    this.readonly = !!opts.readonly;
    this.root = document.createElement("div");
    this.root.className = "cs-editor";
    this.root.classList.toggle("readonly", this.readonly);
    // the toolbar's own inputs are internal: their change events are not the editor's
    this.root.addEventListener("change", (e) => e.stopPropagation());
    this.toolbar = new Toolbar({ state: () => this.view.state, run: (cmd) => this.run(cmd), link: () => this.links.edit(), table: (at) => this.tables.openGrid(at) },
      opts.palette ?? DEFAULT_PALETTE);
    const area = document.createElement("div");
    area.className = "cs-area";
    this.root.append(this.toolbar.el, area);
    host.append(this.root);
    this.links = new LinkUI(() => this.view, this.root, items);
    this.tables = new TableUI(() => this.view, this.root, this.toolbar.colorChoices());
    this.view = new EditorView(area, {
      state: this.state(opts.value),
      editable: () => !this.readonly,
      dispatchTransaction: (tr) => {
        this.view.updateState(this.view.state.apply(tr));
        this.toolbar.update(this.view.state);
        this.links.update(this.view, this.readonly);
        if (tr.docChanged) opts.onChange?.(this.value);
      },
      handleDOMEvents: {
        // links open on a click when reading, and on Ctrl/⌘+click while editing
        click: (_view, e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (!a || !area.contains(a)) return false;
          e.preventDefault();
          const newTab = e.ctrlKey || e.metaKey;
          if (!this.readonly && !newTab) return false;
          openLink({ href: a.getAttribute("href"), ref: a.getAttribute("data-ref") }, newTab, items());
          return true;
        },
        // the right mouse button on selected cells keeps them selected (to merge them)
        mousedown: (_view, e) => e.button === 2 && !!(e.target as HTMLElement).closest(".selectedCell"),
        // the table menu on the right mouse button; outside tables the browser's own menu
        contextmenu: (view, e) => {
          if (this.readonly || !(e.target as HTMLElement).closest("td, th")) return false;
          const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
          // a click outside the selected cells moves the cursor there; inside, the selection stays (merge)
          if (hit && !(e.target as HTMLElement).closest(".selectedCell")) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
          }
          if (!tableAt(view.state)) return false;
          e.preventDefault();
          this.tables.openMenu({ x: e.clientX, y: e.clientY });
          return true;
        },
        focus: (view) => { this.links.update(view, this.readonly); return false; },
        blur: () => { this.links.hideBubble(); return false; },
      },
      // pasted tables keep what the editor supports; a table in a table becomes lines of text
      transformPastedHTML: flattenNestedTables,
      // a pasted web address links the selected text, or is inserted as a link
      handlePaste: (view, e) => {
        const text = e.clipboardData?.getData("text/plain").trim() ?? "";
        const href = /\n/.test(text) ? null : safeHref(text);
        if (!href) return false;
        const link = schema.marks.link.create({ href });
        const { empty, from, to } = view.state.selection;
        const tr = view.state.tr;
        if (empty) tr.replaceSelectionWith(schema.text(text, link.addToSet(view.state.storedMarks ?? view.state.selection.$from.marks())), false);
        else tr.removeMark(from, to, schema.marks.link).addMark(from, to, link);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    });
    this.toolbar.update(this.view.state);
  }

  /** The stored form of the current text. */
  get value(): RichText { return toStorage(this.view.state.doc); }

  /** Replaces the text (and the undo history). */
  set value(v: RichText | null) {
    this.view.updateState(this.state(v));
    this.toolbar.update(this.view.state);
  }

  /** Read-only shows the text without the toolbar. */
  setReadonly(on: boolean) {
    if (on === this.readonly) return;
    this.readonly = on;
    this.root.classList.toggle("readonly", on);
    if (on) { this.links.close(false); this.links.hideBubble(); this.tables.close(); }
    this.view.setProps({}); // editable is asked again
  }

  focus() { this.view.focus(); }
  destroy() { this.links.destroy(); this.tables.destroy(); this.view.destroy(); this.root.remove(); }

  private tableMenu(state: EditorState): boolean {
    if (this.readonly || !tableAt(state)) return false;
    this.tables.openMenu();
    return true;
  }

  private run(cmd: Command) {
    cmd(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  private state(value: RichText | null | undefined): EditorState {
    const keys: Record<string, Command> = {
      "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
      "Mod-b": toggleFlag("bold"), "Mod-i": toggleFlag("italic"), "Mod-u": toggleFlag("underline"),
      "Mod-,": toggleFlag("sub"), "Mod-.": toggleFlag("sup"), "Mod-\\": clearFormatting,
      "Mod-l": setAlign("left"), "Mod-e": setAlign("center"), "Mod-r": setAlign("right"), "Mod-j": setAlign("justify"),
      // a new paragraph or list item keeps the alignment of the one it was split from
      "Enter": keepAlign(chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter)),
      // in a list: indent; in a table: the next / previous cell
      "Tab": chainCommands(indent, nextCell), "Shift-Tab": chainCommands(outdent, prevCell),
      // the table menu from the keyboard
      "ContextMenu": (state) => this.tableMenu(state), "Shift-F10": (state) => this.tableMenu(state),
      "Mod-k": () => { if (this.readonly) return false; this.links.edit(); return true; },
      "Shift-Enter": (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
        return true;
      },
    };
    const state = EditorState.create({ doc: fromStorage(value),
      plugins: [history(), columnResizing({ View: StyledTableView }), tableEditing(), tableEdges, keymap(keys), keymap(baseKeymap)] });
    // irregular stored tables (rows of different lengths) are completed, outside the undo history
    const fix = fixTables(state);
    return fix ? state.apply(fix.setMeta("addToHistory", false)) : state;
  }
}
