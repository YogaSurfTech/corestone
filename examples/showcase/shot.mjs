// The example behind the README's screenshot: seeds a research folder with
// measurement specifications over the API, fills one rich-text field in the
// real editor (which makes the pictures of the formulas), builds a query in
// the query builder and takes the picture. Started by run.sh, from web/:
//   CORESTONE_URL  the server (a new, empty repository)
//   OUT            the picture to write
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { chromium } = require("@playwright/test");

const base = process.env.CORESTONE_URL;
const api = base + "/api";
const out = process.env.OUT;

async function call(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(api + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 503 && attempt < 40) { await new Promise((r) => setTimeout(r, 500)); continue; }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
const config = (scope, path, body) => call("PUT", `/config?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`, body);

// --- the example: a research folder with measurement specifications
const scope = "research";
await config(scope, "entries/workflows/review-workflow.json", {
  name: "Review", initial: "draft",
  states: [{ id: "draft", name: "draft" }, { id: "review", name: "review", presentation: { color: "#b7791f" } }, { id: "approved", name: "approved", final: true, presentation: { color: "#1f9d55" } }],
  transitions: [{ id: "submit", name: "Submit for review", from: "draft", to: "review" }, { id: "approve", name: "Approve", from: "review", to: "approved" }, { id: "rework", name: "Rework", from: "review", to: "draft" }],
});
await config(scope, "entries/msp-fields.json", { fields: [
  { id: "method", name: "Method", type: "enum", options: [{ value: "experiment", label: "Experiment" }, { value: "experiment-fem", label: "Experiment + FEM" }, { value: "analytical", label: "Analytical model" }, { value: "fem", label: "FEM" }] },
  { id: "instrument", name: "Instrument", type: "enum", options: [{ value: "ir-a700", label: "IR camera FLIR A700" }, { value: "calorimeter", label: "Accelerating rate calorimeter" }, { value: "potentiostat", label: "Potentiostat" }, { value: "flow-rig", label: "Flow test rig" }] },
  { id: "maturity", name: "Maturity", type: "enum", options: [{ value: "exploratory", label: "exploratory" }, { value: "validated", label: "validated", presentation: { color: "#3b5bdb" } }, { value: "certified", label: "certified", presentation: { color: "#1f9d55" } }] },
  { id: "uncertainty", name: "Uncertainty (K)", type: "float" },
  { id: "tags", name: "Tags", type: "enum", multiple: true, extendable: true, options: [{ value: "thermal" }, { value: "battery" }, { value: "model" }, { value: "safety" }, { value: "cooling" }] },
  { id: "model", name: "Model and method", type: "richtext" },
  { id: "status", name: "Status", type: "workflow", workflow: "review" },
] });
await config(scope, "entries/types.json", { types: [{ id: "msp", displayName: "Measurement specification", hid: { prefix: "MSP" }, presentation: { columns: ["method", "maturity", "uncertainty"] } }] });

const specs = [
  ["battery-cell", "Transient temperature field of a pouch cell at 3C discharge", "experiment-fem", "ir-a700", "validated", 0.4, ["thermal", "battery", "model"], ["submit"]],
  ["battery-cell", "Entropic heat coefficient from open-circuit voltage", "experiment", "potentiostat", "certified", 0.2, ["battery"], ["submit", "approve"]],
  ["battery-cell", "Thermal runaway onset temperature", "experiment", "calorimeter", "exploratory", 1.5, ["safety", "battery"], []],
  ["battery-cell", "Through-plane thermal conductivity of the electrode stack", "analytical", "ir-a700", "validated", 0.3, ["thermal", "model"], ["submit", "approve"]],
  ["cooling-plate", "Pressure drop of the serpentine channel", "fem", "flow-rig", "exploratory", null, ["cooling"], []],
  ["cooling-plate", "Coolant heat transfer coefficient at the plate", "experiment", "flow-rig", "validated", 0.8, ["cooling", "thermal"], ["submit"]],
  ["cooling-plate", "Contact resistance of the thermal interface", "experiment", "ir-a700", "exploratory", 2.0, ["thermal"], []],
];
let first = "";
for (const [folder, title, method, instrument, maturity, uncertainty, tags, steps] of specs) {
  const fields = { method, instrument, maturity, tags };
  if (uncertainty !== null) fields.uncertainty = uncertainty;
  const e = await call("POST", "/entries", { path: `${scope}/${folder}`, type: "msp", title, fields });
  first ||= e.meta.guid;
  for (const transition of steps) await call("POST", `/artifacts/${e.meta.guid}/transition`, { field: "status", transition });
}

// --- the rich text of the first specification, set in the real editor (which makes the formula pictures)
const f = (formula, display) => (display ? { formula, display: true } : { formula });
const cell = (latex) => [{ text: [f(latex)] }];
const head = (content) => ({ content, header: true });
const model = (image) => [
  { text: [{ text: "Objective.", bold: true }, { text: " Determine the transient temperature field " }, f("T(\\mathbf{x},t)"), { text: " of a pouch cell during a 3C discharge, " }, f("I = \\frac{3\\,Q_\\mathrm{nom}}{1\\,\\mathrm{h}} = 15\\,\\mathrm{A}"), { text: ", and validate the FEM model against IR thermography." }] },
  { text: [{ text: "Governing equation", bold: true, color: "#1565c0" }] },
  { align: "center", text: [f("\\rho c_p \\frac{\\partial T}{\\partial t} = \\nabla\\cdot(\\mathbf{k}\\,\\nabla T) + \\dot q, \\qquad \\dot q = \\frac{I^2 R_\\mathrm{int}}{V} - \\frac{I\\,T}{V}\\,\\frac{\\partial U_\\mathrm{oc}}{\\partial T}", true)] },
  { text: [{ text: "with convection and radiation at the surface " }, f("-k\\,\\partial_n T = h\\,(T - T_\\infty) + \\varepsilon\\sigma\\,(T^4 - T_\\infty^4)"), { text: "." }] },
  { stripes: "rows", table: [
    [head("Parameter"), head("Symbol"), head("Value"), head("Unit")],
    ["Density", cell("\\rho"), "2 450", "kg/m³"],
    ["Specific heat", cell("c_p"), "1 100", "J/(kg·K)"],
    ["Conductivity, in-plane", cell("k_\\parallel"), "28.0", "W/(m·K)"],
    ["Conductivity, through-plane", cell("k_\\perp"), "0.9", "W/(m·K)"],
    ["Heat transfer coefficient", cell("h"), "12", "W/(m²·K)"],
  ] },
  { align: "center", text: [{ image, alt: "IR thermography of the cell at the end of discharge", width: 560 }] },
  { text: [{ text: "Acceptance.", bold: true }, { text: " The model is accepted when " }, f("\\mathrm{RMSE} = \\sqrt{\\tfrac{1}{N}\\sum_i (T_i^\\mathrm{FEM} - T_i^\\mathrm{IR})^2} < 0.5\\,\\mathrm{K}"), { text: "." }] },
  { code: true, lang: "python", text: "rmse = np.sqrt(np.mean((T_fem - T_ir) ** 2))\nassert rmse < 0.5, f\"model rejected: {rmse:.2f} K\"" },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1600 }, deviceScaleFactor: 1.3125 });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(`${base}/artifact/${first}`);
