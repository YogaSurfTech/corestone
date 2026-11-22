import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  stdin: { contents: 'export { mergeKeys } from "./feature";', resolveDir: fileURLToPath(new URL("../packages/editor/src/core", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { mergeKeys } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

/** A command that notes its name and applies or not. */
const cmd = (log, name, applies) => () => { log.push(name); return applies; };

test("a key several have goes to the editor first, then to the features in their order", () => {
  const log = [];
  const keys = mergeKeys({ Tab: cmd(log, "indent", false) }, [{ keys: { Tab: cmd(log, "tables", false) } }, {}, { keys: { Tab: cmd(log, "last", true) } }]);
  assert.equal(keys.Tab(), true);
  assert.deepEqual(log, ["indent", "tables", "last"]);
});

test("the first command that applies ends it", () => {
  const log = [];
  const keys = mergeKeys({ Tab: cmd(log, "indent", true) }, [{ keys: { Tab: cmd(log, "tables", true) } }]);
  assert.equal(keys.Tab(), true);
  assert.deepEqual(log, ["indent"]);
});

test("a feature's key the editor does not have is the feature's alone, and the editor's own stay", () => {
  const log = [];
  const own = { "Mod-b": cmd(log, "bold", true) };
  const keys = mergeKeys(own, [{ keys: { "Mod-k": cmd(log, "link", true) } }]);
  assert.deepEqual(Object.keys(keys).sort(), ["Mod-b", "Mod-k"]);
  keys["Mod-k"]();
  assert.deepEqual(log, ["link"]);
  assert.deepEqual(Object.keys(own), ["Mod-b"]); // not changed in place
});
