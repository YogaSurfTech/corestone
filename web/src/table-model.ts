import { compare, type SortValue } from "./sorting";
import type { SortLevel } from "./types";

/** Rows are fetched in batches of this size as they scroll into view. */
export const BATCH = 50;

/** Promote a column, keeping two tie-breakers; only the primary toggles direction. */
export function promoteSort(levels: SortLevel[], col: string): SortLevel[] {
  const previous = levels.find((level) => level.col === col);
  const dir = levels[0]?.col === col ? (levels[0].dir === "asc" ? "desc" : "asc") : previous?.dir ?? "asc";
  return [{ col, dir }, ...levels.filter((level) => level.col !== col)].slice(0, 3);
}

/** The batches covering rows [start, end). */
export function batchesFor(start: number, end: number): number[] {
  const out: number[] = [];
  for (let b = Math.floor(start / BATCH); b * BATCH < end; b++) out.push(b);
  return out;
}

/**
 * Rows held in the browser, ordered by up to three levels; ties keep the
 * given order. Levels whose column has no value function are skipped.
 */
export function sortLocal<T>(rows: T[], levels: SortLevel[], value: (col: string) => ((row: T) => SortValue) | undefined): T[] {
  const active = levels.flatMap((l) => { const v = value(l.col); return v ? [{ v, dir: l.dir === "asc" ? 1 : -1 }] : []; });
  if (!active.length) return rows;
  return rows.map((row) => ({ row, keys: active.map((l) => l.v(row)) })).sort((a, b) => {
    for (let i = 0; i < active.length; i++) {
      const r = compare(a.keys[i], b.keys[i], active[i].dir);
      if (r) return r;
    }
    return 0;
  }).map((x) => x.row);
}
