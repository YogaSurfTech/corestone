import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Schema, Summary, Workflow } from "../src/types";
import { expect, test, type Page } from "./fixtures";

let script: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/overview.ts", import.meta.url))],
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
async function mount(page: Page, rows: Summary[], schemas = [schema], workflows: Record<string, Workflow> = {}) {
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
    } else if (path.startsWith("/api/workflows/")) {
      const definition = workflows[decodeURIComponent(path.slice("/api/workflows/".length))];
      if (!definition) throw new Error(`Unexpected workflow request: ${route.request().url()}`);
      await route.fulfill({ json: definition });
    } else {
      throw new Error(`Unexpected overview request: ${route.request().url()}`);
    }
  });
  await page.goto("http://overview.test/");
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
