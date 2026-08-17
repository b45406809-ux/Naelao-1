import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Regression guard for a real, live-confirmed production bug: workers/agents declared
// `PLATFORM_DB: D1Database` on its Env interface and used it in 31 places (agent/run's model +
// space lookup, bootstrap/complete, channel inbound, connector webhooks, template resolution),
// but wrangler.toml had NO [[d1_databases]] block at all. On the deployed worker
// `c.env.PLATFORM_DB` was therefore `undefined`, and every one of those routes threw
// "Cannot read properties of undefined (reading 'prepare')".
//
// TypeScript cannot catch this: wrangler.toml is never typechecked against the Env interface, so
// the binding looks present at compile time and is missing at runtime. It stayed hidden because a
// separate PLATFORM_SECRET mismatch made every router-proxied request 401 before it could reach
// the code — the auth failure masked the binding failure.
//
// Sibling of wrangler-vars-parity.test.ts, which guards the vars-replacement bug class.

const WORKERS_DIR = join(process.cwd(), "workers");

/** Bindings that are D1 databases in this codebase, by convention. Keyed by the binding NAME the
 *  code refers to, since that is what `c.env.X` resolves against. */
const D1_BINDINGS = ["PLATFORM_DB"] as const;

function workerDirs(): string[] {
  return readdirSync(WORKERS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(WORKERS_DIR, n, "wrangler.toml")));
}

/** Every .ts file under a worker's src/, read as one blob. Cheap enough at this repo's size and
 *  far more robust than trying to parse imports. */
function readWorkerSource(dir: string): string {
  const src = join(WORKERS_DIR, dir, "src");
  if (!existsSync(src)) return "";
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(src);
  return out.join("\n");
}

describe("wrangler.toml declares every binding the worker's code actually uses", () => {
  for (const binding of D1_BINDINGS) {
    for (const dir of workerDirs()) {
      const source = readWorkerSource(dir);
      // `env.PLATFORM_DB` / `c.env.PLATFORM_DB` — a real runtime use, not just a type declaration
      // or a comment mentioning the name.
      const usesAtRuntime = new RegExp(`env\\.${binding}\\b`).test(source);
      if (!usesAtRuntime) continue;

      it(`workers/${dir} uses env.${binding} at runtime, so wrangler.toml must bind it`, () => {
        const toml = readFileSync(join(WORKERS_DIR, dir, "wrangler.toml"), "utf8");
        expect(
          toml.includes(`binding = "${binding}"`),
          `workers/${dir}/src uses c.env.${binding} but workers/${dir}/wrangler.toml never binds it — ` +
            `it will be undefined on the deployed worker and throw at the first use.`
        ).toBe(true);
      });
    }
  }

  it("covers workers/agents specifically — the worker this bug was found on", () => {
    const source = readWorkerSource("agents");
    expect(/env\.PLATFORM_DB\b/.test(source)).toBe(true);
    const toml = readFileSync(join(WORKERS_DIR, "agents", "wrangler.toml"), "utf8");
    expect(toml).toContain('binding = "PLATFORM_DB"');
    // And it must point at the real platform database, not a placeholder.
    expect(toml).toContain('database_name = "naelao-platform"');
  });
});
