import { expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Leaving an artifact with unsaved changes asks first: Save, Discard
// changes, or Cancel (stay and keep editing) — for in-app navigation and
// for the browser's back button.

const id = stamp();
const folder = `unsaved-${id}`;
const guids: Record<string, string> = {};

test.beforeAll(async () => {
  await seedDomain(folder, "U" + id.slice(-3).toUpperCase());
  const a = await post("/entries", { path: folder, type: "req", title: `First ${id}`, fields: { priority: "low" } });
  const b = await post("/entries", { path: folder, type: "req", title: `Second ${id}`, fields: { priority: "low" } });
  const d = await post("/documents", { path: folder, type: "spec", title: `Doc ${id}` });
  Object.assign(guids, { a: a.meta.guid, b: b.meta.guid, d: d.meta.guid });
});

const stored = async (guid: string) => (await get<{ meta: { title: string } }>(`/entries/${guid}`)).meta.title;

for (const choice of ["cancel", "alt", "confirm"] as const) {
  test(`opening history protects unsaved work: ${choice}`, async ({ page }) => {
    const original = `History ${choice} ${id}`;
    const edited = `${original} edited`;
    const entry = await post("/entries", { path: folder, type: "req", title: original, fields: { priority: "low" } });
    const guid = entry.meta.guid;
    await page.goto(`/artifact/${guid}?folder=${folder}&tab=history`);
    const currentURL = page.url();
    const title = page.locator("corestone-detail [data-test=title]");
    await title.fill(edited);
    await page.locator("#sec-history [data-test=history-version]").first().click();
    const dialog = page.locator(".dialog", { hasText: "Unsaved changes" });
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue(edited);
    await expect(page).toHaveURL(currentURL);
    await dialog.locator(`[data-test=dialog-${choice}]`).click();

    if (choice === "cancel") {
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(currentURL);
      await expect(title).toHaveValue(edited);
      await expect(page.locator(".savebar")).toBeVisible();
      expect(await stored(guid)).toBe(original);
    } else {
      await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
      await expect(title).toHaveValue(original);
      expect(await stored(guid)).toBe(choice === "confirm" ? edited : original);
      await page.locator("[data-test=historic-back]").click();
      await expect(title).toHaveValue(choice === "confirm" ? edited : original);
      await expect(title).toBeEditable();
    }
  });
}

test("browser back and forward to history protect edits of the same artifact", async ({ page }) => {
  const original = `History browser ${id}`;
  const edited = `${original} edited`;
  const entry = await post("/entries", { path: folder, type: "req", title: original, fields: { priority: "low" } });
  const guid = entry.meta.guid;
  await page.goto(`/artifact/${guid}?folder=${folder}&tab=history`);
  await page.locator("#sec-history [data-test=history-version]").first().click();
  await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
  await page.locator("[data-test=historic-back]").click();
  const title = page.locator("corestone-detail [data-test=title]");
  await expect(title).toBeEditable();
  await title.fill(edited);
  const currentURL = page.url();
  await page.goBack();
  const dialog = page.locator(".dialog", { hasText: "Unsaved changes" });
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-test=dialog-cancel]").click();
  await expect(page).toHaveURL(currentURL);
  await expect(title).toHaveValue(edited);

  await page.goBack();
  await dialog.locator("[data-test=dialog-alt]").click();
  await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
  expect(await stored(guid)).toBe(original);
  await page.goBack();
  await expect(title).toBeEditable();
  await title.fill(edited);
  await page.goForward();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue(edited);
  await dialog.locator("[data-test=dialog-confirm]").click();
  await expect(page.locator("[data-test=historic-banner]")).toBeVisible();
  expect(await stored(guid)).toBe(edited);
});

test("an entry with unsaved changes asks before another artifact opens", async ({ page }) => {
  await page.goto(`/artifact/${guids.a}?folder=${folder}`);
  const title = page.locator("corestone-detail [data-test=title]");
  const other = page.locator("corestone-overview table.grid tbody tr", { hasText: `Second ${id}` });
  const dialog = page.locator(".dialog", { hasText: "Unsaved changes" });

  // Cancel: stay, the edit is kept
  await title.fill(`First edited ${id}`);
  await other.click();
  await expect(dialog).toContainText(`First ${id}`);
  await dialog.locator("[data-test=dialog-cancel]").click();
  await expect(page).toHaveURL(new RegExp(guids.a));
  await expect(title).toHaveValue(`First edited ${id}`);

  // Discard: leave, nothing stored
  await other.click();
  await dialog.locator("[data-test=dialog-alt]").click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Second ${id}`);
  expect(await stored(guids.a)).toBe(`First ${id}`);

  // Save: stored, then leave
  await title.fill(`Second saved ${id}`);
  await page.locator("corestone-overview table.grid tbody tr", { hasText: `First ${id}` }).click();
  await dialog.locator("[data-test=dialog-confirm]").click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`First ${id}`);
  expect(await stored(guids.b)).toBe(`Second saved ${id}`);

  // Without changes there is no question
  await page.locator("corestone-overview table.grid tbody tr", { hasText: `Second saved ${id}` }).click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Second saved ${id}`);
  await expect(dialog).toHaveCount(0);
});

test("the browser's back button asks too", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("corestone-overview table.grid tbody tr", { hasText: `First` }).first().click();
  await expect(page).toHaveURL(new RegExp(guids.a));
  await page.locator("corestone-detail [data-test=title]").fill(`Back edit ${id}`);
  await page.goBack();
  const dialog = page.locator(".dialog", { hasText: "Unsaved changes" });
  await dialog.locator("[data-test=dialog-cancel]").click();
  await expect(page).toHaveURL(new RegExp(guids.a));
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Back edit ${id}`);
});

test("a document with unsaved changes asks before closing", async ({ page }) => {
  await page.goto(`/artifact/${guids.d}`);
  const docTitle = page.locator("[data-test=doc-title]");
  await docTitle.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2");
  await page.locator("corestone-document button[title='Back to overview']").click();
  const dialog = page.locator(".dialog", { hasText: "Unsaved changes" });
  await dialog.locator("[data-test=dialog-confirm]").click();
  await expect(page.locator("corestone-document")).toHaveCount(0);
  const doc = await get<{ meta: { title: string } }>(`/documents/${guids.d}`);
  expect(doc.meta.title).toBe(`Doc ${id} v2`);
});
