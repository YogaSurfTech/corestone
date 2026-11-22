// The shapes of Corestone's data that the components show, as the REST API
// gives them. Domain knowledge (which fields exist, which workflows apply)
// never lives here: it is read from schemas.

export type Kind = "entry" | "document" | "link" | "comment";

export interface Summary {
  guid: string;
  kind: Kind;
  type: string;
  title?: string;
  hid?: string;
  folder: string;
  path: string;
  base?: string;
  source?: string;
  target?: string;
  subject?: string;
  parent?: string;
  author?: string;
  excerpt?: string;
  created?: string;
  fields?: Record<string, unknown>;
  etag?: string;
  createdAt?: string;
  modifiedAt?: string;
  links: number;
  comments: number;
}

export interface Attachment {
  name: string;
  path: string;
  etag: string;
  size: number;
}

export type FieldType =
  | "hid" | "boolean" | "integer" | "float" | "currency" | "date" | "time" | "datetime"
  | "text" | "multiline" | "richtext" | "enum" | "hyperlink" | "reference" | "references"
  | "attachment" | "json" | "workflow";

export interface IconPresentation { icon?: string; color?: string; backgroundColor?: string }

export interface EnumOption { value: string; label?: string; presentation?: IconPresentation }

export interface Field {
  id: string;
  name?: string;
  type: FieldType;
  multiple?: boolean;
  required?: boolean;
  options?: EnumOption[];
  extendable?: boolean;
  /** A dynamic enumeration: the options are artifacts, a value is the chosen artifact's GUID. */
  source?: { kind: "entry" | "document"; types: string[]; query?: string; sort?: string[] };
  currency?: string;
  workflow?: string;
  targetTypes?: string[];
  description?: string;
  default?: unknown;
  presentation?: Record<string, unknown>;
}

export interface Schema {
  type: string;
  kind: Kind;
  displayName?: string;
  description?: string;
  hid?: { prefix: string; separator?: string; digits?: number };
  fields?: Field[];
  sourceTypes?: string[];
  targetTypes?: string[];
  cardinality?: string;
  /** Links: the name read from the target ("verified by"). */
  reverseName?: string;
  /** Document types: the entry types "Convert selection to entry" makes. */
  entryTypes?: string[];
  presentation?: Record<string, unknown>;
  sources?: string[];
}

export interface WorkflowState { id: string; name?: string; presentation?: IconPresentation; final?: boolean }

/** A transition is named by its id: it is what a save sends; the server runs it. */
export interface Transition { id: string; name?: string; from: string[]; to: string }

export interface Workflow {
  id: string;
  name?: string;
  description?: string;
  initial: string;
  states: WorkflowState[];
  transitions: Transition[];
  scope?: string;
}

/** The value of a workflow field, written by the server: the state, the transition that led to it, the state before. */
export interface WorkflowValue { state: string; transition?: string; previous?: string }

export interface FolderInfo { name: string; path: string; artifacts: number; direct: number; hasConfig: boolean }

/** One level of a table sort; col is an overview column id ("$hid", …) or a field id. */
export interface SortLevel { col: string; dir: "asc" | "desc" }

/** The filter of a generic table query; types may hold "<kind>/*". */
export interface TableFilter {
  q?: string;
  /** A query in the query language, combined with the rest by AND. */
  query?: string; path?: string; subtree?: boolean; kind?: Kind[]; type?: string; types?: string[]; hid?: string;
  fields?: Record<string, string>; states?: Record<string, string>; valid?: boolean;
}

/** A criterion of a query that cannot match as written. */
export interface QueryWarning { pos: number; message: string }

/** Table rows, the artifacts they point at, and type display names by folder and type. */
export interface TableRows {
  artifacts: Summary[];
  related: Record<string, Summary>;
  typeNames: Record<string, Record<string, string>>;
}

/** What the artifact picker offers when one artifact is to be chosen. */
export interface PickOptions {
  title: string;
  kinds?: Kind[];
  /** Type ids; "<kind>/*" allows every type of a kind. */
  types?: string[];
  /** Narrows what is offered, in the query language. */
  query?: string;
  /** An artifact that is not offered (its GUID). */
  exclude?: string;
}

/** The colour theme; "auto" follows the system setting. */
export type Theme = "auto" | "light" | "dark";
