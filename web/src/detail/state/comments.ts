import { api, type SaveChanges } from "../../api";
import { tracked } from "../../artifact-state";
import { store, toastError } from "../../store";
import type { CommentView, VersionView, View } from "../../types";
import type { Summary } from "../../components/types";
import { commentTypeOf } from "../../components/artifact";
import { DetailPart, type Waiting } from "./part";

/** The comments on the artifact; for a comment, what it is on and the thread it belongs to. */
export class Comments extends DetailPart {
  /** The comment thread shown here; for a comment, the whole thread of its subject. */
  @tracked list: CommentView[] = [];
  /** For a comment: what it is on; a link subject comes with its endpoints and role name. */
  @tracked subject: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string } | null = null;
  /** The comment type to post with here; null when the folder defines none (no comments then). */
  @tracked type: string | null = null;
  /** The comment the box answers. */
  @tracked replyTo: string | null = null;
  /** The text in the box. */
  @tracked text = "";
  /** Comments that wait for Save. */
  @tracked added: { type: string | null; text: string; parent?: string }[] = [];

  override async fetch(view: View) {
    const isComment = view.meta.kind === "comment";
    const subjectOf = async (g?: string) => {
      const meta = g ? await this.d.summary(g) : null;
      if (!meta || meta.kind !== "link") return meta ? { meta } : null;
      const [source, target, role] = await Promise.all([
        meta.source ? this.d.summary(meta.source) : null, meta.target ? this.d.summary(meta.target) : null,
        api.schemaOf(meta.guid).then((s) => s.schema?.displayName).catch(() => undefined)]);
      return { meta, source, target, role };
    };
    const [subject, comments, types] = await Promise.all([
      isComment ? subjectOf(view.meta.subject) : null,
      // Replies share the root subject, so a comment shows the thread it belongs to.
      api.comments(isComment ? view.meta.subject ?? view.meta.guid : view.meta.guid).catch(() => ({ comments: [] })),
      api.types(view.meta.folder).catch(() => ({ types: [] })),
    ]);
    return () => {
      this.subject = subject;
      this.list = comments.comments;
      this.type = commentTypeOf(types.types);
    };
  }

  override show(v: VersionView) {
    this.subject = v.subject ?? null; // as it was then
    this.list = v.comments;
    this.type = null;
  }

  override clear() { this.subject = null; this.list = []; this.reset(); }

  override waiting(): Waiting[] { return [[this.added.length, "comment"]]; }
  override changes(): SaveChanges { return { addComments: this.added.map((c) => ({ ...c, author: this.s.user })) }; }
  override reset() { this.added = []; }
  override saved() { this.text = ""; this.replyTo = null; }

  /**
   * Posting publishes the comment at once when nothing else waits for Save;
   * otherwise it joins the pending changes and is saved with them.
   */
  async post() {
    if (!this.text.trim()) return;
    // A comment's subject is always the root artifact; here, replying defaults to the comment shown.
    const meta = this.d.view?.meta;
    const onComment = meta?.kind === "comment";
    const subject = onComment ? meta?.subject ?? this.guid : this.guid;
    const parent = this.replyTo ?? (onComment ? this.guid : undefined);
    if (this.d.edit.dirty) {
      this.added = [...this.added, { type: this.type, text: this.text, parent }];
      this.saved();
      this.touched();
      return;
    }
    try {
      await api.create("comments", { subject, parent, type: this.type, text: this.text, author: this.s.user });
      this.saved();
      void this.d.reload(true);
      store.refresh();
    } catch (e) { toastError(e); }
  }

  /** Drops a comment that waits for Save. */
  drop(index: number) { this.added = this.added.filter((_, i) => i !== index); }
}
