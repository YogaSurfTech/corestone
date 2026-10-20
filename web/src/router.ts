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

export function navigate(patch: Partial<Route>, replace = false) {
  const next = { ...store.state.route, ...patch };
  const url = routeToURL(next);
  if (url !== window.location.pathname + window.location.search) {
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  store.setRoute(next);
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
  window.addEventListener("popstate", () => store.setRoute(parseRoute()));
}
