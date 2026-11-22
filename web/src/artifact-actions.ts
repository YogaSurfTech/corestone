import { html, nothing } from "lit";
import { DropMenu, fmtTime } from "@corestone/ui";
import { api } from "./api";
import { navigate } from "./router";
import { store, toastError } from "./store";
import type { View } from "./types";
import { label } from "./components/artifact";

// What an entry and a document both offer above their content: the dates and
// the actions menu (move, delete), the same in both views.

/** Deletes the artifact after asking; the view closes. */
export async function deleteArtifact(v: View) {
  const choice = await store.confirm(`Delete ${label(v.meta)}?`, { danger: true, confirmLabel: "Delete",
    text: `The artifact, its ${v.meta.links} link(s), ${v.meta.comments} comment(s) and ${v.attachments?.length ?? 0} attachment(s) are removed in one commit. History stays in Git.` });
  if (choice !== "confirm") return;
  try {
    await api.remove(v.meta.guid, v.etag);
    store.toast("Deleted", "success");
    store.refresh();
    navigate({ guid: null });
  } catch (e) { toastError(e); }
}

/** Moves the artifact to a folder that is asked for; moved gets the new version. */
export function moveArtifact(v: View, moved: (v: View) => void) {
  store.prompt("Move artifact", { text: "Target folder; leave empty for the repository root.", value: v.meta.folder ?? "", confirmLabel: "Move", folder: true }).then((folder) => {
    if (folder === null) return;
    api.move(v.meta.guid, folder).then((nv) => { moved(nv); store.toast(`Moved to ${folder || "/"}`, "success"); store.refresh(); navigate({ folder }); })
      .catch((e) => toastError(e));
  });
}

/** The actions menu of an artifact view. */
export function actionsMenu(move: () => void, remove: () => void): DropMenu {
  return new DropMenu({
    label: "Actions", cls: "actions-pop", align: "end",
    items: () => [
      { label: "Move…", test: "move", run: move },
      { label: "Delete", test: "delete", danger: true, run: remove },
    ],
  });
}

/** The top line of an artifact view: the dates, the actions (none for a historic version), expanding and closing. */
export function viewTop(v: View, o: { actions: DropMenu | null; expanded: boolean; close: () => void; cls?: string }) {
  return html`<div class="dh-top ${o.cls ?? ""}">
    <span class="dh-dates">created: ${fmtTime(v.meta.createdAt)}<span class="gap"></span>updated: ${fmtTime(v.meta.modifiedAt)}</span>
    ${o.actions ? html`<span class="dh-actions">
      <button class="btn sm icon" data-test="actions" title="Actions" aria-label="Actions" aria-haspopup="menu" aria-expanded="false"
        @click=${(e: Event) => o.actions!.toggle(e.currentTarget as HTMLElement)}>⋯</button></span>` : nothing}
    <button class="btn sm" data-test="expand" title=${o.expanded ? "Restore layout" : "Expand detail"} @click=${() => navigate({ expanded: !o.expanded })}>${o.expanded ? "⤡" : "⤢"}</button>
    <button class="btn sm icon" title="Close" aria-label="Close detail view" @click=${o.close}>✕</button>
  </div>`;
}
