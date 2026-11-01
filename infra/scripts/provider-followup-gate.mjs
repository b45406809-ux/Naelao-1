import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const providers = [
  { id: "gemini", envPrefix: "GEMINI" },
  { id: "groqcloud", envPrefix: "GROQ" },
];

function readReport(path) {
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function rankingCallsAllowed(report) {
  return Object.fromEntries(
    providers.map(({ id, envPrefix }) => {
      const result = report?.results?.find((item) => item.provider === id);
      return [
        `${envPrefix}_PLAN_CALLS_ALLOWED`,
        Boolean(
          result &&
            result.state === "completed" &&
            result.validResponseRate === 1 &&
            result.reason == null
        ),
      ];
    })
  );
}

export function planningCallsAllowed(previous, report) {
  return Object.fromEntries(
    providers.map(({ id, envPrefix }) => {
      const result = report?.providers?.find((item) => item.provider === id);
      return [
        `${envPrefix}_GOAL_CALLS_ALLOWED`,
        previous?.[`${envPrefix}_PLAN_CALLS_ALLOWED`] === "true" &&
          result?.state === "completed" &&
          result?.reason == null,
      ];
    })
  );
}

export function blackboardOnlyCallsAllowed(environment) {
  return Object.fromEntries(
    providers.map(({ envPrefix }) => {
      const keyText =
        environment[`${envPrefix}_API_KEYS`] ||
        environment[`${envPrefix}_API_KEY`] ||
        "";
      const hasKey = keyText.split(",").some((key) => key.trim().length > 0);
      const modelConfigured =
        envPrefix !== "GROQ" ||
        (typeof environment.GROQ_FREE_MODEL_ID === "string" &&
          environment.GROQ_FREE_MODEL_ID.trim().length > 0);
      return [
        `${envPrefix}_PLAN_CALLS_ALLOWED`,
        environment[`${envPrefix}_FREE_TIER_CONFIRMED`] === "true" &&
          hasKey &&
          modelConfigured,
      ];
    })
  );
}

function appendEnvironment(values, path) {
  if (!path) throw new Error("GITHUB_ENV is required");
  fs.appendFileSync(
    path,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`
  );
}

const stage = process.argv[2];
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  if (stage === "ranking") {
    appendEnvironment(
      rankingCallsAllowed(readReport(process.env.PROVIDER_SMOKE_REPORT)),
      process.env.GITHUB_ENV
    );
  } else if (stage === "blackboard-only") {
    appendEnvironment(
      blackboardOnlyCallsAllowed(process.env),
      process.env.GITHUB_ENV
    );
  } else if (stage === "planning") {
    appendEnvironment(
      planningCallsAllowed(
        process.env,
        readReport(process.env.BLACKBOARD_RANKING_REPORT)
      ),
      process.env.GITHUB_ENV
    );
  } else {
    throw new Error(
      "usage: node provider-followup-gate.mjs <ranking|blackboard-only|planning>"
    );
  }
}
