import { deepEqual, errorText } from "@corestone/ui";
import { api, ApiError, type SaveChanges, type SaveConflict } from "../../api";
import { EditSession, fieldsPatch, tracked } from "../../artifact-state";
import { store } from "../../store";
import { hidLabel, label } from "../../components/artifact";
import { conflictDialog } from "../conflict";
import { DetailPart, type Waiting } from "./part";

/**
 * The editing of the artifact: the draft of its title, HID and fields, the
 * workflow transitions chosen, and Save, which publishes them together with
 * what the other parts have waiting, in one commit.
 */
export class Edit extends DetailPart {
  @tracked draft: { title: string; hid: string; fields: Record<string, unknown> } | null = null;
  /** Workflow field id → the transition chosen and the state it leads to. */
  @tracked transitions: Record<string, { transition: string; state: string }> = {};
  @tracked busy = false;

  /** The router asks before leaving this artifact with unsaved changes; the others see that it is being edited. */
  private readonly session = new EditSession(this.host, () => this.guid, {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => { if (this.d.view) this.d.resetDraft(); },
    label: () => (this.d.view ? hidLabel(this.d.view.meta) : "This artifact"),
  });

  get dirty(): boolean {
    if (!this.draft || !this.d.view || this.d.historic) return false;
    return this.edited.length > 0 || this.pendingCount > 0;
  }

  /** The edited title, HID and fields that differ from the stored ones. */
  get edited(): string[] {
    const d = this.d.view!.data as Record<string, unknown>;
    return [
      ...(this.draft!.title !== (d.title ?? "") ? ["title"] : []),
      ...(this.draft!.hid !== (d.hid ?? "") ? ["HID"] : []),
      ...(!deepEqual(this.draft!.fields, d.fields ?? {}) ? ["fields"] : []),
    ];
  }

  /** Everything that waits for Save besides the draft, of all parts. */
  private get allWaiting(): Waiting[] { return this.d.parts.flatMap((p) => p.waiting()); }

  get pendingCount(): number { return this.allWaiting.reduce((n, [k]) => n + k, 0); }

  /** What Save will publish, for the save bar. */
  pendingSummary(): string {
    return [...this.edited, ...this.allWaiting.filter(([k]) => k).map(([k, one, many = one + "s"]) => `${k} ${k === 1 ? one : many}`)].join(", ");
  }

  override waiting(): Waiting[] { return [[Object.keys(this.transitions).length, "transition"]]; }

  override changes(): SaveChanges {
    const d = this.d.view!.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (this.draft!.title !== (d.title ?? "")) patch.title = this.draft!.title;
    if (this.draft!.hid !== (d.hid ?? "")) patch.hid = this.draft!.hid || null;
    const fields = fieldsPatch((d.fields as Record<string, unknown>) ?? {}, this.draft!.fields);
    if (fields) patch.fields = fields;
    return { patch, transitions: Object.entries(this.transitions).map(([field, t]) => ({ field, transition: t.transition })) };
  }

  /** The draft starts again from the stored artifact. */
  override reset() {
    const d = this.d.view!.data as Record<string, unknown>;
    this.draft = { title: String(d.title ?? ""), hid: String(d.hid ?? ""), fields: structuredClone((d.fields as Record<string, unknown>) ?? {}) };
    this.transitions = {};
    this.session.done();
  }

  override clear() { this.draft = null; this.transitions = {}; }

  override touched() {
    if (this.d.historic) return; // read-only: nobody is editing
    this.session.touch();
  }

  /** Sets a field of the draft; undefined removes the entry's own value (the base's shows again). */
  setOwnField(id: string, value: unknown) {
    const next = { ...this.draft!.fields };
    if (value === undefined) delete next[id]; else next[id] = value;
    this.draft = { ...this.draft!, fields: next };
    this.touched();
  }

  /** A transition waits for Save; choosing again replaces it, choosing none drops it. */
  transition(field: string, id: string) {
    const t = this.d.workflows.find((x) => x.id === field)?.available.find((x) => x.id === id);
    const transitions = { ...this.transitions };
    if (!t) delete transitions[field];
    else transitions[field] = { transition: t.id, state: t.to };
    this.transitions = transitions;
    this.touched();
  }

  /** Publishes the draft and what every part has waiting; overwrite names the version of a conflict to overwrite. */
  async save(overwrite?: string) {
    const d = this.d;
    if (!d.view || !this.draft || this.busy) return;
    this.busy = true;
    d.error = "";
    const changes: SaveChanges = Object.assign({}, ...d.parts.map((p) => p.changes()), overwrite ? { overwrite } : {});
    try {
      d.view = await api.save(this.guid, changes, d.files.added, d.view.etag);
      store.toast("Saved", "success");
      d.resetDraft();
      for (const p of d.parts) p.saved();
      void d.reload(true);
      store.refresh();
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 412 ? (e.body as Partial<SaveConflict>) : null;
      if (conflict?.conflicts?.length && conflict.etag) {
        conflictDialog(d, conflict as SaveConflict);
      } else if (e instanceof ApiError && e.status === 412) {
        d.error = "Someone else modified this artifact in the meantime. Reload to see their changes; your edits stay in the form until you do.";
      } else if (e instanceof ApiError && e.status === 404) {
        void store.confirm("Deleted meanwhile", { noConfirm: true,
          text: `${label(d.view.meta)} was deleted by someone else while you were editing. Your changes cannot be saved; they stay in the form until you leave.` });
      } else {
        d.error = errorText(e);
      }
    } finally {
      this.busy = false;
    }
  }
}
