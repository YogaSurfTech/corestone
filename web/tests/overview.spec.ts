import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Schema, Summary } from "../src/types";
import { expect, test, type Page } from "./fixtures";

let script: string;
// The app styles make the table body the scroll container the lazy loading measures.
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: 'import "./overview"; import { installRouter } from "./router"; installRouter();',
      resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "overview-test.ts",
    },
    bundle: true, format: "esm", target: "es2022", write: false,
  });
  script = result.outputFiles[0].text;
});

const options = ["low", "medium", "high", "urgent"].map((value, i) => ({ value, label: `Label ${4 - i}` }));
const schema: Schema = {
  type: "task", kind: "entry",
  fields: [
    { id: "priority", type: "enum", options, extendable: true },
    { id: "tags", type: "enum", options, multiple: true, extendable: true },
    { id: "effort", type: "integer" },
    { id: "text", type: "text" },
  ],
  presentation: { columns: ["priority", "tags", "effort", "text"] },
};

function row(guid: string, fields: Summary["fields"], type = "task"): Summary {
  return { guid, type, fields, kind: "entry", title: guid, folder: "", path: guid, links: 0, comments: 0 };
}

interface Calls { queries: { filter?: Record<string, unknown>; sort?: { col: string; dir: string }[]; limit?: number }[]; details: string[][] }

/**
 * Mounts the real overview against a mocked server. Sorting is the server's job
 * (covered by the projection tests); the mock keeps the given order and reverses
 * it when the first sort level is descending, so the rendered order shows it is
 * the server's.
 */
async function mount(page: Page, rows: Summary[], schemas = [schema], related: Record<string, Summary> = {}, folder = ""): Promise<Calls> {
  const calls: Calls = { queries: [], details: [] };
  const byGuid = new Map(rows.map((r) => [r.guid, r]));
  await page.route("http://overview.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${styles} corestone-overview { height: 600px; }</style><script type="module" src="/overview.js"></script><corestone-overview></corestone-overview>` });
    } else if (path === "/overview.js") {
      await route.fulfill({ contentType: "text/javascript", body: script });
    } else if (path.startsWith("/api/icons/")) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#c33"/></svg>' });
    } else if (path === "/api/repository/types") {
      await route.fulfill({ json: { types: schemas } });
    } else if (path === "/api/repository/query") {
      const body = route.request().postDataJSON();
      calls.queries.push(body);
      const kinds: string[] = body.filter?.kind ?? ["entry", "document"];
      let ids = rows.filter((r) => kinds.includes(r.kind)).map((r) => r.guid);
      if (body.sort?.[0]?.dir === "desc") ids = ids.reverse();
      const total = ids.length;
      if (body.limit) ids = ids.slice(0, body.limit);
      await route.fulfill({ json: { total, ids, truncated: ids.length < total } });
    } else if (path === "/api/artifacts/details") {
      const ids: string[] = route.request().postDataJSON().ids;
      calls.details.push(ids);
      await route.fulfill({ json: { artifacts: ids.map((id) => byGuid.get(id)).filter(Boolean), related, typeNames: {} } });
    } else {
      throw new Error(`Unexpected overview request: ${route.request().url()}`);
    }
  });
  await page.goto("http://overview.test/" + (folder ? "?folder=" + encodeURIComponent(folder) : ""));
  return calls;
}

const sortBy = (page: Page, column: string) => page.locator(`th[data-col="${column}"] .th-sort`).click();
const order = (page: Page) => page.locator("table.grid tbody tr:not(.placeholder)").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-guid")));
const lastSort = (calls: Calls) => calls.queries.filter((q) => !q.limit).at(-1)?.sort;

test("rows keep the server's order and enums render their labels", async ({ page }) => {
  await mount(page, [
    row("urgent", { priority: "urgent", tags: ["urgent", "low"], effort: 3 }),
    row("low", { priority: "low", tags: ["low"] }),
    row("missing", {}),
  ]);
  await expect.poll(() => order(page)).toEqual(["urgent", "low", "missing"]);
  await expect(page.locator('tr[data-guid="urgent"] td corestone-enum .enum-label')).toHaveText(["Label 1", "Label 1", "Label 4"]);
  await sortBy(page, "priority");
  await sortBy(page, "priority");
  await expect.poll(() => order(page)).toEqual(["missing", "low", "urgent"]);
  await expect(page.locator('th[data-col="priority"]')).toHaveAttribute("aria-sort", "descending");
});

