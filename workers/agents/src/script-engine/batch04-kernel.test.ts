import { describe, expect, it, vi } from "vitest";
import type { UniversalAgentManifest } from "@naelao/agent-sdk";
import { composeUniversalPrompt } from "./prompt-assembly.js";
import { isToolAllowedForRole, sanitizeToolsForRole } from "./agent-firewall.js";
import { goalPlanner, validateGoalDag } from "./prebuilt/goal-planner.js";
import { framePlannerFirstGoal, PLANNER_FIRST_PROTOCOL } from "./planner-first.js";
import { isPlannerOperationAllowed, UNIVERSAL_AGENT_BASELINE_PREBUILTS } from "./agent-topology.js";
import { ScriptToolSurface } from "./tool-surface.js";

const manifest: UniversalAgentManifest = {
  scope: "SPACE_WIDE", role: "CUSTOMER_SUPPORT",
  prompts: { systemPrompt: "Be kind.", instructions: "Resolve tickets.", userCustomInstructions: "Never promise refunds." },
  capabilities: { enabledPrebuilts: ["knowledge-base"], maxTier: 2 },
  autonomy: { approvalMode: "gate_listed", autoApprovedActions: [], requiresApprovalFor: [] },
};

describe("Batch 04 universal kernel", () => {
  it("compiles exactly four prompt layers in deterministic order", () => {
    const prompt = composeUniversalPrompt({ manifest, businessContext: { name: "Acme", kind: "store", offering: "Widgets", pricing: "$10", setup_status: "complete" } });
    const tags = ["universal_operating_kernel", "living_business_identity", "agent_archetype", "founder_custom_directives"];
    expect(tags.map((tag) => prompt.indexOf(`<${tag}>`))).toEqual([...tags.map((tag) => prompt.indexOf(`<${tag}>`))].sort((a, b) => a - b));
    expect(prompt).toContain("Never promise refunds.");
  });

  it("keeps the universal shell surface while enforcing the support tier ceiling", () => {
    const tools = sanitizeToolsForRole("CUSTOMER_SUPPORT", [{ name: "Bash" }, { name: "Read" }, { name: "knowledge.search" }, { name: "ticket.create" }]);
    expect(tools.map((tool) => tool.name)).toEqual(["Bash", "Read", "knowledge.search", "ticket.create"]);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "Bash", 1)).toBe(true);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "ticket.create", 3)).toBe(false);
  });

  it("frames every parent turn as planner-first while workers execute their assigned leaf task", () => {
    expect(framePlannerFirstGoal("research competitor pricing", { worker: false })).toContain("<planner_first_contract>");
    expect(framePlannerFirstGoal("/goal research competitor pricing", { worker: false })).toContain("research competitor pricing");
    const workerGoal = framePlannerFirstGoal("inspect src/auth.ts", { worker: true });
    expect(workerGoal).toContain("<worker_execution_contract>");
    expect(workerGoal).not.toContain("engine.plan_and_delegate_goal");
  });

  it("documents planner-owned project coordination commands", () => {
    expect(PLANNER_FIRST_PROTOCOL).toContain("naelao project agents list");
    expect(PLANNER_FIRST_PROTOCOL).toContain("native AskUser action");
    expect(PLANNER_FIRST_PROTOCOL).toContain("Never put a clarification question in an answer message");
    expect(UNIVERSAL_AGENT_BASELINE_PREBUILTS).toContain("project-coordination");
    expect(UNIVERSAL_AGENT_BASELINE_PREBUILTS).toContain("executive-cabinet");
  });

  it("keeps worker-owned domain actions behind the parent planner boundary", () => {
    expect(isPlannerOperationAllowed("space", "delegate_to_space_worker")).toBe(true);
    expect(isPlannerOperationAllowed("space", "project.create")).toBe(false);
    expect(isPlannerOperationAllowed("project", "thread.delegate")).toBe(true);
    expect(isPlannerOperationAllowed("project", "wallet.request_payout")).toBe(false);
  });

  it("refuses a direct domain operation from a Space planner before it can reach its worker", async () => {
    const tools = new ScriptToolSurface(
      { scriptsBucket: { list: vi.fn(async () => ({ objects: [], truncated: false })) } as unknown as R2Bucket, spaceId: "s", agentId: "a", tenantId: "t" },
      ["workspace-admin", "executive-cabinet"],
      { plannerScope: "space" },
    );
    await expect(tools.run("project.create", { name: "Do not bypass the cabinet" }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("planner_capability_boundary") });
    expect(tools.availableOperations()).not.toContain("delegate_to_space_worker");
    expect(tools.availableOperations()).not.toContain("thread.delegate");
    await expect(tools.activeCatalog()).resolves.toContain("naelao project agents list");
  });

  it("records the actual execution tier without making telemetry part of correctness", async () => {
    const recordExecution = vi.fn();
    const tools = new ScriptToolSurface({
      scriptsBucket: { list: vi.fn(async () => ({ objects: [], truncated: false })) } as unknown as R2Bucket,
      spaceId: "s", agentId: "a", tenantId: "t", recordExecution,
    }, []);
    await expect(tools.run("tools.describe", { name: "tools.describe" })).resolves.toMatchObject({ ok: true, actual_tier: 1 });
    expect(recordExecution).toHaveBeenCalledWith(expect.objectContaining({
      operation: "tools.describe", tier: 1, engine: "sqlite_fs", ok: true,
    }));

    recordExecution.mockImplementation(() => { throw new Error("analytics unavailable"); });
    await expect(tools.run("tools.describe", { name: "tools.describe" })).resolves.toMatchObject({ ok: true });
  });

  it("persists a DAG and dispatches isolated <=2k worker contexts", async () => {
    const persistGoalTasks = vi.fn(async () => undefined);
    const spawnSubAgent = vi.fn(async () => ({ id: "batch-1" }));
    const tasks = [{ id: "a", title: "Inspect", subtask_spec: "Inspect auth", assigned_role: "DEV_OPERATOR", file_paths: ["src/auth.ts"], dependencies: [], budget_tokens: 1800 }];
    validateGoalDag(tasks as never);
    const result = await goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "secure auth", tasks }, { env: { orchestration: { persistGoalTasks, spawnSubAgent } } as never, run: vi.fn() });
    expect(persistGoalTasks).toHaveBeenCalledOnce();
    expect(spawnSubAgent).toHaveBeenCalledWith({ tasks: [expect.objectContaining({ maxTokens: 1800, role: "DEV_OPERATOR", goal: expect.not.stringContaining("secure auth") })] });
    expect(result).toMatchObject({ max_context_tokens: 2000, context_isolation: "subtask_and_file_slice_only" });
  });
});
