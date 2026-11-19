// What the browser remembers for the user: the only place that touches
// localStorage and sessionStorage. Without storage (private mode, blocked
// site data) reads give the fallback and writes do nothing.

export interface PrefsOptions {
  /** Keep it for this browser tab only. */
  session?: boolean;
}

const area = (o?: PrefsOptions): Storage => (o?.session ? sessionStorage : localStorage);

export const prefs = {
  /** A value stored as plain text; null if there is none. */
  text(key: string, o?: PrefsOptions): string | null {
    try { return area(o).getItem(key); } catch { return null; }
  },
  setText(key: string, value: string, o?: PrefsOptions): void {
    try { area(o).setItem(key, value); } catch { /* storage unavailable */ }
  },
  /** A value stored as JSON; the fallback if there is none or it cannot be read. */
  json<T>(key: string, fallback: T, o?: PrefsOptions): T {
    try { return JSON.parse(area(o).getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
  },
  setJson(key: string, value: unknown, o?: PrefsOptions): void {
    try { area(o).setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  remove(key: string, o?: PrefsOptions): void {
    try { area(o).removeItem(key); } catch { /* storage unavailable */ }
  },
};
