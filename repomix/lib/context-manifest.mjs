import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

export const MANIFEST_SCHEMA = {
  type: "object",
  required: ["read_files", "edit_files", "test_files", "bindings", "migrations", "request_paths", "symbols", "commands", "checklist"],
};
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.@/+ -]+$/;
function strings(value, name, max = 200) {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((entry) => entry.trim()))];
}
export function validateContextManifest(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Context manifest must be an object");
  const manifest = {
    read_files: strings(value.read_files, "read_files"), edit_files: strings(value.edit_files, "edit_files"), new_files: strings(value.new_files ?? [], "new_files"), test_files: strings(value.test_files, "test_files"),
    bindings: strings(value.bindings, "bindings"), migrations: strings(value.migrations, "migrations"), request_paths: strings(value.request_paths, "request_paths"),
    commands: strings(value.commands, "commands", 30), checklist: strings(value.checklist, "checklist", 100), symbols: value.symbols && typeof value.symbols === "object" ? value.symbols : {},
  };
  for (const path of [...manifest.read_files, ...manifest.edit_files, ...manifest.migrations]) {
    if (!SAFE_PATH.test(path) || !index.files[path]) throw new Error(`Manifest references unknown or unsafe file: ${path}`);
  }
  for (const path of manifest.new_files) if (!SAFE_PATH.test(path) || index.files[path]) throw new Error(`new_files must be a safe path that does not exist: ${path}`);
  for (const path of manifest.test_files) if (!SAFE_PATH.test(path) || (!index.files[path] && !manifest.new_files.includes(path))) throw new Error(`test_files references unknown file not declared in new_files: ${path}`);
  for (const [path, names] of Object.entries(manifest.symbols)) {
    if (!index.files[path]) throw new Error(`symbols references unknown file: ${path}`);
    manifest.symbols[path] = strings(names, `symbols.${path}`, 100);
  }
  if (!manifest.checklist.length) throw new Error("Manifest checklist cannot be empty");
  return manifest;
}
function packageRootFor(index, packageName) { return index.packages[packageName]?.root; }
function resolvePackageImport(index, imported) {
  const name = imported.slice("package:".length);
  const root = packageRootFor(index, name);
  if (root === undefined) return [];
  return [...new Set([...(index.packages[name]?.entry_files ?? []), `${root}/package.json`])].filter((path) => index.files[path]);
}
export function expandContextManifest(manifest, index) {
  const selected = new Set([...manifest.read_files, ...manifest.edit_files, ...manifest.test_files, ...manifest.migrations]);
  const queue = [...selected];
  while (queue.length) {
    const path = queue.shift(); const info = index.files[path]; if (!info) continue;
    for (const imported of info.imports ?? []) {
      const candidates = imported.startsWith("package:") ? resolvePackageImport(index, imported) : index.files[imported] ? [imported] : [];
      for (const candidate of candidates) if (!selected.has(candidate)) { selected.add(candidate); queue.push(candidate); }
    }
    for (const test of info.tests ?? []) selected.add(test);
  }
  for (const path of [...selected]) {
    const info = index.files[path]; if (!info?.package) continue;
    const root = index.packages[info.package]?.root;
    if (root) for (const candidate of [`${root}/package.json`, `${root}/tsconfig.json`, `${root}/wrangler.toml`]) if (index.files[candidate]) selected.add(candidate);
  }
  for (const path of Object.keys(index.files)) {
    if (/^infra\/migrations\//.test(path) && manifest.migrations.includes(path)) selected.add(path);
    if (/wrangler.*\.toml$/.test(path) && manifest.bindings.some((binding) => index.files[path].bindings?.includes(binding))) selected.add(path);
  }
  return [...selected].sort();
}
export function deterministicSeed(spec, index, limit = 30) {
  const terms = [...new Set((spec.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((term) => !/^(this|that|with|from|have|will|must|every|item|project|production)$/.test(term)))];
  const scored = Object.entries(index.files).map(([path, info]) => {
    const haystack = `${path} ${(info.symbols ?? []).join(" ")} ${(info.routes ?? []).map((r) => r.path).join(" ")} ${(info.bindings ?? []).join(" ")}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) + (/workers\/router\/src\/index\.ts$/.test(path) ? 1 : 0);
    return { path, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}
export async function renderIndexForScout(index, paths) {
  return paths.map((path) => `${path}\n  package: ${index.files[path].package ?? "root"}\n  imports: ${(index.files[path].imports ?? []).join(", ")}\n  routes: ${(index.files[path].routes ?? []).map((r) => `${r.method} ${r.path}`).join(", ")}\n  bindings: ${(index.files[path].bindings ?? []).join(", ")}\n  symbols: ${(index.files[path].symbols ?? []).join(", ")}\n  tests: ${(index.files[path].tests ?? []).join(", ")}`).join("\n\n");
}
export async function sliceSource(root, path, symbols = [], keywords = []) {
  const text = await readFile(resolve(root, path), "utf8");
  if (text.length <= 160_000 || (!/\.[cm]?[jt]sx?$/.test(path))) return { content: text, complete: true, ranges: [[1, text.split("\n").length]] };
  const ts = await import("typescript");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split("\n"), wanted = new Set(symbols), ranges = [];
  for (const statement of source.statements) {
    const start = source.getLineAndCharacterOfPosition(statement.getFullStart()).line + 1;
    const end = source.getLineAndCharacterOfPosition(statement.end).line + 1;
    const name = statement.name?.text;
    const snippet = text.slice(statement.getFullStart(), statement.end).toLowerCase();
    if (ts.isImportDeclaration(statement)) ranges.push([start, end]);
    else if (name && wanted.has(name)) ranges.push([start, end]);
    else if (keywords.some((term) => snippet.includes(term))) ranges.push([Math.max(1, start - 2), Math.min(lines.length, end + 2)]);
  }
  if (!ranges.length) ranges.push([1, Math.min(lines.length, 300)]);
  ranges.sort((a,b)=>a[0]-b[0]); const merged=[];
  for (const range of ranges) { const last=merged.at(-1); if(last&&range[0]<=last[1]+5) last[1]=Math.max(last[1],range[1]); else merged.push([...range]); }
  const content = merged.map(([start,end]) => `/* ${path}:${start}-${end} */\n${lines.slice(start-1,end).join("\n")}`).join("\n\n");
  return { content, complete: false, ranges: merged };
}
