import { api } from "../../api";
import { tracked } from "../../artifact-state";
import { type CommentView, type LogEntry, type Relationships } from "../../types";
import { DocumentPart } from "./part";

/** What the sidebars show about the document besides its text: links, comments and versions. */
export class Side extends DocumentPart {
  @tracked rel: Relationships | null = null;

  @tracked comments: CommentView[] = [];

  @tracked commentType: string | null = null;

  @tracked history: LogEntry[] = [];

  @tracked commentText = "";

  async load() {
    const [rel, c, h] = await Promise.all([api.relationships(this.guid).catch(() => null), api.comments(this.guid).catch(() => ({ comments: [] })), api.history(this.guid).catch(() => ({ history: [] }))]);
    this.rel = rel;
    this.comments = c.comments;
    this.history = h.history;
  }
}
