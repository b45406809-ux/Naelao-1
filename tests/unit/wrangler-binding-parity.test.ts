import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const WORKERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workers");

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

function getTableEntries(toml: string, table: string): string[] {
  const lines = toml.split(/\r?\n/);
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/)?.[1];
    if (header !== undefined) {
      if (current) entries.push(current.join("\n"));
      current = header === table ? [line] : null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) entries.push(current.join("\n"));
  return entries;
}

function entryIdentity(entry: string): string | null {
  const binding = entry.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1];
  if (binding) return `binding:${binding}`;
  const queue = entry.match(/^\s*queue\s*=\s*"([^"]+)"/m)?.[1];
  if (queue) return `queue:${queue}`;
  const name = entry.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  const className = entry.match(/^\s*class_name\s*=\s*"([^"]+)"/m)?.[1];
  return name && className ? `class:${name}:${className}` : null;
}

function resourceTables(toml: string): string[] {
  return [...toml.matchAll(/^\s*\[\[([^\]]+)\]\]\s*$/gm)]
    .map((match) => match[1]!)
    .filter((table) => !table.startsWith("env.") && table !== "migrations");
}

function regularBindingTables(toml: string): string[] {
  return [...toml.matchAll(/^\[([^\]]+)\]\s*$/gm)]
    .map((match) => match[1]!)
    .filter((table) => !table.startsWith("env.") && table !== "vars")
    .filter((table) => getTableEntries(toml, table).some((entry) => entryIdentity(entry)));
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

  it.each(workerDirs())("preserves top-level resource bindings in staging and production for %s", (dir) => {
    const toml = readFileSync(join(WORKERS_DIR, dir, "wrangler.toml"), "utf8");
    const tables = [...new Set(resourceTables(toml))];
    for (const environment of ["staging", "production"]) {
      for (const table of tables) {
        const expected = getTableEntries(toml, table)
          .map(entryIdentity)
          .filter((identity): identity is string => identity !== null);
        const configured = new Set(
          getTableEntries(toml, `env.${environment}.${table}`).map(entryIdentity)
        );
        for (const identity of expected) {
          expect(
            configured.has(identity),
            `workers/${dir}/wrangler.toml drops ${identity} from env.${environment}.${table}`
          ).toBe(true);
        }
      }
      for (const table of regularBindingTables(toml)) {
        const expected = getTableEntries(toml, table).map(entryIdentity).filter(Boolean);
        const configured = getTableEntries(toml, `env.${environment}.${table}`).map(entryIdentity);
        for (const identity of expected) {
          expect(
            configured,
            `workers/${dir}/wrangler.toml drops ${identity} from env.${environment}.${table}`
          ).toContain(identity);
        }
      }
    }

    const browserBinding = toml.match(/^browser\s*=\s*\{\s*binding\s*=\s*"([^"]+)"/m)?.[1];
    if (browserBinding) {
      for (const environment of ["staging", "production"]) {
        expect(toml).toMatch(
          new RegExp(`^\\[env\\.${environment}\\][\\s\\S]*?^browser\\s*=\\s*\\{\\s*binding\\s*=\\s*"${browserBinding}"`, "m")
        );
      }
    }
  });
});
