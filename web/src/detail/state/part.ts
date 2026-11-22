import { type SaveChanges } from "../../api";
import { StatePart } from "../../artifact-state";
import type { VersionView, View } from "../../types";
import { type DetailHost, type DetailState } from "../state";

/** One kind of change that waits for Save: how many, and its name for one and for several. */
export type Waiting = [count: number, one: string, many?: string];

/**
 * A part of the entry view's state: one concern of the artifact (its links,
 * its comments, …) with the data loaded for it, what the user does with it
 * and what of that waits for Save. The state asks every part the same things;
 * a part answers those that concern it.
 */
export abstract class DetailPart extends StatePart<DetailHost> {
  constructor(protected readonly d: DetailState) { super(d.host); }

  /** Fetches what the part shows of the artifact; the result puts it in place (not called when the load is dropped). */
  fetch(_view: View): Promise<() => void> { return Promise.resolve(() => {}); }
  /** Takes what the part shows from a historic version. */
  show(_version: VersionView): void {}
  /** Forgets what was loaded: another artifact is coming. */
  clear(): void {}

  /** What waits for Save, for the save bar. */
  waiting(): Waiting[] { return []; }
  /** What Save sends for the part. */
  changes(): SaveChanges { return {}; }
  /** Drops what waits for Save. */
  reset(): void {}
  /** A save went through. */
  saved(): void {}

  /** The user changed something that waits for Save. */
  protected touched(): void { this.d.edit.touched(); }
}
