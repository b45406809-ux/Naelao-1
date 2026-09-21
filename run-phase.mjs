#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildRepositoryIndex } from "./repomix/lib/repository-index.mjs";
import { deterministicSeed, expandContextManifest, renderIndexForScout, sliceSource, validateContextManifest } from "./repomix/lib/context-manifest.mjs";
import { availableTextModels, DEFAULT_GEMINI_3_MODELS, parseModelList, rankModels, retryDelayMs } from "./repomix/lib/gemini-models.mjs";

const exec = promisify(execFile);
const ROOT = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
function option(name, fallback) { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; }
const manifest = JSON.parse(await readFile(new URL("repomix/phases.json", import.meta.url), "utf8"));
const start = Number(option("--start", process.env.PHASE_START ?? 1));
const end = Number(option("--end", process.env.PHASE_END ?? manifest.phases.length));
const maxTurns = Number(option("--max-turns", process.env.MAX_TURNS_PER_PHASE ?? 10));
const configuredModels = parseModelList(option("--models", option("--model", process.env.GEMINI_MODELS ?? process.env.IMPLEMENTATION_MODEL ?? DEFAULT_GEMINI_3_MODELS.join(","))));
const configuredReviewModels = parseModelList(option("--review-models", option("--review-model", process.env.REVIEW_MODELS ?? process.env.REVIEW_MODEL ?? configuredModels.join(","))));
const fullVerify = option("--verify", process.env.PHASE_VERIFY_COMMAND ?? "pnpm typecheck && pnpm test");
const dryRun = argv.includes("--dry-run");
const geminiApiBaseUrl = (process.env.GEMINI_API_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const keys = (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "").split(",").map((key) => key.trim()).filter(Boolean);
if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > manifest.phases.length || start > end) throw new Error(`Select an inclusive slice range from 1-${manifest.phases.length}`);
if (!dryRun && keys.length === 0) throw new Error("GEMINI_API_KEYS or GEMINI_API_KEY is required");
if (!configuredModels.length || !configuredReviewModels.length) throw new Error("At least one text-capable Gemini 3.x model is required");
await mkdir(resolve(ROOT, ".phase-runs"), { recursive: true });

