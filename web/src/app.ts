import { html, nothing } from "lit";
import { LightElement, Resizer, splitter } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State, toastError } from "./store";
import { announceName, announceView } from "./ws";
import { folderCrumbs } from "./components/util";
import { provideServices } from "./components/services";
import { services } from "./services";
import "./sidebar";
import "./overview";
import "./detail";
import "./document";
import "./dialogs";
import "./account"; // the account page, shown in a dialog
import "./toast";
import { StoreController } from "./store-controller";

// Application shell (design guide §7.2): header, navigation sidebar, and
// the main workspace with the artifact overview above the detail view.

const DEFAULT_SPLIT = 38, MIN_SPLIT = 12, MAX_SPLIT = 85;
const DEFAULT_NAV_W = 288, MIN_NAV_W = 180, MAX_NAV_W = 640; // sidebar width, px

@customElement("corestone-app")
export class App extends LightElement {
  private readonly watch = new StoreController(this, (s) => {
    if (s.route.guid === this.lastGuid) return;
    this.lastGuid = s.route.guid;
    this.selectedKind = null;
    if (s.route.guid) {
      announceView(s.route.guid);
      api.get(s.route.guid).then((v) => {
        if (store.state.route.guid !== v.meta.guid) return;
        this.selectedKind = v.meta.kind;
      }).catch(() => { this.selectedKind = "missing"; });
    } else announceView("");
  });
  private get s(): State { return this.watch.state; }
  @state() private selectedKind: string | null = null;
  @state() private dismissedConfig = ""; // the invalid-config set the user closed; a different set shows again
  private lastGuid: string | null = null;
  private statusTimer = 0;
  /** The divider between the overview and the selected artifact: the overview's height, % of the main area. */
  private readonly split = new Resizer({
    key: "corestone.split", fallback: DEFAULT_SPLIT, min: MIN_SPLIT, max: MAX_SPLIT, axis: "y", step: 4,
    at: (m, box) => (100 * (m.clientY - box.top)) / box.height,
    changed: () => this.requestUpdate(),
  });
  /** The divider between the folder navigation and the main area: the navigation's width, px. */
  private readonly nav = new Resizer({
    key: "corestone.navWidth", fallback: DEFAULT_NAV_W, min: MIN_NAV_W, max: MAX_NAV_W, axis: "x", step: 16,
    at: (m, box) => m.clientX - box.left,
    changed: () => this.requestUpdate(),
  });

