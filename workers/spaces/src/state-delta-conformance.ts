import { compileDynamicCode } from "../../agents/src/script-engine/dynamic-code.js";
import type { SpaceBlueprint } from "@naelao/agent-sdk";
import { parseArtifactLinters } from "@naelao/agent-sdk";
import type { StateDeltaConformanceReport } from "@naelao/security";
import type { WorkerLoaderBinding } from "../../agents/src/script-engine/code-runner.js";
import type { FixtureSeed, StateAssertion } from "./conformance-state.js";

export interface StateDeltaFixture {
  id: string; projectIndex: number; input: unknown; seed: FixtureSeed;
  assertions: StateAssertion[]; expectedFiles: Record<string, string>;
}
export interface StateDeltaSuite { fixtures: StateDeltaFixture[] }
interface Environment { LOADER?: WorkerLoaderBinding; CONFORMANCE_SANDBOX_DO?: DurableObjectNamespace }
interface StateFactory { (options: { props: { sandboxId: string } }): Fetcher }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const HARNESS = `import { run } from './subject.js';
export default { async fetch(request, env) {
 const { input } = await request.json();
 const rpc = async (path, body) => { const response = await env.STATE.fetch('http://state'+path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); if(!response.ok) throw new Error('fixture_capability_failed'); return response.json(); };
 const ctx = { input, args: {input}, sql: { exec: async (sql,...args) => (await rpc('/sql',{sql,args})).rows }, files: { read: async path => (await rpc('/files/read',{path})).content, write: async (path,content) => rpc('/files/write',{path,content}), validate: async (path,content) => (await rpc('/files/validate',{path,content})).diagnostics } };
 await run(ctx); return new Response('{}');
} };`;

/** The entry is read from the exact project file that the published blueprint installs. */
export async function runStateDeltaFixture(env: Environment, stateFactory: StateFactory, blueprint: SpaceBlueprint, fixture: StateDeltaFixture): Promise<void> {
  if (!env.LOADER || !env.CONFORMANCE_SANDBOX_DO) throw new Error("conformance_runtime_unavailable");
  const project = blueprint.projects[fixture.projectIndex];
  const entry = project?.configuration?.conformance_entry;
  const source = typeof entry === "string" ? project?.starterFiles.find(file => file.path === entry)?.content : undefined;
  if (!source || !/\.(?:js|ts)$/.test(String(entry))) throw new Error("installed_conformance_entry_required");
  const compiled = await compileDynamicCode(source, String(entry).endsWith(".ts") ? "typescript" : "javascript");
  const sandboxId = env.CONFORMANCE_SANDBOX_DO.newUniqueId(); const sandbox = env.CONFORMANCE_SANDBOX_DO.get(sandboxId);
  const call = (path: string, body: unknown) => sandbox.fetch(new Request(`http://sandbox${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  try {
    const prepared = await call("/prepare", { ...fixture.seed, artifactLinters: parseArtifactLinters(project?.configuration?.artifactLinters) }); if (!prepared.ok) throw new Error("fixture_prepare_failed");
    const worker = env.LOADER.load ? env.LOADER.load({ compatibilityDate: "2026-10-01", mainModule: "harness.js", modules: { "harness.js": HARNESS, "subject.js": compiled.javascript }, globalOutbound: null, limits: { cpuMs: 100, subRequests: 64 }, env: { STATE: stateFactory({ props: { sandboxId: sandboxId.toString() } }) } }) : undefined;
    if (!worker) throw new Error("fresh_worker_loader_required");
    const response = await worker.getEntrypoint().fetch(new Request("http://fixture/run", { method: "POST", body: JSON.stringify({ input: fixture.input }), signal: AbortSignal.timeout(3000) }));
    if (!response.ok) throw new Error("worker_execution_failed");
    // Submitted output is ignored. Only the independent host database/file snapshots count.
    await response.body?.cancel();
    const oracleResponse = await call("/assert", { assertions: fixture.assertions });
    if (!oracleResponse.ok) throw new Error("oracle_failed");
    const oracle = await oracleResponse.json<{ rows: unknown[][]; files: Record<string, string>; budget: { rows_written: number; failures: number } }>();
    if (oracle.budget.failures) throw new Error("fixture_capability_violation");
    if (oracle.budget.rows_written > 10000) throw new Error("fixture_write_budget_exceeded");
    if (stable(oracle.rows) !== stable(fixture.assertions.map(assertion => assertion.rows)) || stable(oracle.files) !== stable(fixture.expectedFiles)) throw new Error("state_delta_mismatch");
  } finally { await call("/cleanup", {}); }
}

export function validateStateDeltaSuite(value: unknown, blueprint: SpaceBlueprint): value is StateDeltaSuite {
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 4 * 1024 * 1024) return false;
  const suite = value as StateDeltaSuite;
  if (!Array.isArray(suite.fixtures) || suite.fixtures.length < 50 || suite.fixtures.length > 500) return false;
  const ids = new Set<string>(); const covered = new Set<number>();
  for (const fixture of suite.fixtures) {
    if (!fixture || JSON.stringify(fixture).length > 262144 || typeof fixture.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(fixture.id) || ids.has(fixture.id) || !Number.isInteger(fixture.projectIndex) || !blueprint.projects[fixture.projectIndex] || !fixture.seed || !Array.isArray(fixture.assertions) || !fixture.assertions.length || !fixture.expectedFiles) return false;
    ids.add(fixture.id); covered.add(fixture.projectIndex);
  }
  return blueprint.projects.every((project, i) => covered.has(i) && typeof project.configuration?.conformance_entry === "string");
}
export async function runStateDeltaSuite(env: Environment, stateFactory: StateFactory, blueprint: SpaceBlueprint, suite: StateDeltaSuite): Promise<StateDeltaConformanceReport> {
  if (!validateStateDeltaSuite(suite, blueprint)) throw new Error("invalid_state_delta_suite");
  const report: StateDeltaConformanceReport = { runner: "naelao-state-delta-v1", passed: 0, total: suite.fixtures.length, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] };
  for (const fixture of suite.fixtures) {
    try { await runStateDeltaFixture(env, stateFactory, blueprint, fixture); report.passed++; }
    catch (error) {
      const message = (error as Error).message;
      if (message === "fixture_capability_violation" || message === "fixture_write_budget_exceeded") report.securityViolations++;
      report.diagnostics.push({ fixtureId: fixture.id, error: message.slice(0, 500) });
    }
  }
  return report;
}
