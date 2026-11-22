import { errorText, prefs } from "@corestone/ui";
import { api } from "../api";
import { deleteArtifact, moveArtifact, StatePart, tracked, type ViewHost } from "../artifact-state";
import { store } from "../store";
import type { VersionView, View, WorkflowEval } from "../types";
import type { Schema, Summary } from "../components/types";
import { hidLabel, label } from "../components/artifact";
import { sectionOrder, isOpen, setOpen } from "./sections";
import { type DetailPart } from "./state/part";
import { Edit } from "./state/edit";
import { Links } from "./state/links";
import { Comments } from "./state/comments";
import { Files } from "./state/files";
import { History } from "./state/history";
import { Base } from "./state/base";

// The entry view's state, without any rendering. The artifact itself is here:
// loading it, its schema and workflows, which sections are open. Everything
// else is a part (state/): the editing and Save, the links, the comments, the
// files, the history, the base. A part owns its data, fetches it, and says
// what of it waits for Save; this class asks all parts the same things.
// The sections (the other files here) show the state and call its methods.

export const SECTIONS = ["comment", "fields", "relationships", "comments", "overlay", "attachments", "documents", "history", "metadata"] as const;
export type Section = (typeof SECTIONS)[number];
export const OPEN_KEY = "corestone.detail.sections";

/** What the state needs of the element that shows it. */
export interface DetailHost extends ViewHost {
  version: string;
  at: string;
  /** Closes the menus the element has open. */
  closeMenus(): void;
}

export class DetailState extends StatePart<DetailHost> {
  get version(): string { return this.host.version; }
  get at(): string { return this.host.at; }

  /** The loaded historic version; null while showing the current state. */
  @tracked historic: VersionView | null = null;
  @tracked view: View | null = null;
  @tracked schema: Schema | null = null;
  @tracked workflows: WorkflowEval[] = [];
  /** The documents that embed the entry. */
  @tracked documents: Summary[] = [];
  @tracked error = "";
  @tracked loading = true;
  /** The workflow whose diagram is shown. */
  @tracked showDiagram: string | null = null;
  /** Sections the user opened or closed; remembered for the browser session. */
  @tracked openPrefs: Record<string, boolean> = prefs.json<Record<string, boolean>>(OPEN_KEY, {}, { session: true });
  /** Toggles of changed sections while viewing one historic version; not persisted. */
  @tracked versionOpen: Record<string, boolean> = {};

  readonly edit = new Edit(this);
  readonly links = new Links(this);
  readonly comments = new Comments(this);
  readonly files = new Files(this);
  readonly history = new History(this);
  readonly base = new Base(this);
  /** Every part, in the order the save bar names what they have waiting. */
  readonly parts: readonly DetailPart[] = [this.edit, this.links, this.comments, this.files, this.history, this.base];

  /** The store's refresh count this view last followed. */
  lastTick = -1;
  private loadSeq = 0;
  private softInFlight = false;
  private softPending = false;

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

  private async load(soft: boolean, guid: string, stale: () => boolean) {
    if (!soft) {
      this.loading = true;
      this.view = null;
      this.schema = null;
      this.workflows = [];
      this.documents = [];
      this.historic = null;
      this.host.closeMenus();
      for (const p of this.parts) p.clear();
    }
    this.error = "";
    try {
      if (this.version) return await this.loadVersion(guid, stale);
      const view = await api.get(guid);
      if (stale()) return;
      const [schema, wf, documents, place] = await Promise.all([
        api.schemaOf(guid).catch(() => ({ schema: null })),
        api.workflows(guid).catch(() => ({ workflows: [] })),
        view.meta.kind === "entry" ? api.documents(guid).catch(() => ({ documents: [] })) : { documents: [] },
        Promise.all(this.parts.map((p) => p.fetch(view))),
      ]);
      if (stale()) return;
      // Judge the draft against the view it was made from, after every
      // await: typing that happened during the fetches must survive.
      const wasDirty = this.edit.dirty;
      if (soft && wasDirty && view.etag !== this.view?.etag) {
        // Keep the draft and the version it started from: Save merges the
        // edits into the newer version and asks only if both changed the same thing.
        this.loading = false;
        return;
      }
      this.view = view;
      this.schema = schema.schema;
      this.workflows = wf.workflows;
      this.documents = documents.documents;
      for (const put of place) put();
      if (!this.edit.draft || !wasDirty) this.resetDraft(); // an untouched draft follows the new version
      // A deep link to a section (?tab=comments) also scrolls to it once the view is there.
      const tab = store.state.route.tab;
      if (!soft && sectionOrder(this).includes(tab as Section)) void this.reveal(tab as Section);
    } catch (e) {
      if (stale()) return;
      this.error = errorText(e);
      if (!soft) this.view = null;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  /** A historic version: everything about the artifact comes from that commit, read-only. */
  private async loadVersion(guid: string, stale: () => boolean) {
    const v = await api.version(guid, this.version, this.at);
    if (stale()) return;
    const history = await this.history.fetch();
    if (stale()) return;
    this.historic = v;
    this.versionOpen = {};
    this.view = v;
    this.schema = v.schema ?? null;
    this.workflows = v.workflows;
    this.documents = [];
    for (const p of this.parts) p.show(v);
    history();
    this.resetDraft();
  }

  /** An artifact's summary; null when it does not exist (any more). */
  summary(guid: string): Promise<Summary | null> { return api.get(guid).then((e) => e.meta).catch(() => null); }

  /** Drops everything that waits for Save, in every part. */
  resetDraft() { for (const p of this.parts) p.reset(); }

  /** Whether the historic version shown changed a stored property (title, fields.<id>, …). */
  changed(key: string) { return !!this.historic?.change?.changed.includes(key); }

  changedClass(key: string) { return this.changed(key) ? "changed" : ""; }

  /** Whether the historic version shown added this link or comment. */
  added(guid: string) { return !!this.historic?.change?.added.includes(guid); }

  conflictLabel(key: string): string {
    const [kind, ...rest] = key.split(".");
    const id = rest.join(".");
    switch (kind) {
      case "fields": return this.schema?.fields?.find((f) => f.id === id)?.name ?? id;
      case "files": return `Attachment ${id}`;
      case "links": {
        const r = this.links.all.find((x) => x.link.guid === id);
        return r ? `Link ${r.role ?? r.link.type ?? ""} ${hidLabel(r.other)}` : "Link";
      }
      default: return key === "hid" ? "HID" : key.charAt(0).toUpperCase() + key.slice(1);
    }
  }

  deleteArtifact() { void deleteArtifact(this.view!); }

  move() { moveArtifact(this.view!, (v) => { this.view = v; this.reload(true); }); }

  createOverlay() {
    const v = this.view!;
    store.set({ dialog: { kind: "new", kinds: ["entry"], type: v.meta.type, folder: v.meta.folder, base: { guid: this.guid, label: label(v.meta) } } });
  }

  /** Opens a section and scrolls to it. */
  async reveal(s: Section) {
    if (!isOpen(this, s)) setOpen(this, s, true);
    await this.host.updateComplete;
    this.host.querySelector(`#sec-${s}`)?.scrollIntoView({ block: "start" });
  }
}
