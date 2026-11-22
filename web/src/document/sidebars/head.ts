import { html, type TemplateResult } from "lit";
import { navigate } from "../../router";
import { appIcon } from "../../components/icons";

import { type DocumentState } from "../state";

// A sidebar's heading.

/** A sidebar's heading, with a button that closes it. */
export function sideHead(ds: DocumentState, id: string, title: string): TemplateResult {
  return html`<div class="side-head"><h4>${title}</h4><button class="icon-btn" data-tip="Close" aria-label="Close ${title}" data-test=${"close-" + id}
    @click=${() => navigate({ sidebars: ds.s.route.sidebars.filter((x) => x !== id) }, true)}>${appIcon("close", 16)}</button></div>`;
}