await page.locator("corestone-detail cs-richtext").waitFor();
const stored = await page.evaluate(async (paragraphs) => {
  const el = document.querySelector("corestone-detail cs-richtext");
  // the figure: an IR heat map of the cell with axes and a colour bar, drawn here
  const W = 760, H = 520, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  const stops = [[0, [0, 0, 4]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]]];
  const colour = (t) => {
    t = Math.max(0, Math.min(1, t));
    let i = 1; while (i < stops.length - 1 && t > stops[i][0]) i++;
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], u = (t - a) / (b - a);
    return ca.map((v, k) => Math.round(v + (cb[k] - v) * u));
  };
  const x0 = 90, y0 = 40, w = 480, h = 400;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    const spot = (cx) => Math.exp(-(((u - cx) / 0.16) ** 2 + (v / 0.22) ** 2));
    const edge = Math.min(u, 1 - u, 1 - v) < 0.012 ? 0 : 1;
    const t = (0.18 + 0.34 * Math.exp(-(((u - 0.5) / 0.42) ** 2 + ((v - 0.55) / 0.5) ** 2)) + 0.5 * (spot(0.3) + spot(0.7))) * edge;
    const [r, gg, b] = colour(t); const k = 4 * (y * w + x);
    img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
  }
  g.putImageData(img, x0, y0);
  g.fillStyle = "#9aa0a6"; g.fillRect(x0 + 0.3 * w - 30, y0 - 26, 60, 26); g.fillRect(x0 + 0.7 * w - 30, y0 - 26, 60, 26);
  g.fillStyle = "#222"; g.font = "15px sans-serif"; g.textAlign = "center";
  g.fillText("–", x0 + 0.3 * w, y0 - 8); g.fillText("+", x0 + 0.7 * w, y0 - 8);
  g.strokeStyle = "#222"; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
  g.textAlign = "right";
  for (const [mm, fy] of [[150, 0], [100, 1 / 3], [50, 2 / 3], [0, 1]]) { g.fillText(String(mm), x0 - 8, y0 + fy * h + 5); g.beginPath(); g.moveTo(x0 - 5, y0 + fy * h); g.lineTo(x0, y0 + fy * h); g.stroke(); }
  g.textAlign = "center";
  for (const [mm, fx] of [[0, 0], [50, 0.25], [100, 0.5], [150, 0.75], [200, 1]]) { g.fillText(String(mm), x0 + fx * w, y0 + h + 20); g.beginPath(); g.moveTo(x0 + fx * w, y0 + h); g.lineTo(x0 + fx * w, y0 + h + 5); g.stroke(); }
  g.fillText("x [mm]", x0 + w / 2, y0 + h + 44);
  g.save(); g.translate(30, y0 + h / 2); g.rotate(-Math.PI / 2); g.fillText("y [mm]", 0, 0); g.restore();
  const bx = x0 + w + 40;
  for (let y = 0; y < h; y++) { const [r, gg, b] = colour(1 - y / h); g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(bx, y0 + y, 22, 1); }
  g.strokeRect(bx + 0.5, y0 + 0.5, 22, h);
  g.fillStyle = "#222"; g.textAlign = "left";
  for (const [t, fy] of [[41, 0], [37, 1 / 3], [33, 2 / 3], [29, 1]]) g.fillText(String(t), bx + 30, y0 + fy * h + 5);
  g.fillText("T [°C]", bx - 4, y0 - 10);
  const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
  const name = await el.files.add(new File([blob], "ir-thermography.png", { type: "image/png" }));
  el.value = JSON.parse(JSON.stringify(paragraphs).replaceAll("__IMAGE__", name));
  const formulas = (v) => JSON.stringify(v).split('"formula"').length - 1;
  const pngs = (v) => JSON.stringify(v).split('"png"').length - 1;
  for (let i = 0; i < 200 && (pngs(el.value) < formulas(el.value) || el.querySelector(".pending")); i++) await new Promise((r) => setTimeout(r, 100));
  el.dispatchEvent(new CustomEvent("change", { detail: el.value }));
  return { formulas: formulas(el.value), pngs: pngs(el.value) };
}, model("__IMAGE__"));
console.log("formulas", stored);
await page.locator("[data-test=save]").click();
await page.locator("[data-test=save]").waitFor({ state: "detached", timeout: 15000 });

