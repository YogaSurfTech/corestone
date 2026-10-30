import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Schema, Summary, Workflow } from "../src/types";
import { expect, test, type Page } from "./fixtures";

let script: string;
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

/** Mounts the real overview with API responses, without needing a repository server. */
async function mount(page: Page, rows: Summary[], schemas = [schema], workflows: Record<string, Workflow> = {}, endpoints: Record<string, Summary> = {}, folder = "") {
  await page.route("http://overview.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      await route.fulfill({ contentType: "text/html", body: '<script type="module" src="/overview.js"></script><corestone-overview></corestone-overview>' });
    } else if (path === "/overview.js") {
      await route.fulfill({ contentType: "text/javascript", body: script });
    } else if (path === "/api/repository/types") {
      await route.fulfill({ json: { types: schemas } });
    } else if (path === "/api/repository/search") {
      await route.fulfill({ json: { artifacts: rows, total: rows.length } });
    } else if (path.startsWith("/api/artifacts/")) {
      const meta = endpoints[path.slice("/api/artifacts/".length)];
      if (!meta) throw new Error(`Unexpected endpoint request: ${route.request().url()}`);
      await route.fulfill({ json: { meta, data: {}, etag: "test" } });
    } else if (path.startsWith("/api/workflows/")) {
      const definition = workflows[decodeURIComponent(path.slice("/api/workflows/".length))];
      if (!definition) throw new Error(`Unexpected workflow request: ${route.request().url()}`);
      await route.fulfill({ json: definition });
    } else {
      throw new Error(`Unexpected overview request: ${route.request().url()}`);
    }
  });
  await page.goto("http://overview.test/" + (folder ? "?folder=" + encodeURIComponent(folder) : ""));
  await expect(page.locator("table.grid tbody tr")).toHaveCount(rows.length);
}

const sortBy = (page: Page, column: string) => page.locator(`th[data-col="${column}"] .th-sort`).click();
const order = (page: Page) => page.locator("table.grid tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-guid")));

test("enum sorting uses definition order, keeps unlisted and empty values last, and persists", async ({ page }) => {
  await mount(page, [
    row("high-first", { priority: "high" }), row("unknown-z", { priority: "zebra" }),
    row("urgent", { priority: "urgent" }), row("missing", {}), row("low", { priority: "low" }),
    row("unknown-a", { priority: "alpha" }), row("medium", { priority: "medium" }),
    row("high-second", { priority: "high" }), row("empty", { priority: "" }),
    row("null", { priority: null }),
  ]);
  await sortBy(page, "priority");
  await expect.poll(() => order(page)).toEqual([
    "low", "medium", "high-first", "high-second", "urgent", "unknown-a", "unknown-z", "missing", "empty", "null",
  ]);
  await sortBy(page, "priority");
  const descending = [
    "urgent", "high-first", "high-second", "medium", "low", "unknown-z", "unknown-a", "missing", "empty", "null",
  ];
  await expect.poll(() => order(page)).toEqual(descending);
  await page.reload();
  await expect(page.locator('th[data-col="priority"]')).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => order(page)).toEqual(descending);
});

test("multi-select enums sort by their maximum defined rank, not selection order", async ({ page }) => {
  await mount(page, [
    row("urgent", { tags: ["urgent", "low"] }),
    row("high-first", { tags: ["high", "medium"] }),
    row("low", { tags: ["low"] }), row("empty", { tags: [] }),
    row("high-second", { tags: ["low", "high"] }),
    row("unknown", { tags: ["low", "custom"] }),
    row("medium", { tags: ["medium", "low"] }),
  ]);
  await sortBy(page, "tags");
  await expect.poll(() => order(page)).toEqual(["low", "medium", "high-first", "high-second", "urgent", "unknown", "empty"]);
  await sortBy(page, "tags");
  await expect.poll(() => order(page)).toEqual(["urgent", "high-first", "high-second", "medium", "low", "unknown", "empty"]);
  await expect(page.locator('tr[data-guid="urgent"] td corestone-enum .enum-label')).toHaveText(["Label 1", "Label 4"]);
});

test("enum ranks come from each row's type definition and ties remain stable", async ({ page }) => {
  const other: Schema = {
    ...schema, type: "other",
    fields: [{ id: "priority", type: "enum", options: [{ value: "urgent" }, { value: "low" }] }],
  };
  await mount(page, [
    row("task-high", { priority: "high" }),
    row("other-urgent", { priority: "urgent" }, "other"),
    row("task-low", { priority: "low" }),
    row("other-low", { priority: "low" }, "other"),
  ], [schema, other]);
  await sortBy(page, "priority");
  await expect.poll(() => order(page)).toEqual(["other-urgent", "task-low", "other-low", "task-high"]);
  await sortBy(page, "priority");
  await expect.poll(() => order(page)).toEqual(["task-high", "other-low", "other-urgent", "task-low"]);
});

