// @corestone/ui: the lowest layers of the web client. src/lib holds helpers
// without a user interface of their own; the files next to this one hold the
// controls built on them. Nothing here knows about Corestone's data, the
// server, or ProseMirror (see web/scripts/check-layers.mjs).
export { button, el, type ButtonOptions } from "./lib/dom";
export { prefs, type PrefsOptions } from "./lib/prefs";
