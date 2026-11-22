import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// The view of a table: which columns it shows, in which order, read leniently from storage.
const result = await build({
  stdin: { contents: 'export { readLayout, ordered, arrange, shown, emptyLayout } from "./table/views";', resolveDir: fileURLToPath(new URL("../src/components", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { readLayout, ordered, arrange, shown, emptyLayout } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const cols = [{ id: "$hid" }, { id: "$title" }, { id: "priority" }, { id: "effort", hidden: true }, { id: "$folder" }];
const ids = (cs) => cs.map((c) => c.id);

test("a layout from storage keeps what it can read", () => {
  assert.deepEqual(readLayout(null), emptyLayout());
  assert.deepEqual(readLayout({ widths: { a: 120, b: -1, c: "x" }, sort: [{ col: "a", dir: "asc" }, { col: "a", dir: "desc" }, { col: "b", dir: "up" }],
    order: ["b", 3, "a"], visible: { a: true, b: "no" } }),
  { widths: { a: 120 }, sort: [{ col: "a", dir: "asc" }], order: ["b", "a"], visible: { a: true } });
});

test("columns follow the chosen order; the others keep theirs after them", () => {
  assert.deepEqual(ids(ordered(cols, { ...emptyLayout(), order: ["priority", "$hid"] })), ["priority", "$hid", "$title", "effort", "$folder"]);
  assert.deepEqual(ids(ordered(cols, { ...emptyLayout(), order: ["gone", "$folder"] })), ["$folder", "$hid", "$title", "priority", "effort"]);
});

test("a column is shown as chosen, else by its default; never none", () => {
  const l = { ...emptyLayout(), visible: { effort: true, $hid: false } };
  assert.equal(shown(cols[3], emptyLayout()), false);
  assert.equal(shown(cols[3], l), true);
  assert.deepEqual(ids(arrange(cols, l)), ["$title", "priority", "effort", "$folder"]);
  const none = { ...emptyLayout(), visible: Object.fromEntries(cols.map((c) => [c.id, false])) };
  assert.deepEqual(ids(arrange(cols, none)), ["$hid"]);
});
