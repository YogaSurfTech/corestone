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
    case "overlay": return !!dt.overlay;
    default: return true;
  }
}

export function isEmpty(dt: DetailState, s: Section): boolean {
  switch (s) {
    case "fields": return !(dt.schema?.fields ?? []).length && !Object.keys(dt.draft?.fields ?? {}).length;
    case "relationships": return dt.view?.meta.kind !== "link" && (!dt.rel || !(dt.rel.incoming.length + dt.rel.outgoing.length));
    case "comments": return !dt.comments.length;
    case "attachments": return !dt.view?.attachments?.length;
    case "documents": return !dt.documents.length;
    case "overlay": return !dt.overlay || (dt.overlay.chain.length <= 1 && !dt.overlay.overlays.length);
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
  if (s === "history" && open && !dt.historyLoaded) void dt.loadHistory();
}

export function sectionName(dt: DetailState, s: string) { return { comment: "Comment", fields: "Fields", relationships: "Relationships", comments: "Comments", attachments: "Attachments", documents: "Documents", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }

export function sectionCount(dt: DetailState, s: string): string {
  switch (s) {
    case "fields": return String((dt.schema?.fields ?? []).length || Object.keys(dt.draft?.fields ?? {}).length || "");
    case "relationships": return dt.view?.meta.kind === "link" ? "" : String((dt.rel?.incoming.length ?? 0) + (dt.rel?.outgoing.length ?? 0) || "");
    case "comments": return String(dt.comments.length || "");
    case "attachments": return String(dt.view?.attachments?.length || "");
    case "documents": return String(dt.documents.length || "");
    case "history": return dt.historyLoaded ? (dt.history.length ? dt.history.length + (dt.historyMore ? "+" : "") : "") : "";
    case "overlay": return String(((dt.overlay?.chain.length ?? 1) > 1 ? 1 : 0) + (dt.overlay?.overlays.length ?? 0) || "");
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
      const n = added([...(dt.rel?.incoming ?? []), ...(dt.rel?.outgoing ?? [])].map((r) => r.link.guid));
      return [...(n ? [`${plural(n, "link")} added`] : []), ...(c.removedLinks ? [`${plural(c.removedLinks, "link")} removed`] : [])];
    }
    case "comments": {
      const n = added(dt.comments.map((x) => x.meta.guid));
      return [...(n ? [`${plural(n, "comment")} added`] : []), ...(c.removedComments ? [`${plural(c.removedComments, "comment")} removed`] : [])];
    }
    default: return [];
  }
}

/** The same badges for what waits for Save. */
export function pendingChange(dt: DetailState, s: Section, plural: (n: number, what: string) => string): string[] {
  const p = dt.pending;
  const badges = (n: number, what: string, verb: string) => (n ? [`${plural(n, what)} ${verb}`] : []);
  switch (s) {
    case "fields": return (dt.draft && dt.view && dt.edited.includes("fields")) || Object.keys(p.transitions).length ? ["changed"] : [];
    case "relationships": return [...badges(p.links.length, "link", "added"), ...badges(p.removedLinks.length, "link", "removed")];
    case "comments": return badges(p.comments.length, "comment", "added");
    case "attachments": return [...badges(p.files.length, "attachment", "added"), ...badges(p.removedFiles.length, "attachment", "removed")];
    default: return [];
  }
}
