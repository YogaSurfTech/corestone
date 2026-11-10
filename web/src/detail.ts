import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, ApiError } from "./api";
import { clearLeaveGuard, navigate, setLeaveGuard, type LeaveGuard } from "./router";
import { store, type State } from "./store";
import type { Attachment, CommentView, LogEntry, OverlayView, Relationships, Schema, Summary, View, WorkflowEval } from "./types";
import { announceEdit } from "./ws";
import { commentTypeOf, deepEqual, fmtSize, fmtTime, label, undeclaredField } from "./util";
import "./type-icon";
import "./table";
import type { TableColumn } from "./table";
import "./fields";
import { OVERLAY_HELP, type OverlayState } from "./fields";
import type { PickerAction } from "./dialogs";

// Entry detail view (design guide §7.5): one scrollable page with every
// section the effective schema implies, quick links to sections, and an
// optimistic-concurrency save (ETag / If-Match).

const SECTIONS = ["comment", "fields", "workflows", "relationships", "comments", "overlay", "attachments", "documents", "history", "metadata"] as const;
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
  /** For a comment: what it is on; a link subject comes with its endpoints and role name. */
  @state() private subject: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string } | null = null;
  /** The comment thread shown here; for a comment, the whole thread of its subject. */
  @state() private comments: CommentView[] = [];
  @state() private overlay: OverlayView | null = null;
  @state() private documents: Summary[] = [];
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
  /** A base change shown for review: the new base (null removes it) and that base's effective fields. */
  @state() private baseChange: { to: Summary | null; next: OverlayView | null; keep: boolean } | null = null;
  /** A new base being set up from fields this entry sets itself: its title and the fields that move. */
  @state() private underlay: { title: string; fields: Set<string> } | null = null;
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
    if (!soft) { this.loading = true; this.view = null; this.draft = null; this.schema = null; this.overlay = null; this.baseOverlay = null; this.documents = []; this.rel = null; this.endpoints = null; this.subject = null; this.comments = []; this.history = []; this.historyLoaded = false; this.workflows = []; this.actionsOpen = false; this.baseChange = null; this.underlay = null; }
    this.error = "";
    try {
      const view = await api.get(guid);
      if (stale()) return;
      const isLink = view.meta.kind === "link";
      const isComment = view.meta.kind === "comment";
      const endpoint = (g?: string) => g ? api.get(g).then((e) => e.meta).catch(() => null) : Promise.resolve(null);
      const subjectOf = async (g?: string) => {
        const meta = await endpoint(g);
        if (!meta || meta.kind !== "link") return meta ? { meta } : null;
        const [source, target, role] = await Promise.all([endpoint(meta.source), endpoint(meta.target),
          api.schemaOf(meta.guid).then((s) => s.schema?.displayName).catch(() => undefined)]);
        return { meta, source, target, role };
      };
      const [schema, wf, rel, endpoints, subject, comments, history, overlay, baseOverlay, documents, types] = await Promise.all([
        api.schemaOf(guid).catch(() => ({ schema: null })),
        api.workflows(guid).catch(() => ({ workflows: [] })),
        isLink || isComment ? Promise.resolve(null) : api.relationships(guid).catch(() => null),
        isLink ? Promise.all([endpoint(view.meta.source), endpoint(view.meta.target)]) : Promise.resolve(null),
        isComment ? subjectOf(view.meta.subject) : Promise.resolve(null),
        // Replies share the root subject, so a comment shows the thread it belongs to.
        api.comments(isComment ? view.meta.subject ?? guid : guid).catch(() => ({ comments: [] })),
        // History is only fetched while its section is open.
        this.isOpen("history") ? api.history(guid).catch(() => ({ history: [] })) : Promise.resolve(null),
        view.meta.kind === "entry" ? api.overlay(guid).catch(() => null) : Promise.resolve(null),
        view.meta.kind === "entry" && view.meta.base ? api.overlay(view.meta.base).catch(() => null) : Promise.resolve(null),
        view.meta.kind === "entry" ? api.documents(guid).catch(() => ({ documents: [] })) : Promise.resolve({ documents: [] }),
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
      this.subject = subject;
      this.comments = comments.comments;
      this.history = history?.history ?? [];
      this.historyLoaded = !!history;
      this.overlay = overlay;
      this.baseOverlay = baseOverlay;
      this.documents = documents.documents;
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
    // A comment's subject is always the root artifact; here, replying defaults to the comment shown.
    const onComment = this.view?.meta.kind === "comment";
    const subject = onComment ? this.view?.meta.subject ?? this.guid : this.guid;
    const parent = this.replyTo ?? (onComment ? this.guid : undefined);
    try {
      await api.create("comments", { subject, parent, type: this.commentType, text: this.commentText, author: this.s.user });
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
      comment: () => this.ownCommentSection(),
      fields: () => this.fieldsSection(),
      workflows: () => this.workflowSection(),
      relationships: () => this.relSection(),
      comments: () => this.commentSection(),
      overlay: () => this.overlaySection(),
      attachments: () => this.attachmentSection(),
      documents: () => this.documentSection(),
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
        ${v.meta.kind === "comment" ? html`<h2 class="dh-static" data-test="comment-heading">${typeName} by ${v.meta.author || "anonymous"}</h2>` : html`
        <input class="hid-input ${d.hid ? "" : "empty"}" type="text" data-test="hid" aria-label="HID" .value=${d.hid} placeholder=${hidHint}
          size=${Math.max((d.hid || hidHint).length, 3)}
          title="Human-readable identifier; must be unique. Previous HIDs stay resolvable through history." @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, hid: (e.target as HTMLInputElement).value }; }} />
        ${d.hid ? html`<span class="dash">–</span>` : nothing}
        <h2><input class="title-input" type="text" data-test="title" aria-label="Title" .value=${d.title} placeholder=${"untitled " + v.meta.kind} @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, title: (e.target as HTMLInputElement).value }; }} /></h2>`}
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

  /** A link is about the relation it expresses, so its endpoints come before its fields. Comments cannot be linked. */
  private sectionOrder(): Section[] {
    const order: readonly Section[] = this.view?.meta.kind === "link"
      ? ["relationships", "fields", ...SECTIONS.filter((s) => s !== "relationships" && s !== "fields")]
      : SECTIONS;
    return order.filter((s) => this.hasSection(s));
  }

  private hasSection(s: string): boolean {
    const k = this.view?.meta.kind;
    switch (s) {
      case "comment": return k === "comment";
      case "relationships": return k !== "comment";
      case "workflows": return this.workflows.length > 0;
      case "attachments": return k === "entry" || k === "document";
      case "documents": return k === "entry";
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
      case "documents": return !this.documents.length;
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
  private sectionName(s: string) { return { comment: "Comment", fields: "Fields", workflows: "Workflows", relationships: "Relationships", comments: "Comments", attachments: "Attachments", documents: "Documents", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }
  private sectionCount(s: string): string {
    switch (s) {
      case "fields": return String((this.schema?.fields ?? []).length || Object.keys(this.draft?.fields ?? {}).length || "");
      case "relationships": return this.view?.meta.kind === "link" ? "" : String((this.rel?.incoming.length ?? 0) + (this.rel?.outgoing.length ?? 0) || "");
      case "comments": return String(this.comments.length || "");
      case "attachments": return String(this.view?.attachments?.length || "");
      case "documents": return String(this.documents.length || "");
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

  /** An artifact reference: type icon, HID and title, opening it; a missing one shows its GUID. */
  private artifactRef(guid: string | undefined, s: Summary | null | undefined) {
    return !guid ? html`<span class="muted">—</span>`
      : !s ? html`<span class="muted mono" title="This artifact no longer exists">${guid}</span>`
      : html`<span class="endpoint"><corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span>` : nothing}
        <a href=${"/artifact/" + guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid, tab: "" }); }}>${label(s)}</a></span>`;
  }

  /** An artifact cell opening it; the row click does the same. */
  private openCell(s: Summary, tab?: string) {
    return html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span> ` : nothing}<a href=${"/artifact/" + s.guid} @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); navigate(tab === undefined ? { guid: s.guid } : { guid: s.guid, tab }); }}>${label(s)}</a>`;
  }

  /** A link's own relation: From → role → To, each endpoint opening that artifact. */
  private linkRelSection() {
    const v = this.view!;
    return this.section("relationships", () => html`<div class="links-list"><div class="link-row" data-test="link-relation">
      ${this.artifactRef(v.meta.source, this.endpoints?.source)}
      <span class="arrow">→</span><span class="type">${this.schema?.displayName ?? v.meta.type}</span><span class="arrow">→</span>
      ${this.artifactRef(v.meta.target, this.endpoints?.target)}</div></div>`);
  }

  /** A comment itself: what it is on (and whom it answers), then its author, time and text. */
  private ownCommentSection() {
    const v = this.view!;
    const sub = this.subject;
    const parent = String(v.data.parent ?? "");
    const answered = parent ? this.comments.find((c) => c.meta.guid === parent) : undefined;
    const on = !sub ? this.artifactRef(v.meta.subject, null)
      : sub.meta.kind !== "link" ? this.artifactRef(sub.meta.guid, sub.meta)
      : html`${this.artifactRef(sub.meta.source, sub.source)}
        <a class="muted" href=${"/artifact/" + sub.meta.guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: sub.meta.guid, tab: "" }); }}>→ ${sub.role ?? sub.meta.type} →</a>
        ${this.artifactRef(sub.meta.target, sub.target)}`;
    return this.section("comment", () => html`
      <div class="comment-on" data-test="comment-subject">
        <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${this.schema}></corestone-type-icon>
        <span class="muted">on</span><div class="link-row">${on}</div></div>
      ${parent ? html`<div class="small muted" data-test="comment-parent" style="margin-top:6px">Reply to
        <a href=${"/artifact/" + parent} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: parent, tab: "" }); }}>${answered ? `${answered.meta.author || "anonymous"}'s comment` : "a comment"}</a></div>` : nothing}
      <div class="comment" data-test="comment-own">
        <div class="who"><b>${v.meta.author || "anonymous"}</b> · ${fmtTime(v.meta.created)}</div>
        <div class="text">${String(v.data.text ?? "")}</div>
      </div>`);
  }

  private relSection() {
    if (this.view?.meta.kind === "link") return this.linkRelSection();
    const rel = this.rel;
    type Row = { link: Summary; other: Summary; role?: string; dir: "in" | "out" };
    const rows: Row[] = rel ? [...rel.outgoing.map((l) => ({ ...l, dir: "out" as const })), ...rel.incoming.map((l) => ({ ...l, dir: "in" as const }))] : [];
    const columns: TableColumn<Row>[] = [
      { id: "role", name: "Role", width: 160, value: (r) => r.role || r.link.type, render: (r) => html`<span class="type" title=${r.link.type}>${r.role || r.link.type}</span>` },
      { id: "dir", name: "Dir", width: 72, value: (r) => r.dir, render: (r) => html`<span class="arrow ${r.dir}" title=${r.dir === "in" ? "incoming: the other artifact links to this one" : "outgoing: this artifact links to the other"}>${r.dir === "in" ? "←" : "→"}</span>` },
      { id: "artifact", name: "Artifact", value: (r) => r.other.hid || label(r.other), render: (r) => this.openCell(r.other) },
      { id: "folder", name: "Folder", width: 150, value: (r) => r.other.folder, render: (r) => html`<span class="muted small">${r.other.folder || "/"}</span>` },
      { id: "remove", name: "", width: 60, sortable: false, render: (r) => html`<button class="btn sm" title="Remove link" aria-label="Remove link" @click=${(e: Event) => { e.stopPropagation(); api.remove(r.link.guid).then(() => { this.reload(true); store.refresh(); }).catch((err) => store.toast(err.message, "error")); }}>✕</button>` },
    ];
    const actions = html`
        ${rel?.allowedAsSource.map((s) => html`<button class="btn sm" @click=${() => this.addLink(true, s.type, s.targetTypes)}>＋ ${s.displayName || s.type} →</button>`)}
        ${rel?.allowedAsTarget.filter((s) => !rel.allowedAsSource.some((x) => x.type === s.type)).map((s) => html`<button class="btn sm" @click=${() => this.addLink(false, s.type, s.sourceTypes)}>＋ ${s.reverseName || s.displayName || s.type} ←</button>`)}
        ${rel && !rel.allowedAsSource.length && !rel.allowedAsTarget.length ? html`<span class="muted small" data-test="no-link-types">No link type here allows ${this.view?.meta.type ?? "this type"} as an endpoint.</span>` : nothing}`;
    return this.section("relationships", () => html`
      ${!rows.length ? html`<div class="muted small">No links yet.</div>` : html`<corestone-table class="detail-table" .items=${rows} .columns=${columns}
        .rowKey=${(r: Row) => r.link.guid} .rowClass=${() => "link-row open-row"} @row-click=${(e: CustomEvent<Row>) => navigate({ guid: e.detail.other.guid })}></corestone-table>`}`, actions);
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
    const render = (parent: string, depth: number): TemplateResult[] => (byParent.get(parent) ?? []).filter((c) => !seen.has(c.meta.guid) && seen.add(c.meta.guid) && depth < 50).map((c) => html`<div class="comment ${depth ? "reply" : ""} ${c.meta.guid === this.guid ? "current" : ""}" data-comment=${c.meta.guid}>
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
        <textarea id="comment-text" data-test="comment-text" placeholder=${this.replyTo || this.view?.meta.kind === "comment" ? "Reply…" : "Write a comment…"} .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn primary sm" data-test="comment-send" @click=${this.addComment}>Post</button>
          ${this.replyTo ? html`<button class="btn sm" @click=${() => (this.replyTo = null)}>cancel reply</button>` : nothing}
        </div></div>`}`, actions);
  }

  private attachmentSection() {
    const att = this.view?.attachments ?? [];
    return this.section("attachments", () => html`
      ${!att.length ? html`<div class="muted small">Files stored in the artifact's GUID directory appear here.</div>` : nothing}
      ${!att.length ? nothing : html`<corestone-table class="detail-table" .items=${att} .rowKey=${(a: Attachment) => a.name} .rowClass=${() => "attach-row"} .columns=${[
        { id: "name", name: "Name", value: (a) => a.name, render: (a) => html`<a href=${api.fileUrl(this.guid, a.name)} target="_blank" rel="noopener">${a.name}</a>` },
        { id: "size", name: "Size", width: 100, value: (a) => a.size, render: (a) => html`<span class="size">${fmtSize(a.size)}</span>` },
        { id: "remove", name: "", width: 60, sortable: false, render: (a) => html`<button class="btn sm" title="Remove attachment" aria-label="Remove attachment" @click=${() => api.deleteFile(this.guid, a.name).then(() => this.reload(true)).catch((e) => store.toast(e.message, "error"))}>✕</button>` },
      ] satisfies TableColumn<Attachment>[]}></corestone-table>`}`,
      html`<label class="btn sm">＋ Upload<input type="file" hidden @change=${this.upload} /></label>`);
  }

  /** The documents embedding this entry; each opens scrolled to the entry's block. */
  private documentSection() {
    return this.section("documents", () => !this.documents.length
      ? html`<div class="muted small">This entry is not used in any document.</div>`
      : html`<corestone-table class="detail-table" data-test="documents" .items=${this.documents} .rowClass=${() => "open-row"} .columns=${[
        { id: "document", name: "Document", value: (d) => d.hid || label(d), render: (d) => this.openCell(d, "entry:" + this.guid) },
        { id: "type", name: "Type", width: 140, value: (d) => d.type, render: (d) => html`<span class="muted small">${d.type}</span>` },
        { id: "folder", name: "Folder", width: 150, value: (d) => d.folder, render: (d) => html`<span class="muted small">${d.folder || "/"}</span>` },
      ] satisfies TableColumn<Summary>[]} @row-click=${(e: CustomEvent<Summary>) => navigate({ guid: e.detail.guid, tab: "entry:" + this.guid })}></corestone-table>`);
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
    return this.section("overlay", () => html`${this.baseChangePreview()}${this.underlayForm()}${empty ? html`<div class="muted small">This entry is no overlay and has no overlays.</div>` : html`
      <div class="chain">
        ${base ? html`<div class="col">${node(base.guid, base.hid, base.title, base.fields)}</div><span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>` : nothing}
        <div class="col"><div class="node self"><b>this entry</b>${sets(self?.fields ?? [])}</div></div>
        ${ov.overlays.length ? html`<span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>
          <div class="col" data-test="overlays">${ov.overlays.map((o) => node(o.guid, o.hid, o.title, Object.keys(o.fields ?? {})))}</div>` : nothing}
      </div>
      ${base ? html`<dl class="kv" style="margin-top:10px"><dt>Effective fields</dt><dd>${Object.entries(ov.fields).map(([k, v]) => html`<div><b>${k}</b>: ${typeof v === "object" ? JSON.stringify(v) : String(v)} <span class="muted small">from ${ov.origin[k] === this.guid ? "this entry" : this.levelLabel(ov.origin[k])}</span></div>`)}</dd></dl>` : nothing}`}`,
      html`${this.baseActions(!!base)}<button class="btn sm" data-test="create-overlay" @click=${this.createOverlay}>＋ Create overlay</button>`);
  }

  /** One button for the base: the picker chooses a new one or, if there is one, removes it. */
  private baseActions(hasBase: boolean) {
    const blocked = this.dirty;
    return html`<button class="btn sm" data-test="change-base" ?disabled=${blocked}
      title=${blocked ? "Save or discard your changes first" : hasBase ? "Choose another base or remove it" : "Inherit the fields this entry does not set from another entry"}
      @click=${this.pickBase}>${hasBase ? "Change base…" : "Inherit from…"}</button>`;
  }

  /** Picks a new base of the same type, or removes the current one; nothing changes until the preview is applied. */
  private pickBase = () => {
    const v = this.view!;
    const base = v.meta.base;
    const actions: PickerAction[] = [{ label: "Create new base…", test: "create-base", tone: "add", run: this.startUnderlay }];
    if (base) actions.push({ label: `Remove base ${this.levelLabel(base)}`, test: "remove-base", tone: "remove", run: () => { void this.previewBase(null); } });
    store.set({ picker: { kind: "pick", title: base ? "Change or remove the base" : "Choose or create a base", types: [v.meta.type], kinds: ["entry"], exclude: this.guid,
      actions, onPick: (s: Summary) => { void this.previewBase(s); } } });
  };

  /** The fields this entry sets itself, which can move into a new base. */
  private ownFields(): Record<string, unknown> {
    return ((this.view?.data as Record<string, unknown> | undefined)?.fields ?? {}) as Record<string, unknown>;
  }

  /** Without a base of its own, a new base must contain the required fields. */
  private mustMove(id: string): boolean {
    return !this.view?.meta.base && !!this.schema?.fields?.find((f) => f.id === id)?.required;
  }

  private startUnderlay = () => {
    this.baseChange = null;
    this.underlay = { title: this.view?.meta.title ?? "", fields: new Set(Object.keys(this.ownFields())) };
    void this.reveal("overlay");
  };

  private toggleUnderlayField(id: string, on: boolean) {
    const fields = new Set(this.underlay!.fields);
    if (on) fields.add(id); else fields.delete(id);
    this.underlay = { ...this.underlay!, fields };
  }

  /** The new base: title, the fields that move, and the resulting chain. Effective values stay. */
  private underlayForm() {
    const u = this.underlay;
    if (!u || !this.view) return nothing;
    const own = this.ownFields();
    const ids = Object.keys(own);
    const base = this.view.meta.base;
    const name = (id: string) => this.schema?.fields?.find((f) => f.id === id)?.name || id;
    const show = (v: unknown) => typeof v === "object" ? JSON.stringify(v) : String(v);
    return html`<div class="base-change" data-test="underlay">
      <div class="title">Create a new base for this entry</div>
      <label class="underlay-title small">Title of the new base
        <input type="text" data-test="underlay-title" .value=${u.title} @input=${(e: Event) => { this.underlay = { ...u, title: (e.target as HTMLInputElement).value }; }}></label>
      ${ids.length ? html`<div class="small">Fields that move into the new base:</div>
        <div class="underlay-fields">${ids.map((id) => html`<label class="small" data-field=${id}>
          <input type="checkbox" .checked=${u.fields.has(id) || this.mustMove(id)} ?disabled=${this.mustMove(id)}
            @change=${(e: Event) => this.toggleUnderlayField(id, (e.target as HTMLInputElement).checked)}>
          <span><b>${name(id)}</b>: ${show(own[id])}${this.mustMove(id) ? html` <span class="muted">(required: a base without a base of its own must set it)</span>` : nothing}</span></label>`)}</div>`
        : html`<div class="muted small">This entry sets no fields itself; the new base starts empty.</div>`}
      <div class="chain small" data-test="underlay-chain">${base ? html`<span>${this.levelLabel(base)}</span><span class="arrow">→ overlaid by</span>` : nothing}
        <span><b>new base</b></span><span class="arrow">→ overlaid by</span><span>this entry</span></div>
      <div class="muted small">The moved values are inherited from the new base, so this entry's effective values stay the same.${base ? ` The new base inherits from ${this.levelLabel(base)}.` : ""}</div>
      <div class="buttons">
        <button class="btn sm" data-test="cancel-underlay" @click=${() => { this.underlay = null; }}>Cancel</button>
        <button class="btn sm primary" data-test="apply-underlay" ?disabled=${this.busy} @click=${this.applyUnderlay}>Create base</button>
      </div></div>`;
  }

  /** One commit: the new base with the moved fields, and this entry inheriting them. */
  private applyUnderlay = async () => {
    const u = this.underlay, v = this.view;
    if (!u || !v) return;
    const fields = Object.keys(this.ownFields()).filter((id) => u.fields.has(id) || this.mustMove(id));
    this.busy = true;
    try {
      const res = await api.underlay(this.guid, u.title.trim(), fields, v.etag);
      store.toast(`New base ${label(res.base.meta)} created`, "success");
      this.underlay = null;
      this.reload(true);
      store.refresh();
    } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
    finally { this.busy = false; }
  };

  private async previewBase(to: Summary | null) {
    try {
      const next = to ? await api.overlay(to.guid) : null;
      this.underlay = null;
      this.baseChange = { to, next, keep: true };
      void this.reveal("overlay");
    } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
  }

  /** Effective values before and after the base change. Values set in this entry stay; on
   *  removal with "keep", inherited values are copied into the entry. */
  private baseChangeRows() {
    const c = this.baseChange!, ov = this.overlay!;
    const own = ((this.view!.data as Record<string, unknown>).fields ?? {}) as Record<string, unknown>;
    const after: Record<string, unknown> = {}, afterFrom: Record<string, string> = {};
    if (c.next) for (const [k, v] of Object.entries(c.next.fields)) { after[k] = v; afterFrom[k] = c.next.origin[k]; }
    if (!c.to && c.keep) for (const [k, v] of Object.entries(ov.fields)) { after[k] = v; afterFrom[k] = this.guid; }
    for (const [k, v] of Object.entries(own)) { after[k] = v; afterFrom[k] = this.guid; }
    const levels = [...ov.chain, ...(c.next?.chain ?? [])];
    const from = (g: string | undefined) => !g ? "" : g === this.guid ? "this entry" : ((l) => l?.hid || l?.title || g.slice(0, 8))(levels.find((l) => l.guid === g));
    const name = (id: string) => this.schema?.fields?.find((f) => f.id === id)?.name || id;
    const ids = [...new Set([...Object.keys(ov.fields), ...Object.keys(after)])];
    return ids.map((id) => ({ id, name: name(id), before: ov.fields[id], beforeFrom: from(ov.origin[id]), after: after[id], afterFrom: from(afterFrom[id]),
      changed: !deepEqual(ov.fields[id], after[id]) }));
  }

  private baseChangePreview() {
    const c = this.baseChange;
    if (!c || !this.view || !this.overlay) return nothing;
    const cycle = !!c.next?.chain.some((l) => l.guid === this.guid);
    const same = !!c.to && c.to.guid === this.view.meta.base;
    const rows = cycle || same ? [] : this.baseChangeRows();
    const changed = rows.filter((r) => r.changed);
    const ownCount = Object.keys(((this.view.data as Record<string, unknown>).fields ?? {}) as object).length;
    const overlays = this.overlay.overlays.length;
    const show = (v: unknown) => v === undefined || v === "" ? html`<span class="muted">—</span>` : typeof v === "object" ? JSON.stringify(v) : String(v);
    return html`<div class="base-change" data-test="base-change">
      <div class="title">${c.to ? html`Change the base to <b>${label(c.to)}</b>` : html`Remove the base <b>${this.levelLabel(this.view.meta.base ?? "")}</b>`}</div>
      ${cycle ? html`<div class="notice error">${label(c.to)} inherits from this entry, so it cannot become its base (cycle).</div>`
        : same ? html`<div class="muted small">This already is the base; nothing changes.</div>` : html`
        ${!c.to ? html`<label class="keep small"><input type="checkbox" data-test="keep-values" .checked=${c.keep}
          @change=${(e: Event) => { this.baseChange = { ...c, keep: (e.target as HTMLInputElement).checked }; }}> Keep the inherited values in this entry</label>` : nothing}
        ${changed.length ? html`<table class="base-diff" data-test="base-diff"><thead><tr><th>Field</th><th>Now</th><th>After the change</th></tr></thead>
          <tbody>${changed.map((r) => html`<tr data-field=${r.id}><td>${r.name}</td>
            <td>${show(r.before)} ${r.beforeFrom ? html`<small class="muted">from ${r.beforeFrom}</small>` : nothing}</td>
            <td>${show(r.after)} ${r.afterFrom ? html`<small class="muted">from ${r.afterFrom}</small>` : nothing}</td></tr>`)}</tbody></table>`
          : html`<div class="muted small" data-test="base-no-change">No effective value changes.</div>`}
        <div class="muted small">${ownCount === 1 ? "1 value set in this entry stays" : `${ownCount} values set in this entry stay`} as ${ownCount === 1 ? "it is" : "they are"}.${
          overlays ? ` ${overlays === 1 ? "Its overlay inherits" : `Its ${overlays} overlays inherit`} the new values too.` : ""}</div>`}
      <div class="buttons">
        <button class="btn sm" data-test="cancel-base" @click=${() => { this.baseChange = null; }}>Cancel</button>
        <button class="btn sm primary" data-test="apply-base" ?disabled=${cycle || same || this.busy} @click=${this.applyBase}>${c.to ? "Change base" : "Remove base"}</button>
      </div></div>`;
  }

  /** One update: the new base, plus on removal with "keep" the inherited values. */
  private applyBase = async () => {
    const c = this.baseChange, v = this.view, ov = this.overlay;
    if (!c || !v || !ov) return;
    const patch: Record<string, unknown> = { base: c.to?.guid ?? "" };
    if (!c.to && c.keep) {
      const copy = Object.fromEntries(Object.entries(ov.fields).filter(([k]) => ov.origin[k] !== this.guid));
      if (Object.keys(copy).length) patch.fields = copy;
    }
    this.busy = true;
    try {
      await api.update(this.guid, patch, v.etag);
      store.toast(c.to ? `Base changed to ${label(c.to)}` : "Base removed", "success");
      this.baseChange = null;
      this.reload(true);
      store.refresh();
    } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
    finally { this.busy = false; }
  };


  private historySection() {
    return this.section("history", () => !this.historyLoaded ? html`<div class="muted small">Loading…</div>` : html`
      ${!this.history.length ? nothing : html`<corestone-table class="detail-table" .items=${this.history} .rowKey=${(h: LogEntry) => h.sha} .rowClass=${() => "history-row"} .columns=${[
        { id: "when", name: "When", width: 150, value: (h) => h.time, render: (h) => html`<span class="when" title=${h.time}>${fmtTime(h.time)}</span>` },
        { id: "change", name: "Change", value: (h) => h.subject, render: (h) => html`${h.subject}${h.trailers?.["Corestone-Op"] ? html` <span class="pill">${h.trailers["Corestone-Op"]}</span>` : nothing}` },
        { id: "author", name: "Author", width: 130, value: (h) => h.author, render: (h) => html`<span class="muted small">${h.author}</span>` },
        { id: "commit", name: "Commit", width: 100, value: (h) => h.sha, render: (h) => html`<span class="mono muted">${h.sha.slice(0, 8)}</span>` },
      ] satisfies TableColumn<LogEntry>[]}></corestone-table>`}
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
