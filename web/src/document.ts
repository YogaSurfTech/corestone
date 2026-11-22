import { html, nothing } from "lit";
import { LightElement, Resizer, splitter } from "@corestone/ui";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import "@corestone/editor";
import { type DocNode, type OutlineItem } from "@corestone/editor";
import { server } from "./api";
import { navigate } from "./router";
import { type State } from "./store";
import "./components/type-icon";
import { appIcon, type AppIcon } from "./components/icons";
import "./components/fields";
import "./components/ref";
import { StoreController } from "./store-controller";

import { DocumentState } from "./document/state";
import { documentHost } from "./document/host";
import { outlinePanel } from "./document/outline";
import { sideHead } from "./document/sidebars/head";
import { propertiesPanel } from "./document/sidebars/properties";
import { entryPanel } from "./document/sidebars/entry";
import { relationshipsPanel } from "./document/sidebars/relationships";
import { commentsPanel } from "./document/sidebars/comments";
import { versionsPanel } from "./document/sidebars/versions";

// Document view (design guide §7.6, §9.5; docs/design/Corestone documents.md): one editor for
// the whole document (a tree of sections with text, pictures, tables and placed entries), the
// title above it, and optional sidebars for the outline, properties, the current entry,
// relationships, comments and versions.
//
// This file is the shell: the heading bar with the title and the switches, the
// editor, and the sidebars side by side. The state is document/state.ts.

const SIDEBARS = [["outline", "Outline"], ["props", "Properties"], ["entry", "Entry"], ["rel", "Relationships"], ["comments", "Comments"], ["versions", "Versions"]] as const satisfies readonly (readonly [AppIcon, string])[];

@customElement("corestone-document")
export class DocumentView extends LightElement {
  private readonly d = new DocumentState(this);
  private readonly host = documentHost(this.d);
  @property() guid = "";

  private readonly watch = new StoreController(this, (s) => {
    if (s.refreshTick === this.d.lastTick) return;
    this.d.lastTick = s.refreshTick;
    if (this.d.view) { this.d.loadSide(); this.d.reloadEntries(); }
  });

  private get s(): State { return this.watch.state; }

  /** The left edge of the sidebars: their width, px. */
  private readonly side = new Resizer({
    key: "corestone.docSideWidth", fallback: 320, min: 240, max: 720, axis: "x", step: 16, reverse: true,
    at: (m, box) => box.right - m.clientX,
    changed: () => this.requestUpdate(),
  });

