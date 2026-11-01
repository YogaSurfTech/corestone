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
