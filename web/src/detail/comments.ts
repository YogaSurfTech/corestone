import { html, nothing, type TemplateResult } from "lit";
import { fmtTime } from "@corestone/ui";
import { navigate } from "../router";
import type { CommentView } from "../types";
import { type DetailState } from "./state";
import { artifactRef, refHref, refRoute, sectionOf } from "./parts";

// The comments on the artifact; for a comment, what it is on and the thread it belongs to.

/** A comment itself: what it is on (and whom it answers), then its author, time and text. */
export function ownCommentSection(dt: DetailState) {
  const v = dt.view!;
  const sub = dt.comments.subject;
  const parent = String(v.data.parent ?? "");
  const answered = parent ? dt.comments.list.find((c) => c.meta.guid === parent) : undefined;
  const on = !sub ? artifactRef(dt, v.meta.subject, null)
    : sub.meta.kind !== "link" ? artifactRef(dt, sub.meta.guid, sub.meta)
    : html`${artifactRef(dt, sub.meta.source, sub.source)}
      <a class="muted" href=${refHref(dt, refRoute(dt, sub.meta.guid, sub.meta))} @click=${(e: Event) => { e.preventDefault(); navigate({ ...refRoute(dt, sub.meta.guid, sub.meta), tab: "" }); }}>→ ${sub.role ?? sub.meta.type} →</a>
      ${artifactRef(dt, sub.meta.target, sub.target)}`;
  return sectionOf(dt, "comment", () => html`
    <div class="comment-on" data-test="comment-subject">
      <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${dt.schema}></corestone-type-icon>
      <span class="muted">on</span><div class="link-row">${on}</div></div>
    ${parent ? html`<div class="small muted" data-test="comment-parent" style="margin-top:6px">Reply to
      <a href=${refHref(dt, refRoute(dt, parent, answered?.meta))} @click=${(e: Event) => { e.preventDefault(); navigate({ ...refRoute(dt, parent, answered?.meta), tab: "" }); }}>${answered ? `${answered.meta.author || "anonymous"}'s comment` : "a comment"}</a></div>` : nothing}
    <div class="comment ${dt.changedClass("text")}" data-test="comment-own">
      <div class="who"><b>${v.meta.author || "anonymous"}</b> · ${fmtTime(v.meta.created)}</div>
      <div class="text">${String(v.data.text ?? "")}</div>
    </div>`);
}

export function commentSection(dt: DetailState) {
  const byParent = new Map<string, CommentView[]>();
  // Pending comments sit in their thread like stored ones, marked until saved.
  const pending: CommentView[] = dt.comments.added.map((c, i) => ({
    meta: { guid: "pending-" + i, kind: "comment", type: c.type ?? "comment", folder: "", path: "", author: dt.s.user, links: 0, comments: 0 },
    data: { type: c.type, text: c.text, parent: c.parent } }));
  const all = [...dt.comments.list, ...pending];
  const known = new Set(all.map((c) => c.meta.guid));
  for (const c of all) {
    let p = String(c.data?.parent ?? "");
    if (p && (!known.has(p) || p === c.meta.guid)) p = ""; // orphaned reply: show at the root
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const seen = new Set<string>();
  const render = (parent: string, depth: number): TemplateResult[] => (byParent.get(parent) ?? []).filter((c) => !seen.has(c.meta.guid) && seen.add(c.meta.guid) && depth < 50).map((c) => { const pi = c.meta.guid.startsWith("pending-") ? Number(c.meta.guid.slice(8)) : -1; return html`<div class="comment ${depth ? "reply" : ""} ${c.meta.guid === dt.guid ? "current" : ""} ${dt.added(c.meta.guid) ? "added" : ""} ${pi >= 0 ? "pending-add" : ""}" data-comment=${c.meta.guid}>
    <div class="who"><b>${c.meta.author || "anonymous"}</b> · ${pi >= 0 ? html`<i>unsaved</i>` : fmtTime(c.meta.created)} ${c.data?.type && c.data.type !== "comment" ? html`<span class="pill">${String(c.data.type)}</span>` : nothing}
      ${pi >= 0 ? html`<a href="#" data-test="comment-drop" @click=${(e: Event) => { e.preventDefault(); dt.comments.drop(pi); }}>remove</a>`
      : dt.comments.type ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); dt.comments.replyTo = c.meta.guid; dt.host.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>reply</a>` : nothing}</div>
    <div class="text">${String(c.data?.text ?? "")}</div>
    ${render(c.meta.guid, depth + 1)}</div>`; });
  const actions = dt.historic ? nothing : !dt.comments.type
    ? html`<span class="muted small" data-test="no-comment-type">No comment type is defined here, so no comments can be added.</span>`
    : html`<button class="btn sm" data-test="comment-add" @click=${async () => { await dt.reveal("comments"); dt.host.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>＋ Comment</button>`;
  return sectionOf(dt, "comments", () => html`
    ${!all.length ? html`<div class="muted small">No comments yet.</div>` : render("", 0)}
    ${!dt.comments.type ? nothing : html`<div class="inline-form">
      <textarea id="comment-text" data-test="comment-text" placeholder=${dt.comments.replyTo || dt.view?.meta.kind === "comment" ? "Reply…" : "Write a comment…"} .value=${dt.comments.text} @input=${(e: Event) => (dt.comments.text = (e.target as HTMLTextAreaElement).value)}></textarea>
      <div style="display:flex;flex-direction:column;gap:4px">
        <button class="btn primary sm" data-test="comment-send" title=${dt.edit.dirty ? "Saved together with your other changes" : "Publishes the comment now"} @click=${() => dt.comments.post()}>${dt.edit.dirty ? "Add" : "Post"}</button>
        ${dt.comments.replyTo ? html`<button class="btn sm" @click=${() => (dt.comments.replyTo = null)}>cancel reply</button>` : nothing}
      </div></div>`}`, actions);
}
