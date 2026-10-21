import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const workerDir = join(root, "workers");
const manifests = readdirSync(workerDir).filter((name) => existsSync(join(workerDir, name, "wrangler.toml"))).sort();

function explicitManifestWorkers(workflow: string): string[] {
  return [...workflow.matchAll(/workers\/([a-z0-9-]+)\/wrangler\.toml/g)].map((match) => match[1] ?? "");
}

function loopWorkers(workflow: string, variable: "w" | "WORKERS"): string[] {
  const expression = variable === "w"
    ? /for w in ([^;\n]+); do/g
    : /WORKERS=\(([^)]+)\)/g;
  return [...workflow.matchAll(expression)].flatMap((match) => (match[1] ?? "").split(/[\s\\]+/).filter(Boolean));
}

describe("worker deployment coverage", () => {
  const staging = readFileSync(join(root, ".github/workflows/deploy-staging.yml"), "utf8");
  const production = readFileSync(join(root, ".github/workflows/deploy-prod.yml"), "utf8");

  it("deploys every Wrangler worker manifest to staging", () => {
    const deployed = new Set([...explicitManifestWorkers(staging), ...loopWorkers(staging, "w")]);
    expect([...deployed].sort()).toEqual(manifests);
  });

  it("deploys every Wrangler worker manifest to production", () => {
    const deployed = new Set(loopWorkers(production, "WORKERS"));
    expect([...deployed].sort()).toEqual(manifests);
  });
});
