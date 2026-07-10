import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Regression guard for a real, previously-undetected bug class: wrangler does NOT merge a
// named environment's `vars` table with the top-level `[vars]` block — it REPLACES it entirely.
// `[env.production] vars = { ENVIRONMENT = "production" }` silently drops every other
// top-level var for that deploy. This bit workers/agents concretely: NAELAO_ACCOUNT_ID/
// NAELAO_GATEWAY_ID (the Cloudflare AI Gateway wiring) were declared at the top level but
// missing from [env.staging]/[env.production], so the gateway never activated in any real
// deployment — always silently fell back to the direct Anthropic API. The same shape of bug
// was found (and fixed) in workers/analytics, billing, eval, and security-gateway too.
//
// This test parses every workers/*/wrangler.toml with a small regex-based extractor (no TOML
// dependency needed — these files are flat enough) and asserts: whenever a named environment
// declares its own inline `vars = {...}` table at all, it must carry forward every key the
// top-level `[vars]` block declares. A worker with no [env.staging]/[env.production] vars
// override, or no top-level [vars] at all, is not applicable and skipped.

function extractSection(content: string, startMarker: string): string | null {
  const start = content.indexOf(startMarker);
  if (start === -1) return null;
  const afterStart = start + startMarker.length;
  const nextSection = content.indexOf("\n[", afterStart);
  return content.slice(afterStart, nextSection === -1 ? undefined : nextSection);
}

function extractTopLevelVarsKeys(content: string): string[] {
  const section = extractSection(content, "\n[vars]\n") ?? extractSection(content, "[vars]\n");
  if (!section) return [];
  const keys: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (m) keys.push(m[1]!);
  }
  return keys;
}

function extractEnvVarsKeys(content: string, envHeader: string): string[] | null {
  const envStart = content.indexOf(envHeader);
  if (envStart === -1) return null;
  const nextTopSection = content.indexOf("\n[env.", envStart + envHeader.length);
  const nextAnySection = content.indexOf("\n[[", envStart + envHeader.length);
  let end = content.length;
  if (nextTopSection !== -1) end = Math.min(end, nextTopSection);
  if (nextAnySection !== -1) end = Math.min(end, nextAnySection);
  const block = content.slice(envStart, end);
  const varsLineMatch = /vars\s*=\s*\{([^}]*)\}/.exec(block);
  if (!varsLineMatch) return null; // this env doesn't override vars at all — nothing to shadow
  const inner = varsLineMatch[1]!;
  const keys: string[] = [];
  for (const part of inner.split(",")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(part);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

const workersDir = join(__dirname, "../../workers");
const workerNames = readdirSync(workersDir).filter((name) =>
  existsSync(join(workersDir, name, "wrangler.toml"))
);

describe("wrangler.toml — [env.X].vars must carry forward every top-level [vars] key", () => {
  it("found at least one worker with a wrangler.toml to check (sanity check the test itself runs)", () => {
    expect(workerNames.length).toBeGreaterThan(5);
  });

  // F-13: the prod/staging deploy workflows select an environment with --env=<name>. A worker
  // that declares a top-level ENVIRONMENT var but NO [env.production] block deploys the top-level
  // config (ENVIRONMENT="development") to production. (workers/auth was exactly this gap.) Assert
  // every worker that sets ENVIRONMENT at the top level also defines both named-env blocks.
  for (const name of workerNames) {
    const path = join(workersDir, name, "wrangler.toml");
    const content = readFileSync(path, "utf8");
    if (!extractTopLevelVarsKeys(content).includes("ENVIRONMENT")) continue;
    it(`workers/${name}: declares [env.staging] and [env.production] (F-13)`, () => {
      expect(content).toContain("[env.staging]");
      expect(content).toContain("[env.production]");
    });
  }

  for (const name of workerNames) {
    const path = join(workersDir, name, "wrangler.toml");
    const content = readFileSync(path, "utf8");
    const topKeys = extractTopLevelVarsKeys(content);
    if (topKeys.length === 0) continue; // nothing declared at top level — nothing to shadow

    for (const envHeader of ["\n[env.staging]", "\n[env.production]"]) {
      const envKeys = extractEnvVarsKeys(content, envHeader);
      if (envKeys === null) continue; // this env has no vars override — inherits nothing to break

      const envLabel = envHeader.trim().replace(/[[\]]/g, "");
      it(`workers/${name}: ${envLabel} carries forward every top-level var`, () => {
        const missing = topKeys.filter((k) => !envKeys.includes(k));
        expect(missing, `${envLabel} in workers/${name}/wrangler.toml is missing top-level vars: ${missing.join(", ")}`).toEqual([]);
      });
    }
  }
});
