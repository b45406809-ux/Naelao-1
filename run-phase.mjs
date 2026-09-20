#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};

const manifest = JSON.parse(await readFile(new URL("repomix/phases.json", import.meta.url), "utf8"));
const registry = JSON.parse(await readFile(new URL("repomix/provider-models.json", import.meta.url), "utf8"));

const start = Number(value("--start", process.env.PHASE_START ?? 1));
const end = Number(value("--end", process.env.PHASE_END ?? manifest.phases.length));
const maxTurns = Number(value("--max-turns", process.env.MAX_TURNS_PER_PHASE ?? 12));
const hardInputTokens = Number(value("--hard-tokens", process.env.HARD_INPUT_TOKENS ?? 600000));
const maxFileSizeBytes = Number(value("--max-file-size", process.env.MAX_FILE_SIZE ?? 650000));
const verifyCommand = value("--verify", process.env.PHASE_VERIFY_COMMAND ?? "pnpm typecheck && pnpm test");
const dryRun = argv.includes("--dry-run");

if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > manifest.phases.length || start > end) {
  throw new Error(`Select phases 1-${manifest.phases.length}`);
}

const keys = {
  gemini: (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "").split(",").filter(Boolean),
  groq: (process.env.GROQ_API_KEYS ?? process.env.GROQ_API_KEY ?? "").split(",").filter(Boolean),
  openrouter: (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? "").split(",").filter(Boolean),
};

const requested = (value("--providers", process.env.AI_PROVIDERS ?? "gemini,groq,openrouter")).split(",");
let models = Object.entries(registry.providers)
  .flatMap(([provider, p]) => (requested.includes(provider) && keys[provider].length ? p.models.map((m) => ({ ...m, provider, endpoint: p.endpoint })) : []))
  .sort((a, b) => b.rank - a.rank);

if (!dryRun && !models.length) {
  throw new Error("Configure at least one of GEMINI_API_KEYS, GROQ_API_KEYS, or OPENROUTER_API_KEYS");
}

await mkdir(new URL(".phase-runs/", import.meta.url), { recursive: true });

