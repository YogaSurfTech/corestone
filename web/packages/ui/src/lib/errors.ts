/**
 * What to show for something that was thrown: its message if it has one,
 * otherwise the fallback, otherwise the thing as text.
 */
export function errorText(e: unknown, fallback?: string): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof m === "string" && m) return m;
  return fallback ?? String(e);
}
