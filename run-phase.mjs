#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  childEnvironmentWithoutProviderSecrets,
  parseGeneratedPatchPaths,
  readBoundedResponseText,
} from "./infra/scripts/phase-runner-safety.mjs";

const exec = promisify(execFile);
const ROOT = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const start = Number(args.get("--start") ?? process.env.PHASE_START ?? 1);
const end = Number(args.get("--end") ?? process.env.PHASE_END ?? 13);
const maxTurns = Number(
  args.get("--max-turns") ?? process.env.MAX_TURNS_PER_PHASE ?? 8
);
const dryRun = process.argv.includes("--dry-run");
const changedPaths = new Set();
const apiKeys = [...new Set((
  process.env.GEMINI_API_KEYS ??
  process.env.GEMINI_API_KEY ??
  ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean))];
const models = [...new Set((
  args.get("--models") ??
  process.env.AI_MODELS ??
  "gemini-2.5-flash,gemini-2.5-flash-lite"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean))];

if (
  !Number.isInteger(start) ||
  !Number.isInteger(end) ||
  start < 1 ||
  end > 13 ||
  start > end
) {
  throw new Error(
    "--start and --end must select an inclusive range between 1 and 13"
  );
}
if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 16) {
  throw new Error("--max-turns must be an integer between 1 and 16");
}
if (!dryRun && apiKeys.length === 0)
  throw new Error("Set GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY");
if (models.length === 0) throw new Error("At least one AI model is required");
if (apiKeys.length > 8) throw new Error("At most 8 Gemini API keys may be configured");
if (models.length > 8) throw new Error("At most 8 Gemini models may be configured");
if (models.some((model) => !/^[A-Za-z0-9._-]{1,100}$/.test(model))) {
  throw new Error("Model names may contain only letters, numbers, dots, underscores, and hyphens");
}

const configs = (await readdir(new URL("repomix/", import.meta.url)))
  .filter((name) => /^batch-\d{2}-.+\.json$/.test(name))
  .sort();
if (configs.length !== 13)
  throw new Error(`Expected 13 Repomix configs, found ${configs.length}`);
if (!dryRun) {
  const status = await exec("git", ["status", "--porcelain"], {
    cwd: ROOT,
    env: childEnvironmentWithoutProviderSecrets(),
  });
  if (status.stdout.trim()) {
    throw new Error("Refusing to apply generated patches while the working tree is not clean");
  }
}
await mkdir(new URL(".phase-runs/", import.meta.url), { recursive: true });