async function run(cmd, args, options = {}) {
  const r = await exec(cmd, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

const tokenEstimate = (s) => Math.ceil(s.length / 3.5);

const IGNORED_PATTERNS = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|\.repomix-cache|\.phase-runs|dist|coverage|node_modules)\/|\.(lock|png|jpg|jpeg|gif|svg|ico|pdf|woff2?|map|min\.[a-z]+)$/i;
const MANDATORY_FILES = ["package.json", "pnpm-workspace.yaml", "docs/requirements-trace-matrix.md"];

async function inventory() {
  const files = (await exec("git", ["ls-files"], { cwd: ROOT })).stdout.trim().split("\n");
  return files.filter((f) => f && !IGNORED_PATTERNS.test(f));
}

function generateSkeleton(content) {
  const lines = content.split("\n");
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(import|export\s+(type|interface)|type\s+|interface\s+)/.test(trimmed)) {
      result.push(line);
      continue;
    }
    if (/(class\s+\w+|constructor\(|async\s+\w+\(|\w+\([^)]*\)\s*[:{])/.test(trimmed)) {
      result.push(line.replace(/\{[\s\S]*$/, "{ /* ... */ }"));
      continue;
    }
    if (/^(export\s+)?(const|let|var)\s+\w+/.test(trimmed) && trimmed.length < 120) {
      result.push(line);
    }
  }
  return `// === SKELETON OUTLINE (Full implementation omitted for size) ===\n` + result.slice(0, 300).join("\n");
}

async function chooseInitialFiles(prompt, files) {
  const terms = [...new Set(prompt.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || [])];
  const scored = [];

  for (const file of files) {
    if (IGNORED_PATTERNS.test(file)) continue;
    let size = 0;
    try {
      size = (await stat(new URL(file, import.meta.url))).size;
    } catch {
      continue;
    }
    if (size > maxFileSizeBytes) continue;
    const low = file.toLowerCase();
    const score = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) + (low.includes("router") ? 1 : 0);
    if (score) scored.push({ file, size, score });
  }

  scored.sort((a, b) => b.score - a.score || a.size - b.size);
  let bytes = 0;
  const selected = MANDATORY_FILES.filter((f) => files.includes(f));
  for (const x of scored) {
    if (selected.includes(x.file)) continue;
    if (bytes + x.size > 80000) continue;
    selected.push(x.file);
    bytes += x.size;
  }
  return { files: selected, inventory: files.join("\n") };
}

async function makePack(phase, paths) {
  const macro = String(phase.macro_profile).padStart(2, "0");
  const configs = (await readdir(new URL("repomix/", import.meta.url))).filter((x) => x.startsWith(`batch-${macro}-`) && x.endsWith(".json"));
  const base = JSON.parse(await readFile(new URL(`repomix/${configs[0]}`, import.meta.url), "utf8"));
  base.include = [...new Set(paths)];
  base.output.filePath = `.repomix-cache/micro-${phase.phase}.xml`;
  base.output.instructionFilePath = `.repomix-cache/authority-batch-${phase.phase}.md`;
  const temp = `.repomix-cache/config-${phase.phase}.json`;
  await writeFile(new URL(temp, import.meta.url), JSON.stringify(base, null, 2));
  await run("npx", ["--yes", "repomix@1.18.0", "--config", temp, "--quiet"]);
  return readFile(new URL(base.output.filePath, import.meta.url), "utf8");
}

// Repair common LLM unified diff formatting mistakes
function normalizePatch(text) {
  const lines = text.split("\n");
  const out = [];
  let inHunk = false;
  let oldLines = 0;
  let newLines = 0;
  let hunkHeaderIndex = -1;
  let oldStart = 1;
  let newStart = 1;

  function commitHunk() {
    if (hunkHeaderIndex >= 0) {
      out[hunkHeaderIndex] = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (inHunk) {
        commitHunk();
        inHunk = false;
      }
      out.push(line);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      if (inHunk) commitHunk();
      inHunk = true;
      oldStart = hunkMatch[1];
      newStart = hunkMatch[2];
      oldLines = 0;
      newLines = 0;
      hunkHeaderIndex = out.length;
      out.push(line); // placeholder, updated by commitHunk
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        newLines++;
        out.push(line);
      } else if (line.startsWith("-")) {
        oldLines++;
        out.push(line);
      } else if (line.startsWith(" ") || line === "") {
        // Blank lines in hunks must have a leading space for unified diff standard
        oldLines++;
        newLines++;
        out.push(line === "" ? " " : line);
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
        out.push(line);
      } else {
        // Out of hunk or unknown line
        commitHunk();
        inHunk = false;
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }

  if (inHunk) commitHunk();
  return out.join("\n").trimEnd() + "\n";
}

function extractPatch(text) {
  const fenced = [...text.matchAll(/```(?:diff|patch|git)[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  let raw = "";
  if (fenced.length) {
    raw = fenced.join("\n") + "\n";
  } else {
    const match = text.match(/(?:diff --git a\/|--- [ab]\/)/);
    if (match) {
      raw = text.slice(match.index).split(/\n(?:PHASE_NOTES|RELEASE_LEDGER|VERIFICATION|CONTEXT_REQUEST):/i)[0].replace(/```\s*$/, "").trimEnd() + "\n";
    }
  }

  return raw ? normalizePatch(raw) : "";
}

async function applyPatchFile(patchPath) {
  // Strategy 1: standard 3-way with recount and fix whitespace
  try {
    await run("git", ["apply", "--recount", "--3way", "--whitespace=fix", patchPath]);
    return true;
  } catch (e1) {
    console.warn(`[git apply] Tier 1 failed (${e1.message?.trim()}). Trying ignore-whitespace...`);
  }

  // Strategy 2: ignore whitespace
  try {
    await run("git", ["apply", "--recount", "--ignore-whitespace", "--ignore-space-change", patchPath]);
    return true;
  } catch (e2) {
    console.warn(`[git apply] Tier 2 failed (${e2.message?.trim()}). Trying GNU patch...`);
  }

  // Strategy 3: GNU patch fallback (handles fuzzy context lines far better)
  try {
    await run("patch", ["-p1", "--batch", "--forward", "-i", patchPath]);
    return true;
  } catch (e3) {
    console.error(`[patch fallback] Tier 3 failed: ${e3.message}`);
    throw new Error(`Failed to apply patch via git apply and GNU patch.\nError: ${e3.message}`);
  }
}

async function safeContextRequests(text, allInventory, outlinesMap) {
  const block = text.match(/(?:^|\n)[#* \t]*CONTEXT_REQUEST[* \t]*:\s*\n([\s\S]*?)(?:\n[#* \t]*[A-Z_]+[* \t]*:|$)/i)?.[1] ?? "";
  const wanted = block
    .split("\n")
    .map((x) => x.replace(/^[-* \t]+|[`'"]/g, "").replace(/\s*\(.*?\)/, "").trim())
    .filter(Boolean);

  const matched = wanted.filter((x) => allInventory.includes(x) && !IGNORED_PATTERNS.test(x));
  const valid = [];
  for (const file of matched) {
    try {
      const s = (await stat(new URL(file, import.meta.url))).size;
      if (s <= maxFileSizeBytes) {
        valid.push(file);
      } else {
        console.warn(`[context] File ${file} (${s}B) exceeds ${maxFileSizeBytes}B limit. Providing skeleton outline.`);
        const content = await readFile(new URL(file, import.meta.url), "utf8");
        outlinesMap.set(file, generateSkeleton(content));
      }
    } catch {
      continue;
    }
  }
  return valid.slice(0, 15);
}

function buildPrompt(spec, inventoryText, pack, outlinesMap, allowContextRequest, patchErrorNote = "") {
  let outlinesSection = "";
  if (outlinesMap.size > 0) {
    outlinesSection = "\nLARGE FILES OUTLINE SKELETONS (structural reference):\n";
    for (const [f, outline] of outlinesMap.entries()) {
      outlinesSection += `\n--- ${f} ---\n${outline}\n`;
    }
  }

  let errorPrompt = "";
  if (patchErrorNote) {
    errorPrompt = `\nCRITICAL FIX REQUIRED: The previous patch failed to apply with error:\n${patchErrorNote}\nEnsure all modified files begin with "diff --git a/... b/...", all unchanged lines start with a single space, and exact line hunks match the current source.\n`;
  }

  let formatRules = "";
  if (allowContextRequest) {
    formatRules = `RESPONSE FORMAT REQUIREMENTS:
1. If essential source files are missing from the slice above, respond ONLY with:
CONTEXT_REQUEST:
path/to/file1
path/to/file2

2. Otherwise, declare status and provide standard apply-ready unified diffs:
PHASE_STATUS: COMPLETE (or IN_PROGRESS)
\`\`\`diff
diff --git a/path/to/file b/path/to/file
--- a/path/to/file
+++ b/path/to/file
@@ ... @@
\`\`\``;
  } else {
    formatRules = `RESPONSE FORMAT REQUIREMENTS:
CONTEXT GATHERING IS COMPLETE. DO NOT RETURN CONTEXT_REQUEST.
You MUST provide the implementation now using standard apply-ready unified diffs:
PHASE_STATUS: COMPLETE (or IN_PROGRESS)
\`\`\`diff
diff --git a/path/to/file b/path/to/file
--- a/path/to/file
+++ b/path/to/file
@@ ... @@
\`\`\``;
  }

  return `${spec}

REPOSITORY PATH INVENTORY:
${inventoryText}

CURRENT FULL-SOURCE REPOMIX SLICE:
${pack}
${outlinesSection}
${errorPrompt}
${formatRules}`;
}

async function call(model, key, prompt) {
  let url;
  const headers = { "content-type": "application/json" };
  let body;

  if (model.provider === "gemini") {
    url = `${model.endpoint}/models/${encodeURIComponent(model.id)}:generateContent?key=${encodeURIComponent(key)}`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
    };
  } else {
    url = `${model.endpoint}/chat/completions`;
    headers.authorization = `Bearer ${key}`;
    if (model.provider === "openrouter") {
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL ?? "https://github.com";
      headers["X-Title"] = "Naelao plan implementation";
    }
    body = {
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 32768,
    };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw Object.assign(new Error(`${model.provider}/${model.id}: ${res.status} ${(await res.text()).slice(0, 1000)}`), {
      retryable: [408, 429, 500, 502, 503, 504].includes(res.status),
    });
  }

  const data = await res.json();
  return model.provider === "gemini"
    ? (data.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? "").join("")
    : data.choices?.[0]?.message?.content ?? "";
}

async function request(prompt, phase, turn) {
  const tokens = tokenEstimate(prompt);
  const eligible = models.filter((m) => tokens + 32768 <= m.context && tokens <= m.input_tpm_guard);
  if (!eligible.length) {
    throw new Error(`No configured model can accept estimated ${tokens} input tokens plus output allowance`);
  }

  let last;
  for (const m of eligible) {
    for (const key of keys[m.provider]) {
      try {
        return { text: await call(m, key, prompt), model: `${m.provider}-${m.id}` };
      } catch (e) {
        last = e;
        if (!e.retryable) console.error(e.message);
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * (turn + 1))));
      }
    }
  }
  throw last;
}

for (const phase of manifest.phases.slice(start - 1, end)) {
  console.log(`===== MICRO-PHASE ${phase.phase}/${manifest.phases.length}: items ${phase.from}-${phase.to} =====`);
  const spec = await readFile(new URL(phase.prompt, import.meta.url), "utf8");
  const fullInventory = await inventory();
  const initial = await chooseInitialFiles(spec, fullInventory);
  let paths = initial.files;
  let complete = false;
  let changed = false;
  const outlinesMap = new Map();
  let contextRequestedOnce = false;
  let lastPatchError = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    const allowContext = turn === 1 && !contextRequestedOnce;

    let pack = await makePack(phase, paths);
    let prompt = buildPrompt(spec, initial.inventory, pack, outlinesMap, allowContext, lastPatchError);
    let estimatedTokens = tokenEstimate(prompt);

    while (estimatedTokens > hardInputTokens) {
      const nonMandatory = paths.filter((p) => !MANDATORY_FILES.includes(p));
      if (!nonMandatory.length) {
        throw new Error(`Micro-phase ${phase.phase} mandatory files alone exceed ${hardInputTokens} tokens`);
      }

      let largestFile = nonMandatory[0];
      let largestSize = 0;
      for (const f of nonMandatory) {
        try {
          const s = (await stat(new URL(f, import.meta.url))).size;
          if (s > largestSize) {
            largestSize = s;
            largestFile = f;
          }
        } catch {
          // ignore
        }
      }

      console.warn(`[prune] Prompt is ~${estimatedTokens} tokens (> ${hardInputTokens}). Dropping ${largestFile} (${largestSize}B)...`);
      paths = paths.filter((p) => p !== largestFile);
      pack = await makePack(phase, paths);
      prompt = buildPrompt(spec, initial.inventory, pack, outlinesMap, allowContext, lastPatchError);
      estimatedTokens = tokenEstimate(prompt);
    }

    console.log(`turn ${turn}: ~${estimatedTokens} input tokens, ${paths.length} files`);
    if (dryRun) {
      complete = true;
      break;
    }

    const out = await request(prompt, phase.phase, turn);
    const base = `.phase-runs/phase-${String(phase.phase).padStart(2, "0")}-turn-${turn}-${out.model.replace(/[^a-z0-9._-]/gi, "_")}`;
    await writeFile(new URL(`${base}.response.md`, import.meta.url), out.text);

    if (allowContext) {
      const requestedPaths = await safeContextRequests(out.text, fullInventory, outlinesMap);
      if (requestedPaths.length) {
        console.log(`turn ${turn}: model requested ${requestedPaths.length} context files`);
        contextRequestedOnce = true;
        const mandatory = MANDATORY_FILES.filter((f) => fullInventory.includes(f));
        paths = [...new Set([...mandatory, ...requestedPaths])];
        continue;
      }
    }

    const patch = extractPatch(out.text);
    if (patch) {
      const pp = `${base}.patch`;
      await writeFile(new URL(pp, import.meta.url), patch);
      try {
        await applyPatchFile(pp);
        changed = true;
        lastPatchError = "";
      } catch (err) {
        console.warn(`[patch apply failed on turn ${turn}]: ${err.message}`);
        lastPatchError = err.message;
        continue; // Retry next turn with the error in the prompt
      }
    }

    const isComplete = /(?:^|\n)[#* \t]*PHASE_STATUS[* \t]*:\s*COMPLETE/i.test(out.text);
    if (isComplete && !lastPatchError) {
      complete = true;
      break;
    }

    if (!patch && !isComplete) {
      console.error(`\n=== UNEXPECTED MODEL OUTPUT (Phase ${phase.phase}, Turn ${turn}) ===\n${out.text}\n=======================================================\n`);
      throw new Error(`Phase ${phase.phase} returned neither an applicable patch nor complete status`);
    }

    paths = initial.files;
  }

  if (!complete) {
    throw new Error(`Phase ${phase.phase} exceeded ${maxTurns} turns`);
  }

  if (!dryRun) {
    await run("bash", ["-lc", verifyCommand]);
    if ((await exec("git", ["status", "--porcelain"], { cwd: ROOT })).stdout.trim()) {
      await run("git", ["add", "-A"]);
      await run("git", ["commit", "-m", `feat(plan): complete micro-phase ${phase.phase} items ${phase.from}-${phase.to}`]);
    }
  } else {
    console.log(`dry-run ready (${changed ? "changed" : "no mutation"})`);
  }
}
