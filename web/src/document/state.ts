import { deepEqual, errorText } from "@corestone/ui";
import { type DocNode, type DocumentElement, type EntryFiles, type ItemLinks, type OutlineItem, type RichText } from "@corestone/editor";
import { api, ApiError, type SaveChanges } from "../api";
import { navigate } from "../router";
import { store } from "../store";
import { itemLinks } from "../services";
import { type CommentView, type LogEntry, type Relationships, type View } from "../types";
import { type Field, type Schema } from "../components/types";
import { EditSession, fieldsPatch, StatePart, tracked } from "../artifact-state";
import { commentTypeOf, hidLabel } from "../components/artifact";
import { createFiles } from "../files";


// The document view's state, without any rendering: the stored document, the
// edited title, content and fields, the entries placed in it (loaded ones and
// new ones held until Save), and loading and saving.

/** A placed entry as the document shows it: loaded when it comes near the visible part. */
export interface Loaded { view: View | null; schema: Schema | null; missing?: { hid?: string; title?: string } }
/** A new entry made in the document, held until the document is saved (the save creates it). */
export interface Held { schema: Schema; folder: string; title: string; fields: Record<string, unknown>; files: string[] }
/** Whether a placed entry is new (a key "new:…" instead of a GUID). */
export const isNew = (g: string) => g.startsWith("new:");

/** Document content with the keys of new entries changed by f (in placements and references). */
export function mapKeys<T>(v: T, f: (key: string) => string): T {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x, f)) as T;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === "entry" || k === "ref") && typeof x === "string" && isNew(x)) {
      const [key, sec] = x.split("#");
      out[k] = f(key) + (sec ? "#" + sec : "");
    } else out[k] = mapKeys(x, f);
  }
  return out as T;
}

export class DocumentState extends StatePart {
  @tracked view: View | null = null;
  @tracked schema: Schema | null = null;

  @tracked docTitle = "";
  @tracked content: DocNode[] = [];

  @tracked fields: Record<string, unknown> = {};
  @tracked outline: OutlineItem[] = [];

  @tracked current: string | null = null; // the placed entry last clicked
  @tracked busy = false;
  @tracked error = "";

  @tracked rel: Relationships | null = null;
  @tracked comments: CommentView[] = [];

  @tracked commentType: string | null = null;
  @tracked history: LogEntry[] = [];

  @tracked commentText = "";
  @tracked pendingFiles: File[] = [];

  @tracked removedFiles: string[] = [];
  lastTick = -1;

  loadSeq = 0;
  /** Entries placed in the document, shown lazily and kept while the view lives. */
  entries = new Map<string, Loaded | "loading">();

  /** New entries by key; and the GUIDs saves gave them (the undo history may bring a key back). */
  held = new Map<string, Held>();
  savedKeys = new Map<string, string>();

  /** The entry types converting text makes: the document type's entryTypes that are allowed in
   *  its folder (in that order), or every entry type allowed there. */
  convertTypes: Schema[] = [];
  /** What the server said is wrong with each new entry (its check), by key. */
  problems = new Map<string, string[]>();

  checkTimer = 0;
  /** The missing fields in the entry sidebar flash (to draw attention to them). */
  @tracked flash = false;

  schemas = new Map<string, Promise<Schema | null>>();

  observer?: IntersectionObserver;
  @tracked dragId: string | null = null;

  @tracked dropAt: number | "end" | null = null;

  /** The router asks before leaving this document with unsaved changes; the others see that it is being edited. */
  session = new EditSession(this.host, () => this.guid, {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => this.discard(),
    label: () => (this.view ? hidLabel(this.view.meta) : "This document"),
  });

  get editor(): DocumentElement | null { return this.host.querySelector("cs-document"); }

