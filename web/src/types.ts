// What the REST API answers beyond the data shapes of components/types.ts:
// the views of one artifact, its history, the folders and the server's state.
import type { Attachment, FolderInfo, Schema, Summary, Transition, Workflow } from "./components/types";

export interface View {
  meta: Summary;
  data: Record<string, unknown>;
  etag: string;
  attachments?: Attachment[];
}

/** A workflow field of an artifact evaluated: id and name are the field's; available are the transitions allowed now. */
export interface WorkflowEval { id: string; name: string; definition: Workflow; state: string; transition?: string; previous?: string; available: Transition[] }

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
export interface HistoryEntry extends LogEntry {
  blob?: string;
  /** Links created here that repeat a deleted link (same type and endpoints), with its last version. */
  recreates?: { link: string; prior: string; blob?: string; at?: string; deletedAt?: string; deletedBy?: string }[];
}

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
  /** What this version's commit changed, compared with just before it. */
  change?: VersionChange;
}

export interface VersionChange {
  created?: boolean;
  restored?: boolean; // brought back after a deletion
  changed: string[];  // title, hid, text, …, fields.<id>
  added: string[];    // links and comments that came to point here
  removedLinks?: number;
  removedComments?: number;
}

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

/** A picker footer action besides picking a row; "add" shows a green ＋, "remove" a red ✕. */
export interface PickerAction { label: string; test: string; tone: "add" | "remove"; run: () => void }
