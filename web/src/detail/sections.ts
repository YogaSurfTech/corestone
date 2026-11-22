import { prefs } from "@corestone/ui";
import { OPEN_KEY, SECTIONS, type DetailState, type Section } from "./state";

// The sections of the entry view: which an artifact has, in which order, which are open,
// and what their headings say (a count, and what changed or waits for Save).

/** A link is about the relation it expresses, so its endpoints come before its fields. Comments cannot be linked. */
export function sectionOrder(dt: DetailState): Section[] {
  const order: readonly Section[] = dt.view?.meta.kind === "link"
    ? ["relationships", "fields", ...SECTIONS.filter((s) => s !== "relationships" && s !== "fields")]
    : SECTIONS;
  return order.filter((s) => hasSection(dt, s));
}

export function hasSection(dt: DetailState, s: string): boolean {
  const k = dt.view?.meta.kind;
  switch (s) {
    case "comment": return k === "comment";
    case "relationships": return k !== "comment";
    case "attachments": return k === "entry" || k === "document";
    case "documents": return k === "entry" && !dt.historic;
    case "overlay": return !!dt.base.overlay;
    default: return true;
  }
}

export function isEmpty(dt: DetailState, s: Section): boolean {
  switch (s) {
    case "fields": return !(dt.schema?.fields ?? []).length && !Object.keys(dt.edit.draft?.fields ?? {}).length;
    case "relationships": return dt.view?.meta.kind !== "link" && (!dt.links.rel || !(dt.links.rel.incoming.length + dt.links.rel.outgoing.length));
    case "comments": return !dt.comments.list.length;
    case "attachments": return !dt.view?.attachments?.length;
    case "documents": return !dt.documents.length;
    case "overlay": return !dt.base.overlay || (dt.base.overlay.chain.length <= 1 && !dt.base.overlay.overlays.length);
    case "history": case "metadata": return true; // closed unless asked for
    default: return false;
  }
}

export function isOpen(dt: DetailState, s: Section): boolean {
  // A historic version opens what its commit changed, whatever the saved preference.
  if (dt.historic && sectionChange(dt, s).length) return dt.versionOpen[s] ?? true;
  return dt.openPrefs[s] ?? !isEmpty(dt, s);
}

export function setOpen(dt: DetailState, s: Section, open: boolean, persist = true) {
  if (dt.historic && sectionChange(dt, s).length) { dt.versionOpen = { ...dt.versionOpen, [s]: open }; return; }
  dt.openPrefs = { ...dt.openPrefs, [s]: open };
  if (persist) prefs.setJson(OPEN_KEY, dt.openPrefs, { session: true });
  if (s === "history" && open && !dt.history.loaded) void dt.history.load();
}

export function sectionName(dt: DetailState, s: string) { return { comment: "Comment", fields: "Fields", relationships: "Relationships", comments: "Comments", attachments: "Attachments", documents: "Documents", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }

export function sectionCount(dt: DetailState, s: string): string {
  switch (s) {
    case "fields": return String((dt.schema?.fields ?? []).length || Object.keys(dt.edit.draft?.fields ?? {}).length || "");
    case "relationships": return dt.view?.meta.kind === "link" ? "" : String((dt.links.rel?.incoming.length ?? 0) + (dt.links.rel?.outgoing.length ?? 0) || "");
    case "comments": return String(dt.comments.list.length || "");
    case "attachments": return String(dt.view?.attachments?.length || "");
    case "documents": return String(dt.documents.length || "");
    case "history": return dt.history.loaded ? (dt.history.entries.length ? dt.history.entries.length + (dt.history.more ? "+" : "") : "") : "";
    case "overlay": return String(((dt.base.overlay?.chain.length ?? 1) > 1 ? 1 : 0) + (dt.base.overlay?.overlays.length ?? 0) || "");
    default: return "";
  }
}

/** What the historic version shown changed in a section, as short badges for its heading. */
export function sectionChange(dt: DetailState, s: Section): string[] {
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (!dt.historic) return pendingChange(dt, s, plural);
  const c = dt.historic.change;
  if (!c) return [];
  const added = (guids: string[]) => guids.filter((g) => c.added.includes(g)).length;
  switch (s) {
    case "fields": return c.changed.some((k) => k.startsWith("fields.")) ? ["changed"] : [];
    case "comment": return dt.changed("text") ? ["changed"] : [];
    case "relationships": {
      if (dt.view?.meta.kind === "link") return dt.changed("source") || dt.changed("target") ? ["changed"] : [];
      const n = added([...(dt.links.rel?.incoming ?? []), ...(dt.links.rel?.outgoing ?? [])].map((r) => r.link.guid));
      return [...(n ? [`${plural(n, "link")} added`] : []), ...(c.removedLinks ? [`${plural(c.removedLinks, "link")} removed`] : [])];
    }
    case "comments": {
      const n = added(dt.comments.list.map((x) => x.meta.guid));
      return [...(n ? [`${plural(n, "comment")} added`] : []), ...(c.removedComments ? [`${plural(c.removedComments, "comment")} removed`] : [])];
    }
    default: return [];
  }
}

/** The same badges for what waits for Save. */
export function pendingChange(dt: DetailState, s: Section, plural: (n: number, what: string) => string): string[] {
  const badges = (n: number, what: string, verb: string) => (n ? [`${plural(n, what)} ${verb}`] : []);
  switch (s) {
    case "fields": return (dt.edit.draft && dt.view && dt.edit.edited.includes("fields")) || Object.keys(dt.edit.transitions).length ? ["changed"] : [];
    case "relationships": return [...badges(dt.links.added.length, "link", "added"), ...badges(dt.links.removed.length, "link", "removed")];
    case "comments": return badges(dt.comments.added.length, "comment", "added");
    case "attachments": return [...badges(dt.files.added.length, "attachment", "added"), ...badges(dt.files.removed.length, "attachment", "removed")];
    default: return [];
  }
}
