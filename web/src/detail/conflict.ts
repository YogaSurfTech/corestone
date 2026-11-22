import { html, nothing } from "lit";
import { fmtTime } from "@corestone/ui";
import { type SaveConflict, type SaveConflictItem } from "../api";
import { store } from "../store";
import { label, showValue } from "../components/artifact";
import { type DetailState } from "./state";

// The dialog for a save that met changes of someone else to the same things.

/** Both changed the same things: name them, then cancel or overwrite exactly that version. */
export function conflictDialog(dt: DetailState, c: SaveConflict) {
  const v = dt.view!;
  const fmt = (x: unknown) => x === undefined || x === null || x === "" ? html`<span class="muted">empty</span>`
    : html`<span class="pre-line">${showValue(x)}</span>`;
  const row = (it: SaveConflictItem) => html`<tr data-test="conflict-row">
    <th>${dt.conflictLabel(it.key)}</th>
    <td>${fmt(it.theirs)}<div class="muted small">${it.author ?? "someone"}${it.time ? html` · ${fmtTime(it.time)}` : nothing}</div></td>
    <td>${fmt(it.mine)}</td></tr>`;
  void store.confirm("Changed by someone else", { danger: true, confirmLabel: "Overwrite", resizable: "conflict",
    text: `While you were editing ${label(v.meta)}, someone else changed the same things. Your other changes merge without loss.`,
    body: html`<p><a href=${`/artifact/${v.meta.guid}`} target="_blank" rel="noopener" data-test="conflict-current">Open the current version in a new tab</a></p>
      <table class="base-diff conflict-table" data-test="conflicts"><thead><tr><th></th><th>Theirs (now)</th><th>Yours</th></tr></thead>
      <tbody>${c.conflicts.map(row)}</tbody></table>`,
  }).then((choice) => { if (choice === "confirm") void dt.save(c.etag); });
}