// --- the picture: the overview with a built query, and the specification below it
await page.goto(`${base}/folder/${scope}?subtree=1`);
const add = async (field, act) => {
  await page.locator("[data-test=query-add]").click();
  await page.locator(`[data-test=query-fields] .mi[data-field="${field}"]`).click();
  await act();
};
await add("maturity", async () => {
  await page.locator("[data-test=query-editor] .enum-option[data-value=validated]").click();
  await page.locator("[data-test=query-editor] .enum-option[data-value=certified]").click();
  await page.locator("[data-test=query-apply]").click();
});
await add("status", async () => {
  await page.locator("[data-test=query-editor-not]").click();
  await page.locator("[data-test=query-editor] .enum-option[data-value=draft]").click();
  await page.locator("[data-test=query-apply]").click();
});
await add("uncertainty", async () => {
  await page.locator("[data-test=query-compare]").selectOption("<");
  await page.locator("[data-test=query-editor] [data-test=query-value]").fill("0.5");
  await page.locator("[data-test=query-apply]").click();
});
await page.locator("[data-test=query-join]").nth(1).click();
await page.locator("[data-test=query-join-or]").click();
await page.locator("[data-test=query-join]", { hasText: "OR" }).waitFor();
await page.waitForTimeout(800);
await page.locator("corestone-overview table.grid tbody tr").first().waitFor();
console.log("rows", await page.locator("corestone-overview table.grid tbody tr").count(), "query", new URL(page.url()).searchParams.get("q"));
await page.locator("corestone-overview table.grid tbody tr", { hasText: "Transient temperature field" }).click();
await page.locator("corestone-detail cs-richtext img:not(.ProseMirror-separator)").first().waitFor();
await page.waitForTimeout(1500);
await page.locator(".splitter").focus();
for (let i = 0; i < Number(process.env.UP ?? 5); i++) await page.keyboard.press("ArrowUp");
await page.locator("corestone-detail [data-test=title]").focus().catch(() => {});
await page.evaluate(() => (document.activeElement)?.blur());
await page.waitForTimeout(500);
await page.mouse.move(800, 1590);
await page.screenshot({ path: out });
await browser.close();
