import { html, nothing } from "lit";
import { section } from "@corestone/ui";
import { navigate } from "../router";
import { type Route } from "../store";
import type { Summary } from "../components/types";
import { label } from "../components/artifact";
import { type DetailState, type Section } from "./state";
import { isOpen, setOpen, sectionName, sectionCount, sectionChange } from "./sections";

// What the sections of the entry view share: the frame of a section and the references to other artifacts.

/** A collapsible section; actions stay in the heading so they work while closed. */
export function sectionOf(dt: DetailState, s: Section, body: () => unknown, actions: unknown = nothing) {
  const open = isOpen(dt, s);
  return section({ id: s, title: sectionName(dt, s), count: sectionCount(dt, s), open, actions, body,
    badges: sectionChange(dt, s).map((t) => ({ text: t, cls: t.endsWith("removed") ? "is-removed" : t.endsWith("added") ? "is-added" : "" })),
    onToggle: (to) => setOpen(dt, s, to) });
}

/**
 * Where a reference to another artifact leads: in a historic version to that artifact as it was
 * at the same commit (documents have no version view), otherwise to it as it is now.
 */
export function refRoute(dt: DetailState, guid: string, s?: Summary | null) {
  const h = dt.historic;
  return h && s?.etag && s.kind !== "document" ? { guid, version: s.etag, at: h.commit.sha } : { guid };
}

export function refHref(dt: DetailState, r: Partial<Route>) {
  return "/artifact/" + r.guid + (r.version ? `?version=${r.version}&at=${r.at}` : "");
}

/** An artifact reference: type icon, HID and title, opening it; a missing one shows its GUID. */
export function artifactRef(dt: DetailState, guid: string | undefined, s: Summary | null | undefined) {
  if (!guid) return html`<span class="muted">—</span>`;
  if (!s) return html`<span class="muted mono" title=${dt.historic ? "This artifact did not exist then" : "This artifact no longer exists"}>${guid}</span>`;
  const to = refRoute(dt, guid, s);
  return html`<span class="endpoint"><corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span>` : nothing}
      <a href=${refHref(dt, to)} @click=${(e: Event) => { e.preventDefault(); navigate({ ...to, tab: "" }); }}>${label(s)}</a></span>`;
}

/** An artifact cell opening it; the row click does the same. */
export function openCell(dt: DetailState, s: Summary, tab?: string) {
  const to = refRoute(dt, s.guid, s);
  return html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span> ` : nothing}<a href=${refHref(dt, to)} @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); navigate(tab === undefined ? to : { ...to, tab }); }}>${label(s)}</a>`;
}

/** Opens the artifact a reference names. */
export const openRef = (e: CustomEvent<string>) => navigate({ guid: e.detail });
