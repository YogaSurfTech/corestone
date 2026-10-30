import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, ApiError } from "./api";
import { clearLeaveGuard, navigate, setLeaveGuard, type LeaveGuard } from "./router";
import { store, type State } from "./store";
import type { CommentView, LogEntry, OverlayView, Relationships, Schema, Summary, View, WorkflowEval } from "./types";
import { announceEdit } from "./ws";
import { commentTypeOf, deepEqual, fmtSize, fmtTime, label, undeclaredField } from "./util";
import "./type-icon";
import "./fields";
import type { OverlayState } from "./fields";

// Entry detail view (design guide §7.5): one scrollable page with every
// section the effective schema implies, quick links to sections, and an
// optimistic-concurrency save (ETag / If-Match).

const SECTIONS = ["fields", "workflows", "relationships", "comments", "overlay", "attachments", "history", "metadata"] as const;
type Section = (typeof SECTIONS)[number];
const OPEN_KEY = "corestone.detail.sections";

function readOpenPrefs(): Record<string, boolean> {
  try { return JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

@customElement("corestone-detail")
export class Detail extends LitElement {
  @property() guid = "";
  private unsub?: () => void;
  private s!: State;
  @state() private view: View | null = null;
  @state() private schema: Schema | null = null;
  @state() private workflows: WorkflowEval[] = [];
  @state() private rel: Relationships | null = null;
  /** For a link: the artifacts it connects (null when an endpoint no longer exists). */
  @state() private endpoints: { source: Summary | null; target: Summary | null } | null = null;
  @state() private comments: CommentView[] = [];
  @state() private overlay: OverlayView | null = null;
  /** The base's effective fields: what this entry shows where it sets nothing itself. */
  @state() private baseOverlay: OverlayView | null = null;
  /** The comment type to post with here; null when the folder defines none (no comments then). */
  @state() private commentType: string | null = null;
  @state() private history: LogEntry[] = [];
  @state() private draft: { title: string; hid: string; fields: Record<string, unknown> } | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private loading = true;
  @state() private replyTo: string | null = null;
  @state() private commentText = "";
  @state() private showDiagram: string | null = null;
  @state() private historyLoaded = false;
  @state() private actionsOpen = false;
  /** Sections the user opened or closed; remembered for the browser session. */
  @state() private openPrefs: Record<string, boolean> = readOpenPrefs();
  private lastTick = -1;
  private editing = false;
  private loadSeq = 0;
  private softInFlight = false;
  private softPending = false;
  private warnedEtag = "";

  override createRenderRoot() { return this; }
  /** Asked by the router before leaving this artifact with unsaved changes. */
  private leaveGuard: LeaveGuard = {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => { if (this.view) this.resetDraft(); },
    label: () => (this.view ? label(this.view.meta) : "This artifact"),
  };

  override connectedCallback() {
    super.connectedCallback();
    setLeaveGuard(this.leaveGuard);
    document.addEventListener("click", this.closeActions);
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.refreshTick !== this.lastTick) {
        this.lastTick = s.refreshTick;
        if (this.view) this.reload(true);
      }
      this.requestUpdate();
    });
  }
  private closeActions = () => { if (this.actionsOpen) this.actionsOpen = false; };
  override disconnectedCallback() { this.unsub?.(); document.removeEventListener("click", this.closeActions); clearLeaveGuard(this.leaveGuard); if (this.editing) announceEdit(this.guid, false); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("guid") && this.guid) {
      // A deep link to a section (?tab=history) opens it.
      const tab = store.state.route.tab;
      if ((SECTIONS as readonly string[]).includes(tab)) this.setOpen(tab as Section, true, false);
      this.draft = null; this.reload(false);
    }
  }

  private get dirty(): boolean {
    if (!this.draft || !this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.draft.title !== (d.title ?? "") || this.draft.hid !== (d.hid ?? "") || !deepEqual(this.draft.fields, d.fields ?? {});
  }

  private async reload(soft: boolean) {
    // A navigation (hard load) supersedes everything in flight. Soft
    // refreshes (repository events) are coalesced: under a stream of
    // events one refresh runs at a time and one more is queued, so the
    // view always catches up instead of being superseded forever.
    if (soft) {
      if (this.softInFlight) { this.softPending = true; return; }
      this.softInFlight = true;
    }
    const seq = soft ? this.loadSeq : ++this.loadSeq;
    const guid = this.guid;
    const stale = () => seq !== this.loadSeq || guid !== this.guid;
    try {
      await this.load(soft, guid, stale);
    } finally {
      if (soft) {
        this.softInFlight = false;
        if (this.softPending && !stale()) { this.softPending = false; void this.reload(true); }
        else this.softPending = false;
      }
    }
  }

  private async load(soft: boolean, guid: string, stale: () => boolean) {
    if (!soft) { this.loading = true; this.view = null; this.draft = null; this.schema = null; this.overlay = null; this.baseOverlay = null; this.rel = null; this.endpoints = null; this.comments = []; this.history = []; this.historyLoaded = false; this.workflows = []; this.actionsOpen = false; }
    this.error = "";
    try {
      const view = await api.get(guid);
      if (stale()) return;
      const isLink = view.meta.kind === "link";
      const endpoint = (g?: string) => g ? api.get(g).then((e) => e.meta).catch(() => null) : Promise.resolve(null);
      const [schema, wf, rel, endpoints, comments, history, overlay, baseOverlay, types] = await Promise.all([
        api.schemaOf(guid).catch(() => ({ schema: null })),
        api.workflows(guid).catch(() => ({ workflows: [] })),
        isLink ? Promise.resolve(null) : api.relationships(guid).catch(() => null),
        isLink ? Promise.all([endpoint(view.meta.source), endpoint(view.meta.target)]) : Promise.resolve(null),
        api.comments(guid).catch(() => ({ comments: [] })),
        // History is only fetched while its section is open.
        this.isOpen("history") ? api.history(guid).catch(() => ({ history: [] })) : Promise.resolve(null),
        view.meta.kind === "entry" ? api.overlay(guid).catch(() => null) : Promise.resolve(null),
        view.meta.kind === "entry" && view.meta.base ? api.overlay(view.meta.base).catch(() => null) : Promise.resolve(null),
        api.types(view.meta.folder).catch(() => ({ types: [] })),
      ]);
      if (stale()) return;
      // Judge the draft against the view it was made from, after every
      // await: typing that happened during the fetches must survive.
      const wasDirty = this.dirty;
      if (soft && wasDirty && view.etag !== this.view?.etag) {
        // Keep the draft and the ETag we started from: saving will be
        // rejected (412) instead of silently overwriting the other change.
        if (this.warnedEtag !== view.etag) {
          this.warnedEtag = view.etag;
          store.toast("This artifact was changed by someone else while you were editing.", "error", { label: "Reload", run: () => { this.draft = null; this.reload(false); } });
        }
        this.loading = false;
        return;
      }
      this.view = view;
      this.schema = schema.schema;
      this.workflows = wf.workflows;
      this.rel = rel;
      this.endpoints = endpoints ? { source: endpoints[0], target: endpoints[1] } : null;
      this.comments = comments.comments;
      this.history = history?.history ?? [];
      this.historyLoaded = !!history;
      this.overlay = overlay;
      this.baseOverlay = baseOverlay;
      this.commentType = commentTypeOf(types.types);
      if (!this.draft || !wasDirty) this.resetDraft(); // an untouched draft follows the new version
      // A deep link to a section (?tab=comments) also scrolls to it once the view is there.
      const tab = store.state.route.tab;
      if (!soft && this.sectionOrder().includes(tab as Section)) void this.reveal(tab as Section);
    } catch (e) {
      if (stale()) return;
      this.error = e instanceof ApiError ? e.message : String(e);
      if (!soft) this.view = null;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  private resetDraft() {
    const d = this.view!.data as Record<string, unknown>;
    this.draft = { title: String(d.title ?? ""), hid: String(d.hid ?? ""), fields: structuredClone((d.fields as Record<string, unknown>) ?? {}) };
    if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
  }

  private touched() {
    if (!this.editing) { this.editing = true; announceEdit(this.guid, true); }
  }

  private async save() {
    if (!this.view || !this.draft || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (this.draft.title !== (d.title ?? "")) patch.title = this.draft.title;
    if (this.draft.hid !== (d.hid ?? "")) patch.hid = this.draft.hid || null;
    const fields: Record<string, unknown> = {};
    const old = (d.fields as Record<string, unknown>) ?? {};
    for (const [k, v] of Object.entries(this.draft.fields)) if (!deepEqual(v, old[k])) fields[k] = v === undefined ? null : v;
    for (const k of Object.keys(old)) if (!(k in this.draft.fields)) fields[k] = null;
    if (Object.keys(fields).length) patch.fields = fields;
    try {
      this.view = await api.update(this.guid, patch, this.view.etag);
      store.toast("Saved", "success");
      this.resetDraft();
      store.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        this.error = "Someone else modified this artifact in the meantime. Reload to see their changes; your edits stay in the form until you do.";
      } else {
        this.error = e instanceof ApiError ? e.message : String(e);
      }
    } finally {
      this.busy = false;
    }
  }

  private async transition(wf: string, to: string) {
    try {
      this.view = await api.transition(this.guid, wf, to, this.view?.etag);
      store.toast(`${wf}: now ${this.view.meta.workflows?.[wf] ?? to}`, "success");
      this.reload(true);
      store.refresh();
    } catch (e) {
      store.toast(e instanceof ApiError ? e.message : String(e), "error");
    }
  }

  private async deleteArtifact() {
    const v = this.view!;
    store.set({ dialog: { kind: "confirm", title: `Delete ${label(v.meta)}?`, danger: true, confirmLabel: "Delete",
      text: `The artifact, its ${v.meta.links} link(s), ${v.meta.comments} comment(s) and ${v.attachments?.length ?? 0} attachment(s) are removed in one commit. History stays in Git.`,
      onConfirm: async () => {
        try {
          await api.remove(this.guid, v.etag);
          store.toast("Deleted", "success");
          store.refresh();
          navigate({ guid: null });
        } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
      } } });
  }

  private async addComment() {
    if (!this.commentText.trim()) return;
    try {
      await api.create("comments", { subject: this.guid, parent: this.replyTo ?? undefined, type: this.commentType, text: this.commentText, author: this.s.user });
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
  }

  private addLink(asSource: boolean, type: string, types?: string[]) {
    store.set({ picker: { kind: "pick", title: asSource ? `${type}: choose target` : `${type}: choose source`, types, exclude: this.guid, kinds: ["entry", "document"],
      onPick: async (other: { guid: string }) => {
        try {
          await api.create("links", asSource ? { type, source: this.guid, target: other.guid } : { type, source: other.guid, target: this.guid });
          store.toast("Link created", "success");
          this.reload(true);
          store.refresh();
        } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
      } } });
  }

  private async upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await api.uploadFile(this.guid, file.name, file);
      store.toast(`Attached ${file.name}`, "success");
      this.reload(true);
    } catch (err) { store.toast(err instanceof ApiError ? err.message : String(err), "error"); }
    input.value = "";
  }

  private move() {
    store.prompt("Move artifact", { text: "Target folder; leave empty for the repository root.", value: this.view?.meta.folder ?? "", confirmLabel: "Move", folder: true }).then((folder) => {
      if (folder === null) return;
      api.move(this.guid, folder).then((v) => { this.view = v; store.toast(`Moved to ${folder || "/"}`, "success"); store.refresh(); navigate({ folder }); this.reload(true); })
        .catch((e) => store.toast(e instanceof ApiError ? e.message : String(e), "error"));
    });
  }

  private createOverlay() {
    const v = this.view!;
    store.set({ dialog: { kind: "new", kinds: ["entry"], type: v.meta.type, folder: v.meta.folder, baseGuid: this.guid } });
    // the new dialog reads baseGuid via a small hook below
    window.setTimeout(() => {
      const dlg = document.querySelector("corestone-new-dialog") as (HTMLElement & { base: string; baseLabel: string }) | null;
      if (dlg) { dlg.base = this.guid; dlg.baseLabel = label(v.meta); }
    }, 50);
  }

  override render() {
    if (!this.view && (this.loading || !this.error)) return html`<div class="empty-state">Loading…</div>`;
    if (!this.view) return html`<div class="empty-state"><div class="big">Artifact not available</div>${this.error}<br><button class="btn" @click=${() => navigate({ guid: null })}>Back</button></div>`;
    if (!this.draft) return html`<div class="empty-state">Loading…</div>`;
    const r = this.s.route;
    const order = this.sectionOrder();
    const active = r.tab || order[0];
    const body: Record<Section, () => unknown> = {
      fields: () => this.fieldsSection(),
      workflows: () => this.workflowSection(),
      relationships: () => this.relSection(),
      comments: () => this.commentSection(),
      overlay: () => this.overlaySection(),
      attachments: () => this.attachmentSection(),
      history: () => this.historySection(),
      metadata: () => this.metadataSection(),
    };
    return html`
      ${this.header()}
      <div class="detail-body">
        <nav class="quicklinks">${order.map((s) => html`<a href="#" class=${active === s ? "active" : ""} @click=${(e: Event) => { e.preventDefault(); navigate({ tab: s }, true); this.reveal(s); }}>${this.sectionName(s)}<span class="n">${this.sectionCount(s)}</span></a>`)}</nav>
        <div class="sections">
          ${this.error ? html`<div class="notice error" role="alert">${this.error} ${this.error.includes("Reload") ? html`<button class="btn sm" @click=${() => { this.draft = null; this.reload(false); }}>Reload</button>` : nothing}</div>` : nothing}
          ${order.map((s) => body[s]())}
        </div>
      </div>
      ${this.dirty ? html`<div class="savebar"><span class="dirty">Unsaved changes</span>
        <button class="btn" @click=${() => this.resetDraft()}>Discard</button>
        <button class="btn primary" data-test="save" ?disabled=${this.busy} @click=${this.save}>${this.busy ? "Saving…" : "Save"}</button></div>` : nothing}`;
  }

  /** Three lines: dates and actions, the editable identity, the folder breadcrumb. */
  private header() {
    const v = this.view!;
    const d = this.draft!;
    const r = this.s.route;
    const presence = this.s.presence[this.guid];
    const others = presence ? [...presence.editors].filter((n) => n !== this.s.user) : [];
    const typeName = this.schema?.displayName ?? v.meta.type;
    const hidCfg = this.schema?.hid;
    const hidHint = hidCfg?.prefix ? hidCfg.prefix + (hidCfg.separator ?? "-") : "HID";
    const ov = this.overlay;
    const base = ov && ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
    const overlays = ov?.overlays.length ?? 0;
    const segs = v.meta.folder ? v.meta.folder.split("/") : [];
    const toFolder = (folder: string) => (e: Event) => { e.preventDefault(); navigate({ folder, guid: null }); };
    return html`<div class="detail-head">
      <div class="dh-top">
        <span class="dh-dates">created: ${fmtTime(v.meta.createdAt)}<span class="gap"></span>updated: ${fmtTime(v.meta.modifiedAt)}</span>
        <span class="dh-actions">
          <button class="btn sm icon" data-test="actions" title="Actions" aria-label="Actions" aria-haspopup="menu" aria-expanded=${this.actionsOpen}
            @click=${(e: Event) => { e.stopPropagation(); this.actionsOpen = !this.actionsOpen; }}>⋯</button>
          ${this.actionsOpen ? html`<div class="menu" role="menu">
            <button class="item" role="menuitem" @click=${() => { this.actionsOpen = false; this.move(); }}>Move…</button>
            <button class="item danger" role="menuitem" data-test="delete" @click=${() => { this.actionsOpen = false; this.deleteArtifact(); }}>Delete</button>
          </div>` : nothing}
        </span>
      </div>
      <div class="dh-title">
        <div class="dh-identity">
        <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${this.schema} title=${typeName}></corestone-type-icon>
        <input class="hid-input ${d.hid ? "" : "empty"}" type="text" data-test="hid" aria-label="HID" .value=${d.hid} placeholder=${hidHint}
          size=${Math.max((d.hid || hidHint).length, 3)}
          title="Human-readable identifier; must be unique. Previous HIDs stay resolvable through history." @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, hid: (e.target as HTMLInputElement).value }; }} />
        ${d.hid ? html`<span class="dash">–</span>` : nothing}
        <h2><input class="title-input" type="text" data-test="title" aria-label="Title" .value=${d.title} placeholder=${"untitled " + v.meta.kind} @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, title: (e.target as HTMLInputElement).value }; }} /></h2>
        </div>
        ${others.length ? html`<span class="presence" title="concurrent editing">✎ ${others.join(", ")} editing</span>` : nothing}
        ${base ? html`<button class="pill badge" data-test="badge-overlay" @click=${() => this.reveal("overlay")}>overlay of ${this.levelLabel(base.guid)}</button>` : nothing}
        ${overlays ? html`<button class="pill badge" data-test="badge-overlays" @click=${() => this.reveal("overlay")}>${overlays} overlay${overlays === 1 ? "" : "s"}</button>` : nothing}
        <button class="btn sm" title=${r.expanded ? "Restore layout" : "Expand detail"} @click=${() => navigate({ expanded: !r.expanded })}>${r.expanded ? "⤡" : "⤢"}</button>
        <button class="btn sm icon" title="Close" aria-label="Close detail view" @click=${() => navigate({ guid: null, tab: "", expanded: false })}>✕</button>
      </div>
      <nav class="dh-crumbs" aria-label="Folder">
        <a href="/folder/" @click=${toFolder("")}>/</a>
        ${segs.map((s, i) => { const path = segs.slice(0, i + 1).join("/"); return html`${i ? html`<span class="sep">›</span>` : nothing}<a href=${"/folder/" + path} @click=${toFolder(path)}>${s}</a>`; })}
      </nav>
    </div>`;
  }

  /** A link is about the relation it expresses, so its endpoints come before its fields. */
  private sectionOrder(): Section[] {
    const order: readonly Section[] = this.view?.meta.kind === "link"
      ? ["relationships", "fields", ...SECTIONS.filter((s) => s !== "relationships" && s !== "fields")]
      : SECTIONS;
    return order.filter((s) => this.hasSection(s));
  }

  private hasSection(s: string): boolean {
    const k = this.view?.meta.kind;
    switch (s) {
      case "workflows": return this.workflows.length > 0;
      case "attachments": return k === "entry" || k === "document";
      case "overlay": return !!this.overlay;
      default: return true;
    }
  }
  private isEmpty(s: Section): boolean {
    switch (s) {
      case "fields": return !(this.schema?.fields ?? []).some((f) => f.type !== "workflow") && !Object.keys(this.draft?.fields ?? {}).length;
      case "relationships": return this.view?.meta.kind !== "link" && (!this.rel || !(this.rel.incoming.length + this.rel.outgoing.length));
      case "comments": return !this.comments.length;
      case "attachments": return !this.view?.attachments?.length;
      case "overlay": return !this.overlay || (this.overlay.chain.length <= 1 && !this.overlay.overlays.length);
      case "history": case "metadata": return true; // closed unless asked for
      default: return false;
    }
  }
  private isOpen(s: Section): boolean { return this.openPrefs[s] ?? !this.isEmpty(s); }
  private setOpen(s: Section, open: boolean, persist = true) {
    this.openPrefs = { ...this.openPrefs, [s]: open };
    if (persist) try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(this.openPrefs)); } catch { /* storage unavailable */ }
    if (s === "history" && open && !this.historyLoaded) void this.loadHistory();
  }
  private async loadHistory() {
    const guid = this.guid;
    const h = await api.history(guid).catch(() => ({ history: [] }));
    if (guid !== this.guid) return;
    this.history = h.history;
    this.historyLoaded = true;
  }
  /** Opens a section and scrolls to it. */
  private async reveal(s: Section) {
    if (!this.isOpen(s)) this.setOpen(s, true);
    await this.updateComplete;
    this.querySelector(`#sec-${s}`)?.scrollIntoView({ block: "start" });
  }
  /** A collapsible section; actions stay in the heading so they work while closed. */
  private section(s: Section, body: () => unknown, actions: unknown = nothing) {
    const open = this.isOpen(s);
    const count = this.sectionCount(s);
    return html`<section class="section ${open ? "" : "collapsed"}" id=${"sec-" + s}><h3>
      <button class="sec-toggle" data-test=${"toggle-" + s} aria-expanded=${open} @click=${() => this.setOpen(s, !open)}>
        <span class="chev">${open ? "▾" : "▸"}</span>${this.sectionName(s)}${count ? html`<span class="n">${count}</span>` : nothing}</button>
      <span class="actions">${actions}</span></h3>
      ${open ? body() : nothing}</section>`;
  }
  private sectionName(s: string) { return { fields: "Fields", workflows: "Workflows", relationships: "Relationships", comments: "Comments", attachments: "Attachments", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }
  private sectionCount(s: string): string {
    switch (s) {
      case "fields": return String((this.schema?.fields ?? []).length || Object.keys(this.draft?.fields ?? {}).length || "");
      case "relationships": return this.view?.meta.kind === "link" ? "" : String((this.rel?.incoming.length ?? 0) + (this.rel?.outgoing.length ?? 0) || "");
      case "comments": return String(this.comments.length || "");
      case "attachments": return String(this.view?.attachments?.length || "");
      case "history": return this.historyLoaded ? String(this.history.length || "") : "";
      case "overlay": return String(((this.overlay?.chain.length ?? 1) > 1 ? 1 : 0) + (this.overlay?.overlays.length ?? 0) || "");
      default: return "";
    }
  }

  private fieldsSection() {
    const d = this.draft!;
    const fields = (this.schema?.fields ?? []).filter((f) => f.type !== "workflow");
    const known = new Set(fields.map((f) => f.id));
    const extra = Object.keys(d.fields).filter((k) => !known.has(k));
    return this.section("fields", () => html`
      ${!fields.length && !extra.length ? html`<div class="muted small">No fields defined for this type. Add a schema to describe it.</div>` : nothing}
      ${fields.map((f) => { const ov = this.overlayState(f.id); return html`<corestone-field .field=${f} .value=${ov?.state === "inherited" ? ov.baseValue : d.fields[f.id]} .attachments=${this.view?.attachments ?? []} .typeId=${this.view?.meta.type ?? ""} .folder=${this.view?.meta.folder ?? ""}
        .overlay=${ov} @focusin=${this.touched}
        @overlay-unlock=${(e: CustomEvent) => this.setOwnField(e.detail.id, structuredClone(ov?.baseValue))}
        @overlay-revert=${(e: CustomEvent) => this.setOwnField(e.detail.id, undefined)}
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}
        @open-artifact=${(e: CustomEvent) => navigate({ guid: e.detail })}></corestone-field>`; })}
      ${extra.map((k) => html`<corestone-field .field=${undeclaredField(k, d.fields[k])} .value=${d.fields[k]} undeclared
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}></corestone-field>`)}`);
  }

  /** Overlay state of a field the base chain provides a value for; null when the base sets nothing. */
  private overlayState(fieldId: string): OverlayState | null {
    const base = this.baseOverlay;
    if (!base || base.fields[fieldId] === undefined) return null;
    return { from: this.levelLabel(base.origin[fieldId]), state: this.draft!.fields[fieldId] === undefined ? "inherited" : "overridden", baseValue: base.fields[fieldId] };
  }

  /** Overriding copies the base value into this entry; reverting removes the own value again. */
  private setOwnField(id: string, value: unknown) {
    const next = { ...this.draft!.fields };
    if (value === undefined) delete next[id]; else next[id] = value;
    this.draft = { ...this.draft!, fields: next };
    this.touched();
  }

  /** An overlay chain level by HID, then title, then short GUID. */
  private levelLabel(guid: string): string {
    const lvl = this.overlay?.chain.find((l) => l.guid === guid);
    return lvl?.hid || lvl?.title || guid.slice(0, 8);
  }

  private workflowSection() {
    return this.section("workflows", () => html`
      ${this.workflows.map((w) => html`<div class="workflow" data-workflow=${w.id}>
        <span class="name">${w.definition.name || w.id}</span>
        <span class="pill state">${w.state}</span>
        <select data-test=${"transition-" + w.id} @change=${(e: Event) => { const to = (e.target as HTMLSelectElement).value; if (to) this.transition(w.id, to); (e.target as HTMLSelectElement).value = ""; }}>
          <option value="">${w.available.length ? "Transition to…" : "No transitions available"}</option>
          ${w.available.map((t) => html`<option value=${t.id || t.to}>${t.name || t.id || "→ " + t.to}</option>`)}
        </select>
        <button class="btn sm" @click=${() => (this.showDiagram = this.showDiagram === w.id ? null : w.id)}>? diagram</button>
        ${this.showDiagram === w.id ? html`<div class="wf-diagram" style="flex-basis:100%">
          ${w.definition.states.map((s) => html`<span class="wf-state ${s.id === w.state ? "current" : ""}" style=${s.presentation?.color ? `border-color:${s.presentation.color}` : ""}>${s.name || s.id}</span>`)}
          <span class="wf-edge">·</span>
          ${w.definition.transitions.map((t) => html`<span class="wf-edge">${t.from.join("|")} → ${t.to}${t.name ? ` (${t.name})` : ""}</span>`)}
          <span class="muted small">defined in ${w.definition.scope || "/"}</span></div>` : nothing}
      </div>`)}`);
  }

  /** A link's own relation: From → role → To, each endpoint opening that artifact. */
  private linkRelSection() {
    const v = this.view!;
    const end = (guid: string | undefined, s: Summary | null | undefined) => !guid ? html`<span class="muted">—</span>`
      : !s ? html`<span class="muted mono" title="This artifact no longer exists">${guid}</span>`
      : html`<span class="endpoint"><corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span>` : nothing}
        <a href=${"/artifact/" + guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid }); }}>${label(s)}</a></span>`;
    return this.section("relationships", () => html`<div class="links-list"><div class="link-row" data-test="link-relation">
      ${end(v.meta.source, this.endpoints?.source)}
      <span class="arrow">→</span><span class="type">${this.schema?.displayName ?? v.meta.type}</span><span class="arrow">→</span>
      ${end(v.meta.target, this.endpoints?.target)}</div></div>`);
  }

  private relSection() {
    if (this.view?.meta.kind === "link") return this.linkRelSection();
    const rel = this.rel;
    const row = (lv: { link: { type: string; guid: string }; other: { guid: string; title?: string; hid?: string; kind: string; type: string; folder: string } }, dir: "in" | "out") => html`<div class="link-row">
      <span class="type">${lv.link.type}</span><span class="arrow">${dir === "in" ? "←" : "→"}</span>
      <corestone-type-icon .kind=${lv.other.kind as never} .type=${lv.other.type} .folder=${lv.other.folder}></corestone-type-icon>${lv.other.hid ? html`<span class="hid">${lv.other.hid}</span>` : nothing}
      <a href=${"/artifact/" + lv.other.guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: lv.other.guid }); }}>${label(lv.other as never)}</a>
      <span class="grow"></span>
      <button class="btn sm" title="Remove link" aria-label="Remove link" @click=${() => api.remove(lv.link.guid).then(() => { this.reload(true); store.refresh(); }).catch((e) => store.toast(e.message, "error"))}>✕</button></div>`;
    const actions = html`
        ${rel?.allowedAsSource.map((s) => html`<button class="btn sm" @click=${() => this.addLink(true, s.type, s.targetTypes)}>＋ ${s.displayName || s.type} →</button>`)}
        ${rel?.allowedAsTarget.filter((s) => !rel.allowedAsSource.some((x) => x.type === s.type)).map((s) => html`<button class="btn sm" @click=${() => this.addLink(false, s.type, s.sourceTypes)}>← ${s.displayName || s.type}</button>`)}
        ${rel && !rel.allowedAsSource.length && !rel.allowedAsTarget.length ? html`<span class="muted small" data-test="no-link-types">No link type here allows ${this.view?.meta.type ?? "this type"} as an endpoint.</span>` : nothing}`;
    return this.section("relationships", () => html`
      ${!rel || (!rel.incoming.length && !rel.outgoing.length) ? html`<div class="muted small">No links yet.</div>` : html`<div class="links-list">
        ${rel.outgoing.map((l) => row(l as never, "out"))}${rel.incoming.map((l) => row(l as never, "in"))}</div>`}`, actions);
  }

  private commentSection() {
    const byParent = new Map<string, CommentView[]>();
    const known = new Set(this.comments.map((c) => c.meta.guid));
    for (const c of this.comments) {
      let p = String(c.data?.parent ?? "");
      if (p && (!known.has(p) || p === c.meta.guid)) p = ""; // orphaned reply: show at the root
      byParent.set(p, [...(byParent.get(p) ?? []), c]);
    }
    const seen = new Set<string>();
    const render = (parent: string, depth: number): TemplateResult[] => (byParent.get(parent) ?? []).filter((c) => !seen.has(c.meta.guid) && seen.add(c.meta.guid) && depth < 50).map((c) => html`<div class="comment ${depth ? "reply" : ""}" data-comment=${c.meta.guid}>
      <div class="who"><b>${c.meta.author || "anonymous"}</b> · ${fmtTime(c.meta.created)} ${c.data?.type && c.data.type !== "comment" ? html`<span class="pill">${String(c.data.type)}</span>` : nothing}
        ${this.commentType ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); this.replyTo = c.meta.guid; this.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>reply</a>` : nothing}</div>
      <div class="text">${String(c.data?.text ?? "")}</div>
      ${render(c.meta.guid, depth + 1)}</div>`);
    const actions = !this.commentType
      ? html`<span class="muted small" data-test="no-comment-type">No comment type is defined here, so no comments can be added.</span>`
      : html`<button class="btn sm" data-test="comment-add" @click=${async () => { await this.reveal("comments"); this.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>＋ Comment</button>`;
    return this.section("comments", () => html`
      ${!this.comments.length ? html`<div class="muted small">No comments yet.</div>` : render("", 0)}
      ${!this.commentType ? nothing : html`<div class="inline-form">
        <textarea id="comment-text" data-test="comment-text" placeholder=${this.replyTo ? "Reply…" : "Write a comment…"} .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn primary sm" data-test="comment-send" @click=${this.addComment}>Post</button>
          ${this.replyTo ? html`<button class="btn sm" @click=${() => (this.replyTo = null)}>cancel reply</button>` : nothing}
        </div></div>`}`, actions);
  }

  private attachmentSection() {
    const att = this.view?.attachments ?? [];
    return this.section("attachments", () => html`
      ${!att.length ? html`<div class="muted small">Files stored in the artifact's GUID directory appear here.</div>` : nothing}
      ${att.map((a) => html`<div class="attach-row"><a href=${api.fileUrl(this.guid, a.name)} target="_blank" rel="noopener">${a.name}</a><span class="size">${fmtSize(a.size)}</span>
        <button class="btn sm" title="Remove attachment" aria-label="Remove attachment" @click=${() => api.deleteFile(this.guid, a.name).then(() => this.reload(true)).catch((e) => store.toast(e.message, "error"))}>✕</button></div>`)}`,
      html`<label class="btn sm">＋ Upload<input type="file" hidden @change=${this.upload} /></label>`);
  }

  /** This entry with its direct neighbours: the base it overrides and the overlays overriding it. */
  private overlaySection() {
    const ov = this.overlay!;
    const self = ov.chain[ov.chain.length - 1];
    const base = ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
    const sets = (fields: string[]) => html`<small>${fields.length ? "sets " + fields.join(", ") : "sets nothing"}</small>`;
    const node = (guid: string, hid: string | undefined, title: string | undefined, fields: string[]) => html`<div class="node" data-guid=${guid}>
      <a href=${"/artifact/" + guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid }); }}>${hid ? html`<span class="hid">${hid}</span> ` : nothing}${title || (hid ? "" : guid.slice(0, 8))}</a>
      ${sets(fields)}</div>`;
    const empty = !base && !ov.overlays.length;
    return this.section("overlay", () => empty ? html`<div class="muted small">This entry is no overlay and has no overlays.</div>` : html`
      <div class="chain">
        ${base ? html`<div class="col">${node(base.guid, base.hid, base.title, base.fields)}</div><span class="arrow">→ overrides</span>` : nothing}
        <div class="col"><div class="node self"><b>this entry</b>${sets(self?.fields ?? [])}</div></div>
        ${ov.overlays.length ? html`<span class="arrow">→ overrides</span>
          <div class="col" data-test="overlays">${ov.overlays.map((o) => node(o.guid, o.hid, o.title, Object.keys(o.fields ?? {})))}</div>` : nothing}
      </div>
      ${base ? html`<dl class="kv" style="margin-top:10px"><dt>Effective fields</dt><dd>${Object.entries(ov.fields).map(([k, v]) => html`<div><b>${k}</b>: ${typeof v === "object" ? JSON.stringify(v) : String(v)} <span class="muted small">from ${ov.origin[k] === this.guid ? "this entry" : this.levelLabel(ov.origin[k])}</span></div>`)}</dd></dl>` : nothing}`,
      html`<button class="btn sm" data-test="create-overlay" @click=${this.createOverlay}>＋ Create overlay</button>`);
  }


  private historySection() {
    return this.section("history", () => !this.historyLoaded ? html`<div class="muted small">Loading…</div>` : html`
      ${this.history.map((h) => html`<div class="history-row"><span class="when" title=${h.time}>${fmtTime(h.time)}</span><span>${h.subject}${h.trailers?.["Corestone-Op"] ? html` <span class="pill">${h.trailers["Corestone-Op"]}</span>` : nothing}</span><span class="mono muted">${h.sha.slice(0, 8)}</span></div>`)}
      ${!this.history.length ? html`<div class="muted small">No history yet.</div>` : nothing}`);
  }

  /** Every read-only property not shown elsewhere, plus extra stored properties. */
  private metadataSection() {
    const v = this.view!;
    const d = { ...(v.data as Record<string, unknown>) };
    for (const k of ["guid", "kind", "type", "title", "hid", "fields", "workflows", "content"]) delete d[k];
    return this.section("metadata", () => html`
      <dl class="kv">
        <dt>Type</dt><dd>${this.schema?.displayName ?? v.meta.type} <span class="muted">(${v.meta.type}${this.schema ? "" : ", no schema"})</span></dd>
        <dt>Kind</dt><dd>${v.meta.kind}</dd>
        <dt>Folder</dt><dd><a href=${"/folder/" + v.meta.folder} @click=${(e: Event) => { e.preventDefault(); navigate({ folder: v.meta.folder, guid: null }); }}>${v.meta.folder || "/"}</a></dd>
        <dt>GUID</dt><dd class="mono">${v.meta.guid}</dd>
        <dt>ETag</dt><dd class="mono">${v.etag.slice(0, 12)}</dd>
        <dt>Created</dt><dd>${fmtTime(v.meta.createdAt)}</dd>
        <dt>Modified</dt><dd>${fmtTime(v.meta.modifiedAt)}</dd>
        ${this.schema?.sources?.length ? html`<dt>Schema from</dt><dd>${this.schema.sources.map((s) => s || "/").join(" → ")}</dd>` : nothing}
        <dt>Path</dt><dd class="mono">${v.meta.path}</dd>
      </dl>
      <h4 class="small muted" style="margin-top:10px">Additional properties</h4>
      ${Object.keys(d).length ? html`<pre class="json">${JSON.stringify(d, null, 2)}</pre>` : html`<div class="muted small">No extra properties. Tools may add their own; they are preserved on save.</div>`}`);
  }
}
