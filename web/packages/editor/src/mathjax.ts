import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

// MathJax: LaTeX to SVG. Loaded only when a formula is written or its picture
// is made again (a separate part of the bundle); reading shows the stored PNG.

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// no loading of further packages, no HTML (links, classes, styles), no interactive parts
const LEFT_OUT = new Set(["autoload", "require", "html", "action", "noerrors", "noundefined"]);
const tex = new TeX({
  packages: AllPackages.filter((p) => !LEFT_OUT.has(p)),
  // errors are thrown, to show their message instead of a red box
  formatError: (_jax: unknown, err: Error) => { throw err; },
});
const svg = new SVG({ fontCache: "none" });
const doc = mathjax.document("", { InputJax: tex, OutputJax: svg });

const EX = 8; // pixels per ex (half the 16 px em MathJax assumes)

/** A formula as SVG, sized in pixels; baseline: pixels from the top to the baseline. */
export interface Rendered { svg: string; width: number; height: number; baseline: number }

/** The SVG of a formula; throws with MathJax's message when the LaTeX is wrong. */
export function render(latex: string, display: boolean): Rendered {
  const node = doc.convert(latex, { display, em: 2 * EX, ex: EX, containerWidth: 80 * 2 * EX });
  const el = adaptor.firstChild(node) as Parameters<typeof adaptor.getAttribute>[0];
  const ex = (v: string | null) => parseFloat(v ?? "") || 0;
  const width = ex(adaptor.getAttribute(el, "width")) * EX;
  const height = ex(adaptor.getAttribute(el, "height")) * EX;
  const valign = /vertical-align:\s*(-?[\d.]+)ex/.exec(adaptor.getAttribute(el, "style") ?? "");
  const depth = -(valign ? parseFloat(valign[1]) : 0) * EX;
  adaptor.setAttribute(el, "width", `${width}`);
  adaptor.setAttribute(el, "height", `${height}`);
  adaptor.removeAttribute(el, "style");
  const out = adaptor.outerHTML(el);
  return { svg: out.includes("xmlns=") ? out : out.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"'), width, height, baseline: height - depth };
}
