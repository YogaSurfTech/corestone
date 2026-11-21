import type { FolderInfo, Schema } from "../types";

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

/** The providers a component may ask for. */
export interface Services {
  types: TypeSource;
  folders: FolderSource;
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