  override connectedCallback() {
    super.connectedCallback();
    provideServices(this, services);
    this.pollStatus();
    window.addEventListener("keydown", this.onKey);
  }
  override disconnectedCallback() { window.clearInterval(this.statusTimer); window.removeEventListener("keydown", this.onKey); super.disconnectedCallback(); }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "/" && !typing) { e.preventDefault(); (this.querySelector<HTMLElement>("corestone-overview [data-test=search]") ?? this.querySelector<HTMLElement>("corestone-overview [data-test=query-add]"))?.focus(); }
    if (e.key === "n" && !typing && !this.s.dialog) { e.preventDefault(); store.set({ dialog: { kind: "new", folder: this.s.route.folder } }); }
    if (e.key === "Escape" && !typing && this.s.route.guid && !this.s.dialog) navigate({ guid: null, expanded: false });
  };

  private pollStatus() {
    const tick = () => api.status().then((st) => store.set({ status: st })).catch(() => store.set({ status: null }));
    tick();
    this.statusTimer = window.setInterval(tick, 15000);
  }

  private setName = () => {
    if (this.s.account) { store.set({ dialog: { kind: "account" } }); return; }
    const theme = this.s.theme; // the dialog previews themes live; Cancel restores this one
    store.prompt("Your name", { text: "Shown to others while you view or edit an artifact.", value: this.s.user, confirmLabel: "Save", theme: true })
      .then((n) => {
        if (n === null) { store.setTheme(theme); return; }
        if (n.trim()) { store.setUser(n.trim()); announceName(n.trim()); }
      });
  };

  /** Configuration problems: invalid files (ignored by the server) and references that do not resolve. */
  private configWarnings() {
    const issues = this.s.status?.invalidConfig ?? [];
    const key = issues.map((i) => `${i.path}\n${i.message}`).join("\n");
    if (!issues.length || key === this.dismissedConfig) return nothing;
    return html`<div class="config-warnings" role="alert" data-test="config-warnings">
      <div class="title">⚠ ${issues.length === 1 ? "A configuration problem" : `${issues.length} configuration problems`}</div>
      ${issues.map((i) => html`<div class="issue"><span class="mono">${i.path}</span><span>${i.message}</span>
        ${i.code === "invalid-config" ? html`<span class="ignored">this file is ignored</span>` : nothing}</div>`)}
      <button class="close" title="Dismiss" aria-label="Dismiss" @click=${() => (this.dismissedConfig = key)}>✕</button></div>`;
  }

  override render() {
    if (!this.s) return nothing;
    const { route, status, connected, navCollapsed } = this.s;
    const p = status?.projection;
    const health = !status ? "bad" : p?.maintenance ? "warn" : status.inSync ? "ok" : "warn";
    const healthText = !status ? "server unreachable" : p?.maintenance ? `maintenance: ${p.phase || p.reason || ""} ${p.total ? `${p.progress}/${p.total}` : ""}` : status.inSync ? "in sync" : "syncing…";
    const mainClass = route.guid && this.selectedKind === "document" ? "document" : route.expanded ? "expanded" : "";
    return html`<div class="shell ${navCollapsed ? "nav-collapsed" : ""}" style=${`--nav-w:${this.nav.value}px`}>
      <header class="header">
        <button class="btn sm icon" title="Toggle navigation" aria-label="Toggle navigation" @click=${() => store.toggleNav()}>☰</button>
        <a class="brand" href="/" @click=${(e: Event) => { e.preventDefault(); navigate({ folder: "", guid: null, q: "", type: "", kind: "" }); }}><span class="logo"></span>Corestone</a>
        <nav class="crumbs">${folderCrumbs(route.folder).map((c, i) => html`${i ? html`<span>/</span>` : nothing}<a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ folder: c.path, guid: null, type: "" }); }}>${c.name}</a>`)}</nav>
        <span class="spacer"></span>
        ${p?.maintenance && p.total ? html`<div class="progress" title=${p.phase ?? ""}><div style=${`width:${Math.round((100 * p.progress) / Math.max(1, p.total))}%`}></div></div>` : nothing}
        <span class="status" title=${status ? `head ${status.head.slice(0, 8)} · projection ${p?.processedHash.slice(0, 8) ?? ""}` : ""}><span class="dot ${health}"></span>${healthText}<span class="dot ${connected ? "ok" : "bad"}" data-test="session" title=${connected ? "session connected" : "session disconnected"}></span></span>
        <button class="btn sm" title="Rebuild projection from Git" @click=${() => api.reindex().then(() => store.toast("Reindex started", "info")).catch(toastError)}>Reindex</button>
        <button class="btn sm" data-test="user" title=${this.s.account ? "Your account" : "Your name and theme"} @click=${this.setName}>${this.s.user || "anonymous"}</button>
      </header>
      <corestone-sidebar></corestone-sidebar>
      ${splitter(this.nav, "nav-splitter", "nav-splitter")}
      <div class="nav-scrim" @click=${() => store.toggleNav()}></div>
      <div class="main ${mainClass}" style=${`--split:${this.split.value}%`}>
        <corestone-overview></corestone-overview>
        ${splitter(this.split, "splitter", "splitter")}
        ${route.guid ? (this.selectedKind === "document" ? html`<corestone-document .guid=${route.guid}></corestone-document>` : html`<corestone-detail .guid=${route.guid} .version=${route.version} .at=${route.at}></corestone-detail>`)
          : html`<div class="empty-state" style="display:grid;place-items:center"><div><div class="big">Select an artifact</div>Pick a row above, search with <kbd>/</kbd>, or create one with <kbd>n</kbd>.</div></div>`}
      </div>
    </div>
    ${this.configWarnings()}
    <corestone-dialogs></corestone-dialogs>
    <corestone-toasts></corestone-toasts>`;
  }
}