async function command(program, args, options = {}) {
  const result = await exec(program, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}
function tokenEstimate(text) { return Math.ceil(text.length / 3.5); }
function errorEvidence(error) {
  if (!error || typeof error !== "object") return String(error);
  return [error.message, error.stdout, error.stderr].filter(Boolean).join("\n").slice(0, 12_000);
}
function parseJsonResponse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return a JSON object");
  return JSON.parse(fenced.slice(start, end + 1));
}
function extractPatch(text) {
  const fenced = [...text.matchAll(/```diff\s*\n([\s\S]*?)```/gi)].map((match) => match[1].trim()).filter(Boolean);
  if (fenced.length) return `${fenced.join("\n")}\n`;
  const start = text.indexOf("diff --git ");
  if (start < 0) return "";
  return `${text.slice(start).split(/\n(?:PHASE_NOTES|RELEASE_LEDGER|VERIFICATION|CONTEXT_REQUEST):/)[0].replace(/```\s*$/, "").trimEnd()}\n`;
}
function patchPaths(patch) {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((match) => [match[1], match[2]]).filter((path) => path !== "/dev/null");
}
function contextRequests(text, index) {
  const block = text.match(/CONTEXT_REQUEST:\s*\n([\s\S]*?)(?:\n[A-Z_]+:|$)/i)?.[1] ?? "";
  return [...new Set(block.split("\n").map((line) => line.replace(/^[-* ]+/, "").trim()).filter((path) => index.files[path]))].slice(0, 40);
}
async function discoverModelPool(configured) {
  if (dryRun) return rankModels(configured);
  const discovered = [];
  for (const key of keys) {
    try {
      const response = await fetch(`${geminiApiBaseUrl}/models?key=${encodeURIComponent(key)}`);
      if (response.ok) discovered.push(...availableTextModels(await response.json()));
    } catch { /* configured models remain the fail-closed fallback */ }
  }
  const pool = rankModels(configured, discovered);
  if (!pool.length) throw new Error("No text-capable Gemini 3.x generateContent model is available");
  return pool;
}
const implementationModels = await discoverModelPool(configuredModels);
const reviewModels = await discoverModelPool(configuredReviewModels);
console.log(`Gemini implementation rotation: ${implementationModels.join(", ")}`);
console.log(`Gemini review rotation: ${reviewModels.join(", ")}`);
const unavailableModels = new Set();
const unavailableTargets = new Set();
const unavailableModelKeys = new Map();

async function callGemini(prompt, modelPool, role, responseJson = false) {
  let lastError;
  const attempts = Math.max(1, keys.length * modelPool.length * 2);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const modelIndex = attempt % modelPool.length;
    const keyIndex = Math.floor(attempt / modelPool.length) % keys.length;
    const selectedModel = modelPool[modelIndex];
    const target = `${keyIndex}:${selectedModel}`;
    if (unavailableModels.has(selectedModel) || unavailableTargets.has(target)) continue;
    const key = keys[keyIndex];
    const response = await fetch(`${geminiApiBaseUrl}/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: role === "implementer" ? 0.1 : 0, maxOutputTokens: role === "implementer" ? 65_536 : 16_384, ...(responseJson ? { responseMimeType: "application/json" } : {}) } }),
    });
    if (response.ok) {
      const data = await response.json();
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
      if (text) return text;
      lastError = new Error(`${selectedModel} ${role} returned no content`);
    } else {
      const detail = (await response.text()).slice(0, 2_000);
      lastError = new Error(`${selectedModel} ${role} returned ${response.status}: ${detail}`);
      if (response.status === 404 || response.status === 410) {
        unavailableTargets.add(target);
        const failedKeys = unavailableModelKeys.get(selectedModel) ?? new Set();
        failedKeys.add(keyIndex); unavailableModelKeys.set(selectedModel, failedKeys);
        if (failedKeys.size === keys.length) unavailableModels.add(selectedModel);
      }
      const delay = retryDelayMs(response.status, response.headers.get("retry-after"), attempt);
      console.warn(`${lastError.message}\nRotating to the next Gemini 3.x model/key${delay ? ` after ${delay}ms` : ""}.`);
      if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw lastError ?? new Error(`${role} failed`);
}
function compactIndex(index) {
  return Object.keys(index.files).sort().join("\n");
}
async function planContext(spec, index, phase) {
  const seed = deterministicSeed(spec, index, 50);
  const prompt = `You are the repository context scout for ${phase.slice_id}. Do not write code. Select the exact production files required to implement and verify the specification. Include router/auth ingress, authoritative worker or Durable Object, persistence/migrations, all environment bindings, shell UI when applicable, direct callers, and realistic tests. Return JSON only with arrays: read_files, edit_files, new_files, test_files, bindings, migrations, request_paths, commands, checklist; and an object symbols mapping large file paths to relevant exported/class/function names. Never invent an existing path.\n\nSPECIFICATION:\n${spec}\n\nHIGH-SIGNAL INDEX:\n${await renderIndexForScout(index, seed)}\n\nALL REPOSITORY PATHS:\n${compactIndex(index)}`;
  const response = await callGemini(prompt, implementationModels, "scout", true);
  return validateContextManifest(parseJsonResponse(response), index);
}
function escapeXml(text) { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function numbered(text) { return text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n"); }
async function buildContext(paths, contextManifest, spec, notebook, index) {
  const priority = new Set([...contextManifest.edit_files, ...contextManifest.test_files, ...contextManifest.migrations]);
  const ordered = [...paths].sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)) || a.localeCompare(b));
  const keywords = [...new Set((spec.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []))].slice(0, 40);
  const chunks = []; let tokens = tokenEstimate(spec) + tokenEstimate(JSON.stringify(notebook)) + 2_000;
  for (const path of ordered) {
    const sliced = await sliceSource(ROOT, path, contextManifest.symbols[path] ?? [], keywords);
    const block = `<file path="${escapeXml(path)}" complete="${sliced.complete}" ranges="${escapeXml(JSON.stringify(sliced.ranges))}">\n${escapeXml(numbered(sliced.content))}\n</file>`;
    const cost = tokenEstimate(block);
    if (tokens + cost > manifest.target_input_tokens && !priority.has(path)) continue;
    if (tokens + cost > manifest.hard_input_tokens) throw new Error(`Required context exceeds hard limit at ${path}; split the slice or narrow symbols`);
    chunks.push(block); tokens += cost;
  }
  return { xml: `<repository_context>\n${chunks.join("\n")}\n</repository_context>`, tokens, included: ordered.filter((path) => chunks.some((chunk) => chunk.includes(`path="${escapeXml(path)}"`))) };
}
async function changedFiles(base) {
  const result = await exec("git", ["diff", "--name-only", base, "--"], { cwd: ROOT });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
async function verifyPatch(base, contextManifest, index) {
  await command("git", ["diff", "--check", base, "--"]);
  const changed = await changedFiles(base);
  const allowed = new Set([...contextManifest.edit_files, ...contextManifest.new_files, ...contextManifest.test_files, ...contextManifest.migrations, "docs/requirements-trace-matrix.md"]);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length) throw new Error(`Patch changed files outside the approved manifest: ${unexpected.join(", ")}`);
  const packages = [...new Set(changed.map((path) => index.files[path]?.package).filter(Boolean))];
  for (const packageName of packages) {
    const pkg = JSON.parse(await readFile(resolve(ROOT, index.packages[packageName].root, "package.json"), "utf8"));
    if (pkg.scripts?.typecheck) await command("pnpm", ["--filter", packageName, "typecheck"]);
  }
  const tests = [...new Set(contextManifest.test_files.filter((path) => index.files[path]))];
  if (tests.length) await command("pnpm", ["exec", "vitest", "run", "--config", "tests/vitest.config.ts", ...tests]);
  await command("pnpm", ["exec", "vitest", "run", "--config", "tests/vitest.config.ts", "tests/unit/wrangler-binding-parity.test.ts", "tests/unit/wrangler-vars-parity.test.ts", "tests/unit/requirements-trace-matrix.test.ts"]);
  await command("node", ["repomix/verify-configs.mjs"]);
  return { changed, packages, tests };
}
function completionGates(verification, contextManifest, index) {
  const failures = [];
  const productionChanged = verification.changed.some((path) => /^(workers|packages|apps)\//.test(path));
  if (contextManifest.edit_files.length && !productionChanged) failures.push("No production implementation file changed");
  if (productionChanged && contextManifest.test_files.length === 0) failures.push("No realistic test file was declared");
  for (const migration of contextManifest.migrations) if (!verification.changed.includes(migration) && !contextManifest.read_files.includes(migration)) failures.push(`Migration was neither changed nor explicitly audited: ${migration}`);
  for (const binding of contextManifest.bindings) if (!Object.values(index.files).some((file) => file.bindings?.includes(binding))) failures.push(`Declared binding is absent from Wrangler configuration: ${binding}`);
  for (const requestPath of contextManifest.request_paths) {
    const match = requestPath.match(/^(GET|POST|PUT|PATCH|DELETE|ALL|USE)\s+(.+)$/i);
    if (!match || !Object.values(index.files).some((file) => file.routes?.some((route) => route.method === match[1].toUpperCase() && route.path === match[2]))) failures.push(`Declared request path is not mounted exactly: ${requestPath}`);
  }
  return failures;
}
async function reviewPhase(spec, contextManifest, notebook, base, verification) {
  const diff = (await exec("git", ["diff", "--no-ext-diff", base, "--"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const prompt = `Act as an independent production reviewer. Return JSON only: {"approved":boolean,"blocking_issues":[string],"missing_tests":[string],"security_findings":[string]}. Reject helpers/placeholders, missing router/auth/persistence/config/UI boundaries, unsafe migrations, weak mocks, or unsupported completion claims.\n\nSPEC:\n${spec}\n\nMANIFEST:\n${JSON.stringify(contextManifest)}\n\nNOTEBOOK:\n${JSON.stringify(notebook)}\n\nVERIFICATION:\n${JSON.stringify(verification)}\n\nDIFF:\n${diff.slice(0, 300_000)}`;
  return parseJsonResponse(await callGemini(prompt, reviewModels, "reviewer", true));
}
async function runFullVerification() { await command("bash", ["-lc", fullVerify]); }
async function completedSlice(phase) {
  const subject = `feat(plan): complete ${phase.slice_id} items ${phase.from}-${phase.to}`;
  const result = await exec("git", ["log", "--format=%s", "--max-count=500"], { cwd: ROOT });
  return result.stdout.split(/\r?\n/).includes(subject);
}
async function writeProgress() {
  const subjects = new Set((await exec("git", ["log", "--format=%s", "--max-count=500"], { cwd: ROOT })).stdout.split(/\r?\n/));
  const slices = manifest.phases.map((phase) => {
    const subject = `feat(plan): complete ${phase.slice_id} items ${phase.from}-${phase.to}`;
    return { slice_id: phase.slice_id, items: `${phase.from}-${phase.to}`, status: subjects.has(subject) ? "completed" : "pending", completion_commit_subject: subject };
  });
  await writeFile(resolve(ROOT, ".phase-runs", "progress.json"), `${JSON.stringify({ schema_version: 1, updated_at: new Date().toISOString(), slices }, null, 2)}\n`);
}
await writeProgress();

for (const phase of manifest.phases.slice(start - 1, end)) {
  console.log(`\n===== ${phase.slice_id}: items ${phase.from}-${phase.to} — ${phase.focus} =====`);
  if (!dryRun && await completedSlice(phase)) { console.log(`${phase.slice_id} is already committed; skipping.`); continue; }
  const phaseDir = resolve(ROOT, ".phase-runs", phase.slice_id); await mkdir(phaseDir, { recursive: true });
  const spec = await readFile(resolve(ROOT, phase.prompt), "utf8");
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
  let index = await buildRepositoryIndex(ROOT);
  let contextManifest;
  if (dryRun) {
    const seed = deterministicSeed(spec, index, 30);
    contextManifest = { read_files: seed, edit_files: [], new_files: [], test_files: [], bindings: [], migrations: [], request_paths: [], commands: [], checklist: ["dry-run context audit"], symbols: {} };
  } else contextManifest = await planContext(spec, index, phase);
  await writeFile(resolve(phaseDir, "context-manifest.json"), `${JSON.stringify(contextManifest, null, 2)}\n`);
  let paths = expandContextManifest(contextManifest, index);
  let notebook = { schema_version: 1, phase: phase.slice_id, base_commit: base, checklist: contextManifest.checklist.map((item) => ({ item, status: "pending", evidence: [] })), inspected_files: [], applied_patches: [], verification: [], reviewer: [] };
  let approved = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const context = await buildContext(paths, contextManifest, spec, notebook, index);
    console.log(`turn ${turn}: ~${context.tokens} source/spec tokens across ${context.included.length} files`);
    if (dryRun) { approved = true; break; }
    const prompt = `${spec}\n\nAPPROVED CONTEXT MANIFEST:\n${JSON.stringify(contextManifest)}\n\nPERSISTENT PHASE NOTEBOOK:\n${JSON.stringify(notebook)}\n\n${context.xml}\n\nImplement the next atomic checklist boundary. If source is missing, return only CONTEXT_REQUEST with exact paths. Otherwise put PHASE_STATUS: CONTINUE or COMPLETE before complete unified diff blocks. Never change a file outside edit_files/new_files/test_files/migrations except docs/requirements-trace-matrix.md.`;
    const response = await callGemini(prompt, implementationModels, "implementer");
    await writeFile(resolve(phaseDir, `turn-${turn}.response.md`), response);
    const requested = contextRequests(response, index);
    if (requested.length) { paths = [...new Set([...paths, ...requested])]; notebook.inspected_files = [...new Set([...notebook.inspected_files, ...context.included])]; await writeFile(resolve(phaseDir, "state.json"), JSON.stringify(notebook, null, 2)); continue; }
    const patch = extractPatch(response);
    if (!patch) throw new Error(`${phase.slice_id} turn ${turn} returned neither context request nor diff`);
    const patchFile = resolve(phaseDir, `turn-${turn}.patch`); await writeFile(patchFile, patch);
    const proposed = patchPaths(patch); const allowed = new Set([...contextManifest.edit_files, ...contextManifest.new_files, ...contextManifest.test_files, ...contextManifest.migrations, "docs/requirements-trace-matrix.md"]);
    const unauthorized = proposed.filter((path) => !allowed.has(path)); if (unauthorized.length) throw new Error(`Model proposed files outside manifest: ${unauthorized.join(", ")}`);
    const unseen = proposed.filter((path) => index.files[path] && !context.included.includes(path)); if (unseen.length) throw new Error(`Model attempted to edit files not supplied in this turn: ${unseen.join(", ")}`);
    try {
      await command("git", ["apply", "--check", "--whitespace=error-all", patchFile]);
      await command("git", ["apply", "--3way", "--whitespace=fix", patchFile]);
    } catch (error) {
      notebook.verification.push({ turn, stage: "patch_apply", error: errorEvidence(error) });
      await writeFile(resolve(phaseDir, "state.json"), `${JSON.stringify(notebook, null, 2)}\n`);
      continue;
    }
    notebook.applied_patches.push({ turn, file: patchFile, paths: proposed }); notebook.inspected_files = [...new Set([...notebook.inspected_files, ...context.included])];
    index = await buildRepositoryIndex(ROOT);
    let verification;
    try {
      verification = await verifyPatch(base, contextManifest, index);
      notebook.verification.push({ turn, ...verification });
    } catch (error) {
      const evidence = errorEvidence(error);
      notebook.verification.push({ turn, stage: "layered_verification", error: evidence, changed: await changedFiles(base) });
      notebook.checklist.push({ item: "Repair the latest layered verification failure", status: "pending", evidence: [evidence.slice(0, 4_000)] });
      paths = expandContextManifest(contextManifest, index);
      await writeFile(resolve(phaseDir, "state.json"), `${JSON.stringify(notebook, null, 2)}\n`);
      continue;
    }
    const gates = completionGates(verification, contextManifest, index);
    if (/^PHASE_STATUS:\s*COMPLETE/im.test(response) && gates.length === 0) {
      const review = await reviewPhase(spec, contextManifest, notebook, base, verification); notebook.reviewer.push(review);
      if (review.approved && !(review.blocking_issues?.length || review.missing_tests?.length || review.security_findings?.length)) { approved = true; break; }
      notebook.checklist.push(...[...(review.blocking_issues ?? []), ...(review.missing_tests ?? []), ...(review.security_findings ?? [])].map((item) => ({ item, status: "pending", evidence: ["independent review"] })));
    } else if (gates.length) notebook.checklist.push(...gates.map((item) => ({ item, status: "pending", evidence: ["deterministic completion gate"] })));
    paths = expandContextManifest(contextManifest, index); await writeFile(resolve(phaseDir, "state.json"), `${JSON.stringify(notebook, null, 2)}\n`);
  }
  if (!approved) throw new Error(`${phase.slice_id} did not pass deterministic gates and independent review in ${maxTurns} turns`);
  if (dryRun) continue;
  const next = manifest.phases[phase.phase];
  if (!next || next.macro_profile !== phase.macro_profile || phase.phase === end) await runFullVerification();
  await writeFile(resolve(phaseDir, "state.json"), `${JSON.stringify({ ...notebook, approved: true }, null, 2)}\n`);
  if ((await changedFiles(base)).length) {
    await command("git", ["add", "-A"]); await command("git", ["commit", "-m", `feat(plan): complete ${phase.slice_id} items ${phase.from}-${phase.to}`]);
    if (process.env.PHASE_PUSH_REMOTE) await command("git", ["push", "--set-upstream", process.env.PHASE_PUSH_REMOTE, "HEAD"]);
    await writeProgress();
  }
}
console.log(`Completed slices ${start}-${end}.`);
