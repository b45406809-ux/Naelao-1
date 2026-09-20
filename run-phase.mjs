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

async function inventory() {
  return (await exec("git", ["ls-files"], { cwd: ROOT })).stdout.trim().split("\n");
}

async function chooseInitialFiles(prompt) {
  const files = await inventory();
  const terms = [...new Set(prompt.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) || [])];
  const mandatory = ["package.json", "pnpm-workspace.yaml", "docs/requirements-trace-matrix.md"];
  const scored = [];

  for (const file of files) {
    if (/(^|\/)(node_modules|dist|coverage)\//.test(file) || /\.(png|jpg|gif|woff2?|pdf)$/.test(file)) continue;
    let size = 0;
    try {
      size = (await stat(new URL(file, import.meta.url))).size;
    } catch {
      continue;
    }
    if (size > 250000) continue;
    const low = file.toLowerCase();
    const score = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) + (low.includes("router") ? 1 : 0);
    if (score) scored.push({ file, size, score });
  }

  scored.sort((a, b) => b.score - a.score || a.size - b.size);
  let bytes = 0;
  const selected = [...mandatory];
  for (const x of scored) {
    if (selected.includes(x.file)) continue;
    if (bytes + x.size > 55000) continue;
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

function extractPatch(text) {
  // Support ```diff, ```patch, ```git, and any trailing file specifiers on the code block declaration
  const fenced = [...text.matchAll(/```(?:diff|patch|git)[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (fenced.length) return fenced.join("\n") + "\n";

  // Fallback for raw diffs without fences: match standard git or unified diff prefixes
  const match = text.match(/(?:diff --git a\/|--- [ab]\/)/);
  if (!match) return "";
  return text.slice(match.index).split(/\n(?:PHASE_NOTES|RELEASE_LEDGER|VERIFICATION|CONTEXT_REQUEST):/i)[0].replace(/```\s*$/, "").trimEnd() + "\n";
}

function contextRequests(text, all) {
  // Accommodate optional bolding or header hashes around CONTEXT_REQUEST:
  const block = text.match(/(?:^|\n)[#* \t]*CONTEXT_REQUEST[* \t]*:\s*\n([\s\S]*?)(?:\n[#* \t]*[A-Z_]+[* \t]*:|$)/i)?.[1] ?? "";
  const wanted = block
    .split("\n")
    .map((x) => x.replace(/^[-* \t]+|[`'"]/g, "").replace(/\s*\(.*?\)/, "").trim())
    .filter(Boolean);
  return wanted.filter((x) => all.includes(x)).slice(0, 30);
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
  const initial = await chooseInitialFiles(spec);
  let paths = initial.files;
  let complete = false;
  let changed = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const pack = await makePack(phase, paths);
    const prompt = `${spec}

REPOSITORY PATH INVENTORY (request missing full files by exact path):
${initial.inventory}

CURRENT FULL-SOURCE REPOMIX SLICE:
${pack}

RESPONSE FORMAT REQUIREMENTS:
1. If required files are missing from the slice above, respond ONLY with:
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

    const estimatedTokens = tokenEstimate(prompt);
    if (estimatedTokens > manifest.hard_input_tokens) {
      throw new Error(`Micro-phase ${phase.phase} slice is ${estimatedTokens} estimated tokens, above ${manifest.hard_input_tokens}`);
    }

    console.log(`turn ${turn}: ~${estimatedTokens} input tokens, ${paths.length} files`);
    if (dryRun) {
      complete = true;
      break;
    }

    const out = await request(prompt, phase.phase, turn);
    const base = `.phase-runs/phase-${String(phase.phase).padStart(2, "0")}-turn-${turn}-${out.model.replace(/[^a-z0-9._-]/gi, "_")}`;
    await writeFile(new URL(`${base}.response.md`, import.meta.url), out.text);

    const requestedPaths = contextRequests(out.text, initial.inventory.split("\n"));
    if (requestedPaths.length) {
      console.log(`turn ${turn}: model requested ${requestedPaths.length} additional context files`);
      paths = [...new Set([...paths, ...requestedPaths])];
      continue;
    }

    const patch = extractPatch(out.text);
    if (patch) {
      const pp = `${base}.patch`;
      await writeFile(new URL(pp, import.meta.url), patch);
      await run("git", ["apply", "--check", "--whitespace=error-all", pp]);
      await run("git", ["apply", "--3way", "--whitespace=fix", pp]);
      changed = true;
    }

    const isComplete = /(?:^|\n)[#* \t]*PHASE_STATUS[* \t]*:\s*COMPLETE/i.test(out.text);
    if (isComplete) {
      complete = true;
      break;
    }

    if (!patch) {
      console.error(`\n=== UNEXPECTED MODEL OUTPUT (Phase ${phase.phase}, Turn ${turn}) ===\n${out.text}\n=======================================================\n`);
      throw new Error(`Phase ${phase.phase} returned neither a context request nor a patch`);
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
