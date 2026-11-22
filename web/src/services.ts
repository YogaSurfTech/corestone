import { api, server } from "./api";
import type { Services } from "./components/services";
import { pickArtifact, store } from "./store";
import type { Schema } from "./components/types";

// The providers the components get in the application: they ask the server.

// Types visible per folder, shared by everything on the page and dropped
// whenever the repository changes.
let types = new Map<string, Promise<Schema[]>>();
let typesTick = -1;

export const services: Services = {
  types: {
    types(folder) {
      if (store.state.refreshTick !== typesTick) { types = new Map(); typesTick = store.state.refreshTick; }
      let p = types.get(folder);
      if (!p) {
        p = api.types(folder).then((r) => r.types).catch(() => []);
        types.set(folder, p);
      }
      return p;
    },
  },
  options: {
    options: (type, field, folder) => api.options(type, field, folder).then((r) => r.options),
  },
  fields: {
    resolve: (guid) => api.get(guid).then((v) => v.meta),
    values: (type, field, folder) => api.values(type, field, folder).then((r) => r.values.map((v) => v.value)),
    pick: pickArtifact,
    notify: (text, level) => store.toast(text, level),
    diagramsUrl: () => server.diagrams || undefined,
  },
  table: {
    query: (q, signal) => api.query(q, signal),
    details: (ids, columns, signal) => api.details(ids, columns, signal),
    changed: (listener) => {
      let tick = store.state.refreshTick;
      return store.subscribe((s) => { if (s.refreshTick !== tick) { tick = s.refreshTick; listener(); } });
    },
  },
  folders: {
    children: (path) => api.tree(path, false, 1).then((t) => t.folders),
  },
};