test("text and numeric columns retain natural sorting and empty values stay last", async ({ page }) => {
  await mount(page, [
    row("ten", { effort: 10, text: "Item 10" }),
    row("missing", {}), row("two", { effort: 2, text: "item 2" }),
    row("empty", { text: "" }), row("zero", { effort: 0, text: "Alpha" }),
  ]);
  await sortBy(page, "effort");
  await expect.poll(() => order(page)).toEqual(["zero", "two", "ten", "missing", "empty"]);
  await sortBy(page, "effort");
  await expect.poll(() => order(page)).toEqual(["ten", "two", "zero", "missing", "empty"]);
  await sortBy(page, "text");
  await expect.poll(() => order(page)).toEqual(["zero", "two", "ten", "missing", "empty"]);
  await sortBy(page, "text");
  await expect.poll(() => order(page)).toEqual(["ten", "two", "zero", "missing", "empty"]);
});

test("workflow field and State column use the fetched states-list sequence", async ({ page }) => {
  const task: Workflow = {
    id: "task", initial: "open",
    states: ["open", "implementation", "verification", "done"].map((id) => ({ id })),
    transitions: [],
  };
  const workflowSchema: Schema = {
    ...schema, workflows: ["task"],
    fields: [{ id: "status", type: "workflow", workflow: "task" }],
    presentation: { columns: ["status"] },
  };
  const rows = ["done", "verification", "open", "implementation"].map((id) => ({
    ...row(id, { status: id }), workflows: { task: id },
  }));
  await mount(page, rows, [workflowSchema], { task });
  for (const column of ["status", "$state"]) {
    await sortBy(page, column);
    await expect.poll(() => order(page)).toEqual(["open", "implementation", "verification", "done"]);
    await sortBy(page, column);
    await expect.poll(() => order(page)).toEqual(["done", "verification", "implementation", "open"]);
  }
});

test("three sort levels break ties, promote without duplicates and persist", async ({ page }) => {
  await mount(page, [
    row("a", { priority: "low", effort: 2, text: "same" }),
    row("b", { priority: "high", effort: 1, text: "same" }),
    row("c", { priority: "low", effort: 1, text: "same" }),
    row("d", { priority: "high", effort: 1, text: "first" }),
  ]);
  await sortBy(page, "priority");
  await sortBy(page, "effort");
  await sortBy(page, "text");
  await expect.poll(() => order(page)).toEqual(["d", "c", "b", "a"]);
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
  await expect(page.locator('th[data-col="text"]')).toHaveAttribute("aria-sort", "ascending");
  await sortBy(page, "effort");
  await expect.poll(() => order(page)).toEqual(["d", "c", "b", "a"]);
  await sortBy(page, "effort");
  await expect.poll(() => order(page)).toEqual(["a", "d", "c", "b"]);
  await sortBy(page, "text");
  await expect.poll(() => order(page)).toEqual(["d", "a", "c", "b"]);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("corestone.table")!).sort);
  await expect.poll(saved).toEqual([
    { col: "text", dir: "asc" }, { col: "effort", dir: "desc" }, { col: "priority", dir: "asc" },
  ]);
  await sortBy(page, "$title");
  await expect.poll(saved).toEqual([
    { col: "$title", dir: "asc" }, { col: "text", dir: "asc" }, { col: "effort", dir: "desc" },
  ]);
  await page.reload();
  await expect.poll(saved).toEqual([
    { col: "$title", dir: "asc" }, { col: "text", dir: "asc" }, { col: "effort", dir: "desc" },
  ]);
  await expect(page.locator('th[aria-sort="ascending"]')).toHaveCount(1);
  await expect(page.locator('th[data-col="$title"]')).toHaveAttribute("aria-sort", "ascending");
});

test("legacy single-column sort settings remain usable", async ({ page }) => {
  await mount(page, [row("low", { priority: "low" }), row("high", { priority: "high" })]);
  await page.evaluate(() => localStorage.setItem("corestone.table", JSON.stringify({
    widths: {}, sort: { col: "priority", dir: "desc" },
  })));
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["high", "low"]);
  await expect(page.locator('th[data-col="priority"]')).toHaveAttribute("aria-sort", "descending");
  await sortBy(page, "effort");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("corestone.table")!).sort)).toEqual([
    { col: "effort", dir: "asc" }, { col: "priority", dir: "desc" },
  ]);
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
    await mount(page, [link], [linkSchema], {}, { [source.guid]: source, [target.guid]: target }, folder);
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
