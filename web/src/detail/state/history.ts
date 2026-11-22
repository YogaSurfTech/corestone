import { api } from "../../api";
import { tracked } from "../../artifact-state";
import { toastError } from "../../store";
import type { HistoryEntry } from "../../types";
import { isOpen } from "../sections";
import { DetailPart } from "./part";

/** The commits that touched the artifact; fetched only while their section is open. */
export class History extends DetailPart {
  @tracked entries: HistoryEntry[] = [];
  /** Older entries remain to be loaded. */
  @tracked more = false;
  @tracked loaded = false;

  /** The same for the current state and for a historic version: the history is the artifact's. */
  override async fetch() {
    const h = isOpen(this.d, "history") ? await api.history(this.guid).catch(() => ({ history: [], more: false })) : null;
    return () => {
      this.entries = h?.history ?? [];
      this.more = h?.more ?? false;
      this.loaded = !!h;
    };
  }

  override clear() { this.entries = []; this.more = false; this.loaded = false; }

  /** Loads the history in batches: the first one, or (more) the next older one. */
  async load(more = false) {
    const guid = this.guid;
    const before = more ? this.entries[this.entries.length - 1]?.sha ?? "" : "";
    const h = await api.history(guid, before).catch((e) => { toastError(e); return null; });
    if (guid !== this.guid || !h) return;
    this.entries = more ? [...this.entries, ...h.history] : h.history;
    this.more = h.more;
    this.loaded = true;
  }
}
