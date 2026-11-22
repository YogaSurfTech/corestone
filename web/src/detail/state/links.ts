import { api, type SaveChanges } from "../../api";
import { tracked } from "../../artifact-state";
import { pickArtifact, store } from "../../store";
import type { Relationships, VersionView, View } from "../../types";
import type { Summary } from "../../components/types";
import { setOpen } from "../sections";
import { DetailPart, type Waiting } from "./part";

/** A link that waits for Save, with the artifact at its other end. */
export interface NewLink { type: string; source: string; target: string; other: Summary; role: string; dir: "in" | "out" }

/** The links of the artifact; for a link, the artifacts it connects. */
export class Links extends DetailPart {
  @tracked rel: Relationships | null = null;
  /** For a link: the artifacts it connects (null when an endpoint no longer exists). */
  @tracked endpoints: { source: Summary | null; target: Summary | null } | null = null;
  /** New links that wait for Save. */
  @tracked added: NewLink[] = [];
  /** Stored links (by GUID) whose removal waits for Save. */
  @tracked removed: string[] = [];

  /** Every stored link, incoming and outgoing. */
  get all() { return [...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])]; }

  override async fetch(view: View) {
    const isLink = view.meta.kind === "link";
    const end = (g?: string) => g ? this.d.summary(g) : Promise.resolve(null);
    const [rel, endpoints] = await Promise.all([
      isLink || view.meta.kind === "comment" ? null : api.relationships(view.meta.guid).catch(() => null),
      isLink ? Promise.all([end(view.meta.source), end(view.meta.target)]) : null,
    ]);
    return () => {
      this.rel = rel;
      this.endpoints = endpoints ? { source: endpoints[0], target: endpoints[1] } : null;
    };
  }

  override show(v: VersionView) {
    this.rel = v.meta.kind === "link" || v.meta.kind === "comment" ? null : v.relationships;
    this.endpoints = v.endpoints ?? null; // as they were then
  }

  override clear() { this.rel = null; this.endpoints = null; this.reset(); }

  override waiting(): Waiting[] {
    return [[this.added.length, "link added", "links added"], [this.removed.length, "link removed", "links removed"]];
  }

  override changes(): SaveChanges {
    return {
      addLinks: this.added.map(({ type, source, target }) => ({ type, source, target })),
      removeLinks: this.removed.map((guid) => ({ guid, etag: this.etag(guid) })),
    };
  }

  override reset() { this.added = []; this.removed = []; }

  /** The version of a link as the user saw it, for removing it. */
  etag(guid: string): string | undefined { return this.all.find((r) => r.link.guid === guid)?.link.etag; }

  /** A new link waits for Save. */
  add(asSource: boolean, type: string, role: string, types?: string[]) {
    void pickArtifact({ title: asSource ? `${type}: choose target` : `${type}: choose source`, types, exclude: this.guid, kinds: ["entry", "document"],
      why: `A ${type} link allows only these types as its ${asSource ? "target" : "source"}`, folder: this.d.view?.meta.folder })
      .then((other) => {
        if (!other) return;
        const link = asSource ? { type, source: this.guid, target: other.guid } : { type, source: other.guid, target: this.guid };
        const same = (l: { type?: string; source?: string; target?: string }) => l.type === type && l.source === link.source && l.target === link.target;
        if (this.all.some((l) => !this.removed.includes(l.link.guid) && same(l.link)) || this.added.some(same)) {
          store.toast(`This ${type} link already exists`, "error");
          return;
        }
        this.added = [...this.added, { ...link, other, role, dir: asSource ? "out" : "in" }];
        setOpen(this.d, "relationships", true, false);
        this.touched();
      });
  }

  /** Drops a new link that waits for Save. */
  drop(index: number) { this.added = this.added.filter((_, i) => i !== index); }

  /** Removing a stored link waits for Save; doing it again keeps the link. */
  toggleRemoval(guid: string) {
    this.removed = this.removed.includes(guid) ? this.removed.filter((g) => g !== guid) : [...this.removed, guid];
    this.touched();
  }
}
