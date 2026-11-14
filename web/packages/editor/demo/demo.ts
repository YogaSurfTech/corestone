// The standalone editor demo (served as /editor-demo.html): only the
// package's public interface, no Corestone code.
import { plainText, type RichText, type RichTextElement } from "@corestone/editor";

const KEY = "cs-editor-demo";
const SAMPLE: RichText = [
  { type: "paragraph", text: [
    { text: "The " }, { text: "main housing", marks: { bold: true } }, { text: " is machined from " },
    { text: "stainless steel 1.4404", marks: { italic: true, color: "#1565c0" } }, { text: " and must withstand 16 bar." },
  ] },
  { type: "list", items: [
    { blocks: [{ type: "paragraph", text: "Tolerances follow ISO 2768-m" }] },
    { blocks: [{ type: "paragraph", text: [{ text: "Surface: " }, { text: "Ra 0.8", marks: { bg: "#f9a825" } }] }] },
  ] },
  { type: "paragraph", align: "center", text: [{ text: "H", marks: {} }, { text: "2", marks: { sub: true } }, { text: "O at 20 °C", marks: {} }] },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ed = $<RichTextElement>("ed");
const json = $<HTMLTextAreaElement>("json");
const status = $<HTMLSpanElement>("status");

function saved(): RichText | string | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
}

function show(v: RichText | string | null, note: string) {
  json.value = JSON.stringify(v, null, 2);
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
    const v = JSON.parse(json.value) as RichText | string;
    ed.value = v;
    show(ed.value, "Loaded from the JSON (not saved). Shown as the editor stores it.");
  } catch (e) {
    $("err").textContent = "Not valid JSON: " + (e as Error).message;
  }
};
