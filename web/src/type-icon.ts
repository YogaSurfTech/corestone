import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api } from "./api";
import { store } from "./store";
import type { Kind, Schema } from "./types";
import { kindIcon } from "./util";

// Types visible per folder, shared by all icons on the page and dropped
// whenever the repository changes.
let cache = new Map<string, Promise<Schema[]>>();
let cacheTick = -1;
function typesAt(folder: string): Promise<Schema[]> {
  if (store.state.refreshTick !== cacheTick) { cache = new Map(); cacheTick = store.state.refreshTick; }
  let p = cache.get(folder);
  if (!p) {
    p = api.types(folder).then((r) => r.types).catch(() => []);
    cache.set(folder, p);
  }
  return p;
}

/** URL of an icon as seen from a folder: the nearest folder defining it wins. */
export function iconUrl(name: string, folder: string): string {
  return `/api/icons/${encodeURIComponent(name)}?path=${encodeURIComponent(folder)}`;
}

/**
 * The icon of an artifact's type (presentation.icon of its schema), or the
 * kind's letter when the type has none or the icon cannot be loaded.
 */
@customElement("corestone-type-icon")
export class TypeIcon extends LitElement {
  @property() kind: Kind = "entry";
  @property() type = "";
  @property() folder = "";
  /** The type's schema when the caller already has it; null for "no schema". */
  @property({ attribute: false }) schema: Schema | null | undefined = undefined;
  @state() private resolved: Schema | null = null;
  @state() private broken = false;

  override createRenderRoot() { return this; }

  override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("schema") && !changed.has("type") && !changed.has("folder")) return;
    this.broken = false;
    if (this.schema !== undefined) { this.resolved = this.schema; return; }
    const { type, folder } = this;
    this.resolved = null;
    if (!type) return;
    void typesAt(folder).then((types) => {
      if (type === this.type && folder === this.folder && this.schema === undefined) this.resolved = types.find((t) => t.type === type) ?? null;
    });
  }

  override render() {
    const icon = this.resolved?.presentation?.icon;
    if (typeof icon !== "string" || !icon || this.broken) return kindIcon(this.kind);
    const name = this.resolved?.displayName || this.type;
    return html`<img class="type-icon" src=${iconUrl(icon, this.folder)} width="16" height="16" alt=${name} title=${name} @error=${() => (this.broken = true)} />`;
  }
}
