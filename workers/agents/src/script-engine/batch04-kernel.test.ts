import { describe, expect, it, vi } from "vitest";
import { decisionTools } from "./reasoner.js";
import type { UniversalAgentManifest } from "@naelao/agent-sdk";
import { composeUniversalPrompt } from "./prompt-assembly.js";
import { isToolAllowedForRole, sanitizeToolsForRole } from "./agent-firewall.js";
import { goalPlanner, validateGoalDag } from "./prebuilt/goal-planner.js";
import { framePlannerFirstGoal, PLANNER_FIRST_PROTOCOL } from "./planner-first.js";
import { isPlannerOperationAllowed, UNIVERSAL_AGENT_BASELINE_PREBUILTS } from "./agent-topology.js";
import { ScriptToolSurface } from "./tool-surface.js";
import type { ScriptEngineEnv } from "./types.js";

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

  it("uses arbitrary descriptive roles while access remains capability-controlled", () => {
    const tools = sanitizeToolsForRole("CUSTOMER_SUPPORT", [{ name: "Bash" }, { name: "Read" }, { name: "knowledge.search" }, { name: "ticket.create" }]);
    expect(tools.map((tool) => tool.name)).toEqual(["Bash", "Read", "knowledge.search", "ticket.create"]);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "Bash", 1)).toBe(true);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "ticket.create", 3)).toBe(true);
    expect(isToolAllowedForRole("legal-reviewer", "code.execute_bash", 6)).toBe(true);
    expect(isToolAllowedForRole("legal-reviewer", "code.execute_bash", 7)).toBe(false);
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
    expect(UNIVERSAL_AGENT_BASELINE_PREBUILTS).not.toContain("code-exec");
    expect(UNIVERSAL_AGENT_BASELINE_PREBUILTS).not.toContain("runtime-discovery");
  });

  it("keeps worker-owned domain actions behind the parent planner boundary", () => {
    expect(isPlannerOperationAllowed("space", "delegate_to_space_worker")).toBe(true);
    expect(isPlannerOperationAllowed("space", "project.create")).toBe(false);
    expect(isPlannerOperationAllowed("project", "thread.delegate")).toBe(true);
    expect(isPlannerOperationAllowed("project", "wallet.request_payout")).toBe(false);
    expect(isPlannerOperationAllowed("space", "Edit")).toBe(false);
    expect(isPlannerOperationAllowed("project", "Edit")).toBe(false);
  });

  it.each(["space", "project"] as const)("strips file mutation tools from a %s planner before disclosure and invocation", async (plannerScope) => {
    const put = vi.fn(), get = vi.fn();
    const env: ScriptEngineEnv = {
      scriptsBucket: { put, get, list: vi.fn(async () => ({ objects: [], truncated: false })) } as unknown as R2Bucket,
      spaceId: "s", agentId: "a", tenantId: "t",
    };
    const tools = new ScriptToolSurface(env, ["r2-workspace", "code-exec"], { plannerScope });
    expect(tools.availableOperations()).toContain("Read");
    expect(tools.availableOperations()).toContain("Bash");
    expect(tools.availableOperations()).not.toContain("Edit");
    expect(tools.availableOperations()).not.toContain("Write");
    expect(decisionTools(undefined, tools.availableOperations()).map((tool) => tool.name)).not.toContain("Edit");
    expect(decisionTools(undefined, ["Bash", "Read", "Edit"]).map((tool) => tool.name)).toContain("Edit");
    for (const name of ["Edit", "edit", "patch_file", "Write"]) {
      await expect(tools.run(name, { path: "src/a.ts", old: "a", new: "b" }))
        .resolves.toMatchObject({ ok: false, error: expect.stringContaining("planner_capability_boundary") });
    }
    const scope = { tenantId: "t", spaceId: "s", agentId: "a" };
    // The isolated-code broker must enforce the same boundary.
    await expect(env.codeAuthorize!(scope, "storage.write")).resolves.toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
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

  it("dispatches through the durable DAG host with bounded worker output budgets", async () => {
    const persistGoalTasks = vi.fn(async () => undefined);
    const spawnSubAgent = vi.fn(async () => ({ id: "batch-1" }));
    const executeGoalDag = vi.fn(async () => ({ tasks: { a: { status: "completed", workerId: "a" } } }));
    const tasks = [{ id: "a", title: "Inspect", subtask_spec: "Inspect auth", assigned_role: "DEV_OPERATOR", file_paths: ["src/auth.ts"], dependencies: [], budget_tokens: 1800 }];
    validateGoalDag(tasks as never);
    const result = await goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "secure auth", tasks }, { env: { orchestration: { persistGoalTasks, spawnSubAgent, executeGoalDag } } as never, run: vi.fn() });
    expect(executeGoalDag).toHaveBeenCalledWith("secure auth", [{ ...tasks[0], context_affinity: "shared" }]);
    expect(spawnSubAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ max_output_tokens_per_worker: 2000, context_isolation: "no_parent_conversation" });
    executeGoalDag.mockResolvedValueOnce({ tasks: { a: { status: "failed", workerId: "a" } } });
    await expect(goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "secure auth", tasks }, { env: { orchestration: { persistGoalTasks, spawnSubAgent, executeGoalDag } } as never, run: vi.fn() }))
      .rejects.toThrow("goal_dag_incomplete");
  });

  it("derives task context affinity and discards planner-supplied worker model ids", async () => {
    const executeGoalDag = vi.fn(async () => ({ tasks: { bulk: { status: "completed", workerId: "bulk" } } }));
    const task = { id: "bulk", title: "Parse records", subtask_spec: "Parse independent receipts", assigned_role: "DEV_OPERATOR", model: "openai/gpt-6-luna", file_paths: [], budget_tokens: 500 };
    await goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "parse receipts", tasks: [task] }, {
      env: { orchestration: { persistGoalTasks: vi.fn(), spawnSubAgent: vi.fn(), executeGoalDag } } as never,
      run: vi.fn(),
    });
    expect(executeGoalDag).toHaveBeenCalledWith("parse receipts", [{
      id: "bulk", title: "Parse records", subtask_spec: "Parse independent receipts", assigned_role: "DEV_OPERATOR",
      context_affinity: "isolated", file_paths: [], dependencies: [], budget_tokens: 500,
    }]);
  });

  it("leaves runtime selection to the worker board and discards planner runtime hints", async () => {
    const executeGoalDag = vi.fn(async () => ({ tasks: { media: { status: "completed", workerId: "media" } } }));
    const task = { id: "media", title: "Transcode clip", subtask_spec: "Convert the supplied clip", assigned_role: "DEV_OPERATOR",
      file_paths: ["media/input.mp4"], container_capabilities: ["video.transcode"], budget_tokens: 500, image: "attacker-selected" };
    const result = await goalPlanner.operations["engine.plan_and_delegate_goal"]!({ objective: "convert clip", tasks: [task] }, {
      env: { orchestration: { persistGoalTasks: vi.fn(), spawnSubAgent: vi.fn(), executeGoalDag } } as never,
      run: vi.fn(),
    });
    expect(executeGoalDag).toHaveBeenCalledWith("convert clip", [{
      id: "media", title: "Transcode clip", subtask_spec: "Convert the supplied clip", assigned_role: "DEV_OPERATOR",
      context_affinity: "shared", file_paths: ["media/input.mp4"], dependencies: [], budget_tokens: 500,
    }]);
    expect(result).not.toHaveProperty("tasks.0.image");
    expect(() => validateGoalDag([{ ...task, container_capabilities: ["../escape"] } as never])).not.toThrow();
  });
});
