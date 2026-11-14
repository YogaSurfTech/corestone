import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { splitListItem } from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { clearFormatting, indent, keepAlign, outdent, setAlign, toggleFlag } from "./commands";
import { fromStorage, toStorage, type RichText } from "./model";
import { schema } from "./schema";
import { DEFAULT_PALETTE, Toolbar, type Palette } from "./toolbar";

export interface EditorOptions {
  /** The stored value; a plain string (an older value) is read as paragraphs. */
  value?: RichText | string | null;
  palette?: Palette;
  readonly?: boolean;
  /** Called after every change with the stored form. */
  onChange?: (value: RichText) => void;
}

/** A rich-text editor with its toolbar, in a host element. */
export class RichTextEditor {
  readonly view: EditorView;
  private readonly toolbar: Toolbar;
  private readonly root: HTMLElement;

  constructor(host: HTMLElement, opts: EditorOptions = {}) {
    this.root = document.createElement("div");
    this.root.className = "cs-editor";
    this.toolbar = new Toolbar({ state: () => this.view.state, run: (cmd) => this.run(cmd) }, opts.palette ?? DEFAULT_PALETTE);
    const area = document.createElement("div");
    area.className = "cs-area";
    this.root.append(this.toolbar.el, area);
    host.append(this.root);
    this.view = new EditorView(area, {
      state: this.state(opts.value),
      editable: () => !opts.readonly,
      dispatchTransaction: (tr) => {
        this.view.updateState(this.view.state.apply(tr));
        this.toolbar.update(this.view.state);
        if (tr.docChanged) opts.onChange?.(this.value);
      },
    });
    this.toolbar.update(this.view.state);
  }

  /** The stored form of the current text. */
  get value(): RichText { return toStorage(this.view.state.doc); }

  /** Replaces the text (and the undo history). */
  set value(v: RichText | string | null) {
    this.view.updateState(this.state(v));
    this.toolbar.update(this.view.state);
  }

  focus() { this.view.focus(); }
  destroy() { this.view.destroy(); this.root.remove(); }

  private run(cmd: Command) {
    cmd(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  private state(value: RichText | string | null | undefined): EditorState {
    const keys: Record<string, Command> = {
      "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
      "Mod-b": toggleFlag("bold"), "Mod-i": toggleFlag("italic"), "Mod-u": toggleFlag("underline"),
      "Mod-,": toggleFlag("sub"), "Mod-.": toggleFlag("sup"), "Mod-\\": clearFormatting,
      "Mod-l": setAlign("left"), "Mod-e": setAlign("center"), "Mod-r": setAlign("right"), "Mod-j": setAlign("justify"),
      // a new paragraph or list item keeps the alignment of the one it was split from
      "Enter": keepAlign(chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter)),
      "Tab": indent, "Shift-Tab": outdent,
      "Shift-Enter": (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
        return true;
      },
    };
    return EditorState.create({ doc: fromStorage(value), plugins: [history(), keymap(keys), keymap(baseKeymap)] });
  }
}
