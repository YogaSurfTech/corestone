import { api } from "./api";
import type { Services } from "./components/services";
import { store } from "./store";
import type { Schema } from "./types";

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
  folders: {
    children: (path) => api.tree(path, false, 1).then((t) => t.folders),
  },
};
