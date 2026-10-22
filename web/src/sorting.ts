import type { Schema, Summary, Workflow } from "./types";

interface RankedValue { value: string; rank: number }
type ScalarValue = string | number | null | RankedValue;
export type SortValue = ScalarValue | ScalarValue[];
export type WorkflowLookup = (id: string) => Workflow | undefined;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Definition order, otherwise natural order; unlisted and empty values stay last. */
function compareScalar(a: ScalarValue, b: ScalarValue, dir: number): number {
  const ea = a === null || a === "", eb = b === null || b === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const ra = typeof a === "object" && a !== null ? a.rank : Infinity;
  const rb = typeof b === "object" && b !== null ? b.rank : Infinity;
  if (ra !== Infinity || rb !== Infinity) {
    if (ra === Infinity || rb === Infinity) return ra === Infinity ? 1 : -1;
    return dir * (ra - rb);
  }
  a = typeof a === "object" && a !== null ? a.value : a;
  b = typeof b === "object" && b !== null ? b.value : b;
  return dir * (typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b)));
}

export function compare(a: SortValue, b: SortValue, dir: number): number {
  const left = Array.isArray(a) ? a : [a], right = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const result = compareScalar(left[i] ?? null, right[i] ?? null, dir);
    if (result) return result;
  }
  return 0;
}

export function fieldValue(row: Summary, id: string): string | number | null {
  const v = row.fields?.[id];
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return "{…}";
  return String(v);
}

function ranked(value: string, sequence: string[]): RankedValue {
  const index = sequence.indexOf(value);
  return { value, rank: index < 0 ? Infinity : index };
}

function workflowValue(value: string | number | null, workflow?: Workflow): ScalarValue {
  if (value === null || value === "") return null;
  return ranked(String(value), workflow?.states.map((s) => s.id) ?? []);
}

export function fieldSortValue(row: Summary, id: string, schema?: Schema, workflow?: WorkflowLookup): SortValue {
  const value = fieldValue(row, id);
  const field = schema?.fields?.find((f) => f.id === id);
  if (field?.type === "workflow") {
    return workflowValue(value, field.workflow ? workflow?.(field.workflow) : undefined);
  }
  if (field?.type !== "enum" || value === null || value === "") return value;
  const raw = row.fields?.[id];
  const values = Array.isArray(raw) ? raw.map(String) : [String(value)];
  let highest: RankedValue | null = null;
  for (const v of values) {
    if (v === "") continue;
    const candidate = ranked(v, field.options?.map((o) => o.value) ?? []);
    if (highest === null || compareScalar(candidate, highest, 1) > 0) highest = candidate;
  }
  return highest;
}

/** Compare each workflow in the type's declared order, not the stored object's order. */
export function workflowSortValue(row: Summary, schema: Schema | undefined, workflow: WorkflowLookup): SortValue {
  const ids = [...new Set([...(schema?.workflows ?? []), ...Object.keys(row.workflows ?? {}).sort()])];
  return ids.map((id) => workflowValue(row.workflows?.[id] ?? null, workflow(id)));
}

export function workflowKey(row: Pick<Summary, "folder" | "type">, id: string): string {
  return JSON.stringify([row.folder, row.type, id]);
}
