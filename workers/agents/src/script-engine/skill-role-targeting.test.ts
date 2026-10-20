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
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return { size: bytes.byteLength, text: async () => value, arrayBuffer: async () => bytes.buffer };
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
  it("provides progressive attachment manuals to their matching roles only", async () => {
    const env: ScriptEngineEnv = { scriptsBucket: memoryBucket(), spaceId: "space", agentId: "agent", tenantId: "tenant" };
    const planner = new ScriptToolSurface(env, [], { plannerScope: "space", defaultSkills: ["conversation-research-routing"] });
    const worker = new ScriptToolSurface(env, []);
    await expect(planner.run("Bash", { commands: "skill list" })).resolves.toMatchObject({
      ok: true, output: { skills: expect.arrayContaining([expect.objectContaining({ name: "attachment-routing", role_target: "PLANNER_ORCHESTRATION" })]) },
    });
    await expect(planner.run("Bash", { commands: "skill read conversation-research-routing --section \"Keep the planner's context bounded\"" })).resolves.toMatchObject({
      ok: true, output: { source: "builtin_manual", content: expect.stringContaining("next_cursor") },
    });
    expect(await planner.activeCatalog()).toContain("The planner coordinates and synthesizes");
    await expect(planner.run("Bash", { commands: "skill list" })).resolves.toMatchObject({
      output: { skills: expect.not.arrayContaining([expect.objectContaining({ name: "attachment-readers" })]) },
    });
    await expect(worker.run("Bash", { commands: "skill list" })).resolves.toMatchObject({
      ok: true, output: { skills: expect.arrayContaining([expect.objectContaining({ name: "attachment-readers", role_target: "WORKER_EXECUTION" })]) },
    });
    await expect(planner.run("Bash", { commands: "skill read attachment-routing --toc" })).resolves.toMatchObject({
      ok: true, output: { source: "builtin_manual", headings: expect.stringContaining("Decide from the request first") },
    });
    await expect(planner.run("Bash", { commands: "skill read attachment-readers" })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining("skill_not_available_for_role"),
    });
    await expect(worker.run("Bash", { commands: "skill read conversation-research-worker --lines 1-6" })).resolves.toMatchObject({
      ok: true, output: { source: "builtin_manual", content: expect.stringContaining("next_cursor") },
    });
    await expect(worker.run("Bash", { commands: "skill read attachment-readers --lines 1-4" })).resolves.toMatchObject({
      ok: true, output: { source: "builtin_manual", content: expect.stringContaining("Scoped operations") },
    });
  });

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
      manual_markdown: "# Invoice Reconciliation\n\n## Payment terms\nCheck dates and totals.\n\n## Carveouts\nKeep approved exceptions.\n\n```md\n## Not a real section\n```\n\n## Escalation\nAsk an owner.",
    }, code: "export async function run() { return 'reconciled'; }" });

    const narrowed = new ScriptToolSurface(env, ["conversation", "document-processing"], {
      skillAllowlist: ["conversation-research-worker"], defaultSkills: ["conversation-research-worker"],
    });
    expect(narrowed.availableOperations()).toContain("conversation.search");
    expect(narrowed.availableOperations()).not.toContain("knowledge.search");
    await expect(narrowed.run("invoice-reconcile", {})).resolves.toMatchObject({
      ok: false, error: expect.stringContaining("worker_skill_not_selected_for_task"),
    });
    await expect(narrowed.run("Bash", { commands: "skill list" })).resolves.toMatchObject({
      output: { skills: [expect.objectContaining({ name: "conversation-research-worker" })] },
    });

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
    await expect(worker.run("Bash", { commands: "skill read invoice-reconcile --toc" })).resolves.toMatchObject({
      ok: true,
      output: { headings: expect.stringContaining("## Payment terms") },
    });
    await expect(worker.run("Bash", { commands: 'skill read invoice-reconcile --section "carveouts"' })).resolves.toMatchObject({
      ok: true,
      output: { content: expect.stringContaining("Keep approved exceptions.") },
    });
    await expect(worker.run("Bash", { commands: "skill read invoice-reconcile --lines 3-4" })).resolves.toMatchObject({
      ok: true,
      output: { content: "## Payment terms\nCheck dates and totals." },
    });
    await expect(worker.run("planner-handoff", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not available to worker execution"),
    });
  });
});
