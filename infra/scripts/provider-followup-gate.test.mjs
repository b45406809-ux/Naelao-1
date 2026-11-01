import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  planningCallsAllowed,
  rankingCallsAllowed,
} from "./provider-followup-gate.mjs";

test("ranking-stage gate admits only fully valid provider smoke results", () => {
  const allowed = rankingCallsAllowed({
    results: [
      {
        provider: "gemini",
        state: "completed",
        validResponseRate: 1,
        reason: null,
      },
      {
        provider: "groqcloud",
        state: "partial_stopped_on_quota",
        validResponseRate: 1,
        reason: "quota_or_rate_limited",
      },
    ],
  });
  assert.deepEqual(allowed, {
    GEMINI_PLAN_CALLS_ALLOWED: true,
    GROQ_PLAN_CALLS_ALLOWED: false,
  });
});

test("missing or incomplete smoke report fails closed", () => {
  assert.deepEqual(rankingCallsAllowed(null), {
    GEMINI_PLAN_CALLS_ALLOWED: false,
    GROQ_PLAN_CALLS_ALLOWED: false,
  });
});

test("planning-stage gate blocks providers that rate-limited during ranking", () => {
  const allowed = planningCallsAllowed(
    {
      GEMINI_PLAN_CALLS_ALLOWED: "true",
      GROQ_PLAN_CALLS_ALLOWED: "true",
    },
    {
      providers: [
        { provider: "gemini", state: "completed", reason: undefined },
        {
          provider: "groqcloud",
          state: "failed",
          reason: "quota_or_rate_limited:429",
        },
      ],
    }
  );
  assert.deepEqual(allowed, {
    GEMINI_GOAL_CALLS_ALLOWED: true,
    GROQ_GOAL_CALLS_ALLOWED: false,
  });
});

test("planning-stage gate fails closed when the prior gate or ranking report is missing", () => {
  assert.deepEqual(planningCallsAllowed({}, null), {
    GEMINI_GOAL_CALLS_ALLOWED: false,
    GROQ_GOAL_CALLS_ALLOWED: false,
  });
});

test("CLI carries fail-closed gates between GitHub Actions steps", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "naelao-provider-gate-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, "github-env");
  const smokeReport = path.join(directory, "smoke.json");
  const rankingReport = path.join(directory, "ranking.json");
  const scriptPath = fileURLToPath(
    new URL("./provider-followup-gate.mjs", import.meta.url)
  );

  fs.writeFileSync(
    smokeReport,
    JSON.stringify({
      results: [
        {
          provider: "gemini",
          state: "completed",
          validResponseRate: 1,
          reason: null,
        },
        {
          provider: "groqcloud",
          state: "partial_stopped_on_quota",
          validResponseRate: 1,
          reason: "quota",
        },
      ],
    })
  );
  execFileSync(process.execPath, [scriptPath, "ranking"], {
    env: {
      ...process.env,
      GITHUB_ENV: environmentFile,
      PROVIDER_SMOKE_REPORT: smokeReport,
    },
  });
  assert.match(
    fs.readFileSync(environmentFile, "utf8"),
    /GEMINI_PLAN_CALLS_ALLOWED=true/
  );
  assert.match(
    fs.readFileSync(environmentFile, "utf8"),
    /GROQ_PLAN_CALLS_ALLOWED=false/
  );

  fs.writeFileSync(
    rankingReport,
    JSON.stringify({
      providers: [
        { provider: "gemini", state: "completed" },
        {
          provider: "groqcloud",
          state: "failed",
          reason: "quota_or_rate_limited:429",
        },
      ],
    })
  );
  execFileSync(process.execPath, [scriptPath, "planning"], {
    env: {
      ...process.env,
      GITHUB_ENV: environmentFile,
      BLACKBOARD_RANKING_REPORT: rankingReport,
      GEMINI_PLAN_CALLS_ALLOWED: "true",
      GROQ_PLAN_CALLS_ALLOWED: "false",
    },
  });
  const output = fs.readFileSync(environmentFile, "utf8");
  assert.match(output, /GEMINI_GOAL_CALLS_ALLOWED=true/);
  assert.match(output, /GROQ_GOAL_CALLS_ALLOWED=false/);
});
