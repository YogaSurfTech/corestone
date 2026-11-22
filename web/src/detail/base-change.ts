import { deepEqual } from "@corestone/ui";
import { api } from "../api";
import { pickArtifact, store, toastError } from "../store";
import type { PickerAction } from "../components/picker";
import type { Summary } from "../components/types";
import { label } from "../components/artifact";
import { type DetailState } from "./state";

// Changing an entry's base: choosing another, removing it, or creating a new one from the entry's own fields.

/** Picks a new base of the same type, or removes the current one; nothing changes until the preview is applied. */
export function pickBase(dt: DetailState) {
  const v = dt.view!;
  const base = v.meta.base;
  const actions: PickerAction[] = [{ label: "Create new base…", test: "create-base", tone: "add", run: () => startUnderlay(dt) }];
  if (base) actions.push({ label: `Remove base ${dt.base.levelLabel(base)}`, test: "remove-base", tone: "remove", run: () => { void previewBase(dt, null); } });
  void pickArtifact({ title: base ? "Change or remove the base" : "Choose or create a base", types: [v.meta.type], kinds: ["entry"], exclude: dt.guid, actions,
    why: "A base is an entry of the same type", folder: v.meta.folder })
    .then((s) => { if (s) void previewBase(dt, s); });
}

export function startUnderlay(dt: DetailState) {
  dt.base.change = null;
  dt.base.underlay = { title: dt.view?.meta.title ?? "", fields: new Set(Object.keys(dt.base.ownFields())) };
  void dt.reveal("overlay");
}

export function toggleUnderlayField(dt: DetailState, id: string, on: boolean) {
  const fields = new Set(dt.base.underlay!.fields);
  if (on) fields.add(id); else fields.delete(id);
  dt.base.underlay = { ...dt.base.underlay!, fields };
}

/** One commit: the new base with the moved fields, and this entry inheriting them. */
export async function applyUnderlay(dt: DetailState) {
  const u = dt.base.underlay, v = dt.view;
  if (!u || !v) return;
  const fields = Object.keys(dt.base.ownFields()).filter((id) => u.fields.has(id) || dt.base.mustMove(id));
  dt.edit.busy = true;
  try {
    const res = await api.underlay(dt.guid, u.title.trim(), fields, v.etag);
    store.toast(`New base ${label(res.base.meta)} created`, "success");
    dt.base.underlay = null;
    dt.reload(true);
    store.refresh();
  } catch (e) { toastError(e); }
  finally { dt.edit.busy = false; }
}

export async function previewBase(dt: DetailState, to: Summary | null) {
  try {
    const next = to ? await api.overlay(to.guid) : null;
    dt.base.underlay = null;
    dt.base.change = { to, next, keep: true };
    void dt.reveal("overlay");
  } catch (e) { toastError(e); }
}

/** Effective values before and after the base change. Values set in this entry stay; on
 *  removal with "keep", inherited values are copied into the entry. */
export function baseChangeRows(dt: DetailState) {
  const c = dt.base.change!, ov = dt.base.overlay!;
  const own = dt.base.ownFields();
  const after: Record<string, unknown> = {}, afterFrom: Record<string, string> = {};
  if (c.next) for (const [k, v] of Object.entries(c.next.fields)) { after[k] = v; afterFrom[k] = c.next.origin[k]; }
  if (!c.to && c.keep) for (const [k, v] of Object.entries(ov.fields)) { after[k] = v; afterFrom[k] = dt.guid; }
  for (const [k, v] of Object.entries(own)) { after[k] = v; afterFrom[k] = dt.guid; }
  const levels = [...ov.chain, ...(c.next?.chain ?? [])];
  const from = (g: string | undefined) => !g ? "" : g === dt.guid ? "this entry" : ((l) => l?.hid || l?.title || g.slice(0, 8))(levels.find((l) => l.guid === g));
  const name = (id: string) => dt.schema?.fields?.find((f) => f.id === id)?.name || id;
  const ids = [...new Set([...Object.keys(ov.fields), ...Object.keys(after)])];
  return ids.map((id) => ({ id, name: name(id), before: ov.fields[id], beforeFrom: from(ov.origin[id]), after: after[id], afterFrom: from(afterFrom[id]),
    changed: !deepEqual(ov.fields[id], after[id]) }));
}

/** One update: the new base, plus on removal with "keep" the inherited values. */
export async function applyBase(dt: DetailState) {
  const c = dt.base.change, v = dt.view, ov = dt.base.overlay;
  if (!c || !v || !ov) return;
  const patch: Record<string, unknown> = { base: c.to?.guid ?? "" };
  if (!c.to && c.keep) {
    const copy = Object.fromEntries(Object.entries(ov.fields).filter(([k]) => ov.origin[k] !== dt.guid));
    if (Object.keys(copy).length) patch.fields = copy;
  }
  dt.edit.busy = true;
  try {
    await api.update(dt.guid, patch, v.etag);
    store.toast(c.to ? `Base changed to ${label(c.to)}` : "Base removed", "success");
    dt.base.change = null;
    dt.reload(true);
    store.refresh();
  } catch (e) { toastError(e); }
  finally { dt.edit.busy = false; }
}
