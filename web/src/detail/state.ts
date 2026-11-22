import { type ReactiveControllerHost } from "lit";
import { deepEqual, errorText, prefs, Resizer } from "@corestone/ui";
import type { EntryFiles } from "@corestone/editor";
import { api, ApiError, type SaveChanges, type SaveConflict } from "../api";
import { navigate } from "../router";
import { EditSession, fieldsPatch } from "../artifact-state";
import { createFiles } from "../files";
import { pickArtifact, store, type State, toastError } from "../store";
import type { CommentView, HistoryEntry, OverlayView, Relationships, VersionView, View, WorkflowEval } from "../types";
import type { Schema, Summary } from "../components/types";
import { commentTypeOf, hidLabel, label } from "../components/artifact";
import { type OverlayState } from "../components/fields";
import { conflictDialog } from "./conflict";

// The entry view's state, without any rendering: what was loaded, the draft
// and the changes that wait for Save, saving, and which sections are open.
// The sections (the other files here) show it and call its methods.

/** Changes besides fields that wait for Save, published together in one commit. */
export interface Pending {
  /** Workflow field id → the transition chosen and the state it leads to. */
  transitions: Record<string, { transition: string; state: string }>;
  links: { type: string; source: string; target: string; other: Summary; role: string; dir: "in" | "out" }[];
  removedLinks: string[];
  comments: { type: string | null; text: string; parent?: string }[];
  files: File[];
  removedFiles: string[];
}
export const noPending = (): Pending => ({ transitions: {}, links: [], removedLinks: [], comments: [], files: [], removedFiles: [] });

export const SECTIONS = ["comment", "fields", "relationships", "comments", "overlay", "attachments", "documents", "history", "metadata"] as const;
export type Section = (typeof SECTIONS)[number];
export const OPEN_KEY = "corestone.detail.sections";

export function readOpenPrefs(): Record<string, boolean> {
  return prefs.json<Record<string, boolean>>(OPEN_KEY, {}, { session: true });
}

/** What the state needs of the element that shows it. */
export interface DetailHost extends ReactiveControllerHost, HTMLElement {
  guid: string;
  version: string;
  at: string;
  /** Closes the menus the element has open. */
  closeMenus(): void;
}

/** Makes every assignment to one of the object's fields ask for a new rendering. */
function observe(target: object, changed: () => void) {
  const fields = target as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    let value = fields[key];
    if (typeof value === "function") continue;
    Object.defineProperty(fields, key, { get: () => value, set: (v) => { value = v; changed(); }, enumerable: true, configurable: true });
  }
}

export class DetailState {
  constructor(readonly host: DetailHost) {
    observe(this, () => host.requestUpdate());
  }
  get guid(): string { return this.host.guid; }
  get version(): string { return this.host.version; }
  get at(): string { return this.host.at; }
  get s(): State { return store.state; }

  /** The loaded historic version; null while showing the current state. */
  historic: VersionView | null = null;
  view: View | null = null;

  schema: Schema | null = null;
  workflows: WorkflowEval[] = [];

  rel: Relationships | null = null;
  /** For a link: the artifacts it connects (null when an endpoint no longer exists). */
  endpoints: { source: Summary | null; target: Summary | null } | null = null;

