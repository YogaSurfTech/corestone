import { html, nothing } from "lit";
import { fmtTime, LightElement } from "@corestone/ui";
import { customElement, property } from "lit/decorators.js";
import { navigate } from "./router";
import { store, type State } from "./store";
import "./components/type-icon";
import "./components/table/table";
import "./components/ref";
import "./components/fields";
import { StoreController } from "./store-controller";
import { actionsMenu, viewTop } from "./components/view-top";
import { DetailState, SECTIONS, type Section } from "./detail/state";
import { attachmentSection } from "./detail/attachments";
import { commentSection, ownCommentSection } from "./detail/comments";
import { documentSection } from "./detail/documents";
import { fieldsSection } from "./detail/fields";
import { historySection } from "./detail/history";
import { metadataSection } from "./detail/metadata";
import { overlaySection } from "./detail/overlay";
import { relSection } from "./detail/relationships";
import { sectionOrder, setOpen, sectionName, sectionCount } from "./detail/sections";

// Entry detail view (design guide §7.5): one scrollable page with every
// section the effective schema implies, quick links to sections, and an
// optimistic-concurrency save (ETag / If-Match).
//
// With a version (?version=<blob>&at=<commit>) it shows the artifact as it
// was at that commit (TSK-22): read-only, marked historic (sepia), with the
// links, comments, attachments and base chain of then; configuration is
// today's.
//
// This file is the shell: heading, quick links, the order of the sections and
// the save bar. The state is detail/state.ts, each section a file beside it.

@customElement("corestone-detail")
export class Detail extends LightElement {
  private readonly d = new DetailState(this);
  @property() guid = "";
  /** A historic version to show: the content blob and the commit it is viewed at ("" = current). */
  @property() version = "";

  @property() at = "";

  private readonly watch = new StoreController(this, (s) => {
    if (s.refreshTick === this.d.lastTick) return;
    this.d.lastTick = s.refreshTick;
    if (this.d.view && !this.version) this.d.reload(true); // a version does not change
  });

  private get s(): State { return this.watch.state; }

  private readonly actions = actionsMenu(() => this.d.move(), () => this.d.deleteArtifact());