async function run(command, commandArgs, options = {}) {
  const result = await exec(command, commandArgs, {
    cwd: ROOT,
    env: childEnvironmentWithoutProviderSecrets(),
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function generatePack(configName) {
  await run("npx", [
    "--yes",
    "repomix@1.18.0",
    "--token-budget",
    "1000000",
    "--config",
    `repomix/${configName}`,
    "--quiet",
  ]);
  const config = JSON.parse(
    await readFile(new URL(`repomix/${configName}`, import.meta.url), "utf8")
  );
  return readFile(new URL(config.output.filePath, import.meta.url), "utf8");
}

function extractPatch(text) {
  const fenced = [...text.matchAll(/```diff\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (fenced.length) return `${fenced.join("\n")}\n`;
  const startIndex = text.indexOf("diff --git ");
  if (startIndex < 0) return "";
  const tail = text.slice(startIndex);
  const notes = tail.search(/\n(?:PHASE_NOTES|RELEASE_LEDGER|VERIFICATION):/);
  return `${(notes < 0 ? tail : tail.slice(0, notes)).replace(/```\s*$/, "").trimEnd()}\n`;
}

function statusOf(text) {
  // Manual-compatible prompts intentionally return only a raw diff. API responses
  // may still opt into another turn with the legacy PHASE_STATUS marker.
  return (
    text.match(/^PHASE_STATUS:\s*(CONTINUE|COMPLETE)\s*$/im)?.[1] ?? "COMPLETE"
  );
}

async function requestModel(prompt, phase, turn) {
  const combinations = apiKeys.flatMap((key) =>
    models.map((model) => ({ key, model }))
  );
  let lastError;
  const maxAttempts = Math.min(combinations.length * 2, 32);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const selected =
      combinations[(phase + turn + attempt) % combinations.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selected.model)}:generateContent`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": selected.key,
        },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 65_536 },
        }),
      });
      if (!response.ok) {
        const detail = await readBoundedResponseText(response, 64 * 1024);
        lastError = new Error(
          `${selected.model} returned ${response.status}: ${detail.slice(0, 2_000)}`
        );
        if (![408, 429, 500, 502, 503, 504].includes(response.status))
          throw lastError;
      } else {
        const body = JSON.parse(await readBoundedResponseText(response, 8 * 1024 * 1024));
        const text =
          body.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? "")
            .join("") ?? "";
        if (!text) throw new Error(`${selected.model} returned no text`);
        return { model: selected.model, text };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2 ** Math.min(attempt, 4) * 250, 4_000))
    );
  }
  throw lastError ?? new Error("All model/key rotations failed");
}

async function applyPatch(patchPath) {
  const contents = await readFile(new URL(patchPath, import.meta.url), "utf8");
  const paths = parseGeneratedPatchPaths(contents, ROOT);
  await run("git", ["apply", "--check", "--whitespace=error-all", patchPath]);
  await run("git", ["apply", "--3way", "--whitespace=fix", patchPath]);
  for (const target of paths) changedPaths.add(target);
}

async function verify() {
  await run("pnpm", ["typecheck"]);
  await run("pnpm", ["test"]);
}

for (let phase = start; phase <= end; phase++) {
  const configName = configs[phase - 1];
  console.log(`\n===== PHASE ${phase}/13: ${configName} =====`);
  if (dryRun) {
    const pack = await generatePack(configName);
    console.log(
      `Dry run generated ${pack.length.toLocaleString()} characters.`
    );
    continue;
  }

  let changed = false;
  let complete = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const pack = await generatePack(configName);
    const continuation =
      turn === 1
        ? "Implement the complete phase now."
        : "Continue this same phase from the updated accumulator branch. Re-audit every numbered item and finish all remaining production and verification boundaries.";
    const { model, text } = await requestModel(
      `${pack}\n\n${continuation}`,
      phase,
      turn
    );
    const base = `.phase-runs/phase-${String(phase).padStart(2, "0")}-turn-${turn}-${model.replace(/[^a-z0-9._-]/gi, "_")}`;
    await writeFile(new URL(`${base}.response.md`, import.meta.url), text);
    const patch = extractPatch(text);
    if (patch) {
      const patchPath = `${base}.patch`;
      await writeFile(new URL(patchPath, import.meta.url), patch);
      await applyPatch(patchPath);
      changed = true;
    }
    if (statusOf(text) === "COMPLETE") {
      complete = true;
      break;
    }
    if (!patch)
      throw new Error(
        `Phase ${phase} turn ${turn} requested continuation without an apply-ready diff`
      );
  }
  if (!complete)
    throw new Error(`Phase ${phase} did not complete in ${maxTurns} turns`);
  if (!changed)
    console.log(`Phase ${phase} reported complete with no repository changes.`);
  await verify();
  const status = await exec("git", ["status", "--porcelain"], {
    cwd: ROOT,
    env: childEnvironmentWithoutProviderSecrets(),
  });
  if (changedPaths.size > 0) {
    await run("git", ["add", "-A", "--", ...changedPaths]);
    const staged = await exec("git", ["diff", "--cached", "--name-only"], {
      cwd: ROOT,
      env: childEnvironmentWithoutProviderSecrets(),
    });
    if (!staged.stdout.trim()) continue;
    await run("git", [
      "commit",
      "-m",
      `feat(plan): complete AI implementation phase ${phase}`,
    ]);
  } else if (status.stdout.trim()) {
    throw new Error("Patch application left repository changes outside the validated patch paths");
  }
}

console.log(`\nCompleted phases ${start}-${end}.`);
