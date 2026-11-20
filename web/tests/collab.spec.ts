import { test, expect, get, post, seedDomain, stamp } from "./fixtures";

// Two users in two browser contexts: presence, live updates over the
// session channel, and conflict handling in both views.

const id = stamp();
const folder = `collab-${id}`;

test.beforeAll(async () => {
  await seedDomain(folder, "C" + id.slice(-3).toUpperCase());
});

test("presence: editing badge appears for the other user and clears on save", async ({ browser }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Shared ${id}`, fields: { priority: "low" } });
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const alice = await c1.newPage();
  const bob = await c2.newPage();
  await alice.addInitScript(() => localStorage.setItem("corestone.user", "alice"));
  await bob.addInitScript(() => localStorage.setItem("corestone.user", "bob"));
  await alice.goto(`/artifact/${e.meta.guid}`);
  await bob.goto(`/artifact/${e.meta.guid}`);
  await expect(alice.locator("header [data-test=session].ok")).toBeVisible(); // session connected
  await bob.locator("[data-test=title]").fill("bob is typing");
  await expect(alice.locator(".detail-head .presence")).toContainText("bob");
  await expect(bob.locator(".detail-head .presence")).toHaveCount(0); // never lists yourself
  await bob.locator("[data-test=save]").click();
  await expect(bob.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(alice.locator(".detail-head .presence")).toHaveCount(0);
  // alice's view refreshed with bob's change without reloading
  await expect(alice.locator("corestone-detail [data-test=title]")).toHaveValue("bob is typing");
  await c1.close();
  await c2.close();
});

test("live updates: creations, transitions and deletions show up in the other session", async ({ browser }) => {
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const a = await c1.newPage();
  const b = await c2.newPage();
  await a.goto(`/folder/${folder}/live`);
  await b.goto(`/folder/${folder}/live`);
  await expect(a.locator("corestone-overview .empty-state")).toBeVisible();
  // b creates through the UI; a sees the row appear
  await b.locator("[data-test=new]").click();
  await b.locator("[data-test=new-entry]").click();
  await b.locator(".type-card[data-type=req]").click();
  await b.locator("#new-title").fill(`Live ${id}`);
  await b.locator(".dialog [data-field=priority] .enum-trigger").click();
  await b.locator('.dialog [data-field=priority] .enum-option[data-value="high"]').click();
  await b.locator("[data-test=create]").click();
  await expect(a.locator("corestone-overview table.grid tbody tr", { hasText: `Live ${id}` })).toHaveCount(1);
  // b transitions; a's table shows the new state
  await b.locator(".workflow[data-workflow=status] select").selectOption("submit");
  await b.locator("[data-test=save]").click();
  await expect(a.locator("corestone-overview table.grid tbody tr", { hasText: `Live ${id}` }).locator(".pill.state").first()).toHaveText("review");
  // a opens it, b deletes it: a lands on "not available"
  await a.locator("corestone-overview table.grid tbody tr", { hasText: `Live ${id}` }).click();
  await expect(a.locator("corestone-detail [data-test=title]")).toHaveValue(`Live ${id}`);
  await b.locator("[data-test=actions]").click();
  await b.locator("[data-test=delete]").click();
  await b.locator(".dialog .btn.danger").click();
  await expect(a.locator("corestone-detail .empty-state, corestone-detail .notice.error").first()).toBeVisible();
  await expect(a.locator("corestone-overview table.grid tbody tr", { hasText: `Live ${id}` })).toHaveCount(0);
  await c1.close();
  await c2.close();
});

test("parallel edits of different fields merge without a word", async ({ browser }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Parallel ${id}`, fields: { priority: "low", rationale: "original" } });
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const a = await c1.newPage();
  const b = await c2.newPage();
  await a.goto(`/artifact/${e.meta.guid}`);
  await b.goto(`/artifact/${e.meta.guid}`);
  await a.locator("[data-field=effort] input").fill("8");
  await b.locator("[data-field=rationale] textarea").fill("b's reason");
  await a.locator("[data-test=save]").click();
  await expect(a.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await b.locator("[data-test=save]").click();
  await expect(b.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(b.locator(".dialog")).toHaveCount(0);
  await expect(b.locator(".toast.error")).toHaveCount(0);
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/artifacts/${e.meta.guid}`);
  expect(stored.data.fields.effort).toBe(8);
  expect(stored.data.fields.rationale).toBe("b's reason");
  await c1.close();
  await c2.close();
});

test("conflicting edits: the second writer is told what overlaps, keeps the draft, and can overwrite", async ({ browser }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Conflict ${id}`, fields: { priority: "low", rationale: "original" } });
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const a = await c1.newPage();
  const b = await c2.newPage();
  await a.goto(`/artifact/${e.meta.guid}`);
  await b.goto(`/artifact/${e.meta.guid}`);
  await a.locator("[data-field=rationale] textarea").fill("a's version");
  await b.locator("[data-field=rationale] textarea").fill("b's version");
  await a.locator("[data-test=save]").click();
  await expect(a.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(b.locator("[data-field=rationale] textarea")).toHaveValue("b's version");
  await b.locator("[data-test=save]").click();
  const row = b.locator(".dialog [data-test=conflict-row]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("a's version");
  await expect(row).toContainText("b's version");
  await b.locator(".dialog [data-test=dialog-cancel]").click();
  await expect(b.locator("[data-field=rationale] textarea")).toHaveValue("b's version");
  await b.locator("[data-test=save]").click();
  await b.locator(".dialog [data-test=dialog-confirm]").click();
  await expect(b.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/artifacts/${e.meta.guid}`);
  expect(stored.data.fields.rationale).toBe("b's version");
  await c1.close();
  await c2.close();
});
