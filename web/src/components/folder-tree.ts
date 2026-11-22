import { html, nothing, type TemplateResult } from "lit";
import type { FolderSource } from "./services";
import type { FolderInfo } from "./types";

// The tree of folders, as the folder field and the navigation both show it:
// rows that open in place, with a count and, where asked for, what a folder
// holds besides artifacts. What a click on a row does is the caller's.

/** A folder in the tree; its children are null until they were asked for. */
export interface FolderNode {
  info: FolderInfo;
  children: FolderNode[] | null;
  open: boolean;
  /** Not in the repository yet: it is created with the first artifact saved in it. */
  pending?: boolean;
}

export function folderNode(name: string, path: string, open = false): FolderNode {
  return { info: { name, path, artifacts: 0, direct: 0, hasConfig: false }, children: null, open };
}

/** Reads the folders in a node's folder; a failure leaves it without children. */
export async function loadFolders(n: FolderNode, source: FolderSource | undefined): Promise<void> {
  const found = await (source?.children(n.info.path) ?? Promise.resolve([])).catch(() => []);
  n.children = found.map((info) => ({ info, children: null, open: false }));
}

/** The tree counts everything below a folder; the tooltip says how much of it is in the folder itself. */
export function countTitle(f: FolderInfo): string {
  const below = f.artifacts - f.direct;
  const n = (k: number) => `${k} artifact${k === 1 ? "" : "s"}`;
  return below > 0 ? `${n(f.direct)} here, ${n(below)} in subfolders` : `${n(f.direct)} here`;
}

export interface FolderTreeOptions {
  selected(path: string): boolean;
  /** A click on a row. */
  pick(n: FolderNode): void;
  /** The caret was clicked and the node opened or closed: load its children if it has none yet, and render again. */
  toggled(n: FolderNode): void;
  /** Also show which folders have their own configuration, and what a count is made of. */
  details?: boolean;
  /** A box that narrows the root's folders by name, once there are more than `from`. */
  filter?: { from: number; text: string; changed(text: string): void };
}

/** The tree below a root node, as a list; a row carries its path as data-folder. */
export function folderTree(root: FolderNode, o: FolderTreeOptions): TemplateResult {
  const node = (n: FolderNode, depth: number): TemplateResult => {
    const hasKids = n.children === null || n.children.length > 0;
    const kids = n.open && n.children?.length ? n.children : null;
    const f = depth === 0 ? o.filter : undefined;
    const text = f?.text.trim().toLowerCase();
    return html`<li>
      <div class="row ${o.selected(n.info.path) ? "selected" : ""} ${n.pending ? "pending" : ""}" data-folder=${n.info.path}
        title=${n.pending ? "Not in the repository yet: created with the first artifact saved here" : ""} @click=${() => o.pick(n)}>
        <span class="caret ${hasKids ? "" : "empty"}" @click=${(e: Event) => { e.stopPropagation(); n.open = !n.open; o.toggled(n); }}>${n.open ? "▾" : "▸"}</span>
        <span class="name">${depth === 0 ? html`<b>${n.info.name}</b>` : n.info.name}</span>
        ${o.details && n.info.hasConfig ? html`<span class="badge" title="has a .corestone metadata directory">.corestone</span>` : nothing}
        ${n.info.artifacts ? html`<span class="count" title=${o.details ? countTitle(n.info) : ""}>${n.info.artifacts}</span>` : nothing}
      </div>
      ${kids ? html`<ul>
        ${f && kids.length > f.from ? html`<li><input class="tree-filter" type="search" data-test="folder-filter" placeholder="Filter ${kids.length} folders…"
          .value=${f.text} @input=${(e: Event) => f.changed((e.target as HTMLInputElement).value)} /></li>` : nothing}
        ${(text ? kids.filter((c) => c.info.name.toLowerCase().includes(text)) : kids).map((c) => node(c, depth + 1))}</ul>` : nothing}
    </li>`;
  };
  return html`<ul class="tree">${node(root, 0)}</ul>`;
}
