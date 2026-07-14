#!/usr/bin/env node
// §A1 Harness Excellence Phase HX3 — benchmark runner + regression gate.
//
// Runs a golden JSONL dataset (tests/eval-datasets/*.jsonl) as a real eval suite against a
// deployed environment: creates the suite (or reuses an existing one by name), runs it in
// mode="agent" (a REAL /agent/run per case, not just judging the raw case text), then diffs the
// resulting avg_score against the suite's own last stored result and exits non-zero if the score
// regressed beyond --threshold. Manual dispatch only (costs real tokens) — not wired into CI.
//
// Usage:
//   NAELAO_API_BASE=https://api.naelao.com/v1 NAELAO_TENANT_TOKEN=... \
//     node infra/scripts/run-eval-suite.mjs \
//       --dataset tests/eval-datasets/commerce-business-ops.jsonl \
//       --name "commerce-business-ops" \
//       --space-id <eval-space-id> \
//       --session-id <eval-session-id> \
//       [--agent-id <agent_definition_id>] \
//       [--threshold 0.5] \
//       [--mode agent|text]
//
// Auth: NAELAO_API_BASE is naelao-router's public base URL (e.g. https://api.naelao.com/v1);
// NAELAO_TENANT_TOKEN is a Bearer JWT for a tenant that owns --space-id, exactly like any other
// authenticated API caller — this script does NOT bypass auth or call any worker directly.

import { readFileSync } from "node:fs";
import process from "node:process";

function parseArgs(argv) {
  const args = { threshold: 0.5, mode: "agent" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--space-id") args.spaceId = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
    else if (a === "--agent-id") args.agentId = argv[++i];
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--mode") args.mode = argv[++i];
  }
  return args;
}

function loadCases(path) {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function apiFetch(base, token, path, init = {}) {
  const resp = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

async function findOrCreateSuite(base, token, name, spaceId, cases) {
  const list = await apiFetch(base, token, `/evals?space_id=${encodeURIComponent(spaceId)}`);
  const existing = (list.data ?? []).find((s) => s.name === name);
  if (existing) return existing.id;
  const created = await apiFetch(base, token, "/evals", {
    method: "POST",
    body: JSON.stringify({ name, space_id: spaceId, cases }),
  });
  return created.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = process.env.NAELAO_API_BASE;
  const token = process.env.NAELAO_TENANT_TOKEN;
  if (!base || !token) {
    console.error("Set NAELAO_API_BASE and NAELAO_TENANT_TOKEN env vars.");
    process.exit(2);
  }
  if (!args.dataset || !args.name || !args.spaceId) {
    console.error("Required: --dataset <path> --name <suite-name> --space-id <id>");
    process.exit(2);
  }
  if (args.mode === "agent" && !args.sessionId) {
    console.error("--session-id is required for --mode agent (the default)");
    process.exit(2);
  }

  const cases = loadCases(args.dataset);
  console.log(`Loaded ${cases.length} cases from ${args.dataset}`);

  const suiteId = await findOrCreateSuite(base, token, args.name, args.spaceId, cases);
  console.log(`Eval suite: ${suiteId}`);

  // Read the suite's last stored result BEFORE running again, so the diff is against the prior
  // run, not the one we're about to create.
  const priorResults = await apiFetch(base, token, `/evals/${suiteId}/results`);
  const priorScore = priorResults.data?.[0]?.avg_score ?? null;

  const runBody = {
    mode: args.mode,
    ...(args.sessionId ? { session_id: args.sessionId } : {}),
    ...(args.agentId ? { agent_definition_id: args.agentId } : {}),
  };
  const runResult = await apiFetch(base, token, `/evals/${suiteId}/run`, {
    method: "POST",
    body: JSON.stringify(runBody),
  });

  console.log(`\nRun ${runResult.run_id} (mode=${runResult.mode}) — avg_score=${runResult.avg_score.toFixed(2)}`);
  for (const r of runResult.results) {
    const label = r.agent_error ? `ERROR: ${r.agent_error}` : `score=${r.score} (correctness=${r.correctness}, semantic_validity=${r.semantic_validity})`;
    console.log(`  case[${r.case_index}] ${label}`);
  }

  if (priorScore === null) {
    console.log(`\nNo prior result to diff against — this is the first recorded run.`);
    process.exit(0);
  }

  const delta = runResult.avg_score - priorScore;
  console.log(`\nPrior avg_score=${priorScore.toFixed(2)}  →  current=${runResult.avg_score.toFixed(2)}  (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`);

  if (delta < -args.threshold) {
    console.error(`REGRESSION: score dropped by more than --threshold ${args.threshold}`);
    process.exit(1);
  }
  console.log("No regression beyond threshold.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
