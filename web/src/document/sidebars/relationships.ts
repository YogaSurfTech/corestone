import { html, nothing, type TemplateResult } from "lit";
import { navigate } from "../../router";
import { label } from "../../components/artifact";

import { type DocumentState } from "../state";
import { sideHead } from "./head";

// The relationships sidebar: the document's links.

/** The links from and to the document. */
export function relationshipsPanel(ds: DocumentState, id: string): TemplateResult {
  return html`${sideHead(ds, id, "Relationships")}${!ds.rel || (!ds.rel.incoming.length && !ds.rel.outgoing.length) ? html`<div class="muted small">No links.</div>` : nothing}
    ${ds.rel?.outgoing.map((l) => html`<div>→ <span class="muted small">${l.link.type}</span> <corestone-ref .artifact=${l.other} .text=${label(l.other)} @open-artifact=${(e: CustomEvent<string>) => navigate({ guid: e.detail })}></corestone-ref></div>`)}
    ${ds.rel?.incoming.map((l) => html`<div>← <span class="muted small">${l.link.type}</span> <corestone-ref .artifact=${l.other} .text=${label(l.other)} @open-artifact=${(e: CustomEvent<string>) => navigate({ guid: e.detail })}></corestone-ref></div>`)}`;
}
