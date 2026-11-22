import { html, type TemplateResult } from "lit";
import { fmtTime } from "@corestone/ui";
import { api } from "../../api";
import { toastError } from "../../store";
import { appIcon } from "../../components/icons";

import { type DocumentState } from "../state";
import { sideHead } from "./head";

// The comments sidebar: the comments on the document, and a box to add one.

/** The comments on the document. */
export function commentsPanel(ds: DocumentState, id: string): TemplateResult {
  return html`${sideHead(ds, id, "Comments")}${ds.side.comments.map((c) => html`<div class="comment"><div class="who"><b>${c.meta.author}</b> · ${fmtTime(c.meta.created)}</div><div class="text">${String(c.data?.text ?? "")}</div></div>`)}
    ${!ds.side.commentType ? html`<div class="muted small">No comment type is defined here, so no comments can be added.</div>` : html`<div class="inline-form"><textarea placeholder="Comment…" .value=${ds.side.commentText} @input=${(e: Event) => (ds.side.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
    <button class="icon-btn" data-tip="Post the comment" @click=${async () => { if (!ds.side.commentText.trim()) return; try { await api.create("comments", { subject: ds.guid, type: ds.side.commentType, text: ds.side.commentText, author: ds.s.user }); ds.side.commentText = ""; ds.side.load(); } catch (e) { toastError(e); } }}>${appIcon("send")}<span class="vh">Post</span></button></div>`}`;
}
