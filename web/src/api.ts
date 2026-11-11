import type {
  Attachment, CommentView, Issue, LogEntry, OverlayView, Relationships, RepoStatus, Schema, SortLevel, Summary, TableFilter, TableRows, Tree, View,
  Workflow, WorkflowEval,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A local account (-auth local). */
export interface Account { guid: string; name: string; email: string; role: "user" | "admin"; created: string }
/** How the server signs in: "none" is open; "local" needs an account, and "setup" means none exists yet. */
export interface AuthState { mode: "local" | "none"; setup?: boolean; account?: Account | null }

let onUnauthorized: (() => void) | null = null;
/** Called when the session has ended (any 401 outside signing in). */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

/** Names the configured user so the server records them as commit author. */
function userHeader(): Record<string, string> {
  let user = "";
  try {
    user = localStorage.getItem("corestone.user") || "";
  } catch {
    /* storage unavailable */
  }
  return user ? { "X-Corestone-User": encodeURIComponent(user) } : {};
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, headers: { ...userHeader(), ...headers }, signal };
  if (body !== undefined) {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }
  // Maintenance mode (reindex, large restructuring) answers 503 with
  // Retry-After before anything was written; keep retrying for up to a
  // minute instead of failing the user's action. The header shows the
  // rebuild's progress meanwhile.
  let res = await fetch("/api" + path, init);
  const deadline = Date.now() + 60_000;
  for (let delay = 500; res.status === 503 && res.headers.get("Retry-After") && Date.now() < deadline; delay = Math.min(delay * 1.5, 2000)) {
    await new Promise((r) => setTimeout(r, delay));
    res = await fetch("/api" + path, init);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 && !path.startsWith("/auth")) onUnauthorized?.();
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? res.statusText;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
};

export const api = {
  auth: () => request<AuthState>("GET", "/auth"),
  setup: (name: string, email: string, password: string) => request<Account>("POST", "/auth/setup", { name, email, password }),
  login: (email: string, password: string) => request<Account>("POST", "/auth/login", { email, password }),
  logout: () => request<void>("POST", "/auth/logout"),
  updateMe: (name: string, email: string) => request<Account>("PATCH", "/me", { name, email }),
  changePassword: (current: string, password: string) => request<Account>("POST", "/me/password", { current, password }),
  accounts: () => request<{ accounts: Account[]; unknownAdmins: string[] }>("GET", "/accounts"),
  setRole: (guid: string, role: "user" | "admin") => request<Account>("PUT", `/accounts/${guid}/role`, { role }),
  createAccount: (a: { name: string; email: string; password: string; role: "user" | "admin" }) => request<Account>("POST", "/accounts", a),
  resetPassword: (guid: string, password: string) => request<void>("POST", `/accounts/${guid}/password`, { password }),
  status: () => request<RepoStatus>("GET", "/repository"),
  tree: (path: string, subtree: boolean, limit = 500) => request<Tree>("GET", "/repository/tree" + q({ path, subtree, limit })),
  search: (params: { q?: string; kind?: string; type?: string; path?: string; subtree?: boolean; limit?: number; [k: string]: string | number | boolean | undefined }) =>
    request<{ artifacts: Summary[]; total: number }>("GET", "/repository/search" + q(params)),
  types: (path: string) => request<{ types: Schema[] }>("GET", "/repository/types" + q({ path })),
  values: (type: string, field: string, path = "") => request<{ values: { value: string; count: number }[] }>("GET", "/repository/values" + q({ type, field, path })),
  validate: () => request<{ issues: Issue[]; errors: number; warnings: number }>("GET", "/repository/validate"),
  reindex: () => request<{ started: boolean }>("POST", "/repository/reindex"),
  moveFolder: (from: string, to: string) => request<{ moved: number }>("POST", "/repository/folders/move", { from, to }),
  /** The sorted GUIDs of every match (generic tables); rows come from details. */
  query: (body: { filter?: TableFilter; sort?: SortLevel[]; limit?: number }, signal?: AbortSignal) =>
    request<{ total: number; ids: string[]; truncated: boolean }>("POST", "/repository/query", body, {}, signal),
  details: (ids: string[], columns?: string[], signal?: AbortSignal) =>
    request<TableRows>("POST", "/artifacts/details", { ids, columns }, {}, signal),
  hid: (hid: string) => request<{ records: { guid: string; hid: string; current: boolean }[] }>("GET", "/repository/hids/" + encodeURIComponent(hid)),

  get: (guid: string) => request<View>("GET", "/artifacts/" + guid),
  create: (collection: "entries" | "documents" | "links" | "comments", body: unknown) => request<View>("POST", "/" + collection, body),
  update: (guid: string, patch: unknown, etag?: string) =>
    request<View>("PUT", "/artifacts/" + guid, patch, etag ? { "If-Match": `"${etag}"` } : {}),
  remove: (guid: string, etag?: string) => request<void>("DELETE", "/artifacts/" + guid, undefined, etag ? { "If-Match": `"${etag}"` } : {}),
  move: (guid: string, path: string) => request<View>("POST", `/artifacts/${guid}/move`, { path }),
  /** Creates a new base below an entry from fields it sets itself (one commit). */
  underlay: (guid: string, title: string, fields: string[], etag?: string) =>
    request<{ base: View; entry: View }>("POST", `/artifacts/${guid}/underlay`, { title, fields }, etag ? { "If-Match": `"${etag}"` } : {}),
  schemaOf: (guid: string) => request<{ schema: Schema | null; type: string; folder: string }>("GET", `/artifacts/${guid}/schema`),
  overlay: (guid: string) => request<OverlayView>("GET", `/artifacts/${guid}/overlay`),
  documents: (guid: string) => request<{ documents: Summary[] }>("GET", `/artifacts/${guid}/documents`),
  workflows: (guid: string) => request<{ workflows: WorkflowEval[] }>("GET", `/artifacts/${guid}/workflows`),
  transition: (guid: string, workflow: string, to: string, etag?: string) =>
    request<View>("POST", `/artifacts/${guid}/transition`, { workflow, to }, etag ? { "If-Match": `"${etag}"` } : {}),
  relationships: (guid: string) => request<Relationships>("GET", `/artifacts/${guid}/relationships`),
  comments: (guid: string) => request<{ comments: CommentView[] }>("GET", `/artifacts/${guid}/comments`),
  history: (guid: string) => request<{ history: LogEntry[] }>("GET", `/artifacts/${guid}/history`),
  uploadFile: async (guid: string, name: string, file: File) => {
    const res = await fetch(`/api/artifacts/${guid}/files/${encodeURIComponent(name)}`, { method: "PUT", body: file, headers: userHeader() });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({})))?.error ?? res.statusText);
  },
  deleteFile: (guid: string, name: string) => request<void>("DELETE", `/artifacts/${guid}/files/${encodeURIComponent(name)}`),
  fileUrl: (guid: string, name: string) => `/api/artifacts/${guid}/files/${encodeURIComponent(name)}`,

  effectiveSchema: (type: string, path: string) => request<Schema>("GET", "/schemas/effective" + q({ type, path })),
  workflowDef: (id: string, type: string, path: string) => request<Workflow>("GET", `/workflows/${encodeURIComponent(id)}` + q({ type, path })),
};

export type { Attachment };