  /** For a comment: what it is on; a link subject comes with its endpoints and role name. */
  subject: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string } | null = null;
  /** The comment thread shown here; for a comment, the whole thread of its subject. */
  comments: CommentView[] = [];

  overlay: OverlayView | null = null;
  documents: Summary[] = [];

  /** The base's effective fields: what this entry shows where it sets nothing itself. */
  baseOverlay: OverlayView | null = null;
  /** The comment type to post with here; null when the folder defines none (no comments then). */
  commentType: string | null = null;

  history: HistoryEntry[] = [];
  /** Older history entries remain to be loaded. */
  historyMore = false;

  draft: { title: string; hid: string; fields: Record<string, unknown> } | null = null;
  pending: Pending = noPending();

  busy = false;
  error = "";

  loading = true;
  replyTo: string | null = null;

  commentText = "";
  showDiagram: string | null = null;

  historyLoaded = false;
  /** A base change shown for review: the new base (null removes it) and that base's effective fields. */
  baseChange: { to: Summary | null; next: OverlayView | null; keep: boolean } | null = null;

  /** A new base being set up from fields this entry sets itself: its title and the fields that move. */
  underlay: { title: string; fields: Set<string> } | null = null;
  /** Sections the user opened or closed; remembered for the browser session. */
  openPrefs: Record<string, boolean> = readOpenPrefs();

  /** Toggles of changed sections while viewing one historic version; not persisted. */
  versionOpen: Record<string, boolean> = {};
  lastTick = -1;

  loadSeq = 0;
  softInFlight = false;

  softPending = false;

  /** The router asks before leaving this artifact with unsaved changes; the others see that it is being edited. */
  session = new EditSession(this.host, () => this.guid, {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => { if (this.view) this.resetDraft(); },
    label: () => (this.view ? hidLabel(this.view.meta) : "This artifact"),
  });

  get dirty(): boolean {
    if (!this.draft || !this.view || this.historic) return false;
    return this.fieldsDirty || this.pendingCount > 0;
  }

  /** The edited title, HID and fields that differ from the stored ones. */
  get edited(): string[] {
    const d = this.view!.data as Record<string, unknown>;
    return [
      ...(this.draft!.title !== (d.title ?? "") ? ["title"] : []),
      ...(this.draft!.hid !== (d.hid ?? "") ? ["HID"] : []),
      ...(!deepEqual(this.draft!.fields, d.fields ?? {}) ? ["fields"] : []),
    ];
  }

  get fieldsDirty(): boolean { return this.edited.length > 0; }

  get pendingCount(): number {
    const p = this.pending;
    return Object.keys(p.transitions).length + p.links.length + p.removedLinks.length + p.comments.length + p.files.length + p.removedFiles.length;
  }

  /** What Save will publish, for the save bar. */
  pendingSummary(): string {
    const p = this.pending;
    const n = (k: number, one: string, many = one + "s") => (k ? [`${k} ${k === 1 ? one : many}`] : []);
    return [
      ...this.edited,
      ...n(Object.keys(p.transitions).length, "transition"),
      ...n(p.links.length, "link added", "links added"),
      ...n(p.removedLinks.length, "link removed", "links removed"),
      ...n(p.comments.length, "comment"),
      ...n(p.files.length, "attachment added", "attachments added"),
      ...n(p.removedFiles.length, "attachment removed", "attachments removed"),
    ].join(", ");
  }

  async reload(soft: boolean) {
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

  async load(soft: boolean, guid: string, stale: () => boolean) {
    if (!soft) { this.loading = true; this.view = null; this.draft = null; this.pending = noPending(); this.schema = null; this.overlay = null; this.baseOverlay = null; this.documents = []; this.rel = null; this.endpoints = null; this.subject = null; this.comments = []; this.history = []; this.historyMore = false; this.historyLoaded = false; this.workflows = []; this.historic = null; this.host.closeMenus(); this.baseChange = null; this.underlay = null; }
    this.error = "";
    try {
      if (this.version) return await this.loadVersion(guid, stale);
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
        this.isOpen("history") ? api.history(guid).catch(() => ({ history: [], more: false })) : Promise.resolve(null),
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
        // Keep the draft and the version it started from: Save merges the
        // edits into the newer version and asks only if both changed the same thing.
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
      this.historyMore = history?.more ?? false;
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
      this.error = errorText(e);
      if (!soft) this.view = null;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  /** A historic version: everything about the artifact comes from that commit, read-only. */
  async loadVersion(guid: string, stale: () => boolean) {
    const v = await api.version(guid, this.version, this.at);
    if (stale()) return;
    const history = this.isOpen("history") ? await api.history(guid).catch(() => ({ history: [], more: false })) : null;
    if (stale()) return;
    this.historic = v;
    this.versionOpen = {};
    this.view = v;
    this.schema = v.schema ?? null;
    this.workflows = v.workflows;
    this.rel = v.meta.kind === "link" || v.meta.kind === "comment" ? null : v.relationships;
    // A link's endpoints and a comment's subject come as they were then.
    this.endpoints = v.endpoints ?? null;
    this.subject = v.subject ?? null;
    this.comments = v.comments;
    this.overlay = v.overlay ? { ...v.overlay, overlays: [] } : null;
    this.baseOverlay = v.baseOverlay ? { ...v.baseOverlay, overlays: [] } : null;
    this.documents = [];
    this.commentType = null;
    this.history = history?.history ?? [];
    this.historyMore = history?.more ?? false;
    this.historyLoaded = !!history;
    this.resetDraft();
  }

  /** Whether the historic version shown changed a stored property (title, fields.<id>, …). */
  changed(key: string) { return !!this.historic?.change?.changed.includes(key); }

  changedClass(key: string) { return this.changed(key) ? "changed" : ""; }

  /** Whether the historic version shown added this link or comment. */
  added(guid: string) { return !!this.historic?.change?.added.includes(guid); }

  /** What the historic version shown changed in a section, as short badges for its heading. */
  sectionChange(s: Section): string[] {
    const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    if (!this.historic) return this.pendingChange(s, plural);
    const c = this.historic.change;
    if (!c) return [];
    const added = (guids: string[]) => guids.filter((g) => c.added.includes(g)).length;
    switch (s) {
      case "fields": return c.changed.some((k) => k.startsWith("fields.")) ? ["changed"] : [];
      case "comment": return this.changed("text") ? ["changed"] : [];
      case "relationships": {
        if (this.view?.meta.kind === "link") return this.changed("source") || this.changed("target") ? ["changed"] : [];
        const n = added([...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].map((r) => r.link.guid));
        return [...(n ? [`${plural(n, "link")} added`] : []), ...(c.removedLinks ? [`${plural(c.removedLinks, "link")} removed`] : [])];
      }
      case "comments": {
        const n = added(this.comments.map((x) => x.meta.guid));
        return [...(n ? [`${plural(n, "comment")} added`] : []), ...(c.removedComments ? [`${plural(c.removedComments, "comment")} removed`] : [])];
      }
      default: return [];
    }
  }

  /** The same badges for what waits for Save. */
  pendingChange(s: Section, plural: (n: number, what: string) => string): string[] {
    const p = this.pending;
    const badges = (n: number, what: string, verb: string) => (n ? [`${plural(n, what)} ${verb}`] : []);
    switch (s) {
      case "fields": return (this.draft && this.view && this.edited.includes("fields")) || Object.keys(p.transitions).length ? ["changed"] : [];
      case "relationships": return [...badges(p.links.length, "link", "added"), ...badges(p.removedLinks.length, "link", "removed")];
      case "comments": return badges(p.comments.length, "comment", "added");
      case "attachments": return [...badges(p.files.length, "attachment", "added"), ...badges(p.removedFiles.length, "attachment", "removed")];
      default: return [];
    }
  }

  resetDraft() {
    const d = this.view!.data as Record<string, unknown>;
    this.draft = { title: String(d.title ?? ""), hid: String(d.hid ?? ""), fields: structuredClone((d.fields as Record<string, unknown>) ?? {}) };
    this.pending = noPending();
    this.session.done();
  }

  /** The entry's files for images and file links in rich text: the stored ones and the ones
   *  waiting for Save (a new one joins the pending attachments, shown from the browser until
   *  it is saved). */
  entryFiles: EntryFiles = createFiles({
    pending: () => ({ files: this.pending.files, removed: this.pending.removedFiles }),
    setPending: (files, removedFiles) => { this.pending = { ...this.pending, files, removedFiles }; },
    stored: () => (this.view?.attachments ?? []).map((a) => a.name),
    url: (name) => {
      const h = this.historic;
      return h ? api.versionFileUrl(this.guid, h.etag, h.commit.sha, name) : api.fileUrl(this.guid, name);
    },
    touched: () => this.touched(),
    added: () => this.setOpen("attachments", true, false), // as an upload there does: what Save will store shows
    inPlace: true,
  });

  touched() {
    if (this.historic) return; // read-only: nobody is editing
    this.session.touch();
  }

  async save(overwrite?: string) {
    if (!this.view || !this.draft || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (this.draft.title !== (d.title ?? "")) patch.title = this.draft.title;
    if (this.draft.hid !== (d.hid ?? "")) patch.hid = this.draft.hid || null;
    const fields = fieldsPatch((d.fields as Record<string, unknown>) ?? {}, this.draft.fields);
    if (fields) patch.fields = fields;
    const p = this.pending;
    const changes: SaveChanges = {
      patch,
      transitions: Object.entries(p.transitions).map(([field, t]) => ({ field, transition: t.transition })),
      addLinks: p.links.map(({ type, source, target }) => ({ type, source, target })),
      removeLinks: p.removedLinks.map((guid) => ({ guid, etag: this.linkEtag(guid) })),
      addComments: p.comments.map((c) => ({ ...c, author: this.s.user })),
      removeFiles: p.removedFiles,
      ...(overwrite ? { overwrite } : {}),
    };
    try {
      this.view = await api.save(this.guid, changes, p.files, this.view.etag);
      store.toast("Saved", "success");
      this.resetDraft();
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 412 ? (e.body as Partial<SaveConflict>) : null;
      if (conflict?.conflicts?.length && conflict.etag) {
        conflictDialog(this, conflict as SaveConflict);
      } else if (e instanceof ApiError && e.status === 412) {
        this.error = "Someone else modified this artifact in the meantime. Reload to see their changes; your edits stay in the form until you do.";
      } else if (e instanceof ApiError && e.status === 404) {
        void store.confirm("Deleted meanwhile", { noConfirm: true,
          text: `${label(this.view.meta)} was deleted by someone else while you were editing. Your changes cannot be saved; they stay in the form until you leave.` });
      } else {
        this.error = errorText(e);
      }
    } finally {
      this.busy = false;
    }
  }

  /** The version of a link as the user saw it, for removing it. */
  linkEtag(guid: string): string | undefined {
    return [...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].find((r) => r.link.guid === guid)?.link.etag;
  }

  conflictLabel(key: string): string {
    const [kind, ...rest] = key.split(".");
    const id = rest.join(".");
    switch (kind) {
      case "fields": return this.schema?.fields?.find((f) => f.id === id)?.name ?? id;
      case "files": return `Attachment ${id}`;
      case "links": {
        const r = [...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].find((x) => x.link.guid === id);
        return r ? `Link ${r.role ?? r.link.type ?? ""} ${hidLabel(r.other)}` : "Link";
      }
      default: return key === "hid" ? "HID" : key.charAt(0).toUpperCase() + key.slice(1);
    }
  }

  /** A transition waits for Save; choosing again replaces it, choosing none drops it. */
  transition(field: string, id: string) {
    const t = this.workflows.find((x) => x.id === field)?.available.find((x) => x.id === id);
    const transitions = { ...this.pending.transitions };
    if (!t) delete transitions[field];
    else transitions[field] = { transition: t.id, state: t.to };
    this.pending = { ...this.pending, transitions };
    this.touched();
  }

  async deleteArtifact() {
    const v = this.view!;
    const choice = await store.confirm(`Delete ${label(v.meta)}?`, { danger: true, confirmLabel: "Delete",
      text: `The artifact, its ${v.meta.links} link(s), ${v.meta.comments} comment(s) and ${v.attachments?.length ?? 0} attachment(s) are removed in one commit. History stays in Git.` });
    if (choice !== "confirm") return;
    try {
      await api.remove(this.guid, v.etag);
      store.toast("Deleted", "success");
      store.refresh();
      navigate({ guid: null });
    } catch (e) { toastError(e); }
  }

  /**
   * Posting publishes the comment at once when nothing else waits for Save;
   * otherwise it joins the pending changes and is saved with them.
   */
  async addComment() {
    if (!this.commentText.trim()) return;
    // A comment's subject is always the root artifact; here, replying defaults to the comment shown.
    const onComment = this.view?.meta.kind === "comment";
    const subject = onComment ? this.view?.meta.subject ?? this.guid : this.guid;
    const parent = this.replyTo ?? (onComment ? this.guid : undefined);
    if (this.dirty) {
      this.pending = { ...this.pending, comments: [...this.pending.comments, { type: this.commentType, text: this.commentText, parent }] };
      this.commentText = "";
      this.replyTo = null;
      this.touched();
      return;
    }
    try {
      await api.create("comments", { subject, parent, type: this.commentType, text: this.commentText, author: this.s.user });
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) { toastError(e); }
  }

  /** A new link waits for Save. */
  addLink(asSource: boolean, type: string, role: string, types?: string[]) {
    void pickArtifact({ title: asSource ? `${type}: choose target` : `${type}: choose source`, types, exclude: this.guid, kinds: ["entry", "document"] })
      .then((other) => {
        if (!other) return;
        const link = asSource ? { type, source: this.guid, target: other.guid } : { type, source: other.guid, target: this.guid };
        const all = [...(this.rel?.outgoing ?? []), ...(this.rel?.incoming ?? [])].filter((l) => !this.pending.removedLinks.includes(l.link.guid));
        if (all.some((l) => l.link.type === type && l.link.source === link.source && l.link.target === link.target)
          || this.pending.links.some((l) => l.type === type && l.source === link.source && l.target === link.target)) {
          store.toast(`This ${type} link already exists`, "error");
          return;
        }
        this.pending = { ...this.pending, links: [...this.pending.links, { ...link, other, role, dir: asSource ? "out" : "in" }] };
        this.setOpen("relationships", true, false);
        this.touched();
      });
  }

  /** Removing a stored link waits for Save; removing a pending one drops it. */
  toggleLinkRemoval(guid: string) {
    const removed = this.pending.removedLinks;
    this.pending = { ...this.pending, removedLinks: removed.includes(guid) ? removed.filter((g) => g !== guid) : [...removed, guid] };
    this.touched();
  }

  /** An upload waits for Save; one with the name of a stored file replaces it. */
  upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (!files.length) return;
    const names = new Set(files.map((f) => f.name));
    this.pending = { ...this.pending,
      files: [...this.pending.files.filter((f) => !names.has(f.name)), ...files],
      removedFiles: this.pending.removedFiles.filter((n) => !names.has(n)) };
    this.setOpen("attachments", true, false);
    this.touched();
  }

  toggleFileRemoval(name: string) {
    const removed = this.pending.removedFiles;
    this.pending = { ...this.pending, removedFiles: removed.includes(name) ? removed.filter((n) => n !== name) : [...removed, name] };
    this.touched();
  }

  move() {
    store.prompt("Move artifact", { text: "Target folder; leave empty for the repository root.", value: this.view?.meta.folder ?? "", confirmLabel: "Move", folder: true }).then((folder) => {
      if (folder === null) return;
      api.move(this.guid, folder).then((v) => { this.view = v; store.toast(`Moved to ${folder || "/"}`, "success"); store.refresh(); navigate({ folder }); this.reload(true); })
        .catch((e) => toastError(e));
    });
  }

  createOverlay() {
    const v = this.view!;
    store.set({ dialog: { kind: "new", kinds: ["entry"], type: v.meta.type, folder: v.meta.folder, base: { guid: this.guid, label: label(v.meta) } } });
  }

  /** A link is about the relation it expresses, so its endpoints come before its fields. Comments cannot be linked. */
  sectionOrder(): Section[] {
    const order: readonly Section[] = this.view?.meta.kind === "link"
      ? ["relationships", "fields", ...SECTIONS.filter((s) => s !== "relationships" && s !== "fields")]
      : SECTIONS;
    return order.filter((s) => this.hasSection(s));
  }

  hasSection(s: string): boolean {
    const k = this.view?.meta.kind;
    switch (s) {
      case "comment": return k === "comment";
      case "relationships": return k !== "comment";
      case "attachments": return k === "entry" || k === "document";
      case "documents": return k === "entry" && !this.historic;
      case "overlay": return !!this.overlay;
      default: return true;
    }
  }

  isEmpty(s: Section): boolean {
    switch (s) {
      case "fields": return !(this.schema?.fields ?? []).length && !Object.keys(this.draft?.fields ?? {}).length;
      case "relationships": return this.view?.meta.kind !== "link" && (!this.rel || !(this.rel.incoming.length + this.rel.outgoing.length));
      case "comments": return !this.comments.length;
      case "attachments": return !this.view?.attachments?.length;
      case "documents": return !this.documents.length;
      case "overlay": return !this.overlay || (this.overlay.chain.length <= 1 && !this.overlay.overlays.length);
      case "history": case "metadata": return true; // closed unless asked for
      default: return false;
    }
  }

  isOpen(s: Section): boolean {
    // A historic version opens what its commit changed, whatever the saved preference.
    if (this.historic && this.sectionChange(s).length) return this.versionOpen[s] ?? true;
    return this.openPrefs[s] ?? !this.isEmpty(s);
  }

  setOpen(s: Section, open: boolean, persist = true) {
    if (this.historic && this.sectionChange(s).length) { this.versionOpen = { ...this.versionOpen, [s]: open }; return; }
    this.openPrefs = { ...this.openPrefs, [s]: open };
    if (persist) prefs.setJson(OPEN_KEY, this.openPrefs, { session: true });
    if (s === "history" && open && !this.historyLoaded) void this.loadHistory();
  }

  /** Loads the history in batches: the first one, or (more) the next older one. */
  async loadHistory(more = false) {
    const guid = this.guid;
    const before = more ? this.history[this.history.length - 1]?.sha ?? "" : "";
    const h = await api.history(guid, before).catch((e) => { toastError(e); return null; });
    if (guid !== this.guid || !h) return;
    this.history = more ? [...this.history, ...h.history] : h.history;
    this.historyMore = h.more;
    this.historyLoaded = true;
  }

  /** Opens a section and scrolls to it. */
  async reveal(s: Section) {
    if (!this.isOpen(s)) this.setOpen(s, true);
    await this.host.updateComplete;
    this.host.querySelector(`#sec-${s}`)?.scrollIntoView({ block: "start" });
  }

  sectionName(s: string) { return { comment: "Comment", fields: "Fields", relationships: "Relationships", comments: "Comments", attachments: "Attachments", documents: "Documents", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }

  sectionCount(s: string): string {
    switch (s) {
      case "fields": return String((this.schema?.fields ?? []).length || Object.keys(this.draft?.fields ?? {}).length || "");
      case "relationships": return this.view?.meta.kind === "link" ? "" : String((this.rel?.incoming.length ?? 0) + (this.rel?.outgoing.length ?? 0) || "");
      case "comments": return String(this.comments.length || "");
      case "attachments": return String(this.view?.attachments?.length || "");
      case "documents": return String(this.documents.length || "");
      case "history": return this.historyLoaded ? (this.history.length ? this.history.length + (this.historyMore ? "+" : "") : "") : "";
      case "overlay": return String(((this.overlay?.chain.length ?? 1) > 1 ? 1 : 0) + (this.overlay?.overlays.length ?? 0) || "");
      default: return "";
    }
  }

  /** Overlay state of a field the base chain provides a value for; null when the base sets nothing. */
  overlayState(fieldId: string): OverlayState | null {
    const base = this.baseOverlay;
    if (!base || base.fields[fieldId] === undefined) return null;
    return { from: this.levelLabel(base.origin[fieldId]), state: this.draft!.fields[fieldId] === undefined ? "inherited" : "overridden", baseValue: base.fields[fieldId] };
  }

  /** Overriding copies the base value into this entry; reverting removes the own value again. */
  setOwnField(id: string, value: unknown) {
    const next = { ...this.draft!.fields };
    if (value === undefined) delete next[id]; else next[id] = value;
    this.draft = { ...this.draft!, fields: next };
    this.touched();
  }

  /** An overlay chain level by HID, then title, then short GUID. */
  levelLabel(guid: string): string {
    const lvl = this.overlay?.chain.find((l) => l.guid === guid);
    return lvl?.hid || lvl?.title || guid.slice(0, 8);
  }

  /** The fields this entry sets itself, which can move into a new base. A workflow's state cannot: every entry has its own. */
  ownFields(): Record<string, unknown> {
    const own = ((this.view?.data as Record<string, unknown> | undefined)?.fields ?? {}) as Record<string, unknown>;
    const workflows = new Set((this.schema?.fields ?? []).filter((f) => f.type === "workflow").map((f) => f.id));
    return Object.fromEntries(Object.entries(own).filter(([id]) => !workflows.has(id)));
  }

  /** Without a base of its own, a new base must contain the required fields. */
  mustMove(id: string): boolean {
    return !this.view?.meta.base && !!this.schema?.fields?.find((f) => f.id === id)?.required;
  }

  /** The height of the comparison in the base change preview, px; 0 while it has its own height. */
  diffHeight = new Resizer({
    key: "corestone.height.baseDiff", min: 60, get max() { return window.innerHeight; }, axis: "y", step: 16,
    at: (m, box) => m.clientY - box.top,
    changed: () => this.host.requestUpdate(),
  });
}
