// Types mirrored from the REST API. Domain knowledge (which fields exist,
// which workflows apply) never lives here: it is read from schemas.

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
  workflows?: Record<string, string>;
  fields?: Record<string, unknown>;
  etag?: string;
  createdAt?: string;
  modifiedAt?: string;
  links: number;
  comments: number;
}

export interface View {
  meta: Summary;
  data: Record<string, unknown>;
  etag: string;
  attachments?: Attachment[];
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
  workflows?: string[];
  sourceTypes?: string[];
  targetTypes?: string[];
  cardinality?: string;
  /** Links: the name read from the target ("verified by"). */
  reverseName?: string;
  presentation?: Record<string, unknown>;
  sources?: string[];
}

export interface WorkflowState { id: string; name?: string; presentation?: IconPresentation; final?: boolean }
export interface Transition { id?: string; name?: string; from: string[]; to: string }
export interface Workflow {
  id: string;
  name?: string;
  description?: string;
  initial: string;
  states: WorkflowState[];
  transitions: Transition[];
  scope?: string;
}

export interface WorkflowEval { id: string; definition: Workflow; state: string; available: Transition[] }

/** A link seen from one endpoint; role is the display name, or the reverse name when incoming. */
export interface LinkView { link: Summary; other: Summary; role?: string }
export interface Relationships {
  incoming: LinkView[];
  outgoing: LinkView[];
  allowedAsSource: Schema[];
  allowedAsTarget: Schema[];
}

export interface CommentView { meta: Summary; data: Record<string, unknown> }

export interface OverlayLevel { guid: string; title?: string; hid?: string; fields: string[] }
export interface OverlayView {
  chain: OverlayLevel[];
  fields: Record<string, unknown>;
  origin: Record<string, string>;
  overlays: Summary[];
}

export interface LogEntry {
  sha: string;
  author: string;
  email: string;
  time: string;
  subject: string;
  body?: string;
  trailers?: Record<string, string>;
}

/** A commit in an artifact's history; blob addresses the artifact's version then ("" or absent: it did not exist). */
export interface HistoryEntry extends LogEntry { blob?: string }

/** An artifact as it was at one commit (read-only); configuration is today's. */
export interface VersionView extends View {
  commit: LogEntry;
  exact: boolean;   // false: shown at the commit that introduced this content
  exists: boolean;  // the artifact still exists today
  schema?: Schema | null;
  overlay?: { chain: OverlayLevel[]; fields: Record<string, unknown>; origin: Record<string, string> } | null;
  baseOverlay?: { chain: OverlayLevel[]; fields: Record<string, unknown>; origin: Record<string, string> } | null;
  workflows: WorkflowEval[];
  relationships: Relationships;
  comments: CommentView[];
  /** A link's endpoints as they were then (null: did not exist then). */
  endpoints?: { source: Summary | null; target: Summary | null };
  /** What a comment was on, as it was then; a link comes with its endpoints and role name. */
  subject?: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string };
}

export interface FolderInfo { name: string; path: string; artifacts: number; direct: number; hasConfig: boolean }
export interface Tree { folder: string; folders: FolderInfo[]; artifacts: Summary[]; total: number }

export interface ProjectionStatus {
  processedHash: string;
  maintenance: boolean;
  lastRebuild?: string;
  reason?: string;
  phase?: string;
  progress: number;
  total: number;
  lastError?: string;
  capabilities: { lookup: boolean; query: boolean; search: boolean };
}

export interface RepoStatus {
  branch: string;
  head: string;
  projection: ProjectionStatus;
  inSync: boolean;
  stats?: { artifacts: Record<string, number>; types: Record<string, number>; invalid: number; deleted: number; folders: number; schemas: number; workflows: number };
  /** Configuration problems: invalid files the server ignores (code invalid-config) and unresolved references (config-reference). */
  invalidConfig?: Issue[];
}

export interface Issue { severity: "error" | "warning"; code: string; guid?: string; path?: string; message: string }

export interface Block {
  id?: string;
  type: "section" | "paragraph" | "entry" | "image" | "list" | "code" | "toc";
  title?: string;
  text?: string;
  guid?: string;
  src?: string;
  alt?: string;
  children?: Block[];
  items?: Block[];
  /** toc: how many section levels to list; all when absent. */
  depth?: number;
  [k: string]: unknown;
}

/** One level of a table sort; col is an overview column id ("$hid", …) or a field id. */
export interface SortLevel { col: string; dir: "asc" | "desc" }

/** The filter of a generic table query; types may hold "<kind>/*". */
export interface TableFilter {
  q?: string; path?: string; subtree?: boolean; kind?: Kind[]; type?: string; types?: string[]; hid?: string;
  fields?: Record<string, string>; states?: Record<string, string>; valid?: boolean;
}

/** Table rows, the artifacts they point at, and type display names by folder and type. */
export interface TableRows {
  artifacts: Summary[];
  related: Record<string, Summary>;
  typeNames: Record<string, Record<string, string>>;
}
