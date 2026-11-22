import { type DocNode, type RichText } from "@corestone/editor";
import { api, ApiError, type SaveChanges } from "../../api";
import { navigate } from "../../router";
import { tracked } from "../../artifact-state";
import { store } from "../../store";
import { type View } from "../../types";
import { type Field, type Schema } from "../../components/types";
import { DocumentPart } from "./part";

// The entries placed in the document: the stored ones, loaded when they come
// near the visible part, and the new ones made in the document, which are
// held until a save creates them.

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

export class Entries extends DocumentPart {
  /** Entries placed in the document, shown lazily and kept while the view lives. */
  readonly shown = new Map<string, Loaded | "loading">();

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

  async load(guid: string) {
    if (this.shown.has(guid)) return;
    this.shown.set(guid, "loading");
    let loaded: Loaded;
    try {
      const view = await api.get(guid);
      loaded = { view, schema: await this.schemaOf(view) };
    } catch (e) {
      loaded = { view: null, schema: null, missing: e instanceof ApiError && e.status === 404 ? (await this.lastKnown(guid)) ?? {} : {} };
    }
    this.shown.set(guid, loaded);
    this.editor?.refresh(); // shown again, with its name in cross-references
    if (this.d.current === guid) this.host.requestUpdate();
  }

  /** After changes elsewhere: the entries shown are loaded again. */
  reload() {
    const shown = [...this.shown.keys()];
    this.shown.clear();
    for (const g of shown) void this.load(g);
  }

  /** A key's GUID once a save gave it one; otherwise the key (or GUID) itself. */
  real(key: string): string { return this.savedKeys.get(key) ?? key; }

  /** Makes a new entry of document text, held until the save: of the chosen entry type, its
   *  text in the type's first rich-text field, its fields' defaults set. */
  async create(c: { type: string; title: string; text: RichText; files: string[] }): Promise<string | null> {
    const folder = this.d.view?.meta.folder ?? "";
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
    this.d.current = key;
    this.editor?.refresh();
    if (!this.s.route.sidebars.includes("entry")) navigate({ sidebars: [...this.s.route.sidebars, "entry"] }, true);
    this.flash = false;
    requestAnimationFrame(() => { this.flash = true; window.setTimeout(() => (this.flash = false), 1600); });
  }

  /** A field of a new entry changed (in the sidebar): kept, shown, checked again after a pause. */
  edit(key: string, change: (h: Held) => void) {
    const h = this.held.get(key);
    if (!h) return;
    change(h);
    this.touch();
    this.editor?.refresh();
    this.host.requestUpdate();
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => void this.check(key), 400);
  }

  /** The content as a save sends it (new entries saved before by their GUIDs), and the keys of the new entries still in it. */
  forSave(content: DocNode[]): { content: DocNode[]; used: Set<string> } {
    const used = new Set<string>();
    return { content: mapKeys(content, (k) => { const g = this.savedKeys.get(k); if (!g) used.add(k); return g ?? k; }), used };
  }

  /** Whether every one of these new entries can be created; the first that cannot is shown. */
  async ready(used: Set<string>): Promise<boolean> {
    for (const key of used) {
      if (this.held.has(key) && !(await this.check(key))) { this.attend(key); return false; }
    }
    return true;
  }

  /** What a save sends to create these new entries, and their files. */
  async creations(used: Set<string>): Promise<{ addEntries: NonNullable<SaveChanges["addEntries"]>; files: { key: string; file: File }[] }> {
    const addEntries: NonNullable<SaveChanges["addEntries"]> = [];
    const files: { key: string; file: File }[] = [];
    for (const key of used) {
      const h = this.held.get(key);
      if (!h) throw new Error(`the new entry ${key} is not known any more; remove it from the document`);
      addEntries.push({ key, path: h.folder, type: h.schema.type, title: h.title, fields: h.fields });
      for (const n of h.files) {
        const blob = await this.d.files.docFiles.get!(n);
        files.push({ key, file: blob instanceof File ? blob : new File([blob], n, { type: blob.type }) });
      }
    }
    return { addEntries, files };
  }

  /** A save created new entries: their GUIDs go into the document in place of their keys. */
  created(guids: Record<string, string>) {
    for (const [key, guid] of Object.entries(guids)) { this.savedKeys.set(key, guid); this.held.delete(key); }
    if (this.savedKeys.size) this.editor?.renameEntries(this.savedKeys);
  }

  /** The entry types converting text makes: the document type's entryTypes that are allowed in
   *  its folder (in that order), or every entry type allowed there. */
  offer(types: Schema[], wanted: string[] | undefined) {
    const entryTypes = types.filter((t) => t.kind === "entry");
    this.convertTypes = wanted ? wanted.map((id) => entryTypes.find((t) => t.type === id)).filter((t): t is Schema => !!t) : entryTypes;
    this.editor?.refresh(); // the toolbar offers these types
  }
}
