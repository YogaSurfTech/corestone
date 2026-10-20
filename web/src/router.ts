import { api } from "./api";
import { defaultRoute, store, type Route } from "./store";

// Bidirectional synchronization between the store and the browser URL
// (design guide §7.15): every navigable state is a bookmarkable link.
//
//   /                       repository root
//   /folder/<path>          a folder
//   /artifact/<guid>        an artifact (detail or document view)
//   ?q=&subtree=1&kind=&type=&tab=&sb=props,comments&x=1

export function parseRoute(loc: Location = window.location): Route {
  const r: Route = { ...defaultRoute, sidebars: [] };
  const parts = loc.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "folder") r.folder = parts.slice(1).join("/");
  if (parts[0] === "artifact" && parts[1]) r.guid = parts[1].toLowerCase();
  const sp = new URLSearchParams(loc.search);
  r.q = sp.get("q") ?? "";
  r.subtree = sp.get("subtree") === "1";
  r.kind = sp.get("kind") ?? "";
  r.type = sp.get("type") ?? "";
  r.tab = sp.get("tab") ?? "";
  r.expanded = sp.get("x") === "1";
  r.sidebars = (sp.get("sb") ?? "").split(",").filter(Boolean);
  if (sp.get("folder")) r.folder = sp.get("folder")!;
  return r;
}

export function routeToURL(r: Route): string {
  let path = "/";
  if (r.guid) path = "/artifact/" + r.guid;
  else if (r.folder) path = "/folder/" + r.folder.split("/").map(encodeURIComponent).join("/");
  const sp = new URLSearchParams();
  if (r.guid && r.folder) sp.set("folder", r.folder);
  if (r.q) sp.set("q", r.q);
  if (r.subtree) sp.set("subtree", "1");
  if (r.kind) sp.set("kind", r.kind);
  if (r.type) sp.set("type", r.type);
  if (r.tab) sp.set("tab", r.tab);
  if (r.expanded) sp.set("x", "1");
  if (r.sidebars.length) sp.set("sb", r.sidebars.join(","));
  const s = sp.toString().replace(/%2C/g, ",");
  return path + (s ? "?" + s : "");
}

/** An editor with unsaved changes, asked before the route leaves its artifact. */
export interface LeaveGuard {
  dirty(): boolean;
  /** Saves; resolves true when the changes are stored. */
  save(): Promise<boolean>;
  discard(): void;
  label(): string;
}

let guard: LeaveGuard | null = null;

/** Registers the editor of the open artifact; null (or another editor) replaces it. */
export function setLeaveGuard(g: LeaveGuard | null) {
  guard = g;
}
export function clearLeaveGuard(g: LeaveGuard) {
  if (guard === g) guard = null;
}

/** Asks what to do with unsaved changes; resolves true when the route may change. */
async function mayLeave(): Promise<boolean> {
  const g = guard;
  if (!g || !g.dirty()) return true;
  const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => store.set({ dialog: {
    kind: "confirm", title: "Unsaved changes", text: `${g.label()} has changes that are not saved yet.`,
    confirmLabel: "Save", onConfirm: () => resolve("save"),
    altLabel: "Discard changes", onAlt: () => resolve("discard"),
    onCancel: () => resolve("cancel"),
  } }));
  if (choice === "save") return g.save();
  if (choice === "discard") g.discard();
  return choice === "discard";
}

function apply(next: Route, replace: boolean) {
  const url = routeToURL(next);
  if (url !== window.location.pathname + window.location.search) {
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  store.setRoute(next);
}

export function navigate(patch: Partial<Route>, replace = false) {
  const next = { ...store.state.route, ...patch };
  if (next.guid === store.state.route.guid) return apply(next, replace);
  // Leaving the open artifact: unsaved changes are saved, discarded or kept.
  void mayLeave().then((ok) => { if (ok) apply(next, replace); });
}

export function installRouter() {
  const initial = parseRoute();
  store.setRoute(initial);
  // A link to an artifact without a folder (bookmarked or shared) shows it in
  // the context of its folder. Only on page load: inside the app, opening an
  // artifact keeps the current folder, including the repository root.
  if (initial.guid && !initial.folder && !initial.q && !initial.type) {
    api.get(initial.guid).then((v) => {
      const r = store.state.route;
      if (r.guid === v.meta.guid && !r.folder && !r.q && !r.type && v.meta.folder) navigate({ folder: v.meta.folder }, true);
    }).catch(() => {});
  }
  window.addEventListener("popstate", () => {
    const next = parseRoute();
    // Only unsaved changes interfere with the browser's history.
    if (next.guid === store.state.route.guid || !guard?.dirty()) return store.setRoute(next);
    // The browser has already moved: put the current page back while asking.
    const here = store.state.route;
    history.pushState(null, "", routeToURL(here));
    void mayLeave().then((ok) => { if (ok) apply(next, false); });
  });
  // Closing or reloading the tab: the browser's own confirmation.
  window.addEventListener("beforeunload", (e) => {
    if (guard?.dirty()) e.preventDefault();
  });
}
