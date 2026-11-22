import type { Node } from "prosemirror-model";
import { chainCommands } from "prosemirror-commands";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import type { EditorView, NodeViewConstructor } from "prosemirror-view";
import type { ColorChoices, Point, Tip } from "@corestone/ui";
import type { EntryFiles } from "./files";

// A feature of the editor: one kind of content (code listings, pictures,
// formulas, …) with everything the editor needs for it. The editor knows the
// features only through this interface: it collects their node views, plugins
// and keys and sends them the events on their nodes.

/** How the host application links to its items. Without it, only web links are offered. */
export interface ItemLinks {
  /** Lets the user choose an item; resolves with its id and a name for the link text, or null. */
  pick(): Promise<{ ref: string; label: string } | null>;
  /** The name of an item, shown in the link bubble. */
  label?(ref: string): Promise<string>;
  /** Opens an item; newTab when Ctrl/⌘ was held. */
  open(ref: string, newTab: boolean): void;
}

/** What a feature gets from the editor it is part of. */
export interface FeatureContext {
  view(): EditorView;
  /** The editor's element; panels and menus are put into it. */
  root: HTMLElement;
  readonly(): boolean;
  /** Runs a command on the text and gives it the focus. */
  run(cmd: Command): void;
  /** Tells the user something in passing (e.g. why a file was not added). */
  notice(msg: string): void;
  /** The entry's files (asked each time; absent: none here). */
  files(): EntryFiles | undefined;
  /** Links to items of the host application (asked each time). */
  items(): ItemLinks | undefined;
  /** The colours the editor offers (its palette and the ones used lately). */
  colors(): ColorChoices;
  /** Another feature of the same editor, by its id; absent when the editor has none such. */
  feature(id: string): EditorFeature | undefined;
}

/** A node the user pointed at or selected. */
export interface NodeHit {
  node: Node;
  pos: number;
  /** Where the pointer was; absent from the keyboard. */
  at?: Point;
  /** Ctrl/⌘ was held: open elsewhere (a new tab). */
  newTab: boolean;
}

/** What happens on a node of one type. Each answers false when it does not apply now. */
export interface NodeActions {
  /** The element of the node's view, as a CSS selector. */
  selector: string;
  /** The node's menu (right mouse button); never while read-only. */
  menu?(hit: NodeHit): boolean | void;
  /** Opens the node (double click; Enter while it is selected). */
  open?(hit: NodeHit): boolean | void;
  /** open also applies while the text is read-only. */
  openReadonly?: boolean;
}

/** A button a feature adds to a group of the toolbar ("style": paragraph style, "fmt": text format, "ins": insert). */
export interface ToolbarItem {
  group: "style" | "fmt" | "ins";
  /** Names the button and its icon. */
  id: string;
  tip: Tip;
  /** at: where the toolbar was clicked (absent from the keyboard), for a panel that opens there. */
  run(at?: Point): void;
  pressed?(state: EditorState): boolean;
}

/** The toolbar's building blocks, for a feature that builds a group of its own. */
export interface ToolbarKit {
  state(): EditorState;
  /** A button with the icon of that name. */
  button(name: string, tip: Tip, act: () => void): HTMLButtonElement;
  /** Adds a control to the bar. */
  add(el: HTMLElement): void;
  /** Adds a group: its main control, and behind ▾ its menu. */
  group(main: HTMLElement, label: string, menu: HTMLElement): void;
  /** What was remembered under a key (the choice used last). */
  last(key: string): string | undefined;
  remember(key: string, value: string): void;
  closeMenus(): void;
  /** Called whenever the bar is brought in line with the text. */
  onUpdate(f: (state: EditorState) => void): void;
  /** Brings the bar in line with the text now. */
  refresh(): void;
}
/** Builds a group of the toolbar. */
export type ToolbarGroup = (kit: ToolbarKit) => void;

/**
 * A feature as one editor has it. Features are listed in an order that
 * counts: their plugins and their toolbar buttons follow it.
 */
export interface EditorFeature {
  id: string;
  /** Node views, by node type. */
  nodeViews?: Record<string, NodeViewConstructor>;
  plugins?: Plugin[];
  /** Keys; a key the editor or an earlier feature also has goes to this one when theirs does not apply. */
  keys?: Record<string, Command>;
  /** The actions on the feature's nodes, by node type. */
  nodes?: Record<string, NodeActions>;
  /** What a copied node carries to the clipboard, by node type. */
  clipboard?: Record<string, (node: Node) => HTMLElement>;
  toolbar?: ToolbarItem[];
  /** A group of the toolbar the feature builds itself (after the paragraph styles). */
  toolbarGroup?: ToolbarGroup;
  /** Shows the feature's menu for where the pointer (e) or else the cursor is; true when it did. Never called while read-only. */
  contextMenu?(e?: MouseEvent): boolean;
  /** Pasted or dropped data the feature takes; true when it did. pos: where it was dropped (absent: pasted at the selection). */
  paste?(view: EditorView, data: DataTransfer, drop: boolean, pos?: number): boolean;
  /** Changes pasted HTML before it is read. */
  transformPasted?(html: string): string;
  /** Repairs a text that was just loaded; the change stays out of the undo history. */
  normalize?(state: EditorState): Transaction | undefined;
  /** A click in the text the feature takes; true when it did. */
  click?(view: EditorView, e: MouseEvent): boolean;
  /** Called after every change of the text or the selection, and when the text gets the focus. */
  update?(view: EditorView): void;
  /** The text lost the focus. */
  blur?(): void;
  setReadonly?(on: boolean): void;
  destroy?(): void;
}

/** Makes a feature for one editor. */
export type Feature = (ctx: FeatureContext) => EditorFeature;

/**
 * The node under a pointer event that has an action of the wanted kind: its
 * view's element is found, its position resolved and its type checked.
 */
export function nodeUnder(view: EditorView, e: MouseEvent, nodes: Record<string, NodeActions>, kind: "menu" | "open"): { actions: NodeActions; hit: NodeHit } | null {
  for (const [type, actions] of Object.entries(nodes)) {
    if (!actions[kind]) continue;
    const el = (e.target as HTMLElement).closest(actions.selector);
    if (!el || !view.dom.contains(el)) continue;
    const pos = view.posAtDOM(el, 0);
    const node = view.state.doc.nodeAt(pos);
    if (node?.type.name !== type) continue;
    return { actions, hit: { node, pos, at: { x: e.clientX, y: e.clientY }, newTab: e.ctrlKey || e.metaKey } };
  }
  return null;
}

/**
 * The editor's keys with the features': a key several have goes to the
 * editor's own command first, then to the features' in their order, until
 * one applies.
 */
export function mergeKeys(own: Record<string, Command>, features: Pick<EditorFeature, "keys">[]): Record<string, Command> {
  const keys = { ...own };
  for (const f of features) for (const [key, cmd] of Object.entries(f.keys ?? {})) keys[key] = keys[key] ? chainCommands(keys[key], cmd) : cmd;
  return keys;
}
