#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const patchArgument = process.argv[2];
if (!patchArgument) {
  throw new Error(
    "Usage: node repomix/apply-batch-patch.mjs repomix/patches/batch-NN.patch"
  );
}

const patchPath = path.resolve(root, patchArgument);
const relativePatch = path.relative(root, patchPath).replaceAll(path.sep, "/");
const nameMatch = relativePatch.match(
  /^repomix\/patches\/batch-(\d{2})\.patch$/
);
if (!nameMatch) {
  throw new Error("Patch path must match repomix/patches/batch-NN.patch");
}
const batch = Number(nameMatch[1]);
if (!Number.isInteger(batch) || batch < 1 || batch > 13) {
  throw new Error("Batch number must be between 01 and 13");
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
}

function normalizePatch(source) {
  const fenced = source.match(/```diff\s*\n([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? source).replace(/^\uFEFF/, "").trim();
  const start = candidate.indexOf("diff --git ");
  if (start < 0) {
    throw new Error("The uploaded file does not contain a unified Git diff");
  }
  const normalized = candidate
    .slice(start)
    .replace(/```\s*$/, "")
    .trimEnd();
  const targets = [...normalized.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (targets.length === 0) throw new Error("The diff has no file targets");
  for (const [, before, after] of targets) {
    for (const target of [before, after]) {
      if (
        target.startsWith("/") ||
        target.split("/").includes("..") ||
        target === relativePatch ||
        target.startsWith("repomix/outputs/") ||
        target.startsWith(".repomix-cache/") ||
        target.startsWith(".git/")
      ) {
        throw new Error(`Patch contains a forbidden target: ${target}`);
      }
    }
  }
  return `${normalized}\n`;
}

const uploaded = await readFile(patchPath, "utf8");
const normalized = normalizePatch(uploaded);
await mkdir(path.join(root, ".repomix-cache"), { recursive: true });
const normalizedPath = path.join(
  root,
  ".repomix-cache",
  `batch-${String(batch).padStart(2, "0")}.normalized.patch`
);
await writeFile(normalizedPath, normalized);

run("git", ["apply", "--check", "--whitespace=error-all", normalizedPath]);
run("git", ["apply", "--whitespace=error-all", normalizedPath]);
run("node", ["repomix/build-prompts.mjs"]);
run("node", ["repomix/verify-configs.mjs"]);

const configs = (await readdir(path.join(root, "repomix")))
  .filter((name) => /^batch-\d{2}-.+\.json$/.test(name))
  .sort();
if (configs.length !== 13) {
  throw new Error(`Expected 13 batch configs, found ${configs.length}`);
}

const outputBatch = batch === 13 ? 13 : batch + 1;
const configName = configs[outputBatch - 1];
const configPath = `repomix/${configName}`;
const config = JSON.parse(await readFile(path.join(root, configPath), "utf8"));
await mkdir(path.dirname(path.join(root, config.output.filePath)), {
  recursive: true,
});
await rm(path.join(root, config.output.filePath), { force: true });
run("npx", [
  "--yes",
  "repomix@1.18.0",
  "--token-budget",
  "1000000",
  "--config",
  configPath,
]);

const handoff = {
  appliedBatch: batch,
  outputBatch,
  configPath,
  outputPath: config.output.filePath,
  promptPath: config.output.instructionFilePath,
};
await writeFile(
  path.join(root, ".repomix-cache", "batch-handoff.json"),
  `${JSON.stringify(handoff, null, 2)}\n`
);
console.log(`BATCH_HANDOFF=${JSON.stringify(handoff)}`);
