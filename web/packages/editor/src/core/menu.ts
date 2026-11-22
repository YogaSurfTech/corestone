import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { buildMenu as build, popupMenu as popup, type MenuEntry, type Overlay, type Point } from "@corestone/ui";

// The editor's menus (tables, images, formulas, code, placed entries): menu
// items whose state comes from ProseMirror commands, shown by the menus of
// @corestone/ui.

export interface MenuItem {
  label: string;
  cmd?: Command;
  run?: () => void;
  sub?: MenuItem[];
  danger?: boolean;
  check?: (s: EditorState) => boolean;
  /** Shown only where cmd applies (otherwise shown disabled). */
  onlyIf?: boolean;
  disabled?: boolean;
}

/** The items as the state of the text has them: what applies, what is checked. */
function entries(items: MenuItem[], state: EditorState, act: (it: MenuItem) => void): MenuEntry[] {
  return items.map((it) => {
    const applies = !it.cmd || it.cmd(state);
    return {
      label: it.label,
      danger: it.danger,
      hidden: it.onlyIf && !applies, // merge and split only where they apply
      checked: it.check?.(state),
      disabled: it.disabled || !applies,
      sub: it.sub && entries(it.sub, state, act),
      run: () => act(it),
    };
  });
}

/** The items of a menu; act runs a chosen item. */
export function buildMenu(items: MenuItem[], state: EditorState, act: (it: MenuItem) => void): HTMLElement[] {
  return build(entries(items, state, act));
}

/** Runs a chosen item on the editor: a command gives the focus back to the text, anything else decides itself. */
export function runItem(view: EditorView, it: MenuItem): void {
  if (it.cmd) { it.cmd(view.state, view.dispatch); view.focus(); }
  it.run?.();
}

/** Fills a menu panel of an overlay with items and opens it; choosing an item closes the menu and runs it. */
export function openMenu(overlay: Overlay, panel: HTMLElement, items: MenuItem[], view: () => EditorView, at: Point,
  act: (view: EditorView, it: MenuItem) => void = runItem): void {
  panel.replaceChildren(...buildMenu(items, view().state, (it) => { overlay.close(); act(view(), it); }));
  overlay.open(panel, at);
  (panel.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus();
}

/** Shows a menu of items at a point of the page, inside root (the editor's element); a click
 *  outside or Escape closes it (Escape calls back, to give the focus to the text again).
 *  Returns what closes it. */
export function popupMenu(root: HTMLElement, label: string, cls: string, items: MenuItem[], state: EditorState, at: Point,
  act: (it: MenuItem) => void, escaped: () => void): () => void {
  return popup(root, label, cls, entries(items, state, act), at, escaped);
}
