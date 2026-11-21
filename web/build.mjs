import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist/chunks", { recursive: true, force: true }); // chunks of earlier builds
mkdirSync("dist", { recursive: true });
cpSync("index.html", "dist/index.html");
cpSync("src/styles.css", "dist/styles.css");
cpSync("packages/ui/src/ui.css", "dist/ui.css"); // the look of the blocks of @corestone/ui
// The standalone editor demo (/editor-demo.html): the editor package only.
cpSync("packages/editor/demo/editor-demo.html", "dist/editor-demo.html");
cpSync("packages/editor/src/editor.css", "dist/editor.css");
// Code splitting: parts loaded only when needed (MathJax, for writing formulas) are chunks
// of their own next to the entry points.
const common = { bundle: true, format: "esm", splitting: true, outdir: "dist", chunkNames: "chunks/[name]-[hash]" };
const demo = {
  ...common,
  entryPoints: { "editor-demo": "packages/editor/demo/demo.ts" },
  target: "es2022",
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
};
const options = {
  ...common,
  entryPoints: { main: "src/main.ts" },
  target: "es2022",
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
};
if (watch) {
  for (const o of [options, demo]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(demo)]);
}
