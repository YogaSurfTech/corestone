import { html, nothing, render } from "lit";
import { errorText } from "@corestone/ui";
import { fileNames, renameFiles, type Block, type DocumentHost, type EntryFiles, type Placed, type RichText } from "@corestone/editor";
import { api } from "../api";
import { navigate } from "../router";
import { pickArtifacts, store } from "../store";
import { type View } from "../types";
import { type Schema } from "../components/types";
import { workflowStates } from "../components/artifact";

import { type DocumentState, isNew } from "./state";

// The entries placed in the document, as the editor sees them: how one is chosen, shown and opened,
// and what it becomes as text of the document.

/** What the editor asks the page for: the entries placed in the document, and how they are chosen, shown and opened. */
export function documentHost(ds: DocumentState): DocumentHost {
  return {
      guid: undefined,
      pickEntries: (taken) => pickArtifacts({ title: "Insert entries", kinds: ["entry"],
        taken: { guids: new Set(taken), note: "already in this document" } }, "Insert"),
      renderEntry: (el, p) => renderEntry(ds, el, p),
      openEntry: (key, newTab) => {
        const guid = ds.real(key);
        if (isNew(guid)) { store.toast("This entry is created when the document is saved.", "info"); return; }
        if (newTab) window.open(`/artifact/${guid}`, "_blank", "noopener");
        else navigate({ guid });
      },
      entryLabel: (key) => {
        const guid = ds.real(key);
        const h = ds.held.get(guid);
        if (h) return h.title || "New entry";
        const e = ds.entries.get(guid);
        if (!e || e === "loading") return undefined;
        return e.view ? (e.view.meta.hid || e.view.meta.title || undefined) : e.missing?.hid;
      },
      entryNumbers: true,
      convertToEntry: (c) => ds.newEntry(c),
      entryTypes: () => ({
        remember: ds.view?.meta.type ?? "",
        types: ds.convertTypes.map((t) => ({ id: t.type, name: t.displayName ?? t.type, icon: () => {
          const el = document.createElement("corestone-type-icon") as HTMLElement & { kind: string; type: string; folder: string; schema: Schema };
          Object.assign(el, { kind: "entry", type: t.type, folder: ds.view?.meta.folder ?? "", schema: t });
          return el;
        } })),
      }),
      entryAsText: (key) => entryAsText(ds, ds.real(key)),
    };
}

/** A placed entry: the built-in card (type, number, HID, title, state and its rich-text fields). */
export function renderEntry(ds: DocumentState, el: HTMLElement, p: Placed) {
  el.classList.add("doc-entry");
  const guid = ds.real(p.guid);
  const h = ds.held.get(guid);
  if (h) {
    // a new entry: as it will be, marked until the save creates it (its pictures are the document's)
    const rich = (h.schema.fields ?? []).filter((f) => f.type === "richtext" && h.fields[f.id] != null && h.fields[f.id] !== "");
    render(html`<div class="entry-card new ${ds.current === p.guid ? "current" : ""}">
      <div class="head">${p.number ? html`<span class="num">${p.number}</span>` : nothing}
        <corestone-type-icon kind="entry" .type=${h.schema.type} .folder=${h.folder}></corestone-type-icon>
        <b class="title">${h.title || html`<span class="muted">Untitled</span>`}</b>
        <span class="pill unsaved" title="This entry is created when the document is saved">not saved yet</span>
        ${ds.missing(h).length || ds.problems.has(p.guid) ? html`<span class="pill problem" title=${(ds.problems.get(p.guid) ?? []).join("\n")}>${ds.missing(h).length
          ? `${ds.missing(h).map((f) => f.name ?? f.id).join(", ")} missing` : "cannot be created"}</span>` : nothing}</div>
      ${rich.map((f) => html`<div class="rich"><div class="label">${f.name ?? f.id}</div>
        <cs-richtext readonly .value=${h.fields[f.id] as RichText} .files=${ds.docFiles}></cs-richtext></div>`)}
    </div>`, el);
    return;
  }
  const e = ds.entries.get(guid);
  if (!e || e === "loading") {
    render(html`<div class="entry-card loading"><span class="num">${p.number}</span> Loading entry…</div>`, el);
    if (!e) ds.observer?.observe(el);
    return;
  }
  if (!e.view) {
    const name = e.missing?.hid || e.missing?.title || p.guid;
    render(html`<div class="entry-card missing" title="This entry is not in the repository any more">
      <span class="num">${p.number}</span> Missing entry <b>${name}</b></div>`, el);
    return;
  }
  const v = e.view;
  const d = v.data as Record<string, unknown>;
  const values = (d.fields as Record<string, unknown>) ?? {};
  const rich = (e.schema?.fields ?? []).filter((f) => f.type === "richtext" && values[f.id] != null && values[f.id] !== "");
  const files: EntryFiles = { add: () => Promise.reject(new Error("read-only")), url: (n) => api.fileUrl(v.meta.guid, n), list: async () => [] };
  render(html`<div class="entry-card ${ds.current === p.guid ? "current" : ""}">
    <div class="head">${p.number ? html`<span class="num">${p.number}</span>` : nothing}
      <corestone-type-icon kind="entry" .type=${v.meta.type} .folder=${v.meta.folder}></corestone-type-icon>
      ${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : nothing}<b class="title">${v.meta.title}</b>
      ${workflowStates(v.data.fields as Record<string, unknown> | undefined).map(([, st]) => html`<span class="pill state">${st}</span>`)}</div>
    ${rich.map((f) => html`<div class="rich"><div class="label">${f.name ?? f.id}</div>
      <cs-richtext readonly .value=${values[f.id] as RichText} .files=${files}></cs-richtext></div>`)}
  </div>`, el);
}

/** A placed entry as text of the document: its title (bold), then its rich-text fields (each
 *  under its name when there are several); its pictures become files of the document. */
export async function entryAsText(ds: DocumentState, guid: string): Promise<{ text: RichText } | { error: string }> {
  const h = ds.held.get(guid);
  if (h) return { text: asText(ds, h.title, h.schema, h.fields) }; // (its pictures are the document's already)
  let v: View, schema: Schema | null;
  try {
    v = await api.get(guid);
    schema = await ds.schemaOf(v);
  } catch (e) {
    return { error: `The entry could not be read: ${errorText(e)}` };
  }
  const blocks = asText(ds, v.meta.title || v.meta.hid || "", schema, ((v.data as Record<string, unknown>).fields as Record<string, unknown>) ?? {});
  const names = fileNames(blocks);
  const renamed = await ds.copyFiles(names, (n) => api.fileBlob(api.fileUrl(guid, n)), (_n, f) => ds.docFiles.add(f));
  return { text: renameFiles(blocks, renamed) };
}

/** An entry as document text: its title (bold), then its rich-text fields (each under its
 *  name when there are several). */
export function asText(ds: DocumentState, title: string, schema: Schema | null, values: Record<string, unknown>): Block[] {
  const rich = (schema?.fields ?? []).filter((f) => f.type === "richtext" && values[f.id] != null && values[f.id] !== "");
  const blocks: Block[] = [{ text: [{ text: title || "Untitled", bold: true }] }];
  for (const f of rich) {
    if (rich.length > 1) blocks.push({ text: [{ text: f.name ?? f.id, italic: true }] });
    const val = values[f.id] as RichText;
    blocks.push(...(typeof val === "string" ? val.split("\n").map((t): Block => ({ text: t })) : val));
  }
  return blocks;
}
