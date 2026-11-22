import type { ItemLinks } from "@corestone/editor";
import type { FolderInfo, PickOptions, Schema, SortLevel, Summary, TableFilter, TableRows } from "./types";

// Where the components get their data from. A component imports neither the
// API nor the store: it asks for a provider, and the application answers with
// one that talks to the server. The interfaces grow with the components that
// are moved onto them (refactoring plan, phase 4).

/** The types of entries, comments, links and documents a folder can hold. */
export interface TypeSource {
  /** The types visible in a folder. May answer from a cache, which the provider drops when the repository changes. */
  types(folder: string): Promise<Schema[]>;
}

/** The folders of the repository. */
export interface FolderSource {
  /** The folders directly inside a folder ("" is the repository). */
  children(path: string): Promise<FolderInfo[]>;
}

/** The artifacts a dynamic enumeration offers. */
export interface OptionSource {
  /** The artifacts a field of a type offers as its options in a folder, in the source's order. */
  options(type: string, field: string, folder: string): Promise<Summary[]>;
}

/** What a field editor needs beyond its field and its value. */
export interface FieldServices {
  /** The artifact with a GUID, to show a reference by its name; rejects when there is none. */
  resolve(guid: string): Promise<Summary>;
  /** The values artifacts of a type have in a field, in a folder and below ("" is everywhere). */
  values(type: string, field: string, folder: string): Promise<string[]>;
  /** Lets the user pick an artifact; null when they pick none. */
  pick(options: PickOptions): Promise<Summary | null>;
  /** Links in rich text to items: how one is chosen and what it is called. Without it the editor offers none. */
  itemLinks?: Required<Pick<ItemLinks, "pick" | "label">>;
  /** Tells the user something, as a passing notice. */
  notify(text: string, level: "info" | "error"): void;
  /** Where the diagram editor is served; nothing when there is none. */
  diagramsUrl?(): string | undefined;
}

/** The rows of a table that shows artifacts of the repository. */
export interface TableSource {
  /** The GUIDs of the artifacts a filter lets through, in the order of the sort; truncated: there are more than were given. */
  query(q: { filter?: TableFilter; sort?: SortLevel[] }, signal?: AbortSignal): Promise<{ total: number; ids: string[]; truncated: boolean }>;
  /** The rows of some of them; columns: the fields wanted, all without. */
  details(ids: string[], columns?: string[], signal?: AbortSignal): Promise<TableRows>;
  /** Has a function called whenever the artifacts may have changed; returns what ends that. */
  changed(listener: () => void): () => void;
}

/** The providers a component may ask for. */
export interface Services {
  types: TypeSource;
  folders: FolderSource;
  options: OptionSource;
  fields: FieldServices;
  table: TableSource;
}

const ASK = "cs-services";

/**
 * Makes an element answer its descendants' requests for providers. The
 * nearest such ancestor of a component answers; what it does not have is not
 * looked for further up.
 */
export function provideServices(el: EventTarget, services: Partial<Services>): void {
  el.addEventListener(ASK, (e) => {
    (e as CustomEvent<{ services?: Partial<Services> }>).detail.services = services;
    e.stopPropagation();
  });
}

/**
 * The providers for a component, from the nearest ancestor that has some
 * (provideServices). The component must be in the page. Empty when nobody
 * answers, so a component has to do without (and may look poorer).
 */
export function servicesFor(el: EventTarget): Partial<Services> {
  const detail: { services?: Partial<Services> } = {};
  el.dispatchEvent(new CustomEvent(ASK, { detail, bubbles: true, composed: true }));
  return detail.services ?? {};
}
