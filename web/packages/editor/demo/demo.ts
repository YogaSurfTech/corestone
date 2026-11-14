// The standalone editor demo (served as /editor-demo.html): only the
// package's public interface, no Corestone code.
import { plainText, type RichText, type RichTextElement } from "@corestone/editor";

const KEY = "cs-editor-demo";
const SAMPLE: RichText = [
  { text: [
    { text: "The " }, { text: "main housing", bold: true }, { text: " is machined from " },
    { text: "stainless steel 1.4404", italic: true, color: "#1565c0" }, { text: " and must withstand 16 bar." },
  ] },
  { list: "ul", text: "Tolerances follow ISO 2768-m" },
  { list: "ul", text: [{ text: "Surface: " }, { text: "Ra 0.8", bg: "#f9a825" }] },
  { align: "center", text: [{ text: "H" }, { text: "2", sub: true }, { text: "O at 20 °C" }] },
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
const fileLayout = (v: RichText | null) =>
  Array.isArray(v) ? (v.length ? "[\n" + v.map((b) => "  " + oneLine(b)).join(",\n") + "\n]" : "[]") : JSON.stringify(v);

function show(v: RichText | null, note: string) {
  json.value = fileLayout(v);
  $("plain").textContent = plainText(v);
  $("err").textContent = "";
  status.textContent = note;
}

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
