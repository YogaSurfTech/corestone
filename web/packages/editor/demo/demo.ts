// The standalone editor demo (served as /editor-demo.html): only the
// package's public interface, no Corestone code.
import { plainText, type EntryFiles, type RichText, type RichTextElement } from "@corestone/editor";

const KEY = "cs-editor-demo";
const SAMPLE: RichText = [
  { text: [
    { text: "The " }, { text: "main housing", bold: true }, { text: " is machined from " },
    { text: "stainless steel 1.4404", italic: true, color: "#1565c0" }, { text: " and must withstand 16 bar." },
  ] },
  { list: "ul", text: "Tolerances follow ISO 2768-m" },
  { list: "ul", text: [{ text: "Surface: " }, { text: "Ra 0.8", bg: "#fff59d" }] },
  { align: "center", text: [{ text: "H" }, { text: "2", sub: true }, { text: "O at 20 °C" }] },
  { stripes: "rows", table: [
    [{ content: "Property", header: true }, { content: "Value", header: true }, { content: "Unit", header: true }],
    ["Pressure", [{ text: [{ text: "16", bold: true }] }], "bar"],
    [{ content: "Material: stainless steel 1.4404", colspan: 3 }],
  ] },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ed = $<RichTextElement>("ed");
const json = $<HTMLTextAreaElement>("json");
const status = $<HTMLSpanElement>("status");

function saved(): RichText | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}

// as the server writes it into the entry's file: one line per paragraph
const oneLine = (v: unknown): string =>
  Array.isArray(v) ? "[" + v.map(oneLine).join(", ") + "]"
  : v && typeof v === "object" ? "{" + Object.entries(v).map(([k, e]) => JSON.stringify(k) + ": " + oneLine(e)).join(", ") + "}"
  : JSON.stringify(v);
// a table: its rows on lines of their own
const block = (b: object): string => {
  if (!("table" in b) || !Array.isArray(b.table)) return oneLine(b);
  const head = Object.entries(b).filter(([k]) => k !== "table").map(([k, e]) => JSON.stringify(k) + ": " + oneLine(e));
  const rows = b.table.length ? "[\n" + b.table.map((r: unknown) => "    " + oneLine(r)).join(",\n") + "\n  ]" : "[]";
  return "{" + [...head, '"table": ' + rows].join(", ") + "}";
};
const fileLayout = (v: RichText | null) =>
  Array.isArray(v) ? (v.length ? "[\n" + v.map((b) => "  " + block(b)).join(",\n") + "\n]" : "[]") : JSON.stringify(v);

function show(v: RichText | null, note: string) {
  json.value = fileLayout(v);
  $("plain").textContent = plainText(v);
  $("err").textContent = "";
  status.textContent = note;
}

// the entry's files: kept in this page only (gone on reload), as a host would keep them
const store = new Map<string, File>();
const urls = new Map<string, string>();
const files: EntryFiles = {
  add: async (f) => {
    let name = f.name && f.name !== "image.png" ? f.name : "image.png";
    for (let n = 2; store.has(name); n++) name = name.replace(/(-\d+)?(\.[^.]*)?$/, (_m, _n, ext = "") => `-${n}${ext}`);
    store.set(name, f);
    urls.set(name, URL.createObjectURL(f));
    return name;
  },
  url: (name) => urls.get(name) ?? "",
  list: async () => [...store.keys()],
};
ed.files = files;
ed.sizeKey = "demo"; // a dragged height is remembered
(window as unknown as { demoFiles: Map<string, File> }).demoFiles = store;

ed.value = saved() ?? SAMPLE;
show(ed.value, saved() ? "Loaded the saved value." : "Sample text (nothing saved yet).");

ed.addEventListener("change", () => { status.textContent = "Unsaved changes."; });
$("save").onclick = () => {
  const v = ed.value;
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
  show(v, `Saved at ${new Date().toLocaleTimeString()}.`);
};
$("revert").onclick = () => { ed.value = saved(); show(ed.value, "Back to the saved value."); };
$("sample").onclick = () => { ed.value = SAMPLE; show(ed.value, "Sample text loaded (not saved)."); };
$("empty").onclick = () => { ed.value = []; show(ed.value, "Empty (not saved)."); };
$("load").onclick = () => {
  try {
    const v = JSON.parse(json.value) as RichText;
    ed.value = v;
    show(ed.value, "Loaded from the JSON (not saved). Shown as the editor stores it.");
  } catch (e) {
    $("err").textContent = "Not valid JSON: " + (e as Error).message;
  }
};
