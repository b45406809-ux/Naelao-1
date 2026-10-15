import { describe, expect, it, vi } from "vitest";
import { ScriptToolSurface } from "./tool-surface.js";
import type { ScriptEngineEnv } from "./types.js";

function memoryBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value as ArrayBufferView));
      return {};
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    }),
    head: vi.fn(async (key: string) => objects.has(key) ? {} : null),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
      objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    })),
    delete: vi.fn(async () => undefined),
  } as unknown as R2Bucket & { objects: Map<string, string> };
}

describe("role-targeted skill discovery", () => {
  it("keeps planner orchestration summaries separate from worker-domain summaries and execution", async () => {
    const bucket = memoryBucket();
    const env: ScriptEngineEnv = { scriptsBucket: bucket, spaceId: "space", agentId: "agent", tenantId: "tenant" };
    const author = new ScriptToolSurface(env, []);
    await author.create({ name: "planner-handoff", metadata: {
      description: "Coordinate workers and sequence delegated tasks", domain: "orchestration", requires_tier: 1,
      role_target: "PLANNER_ORCHESTRATION",
    } });
    await author.create({ name: "invoice-reconcile", metadata: {
      description: "Reconcile invoice rows and validate payment data", domain: "finance", requires_tier: 1,
    } });

    const planner = new ScriptToolSurface(env, ["code-exec"], { plannerScope: "project" });
    const worker = new ScriptToolSurface(env, []);
    const plannerCatalog = await planner.activeCatalog();
    const workerCatalog = await worker.activeCatalog();
    expect(plannerCatalog).toContain("planner-handoff");
    expect(plannerCatalog).not.toContain("invoice-reconcile");
    expect(workerCatalog).toContain("invoice-reconcile");
    expect(workerCatalog).not.toContain("planner-handoff");
    await expect(planner.find("invoice payment")).resolves.toEqual([]);
    await expect(worker.find("invoice payment")).resolves.toMatchObject([{ name: "invoice-reconcile" }]);
    await expect(planner.run("invoice-reconcile", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("planner_capability_boundary"),
    });
    await expect(planner.run("Bash", { commands: "skill list" })).resolves.toMatchObject({
      ok: true,
      output: { skills: expect.arrayContaining([expect.objectContaining({ name: "planner-handoff" })]) },
    });
    await expect(planner.run("Bash", { commands: "skill read invoice-reconcile" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("skill_not_available_for_role"),
    });
    await expect(worker.run("planner-handoff", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not available to worker execution"),
    });
  });
});