test("three sort levels are sent to the server, promote without duplicates and persist", async ({ page }) => {
  const calls = await mount(page, [row("a", { priority: "low" }), row("b", { priority: "high" })]);
  await expect.poll(() => order(page)).toEqual(["a", "b"]);
  await sortBy(page, "priority");
  await sortBy(page, "effort");
  await sortBy(page, "text");
  await expect.poll(() => lastSort(calls)).toEqual([{ col: "text", dir: "asc" }, { col: "effort", dir: "asc" }, { col: "priority", dir: "asc" }]);
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
  await expect(page.locator('th[data-col="text"]')).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator('th[data-col="effort"] .sort-level')).toHaveText("2");
  await sortBy(page, "effort");
  await sortBy(page, "effort");
  await sortBy(page, "text");
  const expected = [{ col: "text", dir: "asc" }, { col: "effort", dir: "desc" }, { col: "priority", dir: "asc" }];
  await expect.poll(() => lastSort(calls)).toEqual(expected);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("corestone.table")!).sort);
  await expect.poll(saved).toEqual(expected);
  await sortBy(page, "$title");
  const promoted = [{ col: "$title", dir: "asc" }, { col: "text", dir: "asc" }, { col: "effort", dir: "desc" }];
  await expect.poll(saved).toEqual(promoted);
  const after = await mount(page, [row("a", {})]);
  await expect.poll(() => lastSort(after)).toEqual(promoted);
  await expect(page.locator('th[data-col="$title"]')).toHaveAttribute("aria-sort", "ascending");
});

test("legacy single-column sort settings remain usable", async ({ page }) => {
  await mount(page, [row("low", { priority: "low" }), row("high", { priority: "high" })]);
  await page.evaluate(() => localStorage.setItem("corestone.table", JSON.stringify({
    widths: {}, sort: { col: "priority", dir: "desc" },
  })));
  const calls = await mount(page, [row("low", { priority: "low" }), row("high", { priority: "high" })]);
  await expect.poll(() => lastSort(calls)).toEqual([{ col: "priority", dir: "desc" }]);
  await expect(page.locator('th[data-col="priority"]')).toHaveAttribute("aria-sort", "descending");
  await sortBy(page, "effort");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("corestone.table")!).sort)).toEqual([
    { col: "effort", dir: "asc" }, { col: "priority", dir: "desc" },
  ]);
});

test("large results load row details lazily while scrolling", async ({ page }) => {
  const rows = Array.from({ length: 500 }, (_, i) => row(`row-${String(i).padStart(3, "0")}`, { effort: i }));
  const calls = await mount(page, rows);
  const table = page.locator("table.grid");
  await expect(table).toHaveAttribute("aria-rowcount", "500");
  await expect(page.locator('tr[data-guid="row-000"]:not(.placeholder)')).toHaveCount(1);
  expect(calls.details.flat().length).toBeLessThan(200);
  expect(await page.locator("table.grid tbody tr").count()).toBeLessThan(200);
  await page.locator(".ctable-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('tr[data-guid="row-499"]:not(.placeholder)')).toHaveCount(1);
  expect(new Set(calls.details.flat()).size).toBeLessThan(500);
});

test("rows with and without an enum value are equally high", async ({ page }) => {
  // a type with an icon-marked enum next to one without enum fields (like a spec next to a task)
  const marked: Schema = { type: "task", kind: "entry", presentation: { columns: ["priority"] },
    fields: [{ id: "priority", type: "enum", options: options.map((o) => ({ ...o, presentation: { icon: "dot" } })) }] };
  const plain: Schema = { type: "note", kind: "entry", fields: [] };
  await mount(page, [row("with-enum", { priority: "high" }), row("without-enum", {}, "note")], [marked, plain]);
  await expect(page.locator('tr[data-guid="with-enum"] corestone-enum img.enum-marker')).toHaveJSProperty("complete", true);
  // natural heights, without the uniform height the lazy table imposes
  const heights = await page.locator("table.grid tbody tr:not(.placeholder)").evaluateAll((rows) =>
    rows.map((r) => { (r as HTMLElement).style.height = ""; return r.getBoundingClientRect().height; }));
  expect(heights).toHaveLength(2);
  expect(Math.abs(heights[0] - heights[1])).toBeLessThan(0.5);
});

test("scrolling past the first rows settles instead of running away", async ({ page }) => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(`row-${String(i).padStart(4, "0")}`, { effort: i }));
  const calls = await mount(page, rows);
  // rows of different natural heights (in real repositories e.g. chips in some rows)
  await page.addStyleTag({ content: 'tr[data-guid$="3"] td, tr[data-guid$="7"] td { padding-top: 9px; }' });
  const body = page.locator(".ctable-body");
  await expect(page.locator('tr[data-guid="row-0000"]:not(.placeholder)')).toHaveCount(1);
  // ordinary wheel scrolling, a few screens down from the top
  await body.hover();
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const settled = await body.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(1000);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(settled);
  expect(settled).toBeLessThan(3000);
  expect(new Set(calls.details.flat()).size).toBeLessThan(300);
});

