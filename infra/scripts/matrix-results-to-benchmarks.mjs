#!/usr/bin/env node
// Turn a completed capability-matrix run into the `axes` data for MODEL_BENCHMARKS.
//
// Why this exists rather than reading the numbers off a terminal and typing them in: the benchmark
// validator already rejects incoherent axis data ("7/5 passed"), which means hand-transcription is
// a known, anticipated failure mode. The fix for an anticipated transcription error is to not
// transcribe. This reads the real stored results and emits the exact TypeScript to paste.
//
// It also refuses to emit anything for a model whose run was dominated by agent errors — a pass
// that mostly failed to dispatch measured the infrastructure, not the model, and recording it as
// a capability score is the instrument-failure-as-result mistake in its final possible disguise.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node infra/scripts/matrix-results-to-benchmarks.mjs [--db <d1-database-id>]

import process from "node:process";

const DB = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : "f29714eb-28bd-4c76-895d-eb186e92a88f"; // naelao-platform

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (source .cf-credentials.local).");
  process.exit(1);
}

// Case index -> capability axis. Mirrors the ORDER of agent-capability-matrix.jsonl; the dataset's
// own first tag is the axis, and eval_results only stores case_index, so this is the join.
const AXIS_BY_INDEX = ["agency", "safety", "fabrication", "recovery", "proactivity", "synthesis"];

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }
  );
  const body = await res.json();
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.result[0].results;
}

// The trace grader writes "N of M checks passed" implicitly: score = passed/total*10. Recovering
// passed/total from a score alone is lossy, so parse the reason line, which lists each failure.
// A clean pass says "all trace checks passed".
function passedTotalFrom(row, totalChecks) {
  const reason = row.judge_reasoning ?? "";
  if (/all trace checks passed/i.test(reason)) return { passed: totalChecks, total: totalChecks };
  const failures = reason.split(";").map((s) => s.trim()).filter(Boolean).length;
  const passed = Math.max(0, totalChecks - failures);
  return { passed, total: totalChecks };
}

const CHECK_COUNTS = [5, 4, 2, 3, 3, 3]; // per case, from agent-capability-matrix.jsonl

async function main() {
  const suites = await d1(
    "SELECT id, name FROM eval_suites WHERE name LIKE ? ORDER BY name",
    ["capability-matrix-%"]
  );
  if (suites.length === 0) {
    console.error("No capability-matrix suites found — has the matrix run yet?");
    process.exit(2);
  }

  const out = [];
  for (const suite of suites) {
    const model = suite.name.replace(/^capability-matrix-/, "");
    const runs = await d1(
      "SELECT id, created_at FROM eval_runs WHERE suite_id = ? ORDER BY created_at DESC LIMIT 1",
      [suite.id]
    );
    if (runs.length === 0) { console.error(`  ${model}: no runs — skipped`); continue; }

    const rows = await d1(
      "SELECT case_index, score, judge_reasoning, actual_output FROM eval_results WHERE run_id = ? ORDER BY case_index",
      [runs[0].id]
    );
    const dispatchFailures = rows.filter((r) => (r.actual_output ?? "").includes("agent/run HTTP")).length;
    if (dispatchFailures > rows.length / 2) {
      console.error(`  ${model}: ${dispatchFailures}/${rows.length} cases never dispatched — REFUSING to record (measures infrastructure, not the model)`);
      continue;
    }

    const axes = {};
    for (const r of rows) {
      const axis = AXIS_BY_INDEX[r.case_index];
      if (!axis) continue;
      const { passed, total } = passedTotalFrom(r, CHECK_COUNTS[r.case_index] ?? 1);
      const note = /all trace checks passed/i.test(r.judge_reasoning ?? "")
        ? undefined
        : (r.judge_reasoning ?? "").slice(0, 140);
      axes[axis] = { passed, total, ...(note ? { note } : {}) };
    }
    out.push({ model, axes, cases: rows.length });
  }

  console.log("\n// ---- paste into MODEL_BENCHMARKS entries (the `axes` argument) ----");
  for (const entry of out) {
    console.log(`\n// ${entry.model}  (${entry.cases} cases)`);
    console.log(JSON.stringify(entry.axes, null, 2));
    const totalPassed = Object.values(entry.axes).reduce((a, r) => a + r.passed, 0);
    const totalChecks = Object.values(entry.axes).reduce((a, r) => a + r.total, 0);
    console.log(`// overall: ${totalPassed}/${totalChecks} checks passed`);
  }
  console.log("\n// -------------------------------------------------------------------");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
