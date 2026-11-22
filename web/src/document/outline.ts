import { html, nothing, type TemplateResult } from "lit";
import { appIcon } from "../components/icons";

import { type DocumentState } from "./state";

// The outline sidebar: the sections in order, moved by their grips.

/** The outline: the sections in order; a click goes there. A section is moved with its grip:
 *  over the upper half of a row it goes before that row, over the lower half before the next
 *  one, below the last row to the end; a line shows where, indented to the level it takes. */
export function outlinePanel(ds: DocumentState): TemplateResult {
  const items = ds.outline;
  if (!items.length) return html`<div class="muted small">No headings yet. Make a paragraph a heading with H in the toolbar.</div>`;
  const parentOf = (i: number): string | null => {
    for (let j = i - 1; j >= 0; j--) if (items[j].depth === items[i].depth - 1) return items[j].id;
    return null;
  };
  const indexOf = (i: number): number => {
    let n = 0;
    for (let j = i - 1; j >= 0 && items[j].depth >= items[i].depth; j--) if (items[j].depth === items[i].depth) n++;
    return n;
  };
  const indent = (depth: number) => (depth - 1) * 14 + 4;
  // the dragged section and the ones inside it: no place to drop it
  const from = items.findIndex((x) => x.id === ds.dragId);
  const inside = (i: number) => {
    if (from < 0 || i < from) return false;
    for (let j = from + 1; j <= i; j++) if (items[j].depth <= items[from].depth) return false;
    return true;
  };
  const over = (e: DragEvent, at: number | "end") => {
    if (!ds.dragId) return;
    if (at !== "end" && at >= items.length) at = "end";
    if (at !== "end" && inside(at)) { ds.dropAt = null; return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    ds.dropAt = at;
  };
  const overRow = (e: DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    over(e, e.clientY > r.top + r.height / 2 ? i + 1 : i);
  };
  const end = () => { ds.dragId = null; ds.dropAt = null; };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    const id = ds.dragId, at = ds.dropAt;
    end();
    if (!id || at === null) return;
    if (at === "end") ds.editor?.moveSection(id, null, Number.MAX_SAFE_INTEGER);
    else if (!inside(at)) ds.editor?.moveSection(id, parentOf(at), indexOf(at));
  };
  const last = items.length - 1;
  return html`<div class="outline ${ds.dragId ? "dragging" : ""}" role="tree" aria-label="Outline"
      @dragover=${(e: DragEvent) => over(e, "end")} @drop=${drop} @dragleave=${(e: DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as globalThis.Node | null)) ds.dropAt = null; }}>
    ${items.map((it, i) => html`<div class="outline-row ${ds.dropAt === i ? "drop-before" : ""} ${i === last && ds.dropAt === "end" ? "drop-after" : ""}
        ${ds.dragId === it.id ? "moving" : ""}" role="treeitem" aria-level=${it.depth} data-section=${it.id}
        style=${`--ind:${indent(it.depth)}px`}
        @dragover=${(e: DragEvent) => overRow(e, i)} @drop=${drop}
        @click=${() => ds.editor?.revealSection(it.id)}>
        <span class="num">${it.number}</span><span class="t">${it.title || html`<span class="muted">Untitled</span>`}</span>
        ${it.entries ? html`<span class="count" title="Entries in this section">${it.entries}</span>` : nothing}
        <span class="grip" draggable="true" data-tip="Drag to move the section" aria-label="Move ${it.title || "section"}" @click=${(e: Event) => e.stopPropagation()}
          @dragstart=${(e: DragEvent) => {
            ds.dragId = it.id;
            e.dataTransfer?.setData("text/plain", it.title);
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setDragImage((e.target as HTMLElement).closest(".outline-row")!, 12, 12); }
          }}
          @dragend=${end}>${appIcon("grip", 14)}</span></div>`)}
  </div>`;
}