  override connectedCallback() {
    super.connectedCallback();
    this.d.observer = new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        this.d.observer!.unobserve(e.target);
        const g = (e.target as HTMLElement).dataset.placement;
        if (g && !this.d.held.has(g)) void this.d.loadEntry(this.d.real(g));
      }
    }, { rootMargin: "600px 0px" });
  }

  override disconnectedCallback() {
    this.resizes?.disconnect();
    this.watched = undefined;
    this.d.observer?.disconnect();
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>) { if (changed.has("guid") && this.guid) this.d.load(); }

  /** The editor's toolbar lives in the heading bar, next to the sidebar switches. */
  override updated() {
    const slot = this.querySelector(".doc-tools");
    const bar = this.d.editor?.toolbar();
    if (slot && bar && bar.parentElement !== slot) slot.replaceChildren(bar);
    const scroll = this.querySelector(".doc-scroll");
    if (scroll && scroll !== this.watched) {
      this.resizes ??= new ResizeObserver(() => this.alignTools());
      this.resizes.disconnect();
      this.resizes.observe(scroll);
      this.resizes.observe(this);
      this.watched = scroll;
    }
    this.alignTools();
  }

  private resizes?: ResizeObserver;

  private watched?: Element;

  /** The toolbar starts where the paper starts, when the bar has room for that; otherwise it
   *  follows the left part after a separator. */
  private alignTools() {
    const tools = this.querySelector<HTMLElement>(".doc-tools");
    const page = this.querySelector(".doc-page");
    const right = this.querySelector(".doc-switches");
    const head = this.querySelector(".doc-head");
    if (!tools || !page || !right || !head) return;
    tools.style.marginLeft = "0px";
    const natural = tools.getBoundingClientRect().left;
    // room up to the right part (the right part keeps its place at the bar's end)
    const room = right.getBoundingClientRect().left - 12 - (natural + tools.getBoundingClientRect().width);
    const shift = Math.min(page.getBoundingClientRect().left - natural, room);
    const aligned = shift > 0 && right.getBoundingClientRect().top < tools.getBoundingClientRect().bottom;
    tools.style.marginLeft = aligned ? `${Math.round(shift)}px` : "0px";
    head.classList.toggle("aligned", aligned);
  }

  // ---- render ----

  override render() {
    if (!this.d.view) return html`<div class="empty-state">${this.d.error || "Loading…"}</div>`;
    const r = this.s.route;
    const v = this.d.view;
    const others = (this.s.presence[this.guid]?.editors ?? []).filter((n) => n !== this.s.user);
    this.host.guid = this.guid;
    return html`
      <div class="doc-head doc-toolbar" @keydown=${this.saveKey}>
          <div class="doc-left"><button class="icon-btn" data-tip="Back to overview" aria-label="Back to overview" @click=${() => navigate({ guid: null, sidebars: [] })}>${appIcon("close")}</button>
          <span class="doc-kind" title=${`${this.d.schema?.displayName ?? v.meta.type} in ${v.meta.folder || "/"}`}>${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : html`<span class="muted small">${this.d.schema?.displayName ?? v.meta.type}</span>`}</span>
          <input class="doc-title-input" aria-label="Title" placeholder="Title" .value=${live(this.d.docTitle)} size=${Math.max(8, Math.min(48, this.d.docTitle.length + 1))}
            @input=${(e: Event) => { this.d.docTitle = (e.target as HTMLInputElement).value; this.d.touch(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); this.d.editor?.focus(); } }} />
          ${others.length ? html`<span class="presence">✎ ${others.join(", ")} editing</span>` : nothing}</div>
          <span class="sep doc-sep"></span>
          <div class="doc-tools"></div>
          <span class="doc-switches">${SIDEBARS.map(([id, name]) => html`<button class="icon-btn" data-test=${"sb-" + id} aria-pressed=${r.sidebars.includes(id)}
              aria-label=${name} data-tip=${(r.sidebars.includes(id) ? "Hide " : "Show ") + name.toLowerCase()}
              @click=${() => navigate({ sidebars: r.sidebars.includes(id) ? r.sidebars.filter((x) => x !== id) : [...r.sidebars, id] }, true)}>${appIcon(id)}</button>`)}
          <span class="sep"></span>
          <button class="icon-btn save ${this.d.dirty ? "dirty" : ""}" data-test="save" ?disabled=${!this.d.dirty || this.d.busy} @click=${() => this.d.save()}
            data-tip=${this.d.busy ? "Saving…" : this.d.dirty ? "Save (Ctrl+S)" : "Saved: no changes"}>${appIcon("save")}<span class="vh">${this.d.busy ? "Saving…" : this.d.dirty ? "Save" : "Saved"}</span></button></span>
      </div>
      <div class="doc-main" @keydown=${this.saveKey}>
        ${this.d.error ? html`<div class="notice error">${this.d.error} <button class="icon-btn" data-tip="Reload the stored version" @click=${() => this.d.load()}>${appIcon("reload")}<span class="vh">Reload</span></button></div>` : nothing}
        <div class="doc-scroll"><div class="doc-page">
          <cs-document .host=${this.host} .items=${this.d.itemLinks} .files=${this.d.docFiles} .diagrams=${server.diagrams || undefined} .value=${this.d.content}
            @change=${(e: CustomEvent<DocNode[]>) => { if (e.target !== e.currentTarget) return; this.d.content = e.detail; this.d.touch(); }}
            @outline=${(e: CustomEvent<OutlineItem[]>) => { this.d.outline = e.detail; }}
            @click=${(e: Event) => { const g = (e.target as HTMLElement).closest<HTMLElement>(".cs-placement")?.dataset.placement; if (g && g !== this.d.current) { this.d.current = g; this.d.editor?.refresh(); } }}></cs-document>
        </div></div>
      </div>
      ${r.sidebars.length ? html`${splitter(this.side, "doc-splitter", "doc-splitter")}
        <aside class="doc-side" style=${`--doc-side-w:${this.side.value}px`}>${r.sidebars.map((id) => this.sidebar(id))}</aside>` : nothing}`;
  }

  /** Ctrl+S saves. */
  private readonly saveKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void this.d.save(); } };

  private sidebar(id: string) {
    switch (id) {
      case "outline": return html`${sideHead(this.d, id, "Outline")}${outlinePanel(this.d)}`;
      case "props": return propertiesPanel(this.d, id);
      case "entry": return entryPanel(this.d, id);
      case "rel": return relationshipsPanel(this.d, id);
      case "comments": return commentsPanel(this.d, id);
      case "versions": return versionsPanel(this.d, id);
      default: return nothing;
    }
  }
}
