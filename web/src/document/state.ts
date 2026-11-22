import { deepEqual, errorText } from "@corestone/ui";
import { type DocNode, type DocumentElement, type ItemLinks, type OutlineItem } from "@corestone/editor";
import { api, ApiError } from "../api";
import { navigate } from "../router";
import { store } from "../store";
import { itemLinks } from "../services";
import { type View } from "../types";
import { type Schema } from "../components/types";
import { EditSession, fieldsPatch, StatePart, tracked } from "../artifact-state";
import { commentTypeOf, hidLabel } from "../components/artifact";
import { Entries } from "./state/entries";
import { Files } from "./state/files";
import { Side } from "./state/side";

// The document view's state, without any rendering. The document itself is
// here: the stored version, the edited title, content and fields, loading and
// saving. The rest is a part (state/): the entries placed in it, its files,
// and what the sidebars show about it.

export { isNew, mapKeys, type Held, type Loaded } from "./state/entries";

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
  lastTick = -1;
  loadSeq = 0;
  @tracked dragId: string | null = null;
  @tracked dropAt: number | "end" | null = null;

  readonly entries = new Entries(this);
  readonly files = new Files(this);
  readonly side = new Side(this);

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
    this.files.reset();
    if (this.editor) this.editor.value = this.content;
    this.session.done();
  }

  get dirty(): boolean {
    if (!this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.docTitle.trim() !== (d.title ?? "") || !deepEqual(this.content, d.content ?? []) || !deepEqual(this.fields, d.fields ?? {})
      || this.files.dirty;
  }

  async load() {
    const seq = ++this.loadSeq;
    const guid = this.guid;
    this.error = "";
    this.view = null;
    this.entries.shown.clear();
    try {
      const view = await api.get(guid);
      if (seq !== this.loadSeq) return;
      this.view = view;
      const d = view.data as Record<string, unknown>;
      this.docTitle = String(d.title ?? "");
      this.content = structuredClone((d.content as DocNode[]) ?? []);
      this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
      this.files.reset();
      const [schema, types] = await Promise.all([api.schemaOf(this.guid).catch(() => ({ schema: null })), api.types(view.meta.folder).catch(() => ({ types: [] }))]);
      if (seq !== this.loadSeq) return;
      this.schema = schema.schema;
      this.side.commentType = commentTypeOf(types.types);
      this.entries.offer(types.types, this.schema?.entryTypes);
      this.side.load();
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
    const { content, used } = this.entries.forSave(this.content);
    if (!deepEqual(content, d.content ?? [])) patch.content = content;
    const changedFields = fieldsPatch((d.fields as Record<string, unknown>) ?? {}, this.fields);
    if (changedFields) patch.fields = changedFields;
    try {
      // every new entry must check out first: otherwise it is shown, and nothing is sent
      if (!(await this.entries.ready(used))) { this.error = "Not saved: a new entry is not complete; see the entry sidebar."; return; }
      let made;
      try { made = await this.entries.creations(used); } catch (e) { this.error = `Not saved: ${errorText(e)}`; return; }
      const saved = await api.save(this.guid, { patch, removeFiles: this.files.removed, ...(made.addEntries.length ? { addEntries: made.addEntries } : {}) },
        this.files.added, this.view.etag, made.files);
      this.view = saved;
      const unchanged = this.content === sent.content;
      this.entries.created(saved.created ?? {});
      this.files.reset();
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
