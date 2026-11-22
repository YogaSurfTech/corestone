// The query builder's model: a query as a row of criteria, and the query
// text it stands for. The text is what runs and what the server reads; the
// builder only writes it (a text is never turned back into criteria).
import type { EnumOption, PickOptions, QueryWarning, Summary } from "./types";

/** How two criteria are joined. NOT binds strongest, then AND, then XOR, then OR. */
export type Join = "AND" | "OR" | "XOR";
export const JOINS: Join[] = ["AND", "OR", "XOR"];

/** How a field's value is entered. */
export type Input = "text" | "enum" | "bool" | "number" | "date" | "artifact" | "empty";

export type Compare = "=" | "<" | "<=" | ">" | ">=" | "between";
export const COMPARES: [Compare, string][] = [["=", "is"], ["<", "before / less than"], ["<=", "up to"], [">", "after / more than"], [">=", "from"], ["between", "between"]];

/** A field the builder offers. */
export interface QueryField {
  /** As written in a query: "priority", "~base"; "" for words without a field. */
  id: string;
  name: string;
  input: Input;
  group: "General" | "Fields";
  /** enum: the options, known or to be loaded. */
  options?: EnumOption[];
  load?: () => Promise<EnumOption[]>;
  /** artifact: what the picker offers. */
  picker?: PickOptions;
}

/** What the query field needs from outside: it is handed in, the field asks no server and no store itself. */
export interface QuerySource {
  /** Has the query read: its warnings. Rejects when it cannot be read. */
  check(text: string): Promise<QueryWarning[]>;
  /** The artifacts a dynamic enumeration offers. */
  enumOptions(type: string, field: string, folder: string): Promise<Summary[]>;
  /** The states of a workflow, as options. */
  workflowStates(workflow: string, type: string, folder: string): Promise<EnumOption[]>;
  /** Lets the user choose an artifact; null when they give up. */
  pick(options: PickOptions): Promise<Summary | null>;
  /** Tells the user that something failed. */
  failed(error: unknown): void;
}

export type Value =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "enum"; values: { value: string; label: string }[] }
  | { kind: "bool"; value: boolean }
  | { kind: "range"; compare: Compare; a: string; b: string }
  | { kind: "artifact"; id: string; label: string };

export interface Clause {
  field: { id: string; name: string; input: Input };
  not: boolean;
  /** The operator in front of this criterion (unused for the first). */
  join: Join;
  value: Value;
}

const WORD = /^[\p{L}\p{N}_\-./@+*]+$/u;
const RESERVED = new Set(["AND", "OR", "XOR", "NOT", "NULL"]);

/** A value as written in a query: as it is, or in quotes when it needs them. */
export function quote(v: string): string {
  return WORD.test(v) && !RESERVED.has(v) ? v : `"${v.replace(/[\\"]/g, "\\$&")}"`;
}

function clauseText(c: Clause): string {
  const f = c.field.id;
  const at = f ? f + ":" : "";
  const v = c.value;
  let text: string;
  switch (v.kind) {
    case "empty": text = `${f}:NULL`; break;
    case "bool": text = at + String(v.value); break;
    case "artifact": text = at + quote(v.id); break;
    case "enum": text = v.values.length === 1 ? at + quote(v.values[0].value) : `${f}:(${v.values.map((o) => quote(o.value)).join(" ")})`; break;
    case "range":
      text = v.compare === "between" ? `(${f}:>=${quote(v.a)} AND ${f}:<=${quote(v.b)})` : at + (v.compare === "=" ? "" : v.compare) + quote(v.a);
      break;
    case "text": {
      const words = v.text.trim().split(/\s+/);
      // words without a field are one search; in a field several words are a phrase
      text = !f && words.every((w) => WORD.test(w) && !RESERVED.has(w)) ? words.join(" ") : at + quote(v.text.trim());
      if (!f && words.length > 1 && text === words.join(" ")) text = `(${text})`;
    }
  }
  return c.not ? "NOT " + text : text;
}

/** The query text of a row of criteria. */
export function toText(clauses: Clause[]): string {
  return clauses.map((c, i) => (i ? ` ${c.join} ` : "") + clauseText(c)).join("");
}

/** A criterion as its button reads. */
export function clauseLabel(c: Clause): string {
  const v = c.value;
  const n = c.field.name;
  switch (v.kind) {
    case "empty": return `${n} is empty`;
    case "bool": return `${n}: ${v.value ? "yes" : "no"}`;
    case "artifact": return `${n}: ${v.label}`;
    case "enum": return `${n}: ${v.values.map((o) => o.label).join(", ")}`;
    case "text": return `${n}: ${v.text}`;
    case "range": {
      if (v.compare === "between") return `${n}: ${v.a} – ${v.b}`;
      if (v.compare === "=") return `${n}: ${v.a}`;
      return `${n} ${({ "<": "<", "<=": "≤", ">": ">", ">=": "≥" } as Record<string, string>)[v.compare]} ${v.a}`;
    }
  }
}
