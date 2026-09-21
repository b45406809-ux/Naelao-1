import { execFile } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { extname, dirname, normalize, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".toml", ".sql", ".md", ".yml", ".yaml", ".css", ".html"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const OMIT = /(^|\/)(node_modules|dist|coverage|\.next|\.wrangler|\.git|\.repomix-cache|\.phase-runs)(\/|$)/;

function normalizeRepoPath(path) { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }
function resolveImport(from, specifier, files) {
  if (!specifier.startsWith(".")) return specifier.startsWith("@naelao/") ? `package:${specifier}` : `external:${specifier}`;
  const base = normalizeRepoPath(posix.normalize(posix.join(posix.dirname(from), specifier)));
  for (const candidate of [base, ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`), ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`)]) if (files.has(candidate)) return candidate;
  return `unresolved:${specifier}`;
}
function extractImports(text) {
  const values = [];
  for (const pattern of [/\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of text.matchAll(pattern)) values.push(match[1]);
  }
  return [...new Set(values)];
}
function extractRoutes(text) {
  return [...text.matchAll(/\b(?:app|api|router)\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));
}
function extractBindings(text, path) {
  if (!/wrangler.*\.toml$/.test(path)) return [];
  return [...text.matchAll(/^\s*binding\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1]);
}
function packageName(text, path) {
  if (!path.endsWith("package.json")) return undefined;
  try { return JSON.parse(text).name; } catch { return undefined; }
}
function owningPackage(path, packageRoots) {
  let best;
  for (const [root, name] of packageRoots) if ((path === `${root}/package.json` || path.startsWith(`${root}/`)) && (!best || root.length > best.root.length)) best = { root, name };
  return best;
}
function associatedTests(path, allFiles) {
  const stem = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const normalizedStem = stem.replace(/(?:DO|Worker)$/i, "").toLowerCase();
  return allFiles.filter((candidate) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate)).filter((candidate) => candidate.toLowerCase().includes(normalizedStem) || candidate.includes(path.replace(/\.[^.]+$/, ".test"))).slice(0, 30);
}

export async function buildRepositoryIndex(root = process.cwd(), outputPath = ".repomix-cache/repository-index.json") {
  const listed = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const paths = [...new Set(listed.stdout.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean))].filter((path) => !OMIT.test(path));
  const fileSet = new Set(paths);
  const packageRoots = [];
  const raw = new Map();
  for (const path of paths) {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    try {
      const size = (await stat(resolve(root, path))).size;
      if (size > 5_000_000) continue;
      const text = await readFile(resolve(root, path), "utf8");
      raw.set(path, { text, size });
      const name = packageName(text, path);
      if (name) packageRoots.push([dirname(path) === "." ? "" : normalizeRepoPath(dirname(path)), name]);
    } catch { /* deleted or non-UTF8 files are not context candidates */ }
  }
  const files = {};
  const packages = {};
  for (const [path, item] of raw) {
    const owner = owningPackage(path, packageRoots);
    const imports = extractImports(item.text).map((specifier) => resolveImport(path, specifier, fileSet));
    files[path] = {
      size: item.size,
      lines: item.text.split("\n").length,
      package: owner?.name ?? null,
      imports,
      routes: extractRoutes(item.text),
      bindings: extractBindings(item.text, path),
      tests: associatedTests(path, paths),
      symbols: [...item.text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:class|function|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).slice(0, 500),
    };
    if (owner?.name) (packages[owner.name] ??= { root: owner.root, files: [], dependencies: [], entry_files: [] }).files.push(path);
  }
  for (const [name, pkg] of Object.entries(packages)) {
    const packageJson = raw.get(`${pkg.root ? `${pkg.root}/` : ""}package.json`)?.text;
    if (packageJson) try {
      const parsed = JSON.parse(packageJson);
      pkg.dependencies = [...new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})])];
      const declared = [parsed.module, parsed.main, parsed.types, ...(typeof parsed.exports === "string" ? [parsed.exports] : parsed.exports && typeof parsed.exports === "object" ? Object.values(parsed.exports).flatMap((entry) => typeof entry === "string" ? [entry] : entry && typeof entry === "object" ? Object.values(entry).filter((value) => typeof value === "string") : []) : [])];
      pkg.entry_files = [...new Set(declared.map((entry) => normalizeRepoPath(posix.join(pkg.root, String(entry).replace(/^\.\//, "")))).filter((entry) => files[entry]))];
      if (!pkg.entry_files.length) for (const fallback of [`${pkg.root}/src/index.ts`, `${pkg.root}/src/index.tsx`]) if (files[fallback]) pkg.entry_files.push(fallback);
    } catch { /* malformed package metadata is surfaced by normal package validation */ }
  }
  const reverseImports = {};
  for (const [path, info] of Object.entries(files)) for (const imported of info.imports) if (files[imported]) (reverseImports[imported] ??= []).push(path);
  const index = { schema_version: 1, generated_at: new Date().toISOString(), commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), files, packages, reverse_imports: reverseImports };
  await mkdir(resolve(root, dirname(outputPath)), { recursive: true });
  await writeFile(resolve(root, outputPath), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const index = await buildRepositoryIndex();
  console.log(`Indexed ${Object.keys(index.files).length} text files across ${Object.keys(index.packages).length} packages.`);
}
