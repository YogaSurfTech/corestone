import { Resizer } from "@corestone/ui";
import { api } from "../../api";
import { tracked } from "../../artifact-state";
import type { OverlayView, VersionView, View } from "../../types";
import type { Summary } from "../../components/types";
import { type OverlayState } from "../../components/fields";
import { DetailPart } from "./part";

/** The entry among its base and its overlays: what it inherits, and a change of its base under review. */
export class Base extends DetailPart {
  @tracked overlay: OverlayView | null = null;
  /** The base's effective fields: what this entry shows where it sets nothing itself. */
  @tracked baseOverlay: OverlayView | null = null;
  /** A base change shown for review: the new base (null removes it) and that base's effective fields. */
  @tracked change: { to: Summary | null; next: OverlayView | null; keep: boolean } | null = null;
  /** A new base being set up from fields this entry sets itself: its title and the fields that move. */
  @tracked underlay: { title: string; fields: Set<string> } | null = null;

  /** The height of the comparison in the base change preview, px; 0 while it has its own height. */
  readonly diffHeight = new Resizer({
    key: "corestone.height.baseDiff", min: 60, get max() { return window.innerHeight; }, axis: "y", step: 16,
    at: (m, box) => m.clientY - box.top,
    changed: () => this.host.requestUpdate(),
  });

  override async fetch(view: View) {
    const entry = view.meta.kind === "entry";
    const [overlay, baseOverlay] = await Promise.all([
      entry ? api.overlay(view.meta.guid).catch(() => null) : null,
      entry && view.meta.base ? api.overlay(view.meta.base).catch(() => null) : null,
    ]);
    return () => { this.overlay = overlay; this.baseOverlay = baseOverlay; };
  }

  override show(v: VersionView) {
    this.overlay = v.overlay ? { ...v.overlay, overlays: [] } : null;
    this.baseOverlay = v.baseOverlay ? { ...v.baseOverlay, overlays: [] } : null;
  }

  override clear() { this.overlay = null; this.baseOverlay = null; this.change = null; this.underlay = null; }

  /** Overlay state of a field the base chain provides a value for; null when the base sets nothing. */
  overlayState(fieldId: string): OverlayState | null {
    const base = this.baseOverlay;
    if (!base || base.fields[fieldId] === undefined) return null;
    return { from: this.levelLabel(base.origin[fieldId]), state: this.d.edit.draft!.fields[fieldId] === undefined ? "inherited" : "overridden", baseValue: base.fields[fieldId] };
  }

  /** An overlay chain level by HID, then title, then short GUID. */
  levelLabel(guid: string): string {
    const lvl = this.overlay?.chain.find((l) => l.guid === guid);
    return lvl?.hid || lvl?.title || guid.slice(0, 8);
  }

  /** The fields this entry sets itself, which can move into a new base. A workflow's state cannot: every entry has its own. */
  ownFields(): Record<string, unknown> {
    const own = ((this.d.view?.data as Record<string, unknown> | undefined)?.fields ?? {}) as Record<string, unknown>;
    const workflows = new Set((this.d.schema?.fields ?? []).filter((f) => f.type === "workflow").map((f) => f.id));
    return Object.fromEntries(Object.entries(own).filter(([id]) => !workflows.has(id)));
  }

  /** Without a base of its own, a new base must contain the required fields. */
  mustMove(id: string): boolean {
    return !this.d.view?.meta.base && !!this.d.schema?.fields?.find((f) => f.id === id)?.required;
  }
}
