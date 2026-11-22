// The layer rule of the web client, as a check.
//
//   node scripts/check-layers.mjs           fail on violations that are not in the allowlist,
//                                           and on allowlist lines that no longer apply
//   node scripts/check-layers.mjs --all     print every violation in allowlist form
//   node scripts/check-layers.mjs --prune   remove the allowlist lines that no longer apply
//
// A module imports only from the modules below it, and only the named files
// touch the network and the browser's storage. Inside the application, the
// components know nothing of the server, the store, the router or the views,
// and a view is imported by the application's shell only, never by another
// view. The allowlist holds the violations that existed when a rule was
// introduced; it only shrinks.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The modules, most specific directory first. `packages` are the npm packages
 * a module may import (a trailing * matches a prefix), `modules` the other
 * modules of this list, `typesOf` the packages it may import types from,
 * `files` single files of other modules it may import.
 * A module without `packages` may import anything.
 */
export const MODULES = [
  { id: "ui/lib", dir: "packages/ui/src/lib/", packages: ["lit"], modules: [] },
  { id: "ui", dir: "packages/ui/src/", packages: ["lit"], modules: ["ui/lib"] },
  { id: "editor", dir: "packages/editor/src/", packages: ["@corestone/ui", "prosemirror-*", "mathjax-full"], modules: [] },
  { id: "components", dir: "packages/components/src/", packages: ["@corestone/ui", "lit"], modules: [], typesOf: ["@corestone/editor"] },
  // Components of the application: they show Corestone's data, which is handed to them.
  // The field editor contains the rich-text editor, so the editor package is allowed here.
  { id: "app/components", dir: "src/components/", packages: ["@corestone/ui", "@corestone/editor", "lit"], modules: [] },
  { id: "app", dir: "src/" },
];

/**
 * The application's files that are not views: the access to the server, the
 * state, and the shell that puts the views together. Every other file directly
 * in src/ is a view, and only the shell imports a view.
 */
export const APP_BASE = ["src/api.ts", "src/ws.ts", "src/store.ts", "src/router.ts", "src/types.ts", "src/files.ts", "src/services.ts", "src/store-controller.ts"];
export const APP_SHELL = ["src/app.ts", "src/main.ts"];

/** True for a view of the application: a file directly in src/ that is neither base nor shell. */
export function isView(path) {
  return /^src\/[^/]+\.ts$/.test(path) && !APP_BASE.includes(path) && !APP_SHELL.includes(path);
}

/** The globals only one file may use. */
export const GLOBALS = {
  fetch: "src/api.ts",
  WebSocket: "src/ws.ts",
  localStorage: "packages/ui/src/lib/prefs.ts",
  sessionStorage: "packages/ui/src/lib/prefs.ts",
};

const HOSTS = new Set(["window", "globalThis", "self"]);

export function moduleOf(path) {
  return MODULES.find((m) => path.startsWith(m.dir));
}

/** "lit/decorators.js" is package "lit", "@corestone/editor/model" is "@corestone/editor". */
function packageOf(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function allows(list, name) {
  return (list ?? []).some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

/** True where the identifier names the global itself, not a member or a declaration of that name. */
function usesGlobal(node) {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return ts.isIdentifier(p.expression) && HOSTS.has(p.expression.text);
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)
    || ts.isMethodSignature(p) || ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)
    || ts.isBindingElement(p) || ts.isImportSpecifier(p)) && p.name === node) return false;
  return true;
}

/** The violations of one file: [{ file, line, what }]. `path` is relative to web/, with forward slashes. */
export function violations(path, source) {
  const mod = moduleOf(path);
  if (!mod) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = [];
  const add = (node, what) => found.push({ file: path, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, what });

  const imported = (node, spec, typeOnly) => {
    if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      const to = moduleOf(target + ".ts");
      if (!to) return add(node, `imports ${target}`);
      if (isView(target + ".ts") && !APP_SHELL.includes(path)) return add(node, `imports the view ${target}`);
      if (to === mod || !mod.packages || mod.modules.includes(to.id) || mod.files?.includes(target + ".ts")) return;
      return add(node, `imports ${target}`);
    }
    if (!mod.packages) return;
    const name = packageOf(spec);
    if (allows(mod.packages, name) || (typeOnly && allows(mod.typesOf, name))) return;
    add(node, `imports ${name}`);
  };

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
      imported(node, node.moduleSpecifier.text, typeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imported(node, node.arguments[0].text, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      imported(node, node.argument.literal.text, true);
    } else if (ts.isIdentifier(node) && Object.hasOwn(GLOBALS, node.text) && GLOBALS[node.text] !== path && usesGlobal(node)) {
      add(node, `uses ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** One allowlist line per file and kind of violation, however often it occurs there. */
export const entry = (v) => `${v.file}: ${v.what}`;

/** Splits the violations by the allowlist: the new ones, and the allowlist lines nothing matches any more. */
export function compare(all, allowed) {
  const present = new Set(all.map(entry));
  return {
    fresh: all.filter((v) => !allowed.has(entry(v))),
    stale: [...allowed].filter((line) => !present.has(line)),
  };
}

function sources(root, dir) {
  const out = [];
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = posix.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== "node_modules") out.push(...sources(root, path)); }
    else if (item.name.endsWith(".ts") && !item.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const listFile = join(root, "scripts", "layer-allowlist.txt");
  const dirs = ["src", ...readdirSync(join(root, "packages")).map((p) => `packages/${p}/src`)];
  const all = dirs.flatMap((d) => sources(root, d)).sort().flatMap((p) => violations(p, readFileSync(join(root, p), "utf8")));

  if (process.argv.includes("--all")) {
    console.log([...new Set(all.map(entry))].join("\n"));
    return;
  }
  let lines = readFileSync(listFile, "utf8").split("\n");
  const isEntry = (l) => l.trim() !== "" && !l.startsWith("#");
  const { fresh, stale } = compare(all, new Set(lines.filter(isEntry).map((l) => l.trim())));

  if (process.argv.includes("--prune")) {
    lines = lines.filter((l) => !stale.includes(l.trim()));
    writeFileSync(listFile, lines.join("\n"));
    console.log(`Removed ${stale.length} line(s) from ${relative(process.cwd(), listFile)}.`);
    stale.length = 0;
  }
  for (const v of fresh) console.error(`${v.file}:${v.line}: ${v.what}`);
  for (const line of stale) console.error(`allowlist: "${line}" no longer applies; remove it (--prune)`);
  if (fresh.length || stale.length) {
    if (fresh.length) console.error(`\n${fresh.length} violation(s) of the layer rule. See the header of scripts/check-layers.mjs.`);
    process.exit(1);
  }
  console.log(`Layer rule holds; ${lines.filter(isEntry).length} known violation(s) left in the allowlist.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
