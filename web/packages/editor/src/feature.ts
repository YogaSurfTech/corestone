import type { Node } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import type { EditorView, NodeViewConstructor } from "prosemirror-view";
import type { Point } from "@corestone/ui";
import type { EntryFiles } from "./files";
import type { ItemLinks } from "./links";

// A feature of the editor: one kind of content (code listings, pictures,
// formulas, …) with everything the editor needs for it. The editor knows the
// features only through this interface: it collects their node views, plugins
// and keys and sends them the events on their nodes.

/** What a feature gets from the editor it is part of. */
export interface FeatureContext {
  view(): EditorView;
  /** The editor's element; panels and menus are put into it. */
  root: HTMLElement;
  readonly(): boolean;
  /** Tells the user something in passing (e.g. why a file was not added). */
  notice(msg: string): void;
  /** The entry's files (asked each time; absent: none here). */
  files(): EntryFiles | undefined;
  /** Links to items of the host application (asked each time). */
  items(): ItemLinks | undefined;
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

export interface EditorFeature {
  id: string;
  /** Node views, by node type. */
  nodeViews?(ctx: FeatureContext): Record<string, NodeViewConstructor>;
  plugins?(ctx: FeatureContext): Plugin[];
  keys?(ctx: FeatureContext): Record<string, Command>;
  /** The actions on the feature's nodes, by node type. */
  nodes?(ctx: FeatureContext): Record<string, NodeActions>;
  /** What a copied node carries to the clipboard, by node type. */
  clipboard?(ctx: FeatureContext): Record<string, (node: Node) => HTMLElement>;
  /** Pasted or dropped data the feature takes; true when it did. */
  paste?(view: EditorView, data: DataTransfer, pos: number | undefined, ctx: FeatureContext): boolean;
  setReadonly?(on: boolean): void;
  destroy?(): void;
}

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
