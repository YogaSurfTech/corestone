import { html, type TemplateResult } from "lit";
import { fmtTime } from "@corestone/ui";

import { type DocumentState } from "../state";
import { sideHead } from "./head";

// The versions sidebar: the commits that changed the document.

/** The document's history. */
export function versionsPanel(ds: DocumentState, id: string): TemplateResult {
  return html`${sideHead(ds, id, "Versions")}${ds.side.history.map((h) => html`<div class="small"><span class="muted">${fmtTime(h.time)}</span> ${h.subject} <span class="mono muted">${h.sha.slice(0, 7)}</span></div>`)}`;
}
