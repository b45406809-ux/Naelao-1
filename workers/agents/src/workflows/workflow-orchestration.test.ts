import { describe, expect, it, vi } from "vitest";
import { createWorkflowHooks } from "./workflow-orchestration.js";

describe("container work inside durable workflows", () => {
  it("allows only explicitly declared bounded shell execution capabilities", async () => {
    const tools = { availableOperations: () => ["code.execute_bash", "Bash", "code.execute_python"], create: vi.fn(async () => undefined) };
    const hooks = createWorkflowHooks({} as never, { tenantId: "tenant", spaceId: "space", projectId: "project", agentId: "agent", actorId: "owner" }, "parent", tools as never);
    await expect(hooks.workflowCreate?.("price-check", "export async function execute(step,ctx){ return await ctx.tools.call('analyze','code.execute_bash',{commands:'python3 analyze.py'}); }", { capabilities: ["code.execute_bash"] }))
      .resolves.toEqual({ id: "price-check" });
    expect(tools.create).toHaveBeenCalledWith(expect.objectContaining({ name: "price-check", metadata: expect.objectContaining({ runtime: "workflow", code_capabilities: ["code.execute_bash"] }) }));
    await expect(hooks.workflowCreate?.("unsafe", "export async function execute(){ return null; }", { capabilities: ["Bash"] }))
      .rejects.toThrow("workflow_capability_not_installed");
    await expect(hooks.workflowCreate?.("unsafe-js", "export async function execute(){ return null; }", { capabilities: ["code.run_js"] }))
      .rejects.toThrow("workflow_capability_not_installed");
  });
});
