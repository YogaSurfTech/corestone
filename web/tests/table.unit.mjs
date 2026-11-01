import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  stdin: { contents: 'export * from "./table-model";', resolveDir: fileURLToPath(new URL("../src", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { BATCH, batchesFor, promoteSort } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("a header click promotes its column and keeps two tie-breakers", () => {
  let sort = promoteSort([], "$hid");
  assert.deepEqual(sort, [{ col: "$hid", dir: "asc" }]);
  sort = promoteSort(sort, "$hid");
  assert.deepEqual(sort, [{ col: "$hid", dir: "desc" }]);
  sort = promoteSort(promoteSort(promoteSort(sort, "$title"), "$type"), "$folder");
  assert.deepEqual(sort.map((l) => l.col), ["$folder", "$type", "$title"]);
  // a former tie-breaker comes back with its direction
  sort = promoteSort([{ col: "$title", dir: "asc" }, { col: "$hid", dir: "desc" }], "$hid");
  assert.deepEqual(sort, [{ col: "$hid", dir: "desc" }, { col: "$title", dir: "asc" }]);
});

test("visible rows map to the batches that hold them", () => {
  assert.equal(BATCH, 50);
  assert.deepEqual(batchesFor(0, 0), []);
  assert.deepEqual(batchesFor(0, 30), [0]);
  assert.deepEqual(batchesFor(40, 60), [0, 1]);
  assert.deepEqual(batchesFor(50, 100), [1]);
  assert.deepEqual(batchesFor(990, 1050), [19, 20]);
});
