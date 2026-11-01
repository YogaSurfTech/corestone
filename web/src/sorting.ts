import type { Summary } from "./types";

interface RankedValue { value: string; rank: number }
type ScalarValue = string | number | null | RankedValue;
export type SortValue = ScalarValue | ScalarValue[];

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
