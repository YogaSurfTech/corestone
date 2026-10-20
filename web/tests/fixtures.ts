import { test as base, expect, type Page } from "@playwright/test";

// Shared harness: an API helper bound to the server under test, a unique
// folder per spec, and a guard that fails any test in which the page
// threw an uncaught exception.

export const base_url = process.env.CORESTONE_URL || "http://127.0.0.1:18090";
export const api = base_url + "/api";

/** Sends a write, honouring 503 + Retry-After (maintenance mode) like a well-behaved client. */
async function write(method: string, path: string, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(api + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 503 && attempt < 40) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
export async function put(path: string, body: unknown) {
  return write("PUT", path, body);
}
export async function post<T = { meta: { guid: string; hid?: string; folder: string }; etag: string }>(path: string, body: unknown): Promise<T> {
  return write("POST", path, body) as Promise<T>;
}
export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(api + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
export async function del(path: string) {
  const res = await fetch(api + path, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}

/** Answers the in-app prompt dialog (store.prompt) with a value. */
export async function answerPrompt(page: import("@playwright/test").Page, value: string) {
  const input = page.locator(".dialog input[data-test=prompt]");
  await input.waitFor();
  await input.fill(value);
  await input.press("Enter");
  await page.locator(".dialog.prompt").waitFor({ state: "detached" });
}

export function stamp(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

/** Writes one configuration file (docs/CONFIGURATION.md) below a folder. */
export async function putConfig(scope: string, path: string, body: unknown) {
  return put(`/config?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`, body);
}

type ConfigKind = "entries" | "documents" | "links" | "comments";
type TypeSpec = { id: string; fields?: Record<string, unknown>[]; [k: string]: unknown };

/** Defines the types of one kind in a folder: types.json, and each type's
 *  own fields in <type>-fields.json (which the type uses without listing them). */
export async function defineTypes(scope: string, kind: ConfigKind, types: TypeSpec[], opts: { inheritance?: "off" } = {}) {
  for (const t of types) {
    if (t.fields?.length) await putConfig(scope, `${kind}/${t.id}-fields.json`, { fields: t.fields });
  }
  await putConfig(scope, `${kind}/types.json`, { ...opts, types: types.map(({ fields: _fields, ...t }) => t) });
}

/** Adds a type to a folder's existing types.json of a kind. */
export async function addType(scope: string, kind: ConfigKind, t: TypeSpec) {
  const cur = await get<{ types: Record<string, unknown>[] }>(`/config?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(kind + "/types.json")}`);
  if (t.fields?.length) await putConfig(scope, `${kind}/${t.id}-fields.json`, { fields: t.fields });
  const { fields: _fields, ...rest } = t;
  await putConfig(scope, `${kind}/types.json`, { ...cur, types: [...cur.types, rest] });
}

/** Workflows are configured per kind: writes one for each kind that uses it. */
export async function defineWorkflow(scope: string, kinds: ConfigKind[], id: string, def: Record<string, unknown>) {
  for (const k of kinds) await putConfig(scope, `${k}/workflows/${id}-workflow.json`, def);
}

/** A workflow + entry/document/link/comment types under one scope. */
export async function seedDomain(scope: string, prefix: string) {
  await defineWorkflow(scope, ["entries"], "dev", { name: "Development", initial: "open", states: ["open", "review", "done"],
    transitions: [{ id: "submit", name: "Submit for review", from: "open", to: "review" }, { id: "approve", name: "Approve", from: "review", to: "done" }, { id: "rework", from: "review", to: "open" }] });
  await defineWorkflow(scope, ["entries", "documents"], "publish", { name: "Publishing", initial: "draft", states: ["draft", "released"],
    transitions: [{ id: "release", from: "draft", to: "released" }, { id: "withdraw", from: "released", to: "draft" }] });
  await defineTypes(scope, "entries", [
    { id: "req", displayName: "Requirement", hid: { prefix }, workflows: ["dev", "publish"],
      fields: [{ id: "priority", name: "Priority", type: "enum", required: true, options: [{ value: "low" }, { value: "high" }] },
               { id: "rationale", name: "Rationale", type: "multiline" }, { id: "effort", name: "Effort", type: "integer" }],
      presentation: { columns: ["priority", "effort"] } },
    { id: "tc", displayName: "Test case", hid: { prefix: prefix + "T" } },
  ]);
  await defineTypes(scope, "documents", [{ id: "spec", displayName: "Specification", workflows: ["publish"],
    fields: [{ id: "audience", name: "Audience", type: "enum", options: [{ value: "internal" }, { value: "customer" }] }] }]);
  await defineTypes(scope, "links", [
    { id: "verifies", displayName: "verifies", sourceTypes: ["tc"], targetTypes: ["req"], cardinality: "many-to-many",
      fields: [{ id: "coverage", name: "Coverage", type: "enum", options: [{ value: "full" }, { value: "partial" }] }] },
    { id: "related", displayName: "related to" },
  ]);
  await defineTypes(scope, "comments", [{ id: "comment", displayName: "Comment" }]);
}

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
    expect(errors, "uncaught page errors").toEqual([]);
  }, { auto: true }],
});

export { expect };
export type { Page };

/** Waits until the artifact overview shows the given title. */
export async function rowWithTitle(page: Page, title: string) {
  const row = page.locator("table.grid tbody tr", { hasText: title });
  await expect(row).toHaveCount(1);
  return row;
}
