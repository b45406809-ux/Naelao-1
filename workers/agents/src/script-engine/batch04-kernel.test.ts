import { describe, expect, it, vi } from "vitest";
import type { UniversalAgentManifest } from "@naelao/agent-sdk";
import { composeUniversalPrompt } from "./prompt-assembly.js";
import { isToolAllowedForRole, sanitizeToolsForRole } from "./agent-firewall.js";
import { goalPlanner, validateGoalDag } from "./prebuilt/goal-planner.js";

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

  it("physically removes support file/terminal tools and fails direct checks closed", () => {
    const tools = sanitizeToolsForRole("CUSTOMER_SUPPORT", [{ name: "Bash" }, { name: "Read" }, { name: "knowledge.search" }, { name: "ticket.create" }]);
    expect(tools.map((tool) => tool.name)).toEqual(["knowledge.search", "ticket.create"]);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "Bash", 1)).toBe(false);
    expect(isToolAllowedForRole("CUSTOMER_SUPPORT", "ticket.create", 3)).toBe(false);
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
