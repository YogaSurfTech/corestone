import { html, nothing } from "lit";
import { fmtTime } from "@corestone/ui";
import { navigate } from "../router";
import { type DetailState } from "./state";
import { sectionOf } from "./parts";

// The read-only properties of the artifact that no other section shows.

/** Every read-only property not shown elsewhere, plus extra stored properties. */
export function metadataSection(dt: DetailState) {
  const v = dt.view!;
  const d = { ...(v.data as Record<string, unknown>) };
  for (const k of ["guid", "kind", "type", "title", "hid", "fields", "workflows", "content"]) delete d[k];
  return sectionOf(dt, "metadata", () => html`
    <dl class="kv">
      <dt>Type</dt><dd>${dt.schema?.displayName ?? v.meta.type} <span class="muted">(${v.meta.type}${dt.schema ? "" : ", no schema"})</span></dd>
      <dt>Kind</dt><dd>${v.meta.kind}</dd>
      <dt>Folder</dt><dd><a href=${"/folder/" + v.meta.folder} @click=${(e: Event) => { e.preventDefault(); navigate({ folder: v.meta.folder, guid: null }); }}>${v.meta.folder || "/"}</a></dd>
      <dt>GUID</dt><dd class="mono">${v.meta.guid}</dd>
      <dt>ETag</dt><dd class="mono">${v.etag.slice(0, 12)}</dd>
      <dt>Created</dt><dd>${fmtTime(v.meta.createdAt)}</dd>
      <dt>Modified</dt><dd>${fmtTime(v.meta.modifiedAt)}</dd>
      ${dt.schema?.sources?.length ? html`<dt>Schema from</dt><dd>${dt.schema.sources.map((s) => s || "/").join(" → ")}</dd>` : nothing}
      <dt>Path</dt><dd class="mono">${v.meta.path}</dd>
    </dl>
    <h4 class="small muted" style="margin-top:10px">Additional properties</h4>
    ${Object.keys(d).length ? html`<pre class="json">${JSON.stringify(d, null, 2)}</pre>` : html`<div class="muted small">No extra properties. Tools may add their own; they are preserved on save.</div>`}`);
}
