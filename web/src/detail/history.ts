import { html, nothing } from "lit";
import { fmtTime } from "@corestone/ui";
import { navigate } from "../router";
import type { HistoryEntry } from "../types";
import type { TableColumn } from "../components/table/table";
import { type DetailState } from "./state";
import { sectionOf } from "./parts";

// The commits that touched the artifact.

/** The commits that touched the artifact, newest first; each opens the artifact as it was then. */
export function historySection(dt: DetailState) {
  // Documents open in the document view, which shows no versions yet.
  const linkable = (h: HistoryEntry) => !!h.blob && dt.view?.meta.kind !== "document";
  const shown = (h: HistoryEntry) => !!dt.historic && h.sha === dt.historic.commit.sha;
  const open = (h: HistoryEntry) => { if (linkable(h)) navigate({ version: h.blob!, at: h.sha }); };
  return sectionOf(dt, "history", () => !dt.historyLoaded ? html`<div class="muted small">Loading…</div>` : html`
    ${!dt.history.length ? nothing : html`<corestone-table class="detail-table" data-test="history" .items=${dt.history} .rowKey=${(h: HistoryEntry) => h.sha}
      .rowClass=${(h: HistoryEntry) => `history-row ${linkable(h) ? "open-row" : ""} ${shown(h) ? "shown" : ""}`} .columns=${[
      { id: "when", name: "When", width: 150, value: (h) => h.time, render: (h) => html`<span class="when" title=${h.time}>${fmtTime(h.time)}</span>` },
      { id: "change", name: "Change", value: (h) => h.subject, render: (h) => html`${linkable(h)
        ? html`<a href=${`/artifact/${dt.guid}?version=${h.blob}&at=${h.sha}`} data-test="history-version" title="Show the artifact as it was after this change"
            @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); open(h); }}>${h.subject}</a>`
        : h.subject}${h.trailers?.["Corestone-Op"] ? html` <span class="pill">${h.trailers["Corestone-Op"]}</span>` : nothing}
        ${(h.recreates ?? []).map((r) => html`<div class="muted small" data-test="history-recreates">Same link as one deleted
          ${r.deletedAt ? fmtTime(r.deletedAt) : ""}${r.deletedBy ? ` by ${r.deletedBy}` : ""}${r.blob ? html` · <a href=${`/artifact/${r.prior}?version=${r.blob}${r.at ? `&at=${r.at}` : ""}`}
            data-test="history-recreates-prior" @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); navigate({ guid: r.prior, version: r.blob!, at: r.at ?? "" }); }}>show it</a>` : nothing}</div>`)}` },
      { id: "author", name: "Author", width: 130, value: (h) => h.author, render: (h) => html`<span class="muted small">${h.author}</span>` },
      { id: "commit", name: "Commit", width: 100, value: (h) => h.sha, render: (h) => html`<span class="mono muted">${h.sha.slice(0, 8)}</span>` },
    ] satisfies TableColumn<HistoryEntry>[]} @row-click=${(e: CustomEvent<HistoryEntry>) => open(e.detail)}></corestone-table>`}
    ${!dt.history.length ? html`<div class="muted small">No history yet.</div>` : nothing}
    ${dt.historyMore ? html`<button class="btn sm" data-test="history-more" style="margin-top:6px" @click=${() => dt.loadHistory(true)}>Load older changes</button>` : nothing}`);
}
