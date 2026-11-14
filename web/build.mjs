import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });
cpSync("index.html", "dist/index.html");
cpSync("src/styles.css", "dist/styles.css");
// The standalone editor demo (/editor-demo.html): the editor package only.
cpSync("packages/editor/demo/editor-demo.html", "dist/editor-demo.html");
cpSync("packages/editor/src/editor.css", "dist/editor.css");
const demo = {
  entryPoints: ["packages/editor/demo/demo.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: true,
  outfile: "dist/editor-demo.js",
  logLevel: "info",
};
const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: true,
  outfile: "dist/main.js",
  logLevel: "info",
};
if (watch) {
  for (const o of [options, demo]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(demo)]);
}
