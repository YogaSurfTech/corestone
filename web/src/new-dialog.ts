import { html, nothing } from "lit";
import { LightElement, errorText } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { pickArtifact, store, type NewOptions } from "./store";
import type { Kind, Schema } from "./components/types";
import { collectionOf, displayName, kindLabel, kindPlural, label } from "./components/artifact";
import "./components/type-icon";
import "./components/fields";
import "./components/folder-field";

// The "New" dialog: choose a type, fill the form its schema gives, create.

@customElement("corestone-new-dialog")
export class NewDialog extends LightElement {
  dialog!: NewOptions;
  @state() private types: Schema[] = [];
  @state() private loading = true;
  @state() private schema: Schema | null = null;
  @state() private customType = "";
  @state() private path = "";
  @state() private titleText = "";
  @state() private hid = "";
  @state() private base = "";
  @state() private baseLabel = "";
  @state() private text = "";
  @state() private target = "";
  @state() private targetLabel = "";
  @state() private values: Record<string, unknown> = {};
  @state() private busy = false;
  @state() private error = "";
  /** Set when the chosen type is not visible at the typed folder: the save would be refused. */
  @state() private scopeError = "";
  private listed = false; // the chosen schema came from the visible types, not typed by hand
  private scopeTimer = 0;
  private scopeSeq = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.path = this.dialog.folder ?? store.state.route.folder;
    if (this.dialog.base) { this.base = this.dialog.base.guid; this.baseLabel = this.dialog.base.label; }
    const preset = this.dialog.type;
    api.types(this.path).then((r) => {
      this.types = r.types.filter((t) => !this.dialog.kinds || this.dialog.kinds.includes(t.kind));
      this.loading = false;
      if (preset) {
        const found = this.types.find((t) => t.type === preset);
        this.choose(found ?? { type: preset, kind: this.dialog.kinds?.[0] ?? "entry" }, !!found);
      }
    }).catch((e) => { this.error = errorText(e); this.loading = false; });
  }

  override disconnectedCallback() { window.clearTimeout(this.scopeTimer); super.disconnectedCallback(); }

  private choose(s: Schema, listed = true) {
    this.schema = s;
    this.listed = listed;
    this.values = {};
    for (const f of s.fields ?? []) if (f.default != null) this.values[f.id] = f.default;
    this.error = "";
    this.scopeError = "";
    this.updateComplete.then(() => (this.querySelector<HTMLInputElement>("#new-title, #new-text"))?.focus());
  }

  // Schemas apply lexically along the path, so a folder typed into another
  // scope may see a different schema for the chosen type, or none at all.
  // Follow the typed folder: refresh the visible types, rebuild the form from
  // the schema effective there, and say so before the server refuses the save.
  private onFolder(path: string) {
    this.path = path;
    window.clearTimeout(this.scopeTimer);
    this.scopeTimer = window.setTimeout(() => this.followScope(), 250);
  }

  private async followScope() {
    const seq = ++this.scopeSeq;
    const path = this.path;
    let types: Schema[];
    try {
      types = (await api.types(path)).types.filter((t) => !this.dialog.kinds || this.dialog.kinds.includes(t.kind));
    } catch {
      return; // the server validates on save either way
    }
    if (seq !== this.scopeSeq || path !== this.path) return;
    this.types = types;
    const chosen = this.schema;
    if (!chosen || !this.listed) return; // a hand-typed type id is not checked against the scope
    const here = types.find((t) => t.type === chosen.type);
    if (!here) {
      this.scopeError = `Type ${displayName(chosen, chosen.type)} is not defined at ${path || "the repository root"}; choose another folder or type.`;
      return;
    }
    this.scopeError = "";
    if (JSON.stringify(here) === JSON.stringify(chosen)) return;
    // a different schema for the same type: keep the values of fields that still exist
    const keep: Record<string, unknown> = {};
    for (const f of here.fields ?? []) {
      if (f.id in this.values) keep[f.id] = this.values[f.id];
      else if (f.default != null) keep[f.id] = f.default;
    }
    this.schema = here;
    this.values = keep;
  }

  private kindOf(): Kind { return this.schema?.kind ?? "entry"; }

  private async create() {
    if (!this.schema || this.busy || this.scopeError) return; // a second click before re-render must be a no-op
    this.busy = true;
    this.error = "";
    const kind = this.kindOf();
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.values)) if (v !== null && v !== undefined && v !== "") fields[k] = v;
    try {
      let view;
      if (kind === "link") {
        if (!this.base || !this.target) throw new Error("Choose a source and a target artifact");
        view = await api.create("links", { type: this.schema.type, source: this.base, target: this.target, fields });
        store.toast(`Link ${this.schema.type} created`, "success");
        store.set({ dialog: null });
        store.refresh();
        return;
      }
      if (kind === "comment") {
        if (!this.target) throw new Error("Choose the artifact to comment on");
        view = await api.create("comments", { type: this.schema.type, subject: this.target, text: this.text, author: store.state.user, fields });
        store.toast("Comment added", "success");
        store.set({ dialog: null });
        store.refresh();
        return;
      }
      const body: Record<string, unknown> = { path: this.path, type: this.schema.type, title: this.titleText, fields };
      if (this.hid.trim()) body.hid = this.hid.trim();
      if (this.base) body.base = this.base;
      if (kind === "document") body.content = [];
      view = await api.create(collectionOf[kind], body);
      store.toast(`${kindLabel[kind]} ${view.meta.hid || ""} created`, "success");
      store.set({ dialog: null });
      store.refresh();
      navigate({ guid: view.meta.guid, folder: view.meta.folder, tab: "" });
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (!this.schema) return this.pickType();
    const s = this.schema;
    const kind = this.kindOf();
    return html`<h2><span>New ${displayName(s, s.type)} <span class="muted small">(${kindLabel[kind]})</span></span>
        <button class="btn sm" @click=${() => (this.schema = null)}>← type</button></h2>
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}
      <form @submit=${(e: Event) => { e.preventDefault(); this.create(); }}>
        ${kind === "entry" || kind === "document" ? html`
          <div class="field"><label for="new-title">Title<span class="req">*</span></label><div class="value">
            <input id="new-title" type="text" required .value=${this.titleText} @input=${(e: Event) => (this.titleText = (e.target as HTMLInputElement).value)} /></div></div>
          <div class="field"><label for="new-path">Folder</label><div class="value">
            <corestone-folder-field inputId="new-path" test="new-path" .value=${this.path} @folder-change=${(e: CustomEvent<string>) => this.onFolder(e.detail)}></corestone-folder-field>
            ${this.scopeError ? html`<div class="notice error" data-test="scope-notice" role="alert">${this.scopeError}</div>` : nothing}
            <div class="help">Folders organize; identity stays with the GUID. Schemas apply lexically along this path.</div></div></div>
          <div class="field"><label for="new-hid">HID</label><div class="value">
            <input id="new-hid" type="text" .value=${this.hid} placeholder=${s.hid ? `auto: ${s.hid.prefix}${s.hid.separator ?? "-"}n` : "optional, e.g. REQ-42"} @input=${(e: Event) => (this.hid = (e.target as HTMLInputElement).value)} /></div></div>
          ${kind === "entry" ? html`<div class="field"><label>Base (overlay)</label><div class="value">
            ${this.base ? html`<span class="ref-chip">${this.baseLabel}<button type="button" title="Clear base artifact" aria-label="Clear base artifact" @click=${() => { this.base = ""; this.baseLabel = ""; }}>✕</button></span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("base", [s.type], ["entry"], "A base is an entry of the same type")}>${this.base ? "Change…" : "＋ Inherit from an entry…"}</button>
            <div class="help">An overlay keeps only the fields you set here; everything else resolves from its base.</div></div></div>` : nothing}` : nothing}
        ${kind === "link" ? html`
          <div class="field"><label>Source<span class="req">*</span></label><div class="value">
            ${this.base ? html`<span class="ref-chip">${this.baseLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("base", s.sourceTypes, undefined, `A ${displayName(s, s.type)} link allows only these types as its source`)}>${this.base ? "Change…" : "Select…"}</button>
            ${s.sourceTypes?.length ? html`<div class="help">allowed: ${s.sourceTypes.join(", ")}</div>` : nothing}</div></div>
          <div class="field"><label>Target<span class="req">*</span></label><div class="value">
            ${this.target ? html`<span class="ref-chip">${this.targetLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("target", s.targetTypes, undefined, `A ${displayName(s, s.type)} link allows only these types as its target`)}>${this.target ? "Change…" : "Select…"}</button>
            ${s.targetTypes?.length ? html`<div class="help">allowed: ${s.targetTypes.join(", ")}</div>` : nothing}
            ${s.cardinality ? html`<div class="help">cardinality: ${s.cardinality}</div>` : nothing}</div></div>` : nothing}
        ${kind === "comment" ? html`
          <div class="field"><label>On<span class="req">*</span></label><div class="value">
            ${this.target ? html`<span class="ref-chip">${this.targetLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("target")}>${this.target ? "Change…" : "Select…"}</button></div></div>
          <div class="field"><label for="new-text">Text<span class="req">*</span></label><div class="value">
            <textarea id="new-text" required .value=${this.text} @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}></textarea></div></div>` : nothing}
        ${(s.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${this.values[f.id]} .typeId=${s.type} .folder=${this.path}
          @field-change=${(e: CustomEvent) => { this.values = { ...this.values, [e.detail.id]: e.detail.value }; }}></corestone-field>`)}
        ${(s.fields ?? []).some((f) => f.type === "workflow") ? html`<div class="help" style="margin-top:8px">${(s.fields ?? []).filter((f) => f.type === "workflow").map((f) => f.name || f.id).join(", ")}: starts in the initial state.</div>` : nothing}
        <div class="foot">
          <button type="submit" class="btn primary" ?disabled=${this.busy || !!this.scopeError} data-test="create">${this.busy ? "Creating…" : "Create"}</button>
        </div>
      </form>`;
  }

  private pickArtifact(which: "base" | "target", types?: string[], kinds?: Kind[], why?: string) {
    void pickArtifact({ title: which === "base" ? "Select artifact" : "Select target", types, kinds, why, folder: this.path }).then((s) => {
      if (!s) return;
      if (which === "base") { this.base = s.guid; this.baseLabel = label(s); } else { this.target = s.guid; this.targetLabel = label(s); }
    });
  }

  private pickType() {
    const groups: Record<string, Schema[]> = {};
    for (const t of this.types) (groups[t.kind] ??= []).push(t);
    const order: Kind[] = ["entry", "document", "link", "comment"];
    return html`<h2>What do you want to create?</h2>
      ${this.error ? html`<div class="notice error">${this.error}</div>` : nothing}
      ${this.loading ? html`<p class="muted">Loading types visible at <code>${this.path || "/"}</code>…</p>` : nothing}
      ${!this.loading && !this.types.length ? html`<div class="notice">No schemas are visible at <code>${this.path || "/"}</code>. Define a schema first (or enter a type below).</div>` : nothing}
      ${order.filter((k) => groups[k]?.length).map((k) => html`<div class="nav-title" style="margin-top:10px">${kindPlural[k]}</div>
        <div class="type-grid">${groups[k].map((t) => html`<button class="type-card" data-type=${t.type} @click=${() => this.choose(t)}>
          <div class="kind"><corestone-type-icon .kind=${t.kind} .type=${t.type} .folder=${this.path} .schema=${t}></corestone-type-icon>${t.type}</div><div class="name">${displayName(t, t.type)}</div>
          ${t.description ? html`<div class="desc">${t.description}</div>` : nothing}
          ${t.hid ? html`<div class="desc">HID prefix ${t.hid.prefix}</div>` : nothing}</button>`)}</div>`)}
      <div class="inline-form" style="margin-top:16px;align-items:center">
        <input type="text" placeholder="…or type an unlisted type id" .value=${this.customType} @input=${(e: Event) => (this.customType = (e.target as HTMLInputElement).value)} />
        <select id="custom-kind"><option value="entry">entry</option><option value="document">document</option></select>
        <button class="btn" ?disabled=${!this.customType.trim()} @click=${() => this.choose({ type: this.customType.trim(), kind: (this.querySelector("#custom-kind") as HTMLSelectElement).value as Kind })}>Use</button>
      </div>
`;
  }
}