  /** Drops unsaved edits: title, content, fields and files go back to the stored version. */
  discard() {
    if (!this.view) return;
    const d = this.view.data as Record<string, unknown>;
    this.docTitle = String(d.title ?? "");
    this.content = structuredClone((d.content as DocNode[]) ?? []);
    this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
    this.pendingFiles = [];
    this.removedFiles = [];
    if (this.editor) this.editor.value = this.content;
    this.session.done();
  }

  get dirty(): boolean {
    if (!this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.docTitle.trim() !== (d.title ?? "") || !deepEqual(this.content, d.content ?? []) || !deepEqual(this.fields, d.fields ?? {})
      || this.pendingFiles.length > 0 || this.removedFiles.length > 0;
  }

  async load() {
    const seq = ++this.loadSeq;
    const guid = this.guid;
    this.error = "";
    this.view = null;
    this.entries.clear();
    try {
      const view = await api.get(guid);
      if (seq !== this.loadSeq) return;
      this.view = view;
      const d = view.data as Record<string, unknown>;
      this.docTitle = String(d.title ?? "");
      this.content = structuredClone((d.content as DocNode[]) ?? []);
      this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
      this.pendingFiles = [];
      this.removedFiles = [];
      const [schema, types] = await Promise.all([api.schemaOf(this.guid).catch(() => ({ schema: null })), api.types(view.meta.folder).catch(() => ({ types: [] }))]);
      if (seq !== this.loadSeq) return;
      this.schema = schema.schema;
      this.commentType = commentTypeOf(types.types);
      const entryTypes = types.types.filter((t) => t.kind === "entry");
      const wanted = this.schema?.entryTypes;
      this.convertTypes = wanted ? wanted.map((id) => entryTypes.find((t) => t.type === id)).filter((t): t is Schema => !!t) : entryTypes;
      this.editor?.refresh(); // the toolbar offers these types
      this.loadSide();
      void this.revealEntry();
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** A deep link to an entry (?tab=entry:<guid>, from "Documents" on the entry) scrolls to it once. */
  async revealEntry() {
    const tab = store.state.route.tab;
    if (!tab.startsWith("entry:")) return;
    const guid = tab.slice("entry:".length);
    navigate({ tab: "" }, true);
    await this.host.updateComplete;
    const el = this.host.querySelector(`.cs-placement[data-placement="${CSS.escape(guid)}"]`);
    if (!el) return;
    this.current = guid;
    el.scrollIntoView({ block: "center" });
  }

  async loadSide() {
    const [rel, c, h] = await Promise.all([api.relationships(this.guid).catch(() => null), api.comments(this.guid).catch(() => ({ comments: [] })), api.history(this.guid).catch(() => ({ history: [] }))]);
    this.rel = rel;
    this.comments = c.comments;
    this.history = h.history;
  }

  // ---- entries placed in the document ----

  schemaOf(v: View): Promise<Schema | null> {
    const key = `${v.meta.type}@${v.meta.folder}`;
    let p = this.schemas.get(key);
    if (!p) { p = api.schemaOf(v.meta.guid).then((r) => r.schema).catch(() => null); this.schemas.set(key, p); }
    return p;
  }

  /** The last known name of a deleted entry (its HID and title), for "missing entry". */
  lastKnown(guid: string): Promise<{ hid?: string; title?: string } | undefined> {
    return api.deleted(guid).then((r) => r.deleted[0]).catch(() => undefined);
  }

  async loadEntry(guid: string) {
    if (this.entries.has(guid)) return;
    this.entries.set(guid, "loading");
    let loaded: Loaded;
    try {
      const view = await api.get(guid);
      loaded = { view, schema: await this.schemaOf(view) };
    } catch (e) {
      loaded = { view: null, schema: null, missing: e instanceof ApiError && e.status === 404 ? (await this.lastKnown(guid)) ?? {} : {} };
    }
    this.entries.set(guid, loaded);
    this.editor?.refresh(); // shown again, with its name in cross-references
    if (this.current === guid) this.host.requestUpdate();
  }

  /** After changes elsewhere: the entries shown are loaded again. */
  reloadEntries() {
    const shown = [...this.entries.keys()];
    this.entries.clear();
    for (const g of shown) void this.loadEntry(g);
  }

  /** A key's GUID once a save gave it one; otherwise the key (or GUID) itself. */
  real(key: string): string { return this.savedKeys.get(key) ?? key; }

  /** Makes a new entry of document text, held until the save: of the chosen entry type, its
   *  text in the type's first rich-text field, its fields' defaults set. */
  async newEntry(c: { type: string; title: string; text: RichText; files: string[] }): Promise<string | null> {
    const folder = this.view?.meta.folder ?? "";
    const schema = this.convertTypes.find((t) => t.type === c.type);
    if (!schema) { store.toast(`Entries of type ${c.type} cannot be made in ${folder || "/"}.`, "error"); return null; }
    const fields: Record<string, unknown> = {};
    for (const f of schema.fields ?? []) if (f.default != null) fields[f.id] = f.default;
    const hasText = Array.isArray(c.text) ? c.text.length > 0 : !!c.text;
    if (hasText) {
      const rich = (schema.fields ?? []).find((f) => f.type === "richtext");
      if (!rich) { store.toast(`${schema.displayName ?? schema.type} has no rich-text field for the text; select a single line for its title.`, "error"); return null; }
      fields[rich.id] = c.text;
    }
    const key = "new:" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.held.set(key, { schema, folder, title: c.title, fields, files: c.files });
    void this.check(key).then((ok) => { if (!ok) this.attend(key); });
    return key;
  }

  /** The required fields of a new entry that are still empty. */
  missing(h: Held): Field[] {
    const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);
    return (h.schema.fields ?? []).filter((f) => f.required && empty(h.fields[f.id]));
  }

  /** Asks the server whether a new entry could be created; true when it could. */
  async check(key: string): Promise<boolean> {
    const h = this.held.get(key);
    if (!h) return true;
    let problems: string[];
    try {
      problems = (await api.check("entries", { path: h.folder, type: h.schema.type, title: h.title, fields: h.fields })).problems;
    } catch {
      problems = []; // unknown: the save checks again
    }
    if (this.held.get(key) !== h) return true;
    if (problems.length) this.problems.set(key, problems); else this.problems.delete(key);
    this.editor?.refresh(); // the card shows what is missing
    this.host.requestUpdate();
    return !problems.length && !this.missing(h).length;
  }

  /** Shows a new entry with problems in the entry sidebar (opened if needed), its missing fields flashing. */
  attend(key: string) {
    this.current = key;
    this.editor?.refresh();
    if (!this.s.route.sidebars.includes("entry")) navigate({ sidebars: [...this.s.route.sidebars, "entry"] }, true);
    this.flash = false;
    requestAnimationFrame(() => { this.flash = true; window.setTimeout(() => (this.flash = false), 1600); });
  }

  /** A field of a new entry changed (in the sidebar): kept, shown, checked again after a pause. */
  editHeld(key: string, change: (h: Held) => void) {
    const h = this.held.get(key);
    if (!h) return;
    change(h);
    this.touch();
    this.editor?.refresh();
    this.host.requestUpdate();
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => void this.check(key), 400);
  }

  /** Copies files (pictures of a text) from one artifact to another; names: their new names. */
  async copyFiles(names: string[], get: (n: string) => Promise<Blob>, put: (n: string, f: File) => Promise<unknown>): Promise<Map<string, string>> {
    const renamed = new Map<string, string>();
    for (const n of names) {
      try {
        const blob = await get(n);
        const r = await put(n, new File([blob], n, { type: blob.type }));
        if (typeof r === "string" && r !== n) renamed.set(n, r);
      } catch (e) {
        store.toast(`The file ${n} could not be copied: ${errorText(e)}`, "error");
      }
    }
    return renamed;
  }

  // ---- the document's files (pictures in the text), kept with Save ----

  docFiles: EntryFiles = createFiles({
    pending: () => ({ files: this.pendingFiles, removed: this.removedFiles }),
    setPending: (files, removed) => { this.pendingFiles = files; this.removedFiles = removed; },
    stored: () => (this.view?.attachments ?? []).map((a) => a.name),
    url: (name) => api.fileUrl(this.guid, name),
    touched: () => this.touch(),
  });

  /** Links in the text to items: chosen with the item picker, opened like references. */
  itemLinks: ItemLinks = {
    ...itemLinks,
    open: (g, newTab) => {
      const guid = g.split("#")[0];
      if (newTab) window.open(`/artifact/${guid}`, "_blank", "noopener");
      else navigate({ guid });
    },
  };

  touch() {
    this.session.touch();
  }

  async save() {
    if (!this.view || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const sent = { title: this.docTitle, content: this.content, fields: this.fields };
    if (this.docTitle.trim() !== (d.title ?? "")) patch.title = this.docTitle.trim();
    // new entries: keys saved before are GUIDs now; those still in the document are created with it
    const used = new Set<string>();
    const content = mapKeys(this.content, (k) => { const g = this.savedKeys.get(k); if (!g) used.add(k); return g ?? k; });
    if (!deepEqual(content, d.content ?? [])) patch.content = content;
    // every new entry must check out first: otherwise it is shown, and nothing is sent
    for (const key of used) {
      if (this.held.has(key) && !(await this.check(key))) {
        this.attend(key);
        this.error = "Not saved: a new entry is not complete; see the entry sidebar.";
        this.busy = false;
        return;
      }
    }
    const addEntries: NonNullable<SaveChanges["addEntries"]> = [];
    const entryFiles: { key: string; file: File }[] = [];
    try {
      for (const key of used) {
        const h = this.held.get(key);
        if (!h) throw new Error(`the new entry ${key} is not known any more; remove it from the document`);
        addEntries.push({ key, path: h.folder, type: h.schema.type, title: h.title, fields: h.fields });
        for (const n of h.files) {
          const blob = await this.docFiles.get!(n);
          entryFiles.push({ key, file: blob instanceof File ? blob : new File([blob], n, { type: blob.type }) });
        }
      }
    } catch (e) {
      this.error = `Not saved: ${errorText(e)}`;
      this.busy = false;
      return;
    }
    const changedFields = fieldsPatch((d.fields as Record<string, unknown>) ?? {}, this.fields);
    if (changedFields) patch.fields = changedFields;
    try {
      const saved = await api.save(this.guid, { patch, removeFiles: this.removedFiles, ...(addEntries.length ? { addEntries } : {}) },
        this.pendingFiles, this.view.etag, entryFiles);
      this.view = saved;
      // the new entries exist now: their GUIDs go into the document in place of their keys
      const unchanged = this.content === sent.content;
      for (const [key, guid] of Object.entries(saved.created ?? {})) { this.savedKeys.set(key, guid); this.held.delete(key); }
      if (this.savedKeys.size) this.editor?.renameEntries(this.savedKeys);
      this.pendingFiles = [];
      this.removedFiles = [];
      // changes made elsewhere to other parts were merged in: show the stored version, except
      // where the user changed something while it was saved
      const sd = saved.data as Record<string, unknown>;
      if (this.docTitle === sent.title) this.docTitle = String(sd.title ?? "");
      if (this.fields === sent.fields) this.fields = structuredClone((sd.fields as Record<string, unknown>) ?? {});
      if (unchanged && !deepEqual(this.content, sd.content ?? [])) {
        this.content = structuredClone((sd.content as DocNode[]) ?? []);
        if (this.editor) this.editor.value = this.content;
      }
      store.toast("Document saved", "success");
      this.session.done();
      store.refresh();
    } catch (e) {
      this.error = e instanceof ApiError && e.status === 412 ? "Someone else modified this document. Reload to see their version." : errorText(e);
    } finally {
      this.busy = false;
    }
  }
}
