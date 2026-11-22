import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  stdin: { contents: 'export * from "./services";', resolveDir: fileURLToPath(new URL("../src/components", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { provideServices, servicesFor } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

// Node has events but no page: an element here is an event target whose
// bubbling events go on to its parent unless a listener stopped them.
class El extends EventTarget {
  constructor(parent) { super(); this.parent = parent; }
  dispatchEvent(e) {
    let stopped = false;
    const stop = e.stopPropagation.bind(e);
    e.stopPropagation = () => { stopped = true; stop(); };
    for (let at = this; at && !stopped; at = e.bubbles ? at.parent : undefined) EventTarget.prototype.dispatchEvent.call(at, e);
    return true;
  }
}

test("a component gets the providers of the nearest ancestor that has some", () => {
  const app = new El(), dialog = new El(app), inDialog = new El(new El(dialog)), inApp = new El(app);
  const outer = { types: { types: async () => [] } }, inner = { types: { types: async () => [] } };
  provideServices(app, outer);
  provideServices(dialog, inner);
  assert.equal(servicesFor(inApp).types, outer.types);
  assert.equal(servicesFor(inDialog).types, inner.types);
  assert.equal(servicesFor(app).types, outer.types);
});

test("without an ancestor that provides, a component gets nothing", () => {
  assert.deepEqual(servicesFor(new El(new El())), {});
});
