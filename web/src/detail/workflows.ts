import { html, nothing } from "lit";
import type { Field, WorkflowValue } from "../components/types";
import { isWorkflowValue } from "../components/artifact";
import { type DetailState } from "./state";

// A workflow field: its state and the transitions allowed from it.

/** A workflow field: its state, and the transitions allowed from it. Choosing one waits for Save. */
export function workflowField(dt: DetailState, f: Field) {
  const w = dt.workflows.find((x) => x.id === f.id);
  const state = w?.state ?? (isWorkflowValue(dt.edit.draft!.fields[f.id]) ? (dt.edit.draft!.fields[f.id] as WorkflowValue).state : "");
  const next = dt.edit.transitions[f.id];
  const stateName = (id: string) => { const st = w?.definition.states.find((x) => x.id === id); return st?.name || id; };
  return html`<div class="field ${dt.changedClass("fields." + f.id)}" data-field=${f.id}>
    <label for=${"f-" + f.id}>${f.name || f.id}</label>
    <div class="value"><div class="workflow ${next ? "pending-add" : ""}" data-workflow=${f.id}>
      <span class="pill state ${next ? "pending-remove" : ""}">${state ? stateName(state) : "—"}</span>
      ${next ? html`<span class="arrow">→</span><span class="pill state" data-test=${"pending-state-" + f.id} title="Saved with the next Save">${stateName(next.state)}</span>` : nothing}
      ${dt.historic || !w ? nothing : html`<select id=${"f-" + f.id} data-test=${"transition-" + f.id} .value=${next?.transition ?? ""} @change=${(e: Event) => dt.edit.transition(f.id, (e.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!next}>${!w.available.length ? "No transitions available" : next ? "Keep " + stateName(w.state) : "Change state…"}</option>
        ${w.available.map((t) => html`<option value=${t.id} ?selected=${next?.transition === t.id}>${t.name || t.id} → ${stateName(t.to)}</option>`)}
      </select>`}
      ${w ? html`<button class="btn sm" title=${"Workflow " + (w.definition.name || w.definition.id)} @click=${() => (dt.showDiagram = dt.showDiagram === f.id ? null : f.id)}>? diagram</button>` : nothing}
      ${w && dt.showDiagram === f.id ? html`<div class="wf-diagram" style="flex-basis:100%">
        ${w.definition.states.map((s) => html`<span class="wf-state ${s.id === w.state ? "current" : ""}" style=${s.presentation?.color ? `border-color:${s.presentation.color}` : ""}>${s.name || s.id}</span>`)}
        <span class="wf-edge">·</span>
        ${w.definition.transitions.map((t) => html`<span class="wf-edge">${t.from.join("|")} → ${t.to} (${t.name || t.id})</span>`)}
        <span class="muted small">defined in ${w.definition.scope || "/"}</span></div>` : nothing}
    </div>
    ${f.description ? html`<div class="help">${f.description}</div>` : nothing}</div>
  </div>`;
}
