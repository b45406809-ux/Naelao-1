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
//       [--mode agent|text] \
//       [--models "@cf/openai/gpt-oss-120b,@cf/qwen/qwen3-30b-a3b-fp8"] \
//       [--datasets a.jsonl,b.jsonl]
//
// MODEL MATRIX: pass --models to score the SAME dataset across several candidate models in one
// invocation and print a comparison table. Each model is a separate eval run carrying a per-run
// model override, so nothing about the space's stored configuration is mutated to take the
// measurement. The regression gate below is skipped in matrix mode — comparing models against
// each other and gating one model against its own history are different questions, and conflating
// them would fire a "regression" every time the matrix simply reordered.
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
    else if (a === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (a === "--datasets") args.datasets = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
  }
  return args;
}

/** Right-pad for the comparison table. */
function pad(v, n) {
  const s = String(v);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(v, n) {
  const s = String(v);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
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
  if (!args.dataset && !args.datasets) {
    console.error("Required: --dataset <path> (or --datasets a,b) --name <suite-name> --space-id <id>");
    process.exit(2);
  }
  if (!args.name || !args.spaceId) {
    console.error("Required: --name <suite-name> --space-id <id>");
    process.exit(2);
  }
  if (args.mode === "agent" && !args.sessionId) {
    console.error("--session-id is required for --mode agent (the default)");
    process.exit(2);
  }

  if (args.models && args.models.length > 0) {
    await runMatrix(base, token, args);
    return;
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

/**
 * Score one or more datasets across several candidate models and print a comparison table.
 *
 * Reports four columns, not just a score, because a score alone hides the failure modes that
 * actually disqualify a model for agent work:
 *  - errors: runs that never produced an answer at all (a model that can't drive the tool loop
 *    fails here long before its answer quality matters).
 *  - judge: cases the JUDGE failed on. Excluded from the score by the worker, surfaced here so a
 *    broken instrument is visible rather than quietly shrinking the sample.
 *  - latency: an agent that takes 40s per turn is unusable in a chat surface regardless of score.
 */
async function runMatrix(base, token, args) {
  const datasets = args.datasets ?? [args.dataset];
  const rows = [];

  for (const dataset of datasets) {
    const cases = loadCases(dataset);
    const suiteName = datasets.length > 1 ? `${args.name}:${dataset.split("/").pop()}` : args.name;
    const suiteId = await findOrCreateSuite(base, token, suiteName, args.spaceId, cases);
    console.log(`\n=== ${dataset} (${cases.length} cases) — suite ${suiteId} ===`);

    for (const model of args.models) {
      process.stdout.write(`  ${model} … `);
      const startedAt = Date.now();
      let result;
      try {
        result = await apiFetch(base, token, `/evals/${suiteId}/run`, {
          method: "POST",
          body: JSON.stringify({
            mode: args.mode,
            ...(args.sessionId ? { session_id: args.sessionId } : {}),
            ...(args.agentId ? { agent_definition_id: args.agentId } : {}),
            model,
          }),
        });
      } catch (err) {
        // One model failing outright must not abandon the rest of the matrix — that IS a result.
        console.log(`FAILED (${err instanceof Error ? err.message : String(err)})`);
        rows.push({ dataset, model, score: null, errors: cases.length, judge: 0, latency: null, note: "run failed" });
        continue;
      }
      const wall = Date.now() - startedAt;
      console.log(`avg=${result.avg_score.toFixed(2)} errors=${result.agent_errors} judge_errors=${result.judge_errors} (${(wall / 1000).toFixed(1)}s)`);
      rows.push({
        dataset,
        model,
        score: result.avg_score,
        errors: result.agent_errors,
        judge: result.judge_errors,
        latency: result.avg_latency_ms,
        scored: result.scored_count,
        cases: result.case_count,
      });
    }
  }

  console.log(`\n${"=".repeat(100)}\nMODEL COMPARISON\n${"=".repeat(100)}`);
  console.log(`${pad("model", 46)} ${pad("dataset", 22)} ${padLeft("score", 6)} ${padLeft("err", 4)} ${padLeft("judge", 6)} ${padLeft("ms/case", 8)}`);
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(
      `${pad(r.model, 46)} ${pad((r.dataset ?? "").split("/").pop() ?? "", 22)} ` +
        `${padLeft(r.score === null ? "—" : r.score.toFixed(2), 6)} ${padLeft(r.errors, 4)} ` +
        `${padLeft(r.judge, 6)} ${padLeft(r.latency === null ? "—" : r.latency, 8)}`
    );
  }

  // Aggregate across datasets so a model that is good at one thing and useless at another can't
  // win on a single strong dataset.
  const byModel = new Map();
  for (const r of rows) {
    const agg = byModel.get(r.model) ?? { score: 0, n: 0, errors: 0, judge: 0, latency: 0, latencyN: 0 };
    if (r.score !== null) { agg.score += r.score; agg.n++; }
    agg.errors += r.errors;
    agg.judge += r.judge;
    if (r.latency !== null && r.latency !== undefined) { agg.latency += r.latency; agg.latencyN++; }
    byModel.set(r.model, agg);
  }
  const overall = [...byModel.entries()]
    .map(([model, a]) => ({
      model,
      score: a.n > 0 ? a.score / a.n : null,
      errors: a.errors,
      judge: a.judge,
      latency: a.latencyN > 0 ? Math.round(a.latency / a.latencyN) : null,
    }))
    // Errors first: a model that cannot complete runs is disqualified regardless of how the
    // cases it DID finish were scored.
    .sort((x, y) => x.errors - y.errors || (y.score ?? -1) - (x.score ?? -1));

  console.log(`\n${"=".repeat(100)}\nOVERALL (averaged across datasets, ranked by errors then score)\n${"=".repeat(100)}`);
  console.log(`${pad("model", 46)} ${padLeft("score", 6)} ${padLeft("err", 4)} ${padLeft("judge", 6)} ${padLeft("ms/case", 8)}`);
  console.log("-".repeat(100));
  for (const r of overall) {
    console.log(
      `${pad(r.model, 46)} ${padLeft(r.score === null ? "—" : r.score.toFixed(2), 6)} ` +
        `${padLeft(r.errors, 4)} ${padLeft(r.judge, 6)} ${padLeft(r.latency === null ? "—" : r.latency, 8)}`
    );
  }

  console.log(`\nJSON: ${JSON.stringify({ rows, overall })}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
