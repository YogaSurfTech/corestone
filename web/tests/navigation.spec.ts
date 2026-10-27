import { answerPrompt, api, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Navigation and shell behaviour: keyboard shortcuts, breadcrumbs,
// history navigation, deep links, filters, kind chips, columns, sorting,
// collapse state, responsive layout, dark mode, status and reindex.

const id = stamp();
const folder = `nav-${id}`;
const guids: Record<string, string> = {};

test.beforeAll(async () => {
  await seedDomain(folder, "N" + id.slice(-3).toUpperCase());
  const a = await post("/entries", { path: `${folder}/alpha`, type: "req", title: `Alpha one ${id}`, fields: { priority: "high", effort: 1 } });
  const b = await post("/entries", { path: `${folder}/beta`, type: "req", title: `Beta two ${id}`, fields: { priority: "low", effort: 2 } });
  const t = await post("/entries", { path: `${folder}/alpha`, type: "tc", title: `Gamma test ${id}` });
  const d = await post("/documents", { path: `${folder}/beta`, type: "spec", title: `Delta doc ${id}` });
  await post("/links", { type: "verifies", source: t.meta.guid, target: a.meta.guid });
  await post("/comments", { subject: a.meta.guid, text: "note", author: "nav" });
  Object.assign(guids, { a: a.meta.guid, b: b.meta.guid, t: t.meta.guid, d: d.meta.guid });
});

test("keyboard shortcuts, breadcrumbs and browser history", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.keyboard.press("/");
  await expect(page.locator("[data-test=search]")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 700, y: 700 } });
  await page.keyboard.press("n");
  await expect(page.locator(".dialog")).toContainText("What do you want to create");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dialog")).toHaveCount(0);
  // breadcrumbs
  await page.locator(`.tree .row[data-folder="${folder}/alpha"]`).click();
  await expect(page.locator("header .crumbs")).toContainText("alpha");
  await page.locator("header .crumbs a", { hasText: folder }).click();
  await expect(page.locator(".toolbar .title")).toHaveText(folder);
  // open an artifact, Escape closes it, back reopens it
  await page.locator(`.tree .row[data-folder="${folder}/alpha"]`).click();
  await page.locator("table.grid tbody tr", { hasText: `Alpha one ${id}` }).click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  await page.locator("body").click({ position: { x: 700, y: 60 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("corestone-detail")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  await page.goBack();
  await expect(page.locator("corestone-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  // the header brand goes home
  await page.locator("header .brand").click();
  await expect(page.locator(".toolbar .title")).toHaveText("Repository");
});

test("deep links: section tab, expanded layout, folder context", async ({ page }) => {
  await page.goto(`/artifact/${guids.a}?tab=history&x=1`);
  await expect(page.locator(".quicklinks a.active")).toHaveText(/History/);
  await expect(page.locator("corestone-overview")).toBeHidden();
  await expect(page.locator(".tree .row.selected")).toContainText("alpha"); // folder inferred from the artifact
  await page.locator(".detail-head button[title='Restore layout']").click();
  await expect(page.locator("corestone-overview")).toBeVisible();
  await expect(page).not.toHaveURL(/x=1/);
  await page.locator(".quicklinks a", { hasText: "Comments" }).click();
  await expect(page).toHaveURL(/tab=comments/);
  await expect(page.locator("#sec-comments .comment")).toHaveCount(1);
  // the ✕ closes and drops the tab from the URL
  await page.locator(".detail-head button[title=Close]").click();
  await expect(page).not.toHaveURL(/tab=/);
});

test("overview: kind chips, schema columns, subtree, sorting stability, social counts", async ({ page }) => {
  await page.goto(`/folder/${folder}?subtree=1`);
  const table = page.locator("table.grid");
  await expect(table.locator("thead")).toContainText("Priority");
  await expect(table.locator("thead")).toContainText("Effort");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const alpha = table.locator("tbody tr", { hasText: `Alpha one ${id}` });
  await expect(alpha).toContainText("high");
  await expect(alpha.locator(".social")).toContainText("⇄ 1 · ✎ 1");
  await page.locator(".chip", { hasText: "Documents" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr .kind-icon.document")).toBeVisible();
  await page.locator(".chip", { hasText: "Links" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("verifies");
  await page.locator(".chip", { hasText: "Comments" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.locator(".chip", { hasText: "Entries + Docs" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page.locator("[data-test=subtree]").uncheck();
  await expect(page.locator("corestone-overview .empty-state")).toContainText("Nothing here yet");
  // by-type counts in the sidebar reflect the subtree
  await expect(page.locator(".tree .row[data-type=req] .count")).toHaveText("2");
  await page.locator(".tree .row[data-type=tc]").click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator(".toolbar .title")).toContainText("Test case");
});

test("search: text, HID, results across folders, clearing", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("[data-test=search]").fill("gamma");
  await expect(page.locator(".toolbar .title")).toContainText("gamma");
  await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
  const hid = (await (await fetch(`${api}/entries/${guids.b}`)).json()).meta.hid as string;
  await page.locator("[data-test=search]").fill(hid);
  await expect(page.locator("table.grid tbody tr", { hasText: `Beta two ${id}` })).toHaveCount(1);
  await page.locator("[data-test=search]").fill("");
  await expect(page.locator(".toolbar .title")).toHaveText(folder);
  await expect(page).not.toHaveURL(/q=/);
});

test("navigation collapse persists; responsive layout; dark mode", async ({ page, browser }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("header button[title='Toggle navigation']").click();
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.reload();
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.locator("header button[title='Toggle navigation']").click();
  await expect(page.locator("corestone-sidebar")).toBeVisible();
  // phone-sized viewport: no horizontal overflow, table still usable
  await page.goto(`/folder/${folder}/alpha`);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator("corestone-sidebar")).toBeVisible(); // overlays the content on small screens
  await page.locator(".nav-scrim").click({ position: { x: 700, y: 400 } }); // tapping beside the overlay closes it
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.locator("table.grid tbody tr").first().click();
  await expect(page.locator("corestone-detail [data-test=title]")).toBeVisible();
  const overflow = await page.evaluate(() => document.querySelector(".shell")!.scrollWidth - document.querySelector(".shell")!.clientWidth);
  expect(overflow).toBe(0);
  // a first visit on a phone starts with the navigation closed; choosing a folder closes it again
  const phone = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const small = await phone.newPage();
  await small.goto(`/folder/${folder}?subtree=1`);
  await expect(small.locator("corestone-sidebar")).toBeHidden();
  await expect(small.locator("table.grid tbody tr").first()).toBeVisible();
  await small.locator("header button[title='Toggle navigation']").click();
  await expect(small.locator("corestone-sidebar")).toBeVisible();
  await small.locator(`.tree .row[data-folder='${folder}/alpha']`).click();
  await expect(small.locator("corestone-sidebar")).toBeHidden();
  await expect(small).toHaveURL(new RegExp(`/folder/${folder}/alpha`));
  await small.locator("table.grid tbody tr").first().click();
  await expect(small.locator("corestone-detail [data-test=title]")).toBeVisible();
  await phone.close();
  // dark mode renders with dark background and readable text
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1200, height: 800 } });
  const dark = await ctx.newPage();
  await dark.goto(`/artifact/${guids.a}`);
  await expect(dark.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toMatch(/rgb\((\d+), (\d+), (\d+)\)/);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(200);
  await ctx.close();
});

test("theme choice in the name dialog: preview, cancel, persist", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/folder/${folder}`);
  const bgSum = async () => (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "auto");
  const user = page.locator("header button[title='Your name and theme']");
  expect(await bgSum()).toBeGreaterThan(600);
  // choosing previews right away; Cancel restores the previous theme
  await user.click();
  await expect(page.locator(".dialog [data-theme-choice=auto]")).toHaveAttribute("aria-checked", "true");
  await page.locator(".dialog [data-theme-choice=dark]").click();
  expect(await theme()).toBe("dark");
  expect(await bgSum()).toBeLessThan(200);
  await page.locator(".dialog button", { hasText: "Cancel" }).click();
  expect(await theme()).toBe("auto");
  expect(await bgSum()).toBeGreaterThan(600);
  // Save keeps it, across reloads
  await user.click();
  await page.locator(".dialog [data-theme-choice=dark]").click();
  await page.locator(".dialog button[type=submit]").click();
  await page.reload();
  await expect(user).toBeVisible();
  expect(await theme()).toBe("dark");
  expect(await bgSum()).toBeLessThan(200);
  // a forced light theme wins over a dark system; Auto follows the system again
  await page.emulateMedia({ colorScheme: "dark" });
  await user.click();
  await page.locator(".dialog [data-theme-choice=light]").click();
  expect(await bgSum()).toBeGreaterThan(600);
  await page.locator(".dialog [data-theme-choice=auto]").click();
  expect(await bgSum()).toBeLessThan(200);
  await page.locator(".dialog button[type=submit]").click();
  await page.reload();
  await expect(user).toBeVisible();
  expect(await theme()).toBe("auto");
});

test("invalid configuration files are announced and can be dismissed", async ({ page }) => {
  const issue = { severity: "error", code: "invalid-config", path: `${folder}/.corestone/config/entries/types.json`, message: "validation failed: schema is not valid JSON: invalid character" };
  await page.route("**/api/repository", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), invalidConfig: [issue] } });
  });
  await page.goto(`/folder/${folder}`);
  const banner = page.locator("[data-test=config-warnings]");
  await expect(banner).toContainText("A configuration problem");
  await expect(banner).toContainText(issue.path);
  await expect(banner).toContainText("not valid JSON");
  await expect(banner).toContainText("this file is ignored");
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
});

test("status indicator, user name and reindex", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await expect(page.locator("header .status")).toContainText("in sync", { timeout: 20000 });
  await page.locator("header button[title='Your name and theme']").click();
  await answerPrompt(page, "Zoë");
  await expect(page.locator("header button[title='Your name and theme']")).toHaveText("Zoë");
  await page.reload();
  await expect(page.locator("header button[title='Your name and theme']")).toHaveText("Zoë");
  const before = (await get<{ projection: { lastRebuild?: string } }>("/repository")).projection.lastRebuild ?? "";
  await page.locator("header button", { hasText: "Reindex" }).click();
  await expect(page.locator(".toast", { hasText: "Reindex started" })).toBeVisible();
  // wait for the rebuild itself to finish, not just for the header to look calm
  await expect.poll(async () => (await get<{ projection: { lastRebuild?: string } }>("/repository")).projection.lastRebuild ?? "", { timeout: 60000 }).not.toBe(before);
  await expect(page.locator("header .status")).toContainText("in sync", { timeout: 20000 });
  await expect(page.locator("table.grid tbody tr, .empty-state").first()).toBeVisible();
  // a large folder still lists and filters quickly
  const many = Array.from({ length: 120 }, (_, i) => post("/entries", { path: `${folder}/bulk`, type: "req", title: `Bulk ${i} ${id}`, fields: { priority: "low", effort: i } }));
  await Promise.all(many);
  await page.locator(`.tree .row[data-folder="${folder}/bulk"]`).click();
  await expect(page.locator(".toolbar .hint")).toContainText("120 artifacts");
  await expect(page.locator("table.grid tbody tr")).toHaveCount(120);
  await page.locator("[data-test=search]").fill(`Bulk 7 ${id}`);
  await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
});

test("the divider between overview and detail can be dragged, keyed, reset, and is remembered", async ({ page }) => {
  await page.goto(`/folder/${folder}/alpha`);
  const overview = page.locator("corestone-overview");
  const bar = page.locator("[data-test=splitter]");
  const height = async () => (await overview.boundingBox())!.height;
  const initial = await height();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 153, { steps: 5 });
  await page.mouse.up();
  expect(await height()).toBeGreaterThan(initial + 120);
  const dragged = await height();
  await page.reload();
  await expect.poll(height).toBeCloseTo(dragged, -1);
  await bar.focus();
  await page.keyboard.press("ArrowUp");
  expect(await height()).toBeLessThan(dragged);
  await bar.dblclick();
  await expect.poll(height).toBeCloseTo(initial, -1);
  // hidden when the detail view is expanded
  await page.goto(`/artifact/${guids.a}?x=1`);
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  await expect(bar).toBeHidden();
  expect((await page.locator("corestone-detail").boundingBox())!.height).toBeGreaterThan(300);
});

test("the folder navigation edge can be dragged, keyed, reset, and is remembered", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  const nav = page.locator("corestone-sidebar");
  const bar = page.locator("[data-test=nav-splitter]");
  const width = async () => (await nav.boundingBox())!.width;
  const initial = await width();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 123, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBeGreaterThan(initial + 100);
  const dragged = await width();
  await page.reload();
  await expect.poll(width).toBeCloseTo(dragged, -1);
  await bar.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await width()).toBeLessThan(dragged);
  await bar.dblclick();
  await expect.poll(width).toBeCloseTo(initial, -1);
  // hidden with the navigation
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(bar).toBeHidden();
});

test("table headers sort ascending and descending, columns resize, and both are remembered", async ({ page }) => {
  const sub = `${folder}/sorting`;
  await post("/entries", { path: sub, type: "req", title: `Mu 10 ${id}`, fields: { priority: "low", effort: 10 } });
  await post("/entries", { path: sub, type: "req", title: `alpha ${id}`, fields: { priority: "high", effort: 9 } });
  await post("/entries", { path: sub, type: "tc", title: `Mu 9 ${id}` });
  await post("/entries", { path: sub, type: "tc", title: `Zeta ${id}` });
  await page.goto(`/folder/${sub}`);
  const header = (col: string) => page.locator(`table.grid th[data-col="${col}"]`);
  const column = (col: string) => page.evaluate((c) => {
    const i = document.querySelector<HTMLTableCellElement>(`table.grid th[data-col="${c}"]`)!.cellIndex;
    return [...document.querySelectorAll<HTMLTableRowElement>("table.grid tbody tr")].map((tr) => tr.cells[i].innerText.trim());
  }, col);
  const titles = async () => (await column("$title")).map((t) => t.replace(/^[EDLC]\s*/, ""));
  const names = [`alpha ${id}`, `Mu 9 ${id}`, `Mu 10 ${id}`, `Zeta ${id}`]; // case-insensitive, natural number order
  await expect(page.locator("table.grid tbody tr")).toHaveCount(4);
  await header("$title").locator(".th-sort").click();
  await expect(header("$title")).toHaveAttribute("aria-sort", "ascending");
  expect(await titles()).toEqual(names);
  await header("$title").locator(".th-sort").click();
  await expect(header("$title")).toHaveAttribute("aria-sort", "descending");
  expect(await titles()).toEqual([...names].reverse());
  // numbers sort by value and empty cells stay last in both directions
  await header("effort").locator(".th-sort").click();
  expect(await column("effort")).toEqual(["9", "10", "", ""]);
  await header("effort").locator(".th-sort").click();
  expect(await column("effort")).toEqual(["10", "9", "", ""]);
  await expect(header("$title")).toHaveAttribute("aria-sort", "none");
  // drag the title column's edge
  const width = async () => (await header("$title").boundingBox())!.width;
  const before = await width();
  const edge = (await header("$title").locator(".col-resize").boundingBox())!;
  await page.mouse.move(edge.x + 3, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + 123, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(header("effort")).toHaveAttribute("aria-sort", "descending"); // the drag did not sort
  expect(await width()).toBeCloseTo(before + 120, -1);
  const dragged = await width();
  await page.reload();
  await expect(page.locator("table.grid tbody tr")).toHaveCount(4);
  await expect.poll(width).toBeCloseTo(dragged, -1);
  await expect(header("effort")).toHaveAttribute("aria-sort", "descending");
  expect(await column("effort")).toEqual(["10", "9", "", ""]);
  // double-click fits the column to its content
  await header("$title").locator(".col-resize").dblclick();
  await expect.poll(width).toBeLessThan(dragged);
  await expect(header("effort")).toHaveAttribute("aria-sort", "descending");
});

test("opening an artifact keeps the folder, the navigation and the table as they are", async ({ page }) => {
  await page.goto(`/?subtree=1`);
  const row = page.locator("table.grid tbody tr", { hasText: `Beta two ${id}` });
  await expect(row).toBeVisible();
  await expect(page.locator(".tree .row.selected")).toContainText("Repository");
  let searches = 0;
  page.on("request", (r) => { if (r.url().includes("/api/search")) searches++; });
  await row.click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Beta two ${id}`);
  await expect(page).not.toHaveURL(/folder=/);
  await expect(page.locator(".tree .row.selected")).toContainText("Repository");
  await expect(page.locator(".toolbar .title")).toHaveText("Repository");
  await page.locator("table.grid tbody tr", { hasText: `Alpha one ${id}` }).click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(`Alpha one ${id}`);
  await expect(page.locator(".tree .row.selected")).toContainText("Repository");
  expect(searches).toBe(0);
});
