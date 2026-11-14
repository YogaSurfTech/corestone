import { api, del, expect, get, post, put, seedDomain, stamp, test } from "./fixtures";

// Historic versions (TSK-22): the history list opens an artifact as it was
// after each change, read-only and marked historic, across moves.

const id = stamp();
const folder = `hist-${id}`;
const prefix = "H" + id.slice(-3).toUpperCase();

test.beforeAll(async () => {
  await seedDomain(folder, prefix);
});

test("the history opens read-only historic versions, also across a move", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `First ${id}`, fields: { priority: "low" } });
  const guid = e.meta.guid;
  await put(`/artifacts/${guid}`, { title: `Second ${id}`, fields: { priority: "high" } });
  const tc = await post("/entries", { path: folder, type: "tc", title: `Checker ${id}` });
  await post("/links", { type: "verifies", source: tc.meta.guid, target: guid });
  await post(`/artifacts/${guid}/move`, { path: `${folder}/moved` });
  await put(`/artifacts/${guid}`, { title: `Third ${id}` });

  await page.goto(`/artifact/${guid}?tab=history`);
  const rows = page.locator("#sec-history .history-row");
  await expect(rows).toHaveCount(5); // update, move, link created, update, create
  await expect(rows.nth(2)).toContainText("Link verifies");
  const detail = page.locator("corestone-detail");
  await expect(detail).not.toHaveClass(/historic/);

  // The creation: first title, old folder, no link yet, nothing editable.
  await rows.nth(4).locator("[data-test=history-version]").click();
  await expect(page).toHaveURL(new RegExp(`/artifact/${guid}\\?.*version=[0-9a-f]{40}.*at=[0-9a-f]{40}`));
  await expect(detail).toHaveClass(/historic/);
  await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
  await expect(page.locator("[data-test=title]")).toHaveValue(`First ${id}`);
  await expect(page.locator("[data-test=title]")).toHaveAttribute("readonly", "");
  await expect(page.locator(".dh-crumbs a").last()).toHaveText(folder);
  await expect(page.locator("[data-test=actions]")).toBeHidden();
  await expect(page.locator("#sec-relationships")).not.toContainText(`Checker ${id}`); // no link yet
  await expect(page.locator("#sec-relationships .actions button")).toHaveCount(0);
  await expect(page.locator(".workflow select")).toHaveCount(0);
  await expect(page.locator("[data-test=comment-text]")).toHaveCount(0);
  await expect(page.locator("#sec-history [data-test=history-shown]")).toHaveCount(1);
  await expect(page.locator("[data-test=title]")).not.toBeEditable();
  await expect(page.locator("[data-test=hid]")).not.toBeEditable();
  await expect(page.locator("#sec-fields input, #sec-fields textarea").first()).not.toBeEditable();
  await expect(page.locator(".savebar")).toHaveCount(0);

  // After the move: the second title in the new folder, with the link of then.
  await page.locator("#sec-history .history-row").nth(1).locator("[data-test=history-version]").click();
  await expect(page.locator("[data-test=title]")).toHaveValue(`Second ${id}`);
  await expect(page.locator(".dh-crumbs a").last()).toHaveText("moved");
  await expect(page.locator("#sec-relationships")).toContainText(`Checker ${id}`);
  await expect(page.locator("#sec-relationships")).toContainText("verified by");

  // The browser's back button returns to the previous version, then "Back to current".
  await page.goBack();
  await expect(page.locator("[data-test=title]")).toHaveValue(`First ${id}`);
  await page.locator("[data-test=historic-back]").click();
  await expect(detail).not.toHaveClass(/historic/);
  await expect(page.locator("[data-test=title]")).toHaveValue(`Third ${id}`);
  await expect(page.locator("[data-test=title]")).not.toHaveAttribute("readonly", "");
  await expect(page).not.toHaveURL(/version=/);
});

test("the history comes in batches; versions are only served for the artifact's own blobs", async () => {
  const e = await post("/entries", { path: folder, type: "req", title: `Paged ${id}`, fields: { priority: "low" } });
  const guid = e.meta.guid;
  for (const t of ["a", "b", "c"]) await put(`/artifacts/${guid}`, { title: `Paged ${id} ${t}` });
  type Page = { history: { sha: string; blob?: string }[]; more: boolean };
  const first = await get<Page>(`/artifacts/${guid}/history?limit=3`);
  expect(first.history).toHaveLength(3);
  expect(first.more).toBe(true);
  const rest = await get<Page>(`/artifacts/${guid}/history?limit=3&before=${first.history[2].sha}`);
  expect(rest.history).toHaveLength(1);
  expect(rest.more).toBe(false);
  expect(rest.history[0].blob).toBe(e.etag);

  const other = await post("/entries", { path: folder, type: "tc", title: `Other ${id}` });
  expect((await fetch(`${api}/artifacts/${guid}/versions/${other.etag}`)).status).toBe(404);
  const ok = await fetch(`${api}/artifacts/${guid}/versions/${e.etag}?commit=${rest.history[0].sha}`);
  expect(ok.status).toBe(200);
  expect((await ok.json()).exact).toBe(true);
});

test("a version shows the links and comments of its time, the other side as it was then", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Subject ${id}`, fields: { priority: "low" } });
  const guid = e.meta.guid;
  const tc = await post("/entries", { path: folder, type: "tc", title: `Old name ${id}` });
  const link = await post("/links", { type: "verifies", source: tc.meta.guid, target: guid });
  const comment = await post("/comments", { subject: guid, text: `Said then ${id}` });
  await put(`/artifacts/${guid}`, { title: `Subject 2 ${id}` });
  await put(`/artifacts/${tc.meta.guid}`, { title: `New name ${id}` });
  await del(`/artifacts/${comment.meta.guid}`);
  await del(`/artifacts/${link.meta.guid}`);

  await page.goto(`/artifact/${guid}?tab=history`);
  const rows = page.locator("#sec-history .history-row");
  await expect(rows).toHaveCount(6); // link deleted, comment deleted, update, comment, link, create
  await expect(page.locator("#sec-relationships")).not.toContainText(`Old name ${id}`);

  // After the update: the link and the comment deleted since, the test case under its old name.
  await rows.nth(2).locator("[data-test=history-version]").click();
  await expect(page.locator("[data-test=title]")).toHaveValue(`Subject 2 ${id}`);
  await expect(page.locator("#sec-relationships")).toContainText(`Old name ${id}`);
  await expect(page.locator("#sec-relationships")).not.toContainText(`New name ${id}`);
  await expect(page.locator("#sec-comments")).toContainText(`Said then ${id}`);

  // The other side opens as it was at the same commit.
  await page.locator("#sec-relationships").getByRole("link", { name: new RegExp(`Old name ${id}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/artifact/${tc.meta.guid}\\?.*version=${tc.etag}`));
  await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
  await expect(page.locator("[data-test=title]")).toHaveValue(`Old name ${id}`);
});
