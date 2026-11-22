import { errorText } from "@corestone/ui";
import { type EntryFiles } from "@corestone/editor";
import { api } from "../../api";
import { tracked } from "../../artifact-state";
import { createFiles } from "../../files";
import { store } from "../../store";
import { DocumentPart } from "./part";

/** The document's files (pictures in the text): the uploads and removals that wait for Save. */
export class Files extends DocumentPart {
  @tracked added: File[] = [];

  @tracked removed: string[] = [];

  docFiles: EntryFiles = createFiles({
    pending: () => ({ files: this.added, removed: this.removed }),
    setPending: (files, removed) => { this.added = files; this.removed = removed; },
    stored: () => (this.d.view?.attachments ?? []).map((a) => a.name),
    url: (name) => api.fileUrl(this.guid, name),
    touched: () => this.touch(),
  });

  /** Copies files (pictures of a text) from one artifact to another; names: their new names. */
  async copy(names: string[], get: (n: string) => Promise<Blob>, put: (n: string, f: File) => Promise<unknown>): Promise<Map<string, string>> {
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

  get dirty(): boolean { return this.added.length > 0 || this.removed.length > 0; }

  /** Drops the uploads and removals that wait for Save. */
  reset() { this.added = []; this.removed = []; }
}
