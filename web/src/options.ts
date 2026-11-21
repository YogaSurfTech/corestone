// Options of dynamic enumerations: an enum field with a source offers
// artifacts, and its value is the chosen artifact's GUID. The options are
// loaded per type, field and folder, and shared briefly by editors and tables.
import { api } from "./api";
import type { EnumOption, Field } from "./types";
import { hidLabel } from "./util";

const TTL = 30_000;
const cache = new Map<string, { at: number; loading: Promise<EnumOption[]>; options?: EnumOption[] }>();

/** The options of a field with a source, in the source's order. */
export function sourceOptions(type: string, field: string, folder: string): Promise<EnumOption[]> {
  const key = JSON.stringify([type, field, folder]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.loading;
  const entry: { at: number; loading: Promise<EnumOption[]>; options?: EnumOption[] } = { at: Date.now(), loading: Promise.resolve([]) };
  entry.loading = api.options(type, field, folder)
    .then((r) => (entry.options = r.options.map((s) => ({ value: s.guid, label: hidLabel(s) }))))
    .catch((error) => { cache.delete(key); throw error; });
  cache.set(key, entry);
  return entry.loading;
}

/** The options if they are loaded; otherwise loads them and calls loaded() once they are there. */
export function knownOptions(type: string, field: string, folder: string, loaded: () => void): EnumOption[] | undefined {
  const hit = cache.get(JSON.stringify([type, field, folder]));
  if (hit?.options && Date.now() - hit.at < TTL) return hit.options;
  if (hit?.options === undefined || Date.now() - hit.at >= TTL) void sourceOptions(type, field, folder).then(loaded, () => {});
  return hit?.options;
}

/** The options plus the field's values that are no option any more (the artifact was deleted or retyped). */
export function withMissing(options: EnumOption[], value: unknown): EnumOption[] {
  const values = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  const missing = values.filter((v): v is string => typeof v === "string" && !options.some((o) => o.value === v));
  return missing.length ? [...options, ...missing.map((v) => ({ value: v, label: "Missing item" }))] : options;
}

/** Whether the field is a dynamic enumeration. */
export const hasSource = (f: Field | undefined): boolean => !!f && f.type === "enum" && !!f.source;
