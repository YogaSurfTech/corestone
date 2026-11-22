import type { RepoStatus, View } from "./types";
import type { PickerOptions } from "./components/picker";
import type { Kind, Summary, Theme } from "./components/types";
import { errorText, prefs } from "@corestone/ui";
import type { Account } from "./api";

// Central application store (design guide §7.14): every persistent UI state
// lives here; components observe it and never talk to each other.

export interface Route {
  folder: string;        // selected folder ("" = root)
  guid: string | null;   // selected artifact
  q: string;             // search query
  subtree: boolean;      // include nested folders
  kind: string;          // kind filter ("" = entries+documents)
  type: string;          // type filter
  tab: string;           // detail section / document sidebar
  sidebars: string[];    // visible document sidebars
  expanded: boolean;     // detail fills the workspace
  version: string;       // a historic version of the artifact: its content blob ("" = current)
  at: string;            // the commit that version is viewed at
}


export interface Toast { id: number; text: string; level: "info" | "error" | "success"; action?: { label: string; run: () => void } }

export interface Presence { viewers: string[]; editors: string[] }

/** What the "New" dialog starts with. */
export interface NewOptions {
  /** The folder the artifact goes to; without it the folder that is shown. */
  folder?: string;
  /** The kinds whose types are offered; without it all. */
  kinds?: Kind[];
  /** The type that is chosen already. */
  type?: string;
  /** The entry the new one inherits from. */
  base?: { guid: string; label: string };
}

export interface ConfirmOptions {
  text: string;
  /** Shown below the text (a template). */
  body?: unknown;
  /** The confirm button warns. */
  danger?: boolean;
  confirmLabel?: string;
  /** A second way to go on, beside confirming. */
  altLabel?: string;
  /** Nothing to confirm: the dialog only tells, and has one button. */
  noConfirm?: boolean;
  /** The dialog has a grip; its size is remembered under this name. */
  resizable?: string;
}

/** How a confirmation ended. */
export type Choice = "confirm" | "alt" | "cancel";

/** The dialog that is open. Its `done` is called once, when it closes. */
export type Dialog =
  | ({ kind: "new" } & NewOptions)
  | ({ kind: "confirm"; title: string; done: (choice: Choice) => void } & ConfirmOptions)
  | ({ kind: "prompt"; title: string; done: (value: string | null) => void } & PromptOptions)
  | { kind: "account" };

/** The open artifact picker: one artifact is chosen, or several with checkboxes and a "<verb> n" button. */
export type PickerDialog = PickerOptions & (
  | { multi?: undefined; done: (picked: Summary | null) => void }
  | { multi: { verb: string }; done: (guids: string[]) => void });

export interface PromptOptions {
  text?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** The value is a folder path: show the folder field instead of a plain input. */
  folder?: boolean;
  /** Also offer the colour theme; choosing one applies it right away. */
  theme?: boolean;
  /** With folder: the folder being moved, which is no typo candidate. */
  ignore?: string;
}

export interface State {
  route: Route;
  status: RepoStatus | null;
  connected: boolean;
  session: string;
  user: string;
  /** The signed-in account (-auth local); null when the server runs open. */
  account: Account | null;
  theme: Theme;
  selection: View | null;
  selectionError: string | null;
  loading: boolean;
  presence: Record<string, Presence>;
  toasts: Toast[];
  dialog: Dialog | null;
  picker: PickerDialog | null; // an artifact picker shown above the current dialog
  refreshTick: number;
  navCollapsed: boolean;
}

export const defaultRoute: Route = { folder: "", guid: null, q: "", subtree: false, kind: "", type: "", tab: "", sidebars: [], expanded: false, version: "", at: "" };

type Listener = (s: State) => void;

class Store {
  state: State = {
    route: { ...defaultRoute },
    status: null,
    connected: false,
    session: "",
    user: prefs.text("corestone.user") || "",
    account: null,
    theme: applyTheme(prefs.text("corestone.theme") as Theme | null),
    selection: null,
    selectionError: null,
    loading: false,
    presence: {},
    toasts: [],
    dialog: null,
    picker: null,
    refreshTick: 0,
    navCollapsed: (prefs.text("corestone.nav") ?? (narrowScreen() ? "collapsed" : "open")) === "collapsed",
  };
  private listeners = new Set<Listener>();
  private toastSeq = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setRoute(patch: Partial<Route>) {
    this.set({ route: { ...this.state.route, ...patch } });
  }

  toast(text: string, level: Toast["level"] = "info", action?: Toast["action"]) {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts, { id, text, level, action }] });
    window.setTimeout(() => this.dismiss(id), level === "error" ? 9000 : 4000);
  }

  dismiss(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  /** Asks the user for one line of text; resolves null when cancelled. */
  prompt(title: string, opts: PromptOptions = {}): Promise<string | null> {
    return new Promise((resolve) => {
      this.set({ dialog: { kind: "prompt", title, ...opts, done: resolve } });
    });
  }

  /** Asks the user to confirm something; resolves with what they chose. */
  confirm(title: string, opts: ConfirmOptions): Promise<Choice> {
    return new Promise((resolve) => {
      this.set({ dialog: { kind: "confirm", title, ...opts, done: resolve } });
    });
  }

  refresh() {
    this.set({ refreshTick: this.state.refreshTick + 1 });
  }

  setUser(name: string) {
    prefs.setText("corestone.user", name);
    this.set({ user: name });
  }

  /** The signed-in account also names the user (presence, commits). */
  setAccount(account: Account) {
    this.set({ account, user: account.name });
  }

  setTheme(theme: Theme) {
    if (theme === "auto") prefs.remove("corestone.theme"); else prefs.setText("corestone.theme", theme);
    this.set({ theme: applyTheme(theme) });
  }

  toggleNav() {
    const c = !this.state.navCollapsed;
    prefs.setText("corestone.nav", c ? "collapsed" : "open");
    this.set({ navCollapsed: c });
  }

  /** On narrow screens the navigation is an overlay: close it after a choice. */
  closeNavIfOverlay() {
    if (narrowScreen() && !this.state.navCollapsed) this.set({ navCollapsed: true });
  }
}

/** Sets the theme on <html>; "auto" leaves it to the system preference. */
function applyTheme(theme: Theme | null): Theme {
  const t: Theme = theme === "light" || theme === "dark" ? theme : "auto";
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  return t;
}

function narrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;
}

export const store = new Store();

/** Shows something that was thrown as an error toast. */
/** Opens the artifact picker for one artifact: the chosen one, or null when the picker is closed without. */
export function pickArtifact(options: PickerOptions): Promise<Summary | null> {
  return new Promise((resolve) => {
    store.set({ picker: { ...options, done: resolve } });
  });
}

/** Opens the artifact picker for several artifacts: the GUIDs of the chosen ones, none when it is closed without. */
export function pickArtifacts(options: PickerOptions, verb: string): Promise<string[]> {
  return new Promise((resolve) => {
    store.set({ picker: { ...options, multi: { verb }, done: resolve } });
  });
}

export const toastError = (e: unknown) => store.toast(errorText(e), "error");
