import { html, nothing } from "lit";
import { DropMenu, fmtTime } from "@corestone/ui";
import type { Summary } from "./types";

// The top line of the entry view and of the document view, the same in both:
// the folder, the dates, the actions menu, expanding and closing. What the
// controls do is the view's.

export interface ViewTopOptions {
  /** The actions menu; none: no menu (a historic version). */
  actions: DropMenu | null;
  expanded: boolean;
  /** A folder of the path was clicked. */
  folder(path: string): void;
  /** Expanding or restoring was clicked. */
  expand(): void;
  close(): void;
  cls?: string;
}

/** The actions menu of an artifact view: moving and deleting. */
export function actionsMenu(move: () => void, remove: () => void): DropMenu {
  return new DropMenu({
    label: "Actions", cls: "actions-pop", align: "end",
    items: () => [
      { label: "Move…", test: "move", run: move },
      { label: "Delete", test: "delete", danger: true, run: remove },
    ],
  });
}

/** The top line of an artifact view. */
export function viewTop(meta: Summary, o: ViewTopOptions) {
  const segs = meta.folder ? meta.folder.split("/") : [];
  const toFolder = (path: string) => (e: Event) => { e.preventDefault(); o.folder(path); };
  return html`<div class="dh-top ${o.cls ?? ""}">
    <nav class="dh-crumbs" aria-label="Folder">
      <a href="/folder/" @click=${toFolder("")}>/</a>
      ${segs.map((s, i) => { const path = segs.slice(0, i + 1).join("/"); return html`${i ? html`<span class="sep">›</span>` : nothing}<a href=${"/folder/" + path} @click=${toFolder(path)}>${s}</a>`; })}
    </nav>
    <span class="dh-dates">created: ${fmtTime(meta.createdAt)}<span class="gap"></span>updated: ${fmtTime(meta.modifiedAt)}</span>
    ${o.actions ? html`<span class="dh-actions">
      <button class="btn sm icon" data-test="actions" title="Actions" aria-label="Actions" aria-haspopup="menu" aria-expanded="false"
        @click=${(e: Event) => o.actions!.toggle(e.currentTarget as HTMLElement)}>⋯</button></span>` : nothing}
    <button class="btn sm" data-test="expand" title=${o.expanded ? "Restore layout" : "Expand detail"} @click=${o.expand}>${o.expanded ? "⤡" : "⤢"}</button>
    <button class="btn sm icon" title="Close" aria-label="Close detail view" @click=${o.close}>✕</button>
  </div>`;
}
