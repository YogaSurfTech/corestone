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

export interface LinkView { link: Summary; other: Summary }
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