  closeMenus() { this.actions.close(); }
  override disconnectedCallback() { this.closeMenus(); super.disconnectedCallback(); }

  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has("guid") || changed.has("version") || changed.has("at")) && this.guid) {
      // A deep link to a section (?tab=history) opens it.
      const tab = store.state.route.tab;
      if ((SECTIONS as readonly string[]).includes(tab)) setOpen(this.d, tab as Section, true, false);
      this.d.edit.draft = null; this.d.reload(false);
    }
  }

  override updated() { this.classList.toggle("historic", !!this.d.historic); }

  override render() {
    if (!this.d.view && (this.d.loading || !this.d.error)) return html`<div class="empty-state">Loading…</div>`;
    if (!this.d.view) return html`<div class="empty-state"><div class="big">Artifact not available</div>${this.d.error}<br><button class="btn" @click=${() => navigate({ guid: null })}>Back</button></div>`;
    if (!this.d.edit.draft) return html`<div class="empty-state">Loading…</div>`;
    const r = this.s.route;
    const order = sectionOrder(this.d);
    const active = r.tab || order[0];
    const body: Record<Section, () => unknown> = {
      comment: () => ownCommentSection(this.d),
      fields: () => fieldsSection(this.d),
      relationships: () => relSection(this.d),
      comments: () => commentSection(this.d),
      overlay: () => overlaySection(this.d),
      attachments: () => attachmentSection(this.d),
      documents: () => documentSection(this.d),
      history: () => historySection(this.d),
      metadata: () => metadataSection(this.d),
    };
    return html`
      ${this.header()}
      <div class="detail-body">
        <nav class="quicklinks">${order.map((s) => html`<a href="#" class=${active === s ? "active" : ""} @click=${(e: Event) => { e.preventDefault(); navigate({ tab: s }, true); this.d.reveal(s); }}>${sectionName(this.d, s)}<span class="n">${sectionCount(this.d, s)}</span></a>`)}</nav>
        <div class="sections">
          ${this.d.error ? html`<div class="notice error" role="alert">${this.d.error} ${this.d.error.includes("Reload") ? html`<button class="btn sm" @click=${() => { this.d.edit.draft = null; this.d.reload(false); }}>Reload</button>` : nothing}</div>` : nothing}
          ${order.map((s) => body[s]())}
        </div>
      </div>
      ${this.d.edit.dirty ? html`<div class="savebar"><span class="dirty" data-test="unsaved-summary">Unsaved changes: ${this.d.edit.pendingSummary()}</span>
        <button class="btn" @click=${() => this.d.resetDraft()}>Discard</button>
        <button class="btn primary" data-test="save" ?disabled=${this.d.edit.busy} @click=${() => this.d.edit.save()}>${this.d.edit.busy ? "Saving…" : "Save"}</button></div>` : nothing}`;
  }

  /** Two lines: the folder, dates and actions; the editable identity. */
  private header() {
    const v = this.d.view!;
    const d = this.d.edit.draft!;
    const r = this.s.route;
    const presence = this.s.presence[this.guid];
    const others = presence ? [...presence.editors].filter((n) => n !== this.s.user) : [];
    const typeName = this.d.schema?.displayName ?? v.meta.type;
    const hidCfg = this.d.schema?.hid;
    const hidHint = hidCfg?.prefix ? hidCfg.prefix + (hidCfg.separator ?? "-") : "HID";
    const ov = this.d.base.overlay;
    const base = ov && ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
    const overlays = ov?.overlays.length ?? 0;
    return html`<div class="detail-head">
      ${viewTop(v.meta, { actions: this.d.historic ? null : this.actions, expanded: r.expanded,
        folder: (folder) => navigate({ folder, guid: null }), expand: () => navigate({ expanded: !r.expanded }),
        close: () => navigate({ guid: null, tab: "", expanded: false }) })}
      <div class="dh-title">
        <div class="dh-identity">
        <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${this.d.schema} title=${typeName}></corestone-type-icon>
        ${v.meta.kind === "comment" ? html`<h2 class="dh-static" data-test="comment-heading">${typeName} by ${v.meta.author || "anonymous"}</h2>` : html`
        <input class="hid-input ${d.hid ? "" : "empty"} ${this.d.changedClass("hid")}" type="text" data-test="hid" aria-label="HID" .value=${d.hid} placeholder=${hidHint} ?readonly=${!!this.d.historic}
          size=${Math.max((d.hid || hidHint).length, 3)}
          title="Human-readable identifier; must be unique. Previous HIDs stay resolvable through history." @focus=${() => this.d.edit.touched()}
          @input=${(e: Event) => { this.d.edit.draft = { ...d, hid: (e.target as HTMLInputElement).value }; }} />
        ${d.hid ? html`<span class="dash">–</span>` : nothing}
        <h2><input class="title-input ${this.d.changedClass("title")}" type="text" data-test="title" aria-label="Title" .value=${d.title} placeholder=${"untitled " + v.meta.kind} ?readonly=${!!this.d.historic} @focus=${() => this.d.edit.touched()}
          @input=${(e: Event) => { this.d.edit.draft = { ...d, title: (e.target as HTMLInputElement).value }; }} /></h2>`}
        </div>
        ${others.length ? html`<span class="presence" title="concurrent editing">✎ ${others.join(", ")} editing</span>` : nothing}
        ${base ? html`<button class="pill badge" data-test="badge-overlay" @click=${() => this.d.reveal("overlay")}>overlay of ${this.d.base.levelLabel(base.guid)}</button>` : nothing}
        ${overlays ? html`<button class="pill badge" data-test="badge-overlays" @click=${() => this.d.reveal("overlay")}>${overlays} overlay${overlays === 1 ? "" : "s"}</button>` : nothing}
      </div>
      ${this.d.historic ? this.historicBanner() : nothing}
    </div>`;
  }

  /** The banner of a historic version: when, by whom, and the way back. */
  private historicBanner() {
    const h = this.d.historic!;
    const back = () => navigate({ version: "", at: "" });
    return html`<div class="historic-banner" role="status" data-test="historic-banner">
      <span class="hb-label">Historic version</span>
      ${h.change?.created ? html`<span class="pill" data-test="historic-created">Created</span>` : h.change?.restored ? html`<span class="pill" data-test="historic-restored">Restored</span>` : nothing}
      <span>${fmtTime(h.commit.time)} · ${h.commit.author} · <span title=${h.commit.body ?? ""}>${h.commit.subject}</span></span>
      <span class="mono muted small" title="Content blob ${h.etag} at commit ${h.commit.sha}">${h.etag.slice(0, 8)} @ ${h.commit.sha.slice(0, 8)}</span>
      ${h.exact ? nothing : html`<span class="small" data-test="historic-inexact">The requested commit is unknown; shown at the commit that introduced this version.</span>`}
      <span class="small muted">Read-only. Fields and link roles are shown with today's configuration.</span>
      <span class="spacer"></span>
      ${h.exists ? html`<button class="btn sm" data-test="historic-back" @click=${back}>Back to current</button>`
        : html`<span class="small" data-test="historic-deleted">This artifact has been deleted since.</span>`}
    </div>`;
  }
}
