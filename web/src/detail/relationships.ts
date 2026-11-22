import { html, nothing } from "lit";
import { navigate } from "../router";
import type { Summary } from "../components/types";
import { label } from "../components/artifact";
import type { TableColumn } from "../components/table/table";
import { type DetailState } from "./state";
import { artifactRef, openCell, refRoute, sectionOf } from "./parts";

// The links of the artifact; for a link, the relation it expresses.

/** A link's own relation: From → role → To, each endpoint opening that artifact. */
export function linkRelSection(dt: DetailState) {
  const v = dt.view!;
  return sectionOf(dt, "relationships", () => html`<div class="links-list"><div class="link-row" data-test="link-relation">
    <span class=${dt.changedClass("source")}>${artifactRef(dt, v.meta.source, dt.endpoints?.source)}</span>
    <span class="arrow">→</span><span class="type">${dt.schema?.displayName ?? v.meta.type}</span><span class="arrow">→</span>
    <span class=${dt.changedClass("target")}>${artifactRef(dt, v.meta.target, dt.endpoints?.target)}</span></div></div>`);
}

export function relSection(dt: DetailState) {
  if (dt.view?.meta.kind === "link") return linkRelSection(dt);
  const rel = dt.rel;
  type Row = { link: Summary; other: Summary; role?: string; dir: "in" | "out"; pending?: number };
  const p = dt.pending;
  const rows: Row[] = [...(rel ? [...rel.outgoing.map((l) => ({ ...l, dir: "out" as const })), ...rel.incoming.map((l) => ({ ...l, dir: "in" as const }))] : []),
    ...p.links.map((l, i) => ({ link: { guid: "pending-" + i, kind: "link" as const, type: l.type, folder: "", path: "", source: l.source, target: l.target, links: 0, comments: 0 }, other: l.other, role: l.role, dir: l.dir, pending: i }))];
  const removeLink = (r: Row) => r.pending !== undefined
    ? (dt.pending = { ...p, links: p.links.filter((_, i) => i !== r.pending) })
    : dt.toggleLinkRemoval(r.link.guid);
  const removing = (r: Row) => p.removedLinks.includes(r.link.guid);
  const columns: TableColumn<Row>[] = [
    { id: "role", name: "Role", width: 160, value: (r) => r.role || r.link.type, render: (r) => html`<span class="type" title=${r.link.type}>${r.role || r.link.type}</span>` },
    { id: "dir", name: "Dir", width: 72, value: (r) => r.dir, render: (r) => html`<span class="arrow ${r.dir}" title=${r.dir === "in" ? "incoming: the other artifact links to this one" : "outgoing: this artifact links to the other"}>${r.dir === "in" ? "←" : "→"}</span>` },
    { id: "artifact", name: "Artifact", value: (r) => r.other.hid || label(r.other), render: (r) => openCell(dt, r.other) },
    { id: "folder", name: "Folder", width: 150, value: (r) => r.other.folder, render: (r) => html`<span class="muted small">${r.other.folder || "/"}</span>` },
    ...(dt.historic ? [] : [{ id: "remove", name: "", width: 60, sortable: false, render: (r: Row) => removing(r)
      ? html`<button class="btn sm" title="Keep link" aria-label="Keep link" data-test="link-keep" @click=${(e: Event) => { e.stopPropagation(); removeLink(r); }}>↺</button>`
      : html`<button class="btn sm" title="Remove link" aria-label="Remove link" @click=${(e: Event) => { e.stopPropagation(); removeLink(r); }}>✕</button>` }]),
  ];
  const actions = dt.historic ? nothing : html`
      ${rel?.allowedAsSource.map((s) => html`<button class="btn sm" @click=${() => dt.addLink(true, s.type, s.displayName || s.type, s.targetTypes)}>＋ ${s.displayName || s.type} →</button>`)}
      ${rel?.allowedAsTarget.filter((s) => !rel.allowedAsSource.some((x) => x.type === s.type)).map((s) => html`<button class="btn sm" @click=${() => dt.addLink(false, s.type, s.reverseName || s.displayName || s.type, s.sourceTypes)}>＋ ${s.reverseName || s.displayName || s.type} ←</button>`)}
      ${rel && !rel.allowedAsSource.length && !rel.allowedAsTarget.length ? html`<span class="muted small" data-test="no-link-types">No link type here allows ${dt.view?.meta.type ?? "this type"} as an endpoint.</span>` : nothing}`;
  return sectionOf(dt, "relationships", () => html`
    ${!rows.length ? html`<div class="muted small">No links yet.</div>` : html`<corestone-table class="detail-table" .items=${rows} .columns=${columns}
      .rowKey=${(r: Row) => r.link.guid} .rowClass=${(r: Row) => `link-row open-row ${dt.added(r.link.guid) ? "added" : ""} ${r.pending !== undefined ? "pending-add" : ""} ${removing(r) ? "pending-remove" : ""}`} @row-click=${(e: CustomEvent<Row>) => navigate(refRoute(dt, e.detail.other.guid, e.detail.other))}></corestone-table>`}
    `, actions);
}