for (const folder of ["", "overview-scope"]) {
  test(`Links columns show From Role To and fields with independent navigation in ${folder || "root"}`, async ({ page }) => {
    const source = { ...row("11111111-1111-4111-8111-111111111111", {}), hid: "CMP-1", folder: "source-folder" };
    const target = { ...row("22222222-2222-4222-8222-222222222222", {}), folder: "target-folder" };
    const link = { ...row("33333333-3333-4333-8333-333333333333", { note: "Evidence", priority: "high" }, "verifies"),
      kind: "link" as const, source: source.guid, target: target.guid, author: "alice",
      createdAt: "2026-01-01T10:00:00Z", modifiedAt: "2026-01-02T10:00:00Z" };
    const linkSchema: Schema = { type: "verifies", kind: "link", displayName: "Verifies",
      fields: [{ id: "note", name: "Note", type: "text" }, { id: "priority", name: "Priority", type: "enum",
        options: [{ value: "high", label: "High" }] }] };
    await mount(page, [link], [linkSchema], { [source.guid]: source, [target.guid]: target }, folder);
    await page.getByRole("button", { name: "Links", exact: true }).click();
    await expect(page.locator("thead th .th-sort")).toHaveText(["From", "Role", "To", "Note", "Priority", "Author", "Created", "Updated"]);
    const cells = page.locator(`tr[data-guid="${link.guid}"] td`);
    // endpoint cells start with the type icon (here the kind letter fallback); the link carries the label
    await expect(cells.nth(0).getByRole("link")).toHaveText("CMP-1");
    await expect(cells.nth(1)).toHaveText("Verifies");
    await expect(cells.nth(2).getByRole("link")).toHaveText(target.guid);
    await expect(cells.nth(3)).toHaveText("Evidence");
    await expect(cells.nth(4)).toContainText("High");
    await expect(cells.nth(5)).toHaveText("alice");
    await expect(cells.nth(6)).not.toBeEmpty();
    await expect(cells.nth(7)).not.toBeEmpty();
    await expect(cells.nth(4).locator("button")).toHaveCount(0);
    await cells.nth(0).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/artifact/${source.guid}`));
    expect(new URL(page.url()).searchParams.get("folder") ?? "").toBe(folder);
    expect(new URL(page.url()).searchParams.get("kind")).toBe("link");
    await cells.nth(2).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/artifact/${target.guid}`));
    expect(new URL(page.url()).searchParams.get("folder") ?? "").toBe(folder);
    expect(new URL(page.url()).searchParams.get("kind")).toBe("link");
    await cells.nth(3).click();
    await expect(page).toHaveURL(new RegExp(`/artifact/${link.guid}`));
    await cells.nth(0).getByRole("link").click();
    await cells.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/artifact/${link.guid}`));
  });
}
