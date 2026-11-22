import type { ReactiveController, ReactiveControllerHost } from "lit";
import { deepEqual } from "@corestone/ui";
import { clearLeaveGuard, setLeaveGuard, type LeaveGuard } from "./router";
import { announceEdit } from "./ws";
import { store, type State } from "./store";

// What the entry view and the document view share about an artifact that is
// being edited, without any rendering: what a save sends for the fields, and
// who is told about unsaved changes.

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
