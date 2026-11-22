import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, entry, violations } from "../scripts/check-layers.mjs";

const what = (path, source) => violations(path, source).map((v) => v.what);

test("the editor imports ProseMirror, the ui package and itself, nothing of the app", () => {
  assert.deepEqual(what("packages/editor/src/a.ts", `
    import { EditorView } from "prosemirror-view";
    import { Overlay } from "@corestone/ui";
    import { schema } from "./schema";
    export * from "./model";
  `), []);
  assert.deepEqual(what("packages/editor/src/a.ts", `
    import { html } from "lit";
    import { api } from "../../../src/api";
    const later = await import("../../../src/store");
  `), ["imports lit", "imports src/api", "imports src/store"]);
});

test("the ui primitives import Lit only; the building blocks may use the primitives", () => {
  assert.deepEqual(what("packages/ui/src/lib/dom.ts", `import { LitElement } from "lit"; import { x } from "./prefs";`), []);
  assert.deepEqual(what("packages/ui/src/lib/dom.ts", `import { Overlay } from "../overlay";`), ["imports packages/ui/src/overlay"]);
  assert.deepEqual(what("packages/ui/src/overlay.ts", `import { el } from "./lib/dom";`), []);
  assert.deepEqual(what("packages/ui/src/overlay.ts", `import { EditorView } from "prosemirror-view";`), ["imports prosemirror-view"]);
});

test("components take only types from the editor", () => {
  assert.deepEqual(what("packages/components/src/fields.ts", `import type { Paragraph } from "@corestone/editor/model";`), []);
  assert.deepEqual(what("packages/components/src/fields.ts", `import { toStorage } from "@corestone/editor/model";`), ["imports @corestone/editor"]);
});

test("the app imports anything", () => {
  assert.deepEqual(what("src/detail.ts", `import { RichTextEditor } from "@corestone/editor"; import { api } from "./api"; import "x";`), []);
});

test("components of the app take nothing of the server, the store or the views", () => {
  assert.deepEqual(what("src/components/table/table.ts", `
    import { html } from "lit";
    import { LightElement } from "@corestone/ui";
    import "@corestone/editor";
    import type { Summary } from "../types";
    import { compare } from "./sorting";
  `), []);
  assert.deepEqual(what("src/components/table/table.ts", `
    import { api } from "../../api";
    import { store } from "../../store";
    import { navigate } from "../../router";
    import "../../dialogs";
    import { EditorView } from "prosemirror-view";
  `), ["imports src/api", "imports src/store", "imports src/router", "imports the view src/dialogs", "imports prosemirror-view"]);
  assert.deepEqual(what("src/overview.ts", `import "./components/table/table";`), []);
});

test("only the shell imports a view", () => {
  assert.deepEqual(what("src/app.ts", `import "./overview"; import "./detail";`), []);
  assert.deepEqual(what("src/main.ts", `import { SignIn } from "./account";`), []);
  assert.deepEqual(what("src/document.ts", `import { freeFileName } from "./detail"; import { store } from "./store"; import { x } from "./files";`),
    ["imports the view src/detail"]);
  assert.deepEqual(what("src/store.ts", `import "./dialogs";`), ["imports the view src/dialogs"]);
  assert.deepEqual(what("src/new-view.ts", `import type { PickerAction } from "./dialogs";`), ["imports the view src/dialogs"]);
});

test("the network and the storage belong to one file each", () => {
  assert.deepEqual(what("src/api.ts", `fetch("/api"); localStorage.getItem("k");`), ["uses localStorage"]);
  assert.deepEqual(what("src/ws.ts", `new WebSocket(url);`), []);
  assert.deepEqual(what("src/detail.ts", `await fetch(u); new WebSocket(u); window.sessionStorage.clear();`),
    ["uses fetch", "uses WebSocket", "uses sessionStorage"]);
  assert.deepEqual(what("packages/ui/src/lib/prefs.ts", `localStorage.setItem("k", "v"); sessionStorage.removeItem("k");`), []);
  assert.deepEqual(what("packages/editor/src/files.ts", `const res = await globalThis.fetch(from);`), ["uses fetch"]);
});

test("a member, a declaration or a word in text of the same name is no use of the global", () => {
  assert.deepEqual(what("src/detail.ts", `
    // fetch("x") and localStorage in a comment
    const text = "fetch(localStorage)";
    api.fetch(1); this.localStorage = 2;
    const options = { fetch: 1 };
    function load(fetch: () => void) { return 1; }
    interface Host { fetch(): void; WebSocket: number }
  `), []);
});

test("the allowlist covers a file and kind; lines nothing matches are reported", () => {
  const all = [
    ...violations("src/detail.ts", `fetch(a);\nfetch(b);\nlocalStorage.clear();`),
  ];
  assert.deepEqual(all.map((v) => v.line), [1, 2, 3]);
  const { fresh, stale } = compare(all, new Set(["src/detail.ts: uses fetch", "src/gone.ts: uses fetch"]));
  assert.deepEqual(fresh.map(entry), ["src/detail.ts: uses localStorage"]);
  assert.deepEqual(stale, ["src/gone.ts: uses fetch"]);
});

test("the parts of a view are imported by that view and by each other only", () => {
  assert.deepEqual(what("src/detail.ts", `import { DetailState } from "./detail/state";`), []);
  assert.deepEqual(what("src/detail/fields.ts", `import { sectionOf } from "./parts"; import type { DetailState } from "./state";`), []);
  assert.deepEqual(what("src/document/sidebars/entry.ts", `import type { DocumentState } from "../state";`), []);
  assert.deepEqual(what("src/document.ts", `import { DetailState } from "./detail/state";`), ["imports src/detail/state, a part of the view src/detail"]);
  assert.deepEqual(what("src/app.ts", `import "./detail/state";`), ["imports src/detail/state, a part of the view src/detail"]);
  assert.deepEqual(what("src/detail/fields.ts", `import "../document";`), ["imports the view src/document"]);
});
