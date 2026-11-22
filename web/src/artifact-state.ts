import type { ReactiveController, ReactiveControllerHost } from "lit";
import { deepEqual } from "@corestone/ui";
import { clearLeaveGuard, navigate, setLeaveGuard, type LeaveGuard } from "./router";
import { announceEdit } from "./ws";
import { store, toastError, type State } from "./store";
import { api } from "./api";
import type { View } from "./types";
import { label } from "./components/artifact";

// What the entry view and the document view share about an artifact that is
// being edited, without any rendering: what a save sends for the fields, who
// is told about unsaved changes, and moving and deleting it.

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

/**
 * The fields a save sends: those whose value differs from the stored one,
 * and null for those that were removed. Nothing when none differs.
 */
export function fieldsPatch(stored: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (!deepEqual(v, stored[k])) patch[k] = v ?? null;
  for (const k of Object.keys(stored)) if (!(k in next)) patch[k] = null;
  return Object.keys(patch).length ? patch : undefined;
}

/**
 * The editing of one artifact in a view: while the view is on the page the
 * router asks its guard before leaving, and from the first change until the
 * changes are saved or dropped the others who look at the artifact are told
 * that it is being edited.
 */
export class EditSession implements ReactiveController {
  private editing = false;

  constructor(host: ReactiveControllerHost, private readonly guid: () => string, private readonly guard: LeaveGuard) {
    host.addController(this);
  }

  hostConnected() { setLeaveGuard(this.guard); }
  hostDisconnected() { clearLeaveGuard(this.guard); this.done(); }

  /** The artifact got an unsaved change. */
  touch(): void {
    if (!this.editing) { this.editing = true; announceEdit(this.guid(), true); }
  }

  /** The changes were saved or dropped. */
  done(): void {
    if (this.editing) { announceEdit(this.guid(), false); this.editing = false; }
  }
}

/** What a view's state needs of the element that shows it. */
export interface ViewHost extends ReactiveControllerHost, HTMLElement {
  /** The artifact the view shows. */
  guid: string;
}

/**
 * A field of a state part that the view shows: assigning it asks the view
 * for a new rendering. A field without it is bookkeeping the view never shows.
 */
export function tracked(proto: object, key: string) {
  const slot = Symbol(key);
  Object.defineProperty(proto, key, {
    get(this: Record<symbol, unknown>) { return this[slot]; },
    set(this: Record<symbol, unknown> & StatePart, value: unknown) { this[slot] = value; this.host.requestUpdate(); },
    enumerable: true, configurable: true,
  });
}

/**
 * The base of a view's state and of the parts it is made of: a part holds
 * data and what is done with it and renders nothing; the element is its host.
 */
export abstract class StatePart<H extends ViewHost = ViewHost> {
  constructor(readonly host: H) {}
  get guid(): string { return this.host.guid; }
  /** The application's state. */
  get s(): State { return store.state; }
}
