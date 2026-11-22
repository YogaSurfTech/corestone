import type { EntryFiles } from "@corestone/editor";
import { api, type SaveChanges } from "../../api";
import { tracked } from "../../artifact-state";
import { createFiles } from "../../files";
import { setOpen } from "../sections";
import { DetailPart, type Waiting } from "./part";

/** The files stored with the artifact: the uploads and removals that wait for Save. */
export class Files extends DetailPart {
  /** Uploads that wait for Save. */
  @tracked added: File[] = [];
  /** Stored files (by name) whose removal waits for Save. */
  @tracked removed: string[] = [];

  /** The entry's files for images and file links in rich text: the stored ones and the ones
   *  waiting for Save (a new one joins the uploads, shown from the browser until it is saved). */
  readonly entryFiles: EntryFiles = createFiles({
    pending: () => ({ files: this.added, removed: this.removed }),
    setPending: (files, removed) => { this.added = files; this.removed = removed; },
    stored: () => (this.d.view?.attachments ?? []).map((a) => a.name),
    url: (name) => {
      const h = this.d.historic;
      return h ? api.versionFileUrl(this.guid, h.etag, h.commit.sha, name) : api.fileUrl(this.guid, name);
    },
    touched: () => this.touched(),
    added: () => setOpen(this.d, "attachments", true, false), // as an upload there does: what Save will store shows
    inPlace: true,
  });

  override waiting(): Waiting[] {
    return [[this.added.length, "attachment added", "attachments added"], [this.removed.length, "attachment removed", "attachments removed"]];
  }
  override changes(): SaveChanges { return { removeFiles: this.removed }; }
  override reset() { this.added = []; this.removed = []; }
  override clear() { this.reset(); }

  /** An upload waits for Save; one with the name of a stored file replaces it. */
  upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (!files.length) return;
    const names = new Set(files.map((f) => f.name));
    this.added = [...this.added.filter((f) => !names.has(f.name)), ...files];
    this.removed = this.removed.filter((n) => !names.has(n));
    setOpen(this.d, "attachments", true, false);
    this.touched();
  }

  /** Drops an upload that waits for Save. */
  drop(file: File) { this.added = this.added.filter((f) => f !== file); }

  /** Removing a stored file waits for Save; doing it again keeps the file. */
  toggleRemoval(name: string) {
    this.removed = this.removed.includes(name) ? this.removed.filter((n) => n !== name) : [...this.removed, name];
    this.touched();
  }
}
