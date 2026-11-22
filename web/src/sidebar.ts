import { html, nothing } from "lit";
import { LightElement } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { Schema } from "./components/types";
import { folderNode, folderTree, loadFolders, type FolderNode } from "./components/folder-tree";
import { services } from "./services";
import { displayName, kindPlural } from "./components/artifact";
import { StoreController } from "./store-controller";

// Repository navigation (design guide §7.3): subtree toggle, the
// folder hierarchy below the current folder, and artifacts grouped by schema type.

const FILTER_FROM = 15; // children of the current folder before a filter box appears

@customElement("corestone-sidebar")
export class Sidebar extends LightElement {
  private readonly watch = new StoreController(this, (s, first) => {
    if (first || s.refreshTick !== this.lastTick) {
      this.lastTick = s.refreshTick;
      this.reloadAll();
    }
    if (s.route.folder !== this.lastFolder) {
      this.lastFolder = s.route.folder;
      this.rootAt(s.route.folder);
      this.loadTypes(s.route.folder);
    }
  });
  private get s(): State { return this.watch.state; }
  @state() private root = folderNode("Repository", "", true);
  @state() private types: Schema[] = [];
  @state() private counts: Record<string, number> = {};
  private lastTick = -1;
  private lastFolder: string | null = null;
  @state() private filter = "";
  private rootSeq = 0;


  private async reloadAll() {
    await this.rootAt(this.s.route.folder);
    this.loadTypes(this.s.route.folder);
  }

  private async load(n: FolderNode) {
    await loadFolders(n, services.folders);
    this.requestUpdate();
  }

  // The tree is rooted at the folder being worked in: a large repository
  // shows only what lies below, the way up is the "up" row and the header
  // breadcrumb. Carets still expand in place without navigating.
  private async rootAt(folder: string) {
    const seq = ++this.rootSeq;
    const parts = folder.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? "Repository";
    const root = folderNode(name, folder, true);
    if (this.root.info.path !== folder) { this.root = root; this.filter = ""; } // show the new place at once
    const [parent] = await Promise.all([
      parts.length ? api.tree(parts.slice(0, -1).join("/"), false, 1).catch(() => null) : null,
      this.load(root),
    ]);
    if (seq !== this.rootSeq) return;
    const info = parent?.folders.find((f) => f.path === folder);
    if (info) root.info = info;
    // not in the repository yet (planned with "New folder"): a placeholder
    else if (parts.length && parent && !root.children?.length) root.pending = true;
    this.root = root;
  }

  private async loadTypes(folder: string) {
    try {
      const [t, counts] = await Promise.all([api.types(folder), api.search({ path: folder, subtree: true, kind: "entry,document", limit: 1 }).then(() => this.typeCounts(folder))]);
      this.types = t.types;
      this.counts = counts;
    } catch {
      /* keep old */
    }
  }

  private async typeCounts(folder: string): Promise<Record<string, number>> {
    const st = await api.status().catch(() => null);
    if (!folder && st?.stats) return st.stats.types;
    const r = await api.search({ path: folder, subtree: true, kind: "entry,document", limit: 5000 });
    const c: Record<string, number> = {};
    for (const a of r.artifacts) c[a.type] = (c[a.type] ?? 0) + 1;
    return c;
  }

  // Folders exist only through their content (Git tracks no empty
  // directories), so a new folder is a destination: it is shown as a
  // placeholder and becomes real with the first artifact saved there.
  private newFolder = async () => {
    const parent = this.s.route.folder;
    const name = await store.prompt("New folder", {
      text: `Subfolder of ${parent || "the repository root"}. It is created with the first artifact you save in it.`,
      placeholder: "name or sub/path", confirmLabel: "Open",
    });
    const rel = (name ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel) return;
    navigate({ folder: parent ? `${parent}/${rel}` : rel, guid: null, type: "", q: "" });
  };

  private up() {
    const parts = this.s.route.folder.split("/").filter(Boolean);
    if (!parts.length) return nothing;
    const parent = parts.slice(0, -1).join("/");
    return html`<div class="row up" data-test="nav-up" title="Up to ${parent || "the repository root"}"
      @click=${() => navigate({ folder: parent, guid: null, type: "", q: "" })}>
      <span class="caret">↑</span><span class="name">${parts[parts.length - 2] ?? "Repository"}</span></div>`;
  }

  override render() {
    if (!this.s) return nothing;
    const r = this.s.route;
    const groups: Record<string, Schema[]> = {};
    for (const t of this.types) if (t.kind === "entry" || t.kind === "document") (groups[t.kind] ??= []).push(t);
    return html`
      <div class="nav-search">
        <label class="nav-toggle"><span>Include subfolders (subtree)</span>
          <input type="checkbox" .checked=${r.subtree} data-test="subtree" @change=${(e: Event) => navigate({ subtree: (e.target as HTMLInputElement).checked })} /></label>
      </div>
      <div class="nav-scroll">
        <div class="nav-section"><div class="nav-title"><span>Folders</span>
          <button class="btn sm" data-test="new-folder" title="New subfolder of the current folder" @click=${this.newFolder}>＋</button></div>
          <div class="tree">${this.up()}</div>
          ${folderTree(this.root, {
            selected: (path) => r.folder === path && !r.type,
            pick: (n) => { navigate({ folder: n.info.path, guid: null, type: "", q: "" }); store.closeNavIfOverlay(); },
            toggled: (n) => { if (n.open && !n.children) void this.load(n); this.requestUpdate(); },
            details: true,
            filter: { from: FILTER_FROM, text: this.filter, changed: (text) => (this.filter = text) },
          })}</div>
        <div class="nav-section"><div class="nav-title"><span>By type${r.folder ? html` <span class="muted">in ${r.folder}</span>` : nothing}</span></div>
          ${!this.types.length ? html`<div class="muted small" style="padding:4px 8px">No schemas visible here yet.</div>` : nothing}
          <ul class="tree">${(["entry", "document"] as const).filter((k) => groups[k]?.length).map((k) => html`<li>
            <div class="row"><span class="caret">▾</span><span class="name muted">${kindPlural[k]}</span></div>
            <ul>${groups[k].map((t) => html`<li><div class="row ${r.type === t.type ? "selected" : ""}" data-type=${t.type}
              @click=${() => { navigate({ type: t.type, kind: k, guid: null }); store.closeNavIfOverlay(); }}>
              <span class="caret empty">·</span><span class="name">${displayName(t, t.type)}</span>
              ${this.counts[t.type] ? html`<span class="count">${this.counts[t.type]}</span>` : nothing}</div></li>`)}</ul></li>`)}</ul></div>
      </div>`;
  }
}
