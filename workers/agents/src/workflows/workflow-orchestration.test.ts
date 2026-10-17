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

  it("lists only workflows installed in the active project after rechecking membership", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/spaces/space/members") return Response.json({ data: [{ user_id: "member", role: "member" }] });
      if (url.pathname === "/spaces/space/projects/project/members") return Response.json({ data: [{ user_id: "member", role: "editor" }] });
      if (url.pathname === "/spaces/space/container-installations") return Response.json({ installations: [
        { instance: { instance_id: "install-a", project_id: "project", scope: "PROJECT_BOUND", status: "active" }, manifest: { id: "ext_trade", bundle: { id: "ext_trade", version: "1.2.0", primitives: [
          { kind: "canvas", id: "mentor_console" }, { kind: "gadget", id: "trade_journal" }, { kind: "workflow", id: "place_order", entry: "./place-order.ts", toolNames: ["orders.place"] },
        ], workerRoles: [{ id: "order_worker", invocation: "workflow_step", execution: "worker", entry: "./place-order.ts", primitiveIds: ["place_order"] }] } } },
        { instance: { instance_id: "install-b", project_id: "other", scope: "PROJECT_BOUND", status: "active" }, manifest: { id: "ext_other", bundle: { id: "ext_other", version: "1.0.0", primitives: [{ kind: "workflow", id: "private", entry: "./private.ts", toolNames: [] }] } } },
      ] });
      return new Response("", { status: 404 });
    });
    const bucket = { get: async () => ({ text: async () => "{}" }) };
    const env = { PLATFORM_SECRET: "secret", SPACES_WORKER: { fetch }, SCRIPTS_R2: bucket };
    const hooks = createWorkflowHooks(env as never, { tenantId: "tenant", spaceId: "space", projectId: "project", agentId: "agent", actorId: "member" }, "parent", {} as never);
    await expect(hooks.workflowListExtensions?.()).resolves.toEqual([{ extensionId: "ext_trade", version: "1.2.0", installationId: "install-a",
      parts: [{ id: "mentor_console", kind: "canvas" }, { id: "trade_journal", kind: "gadget" }, { id: "place_order", kind: "workflow" }],
      workflows: [{ id: "place_order", entry: "./place-order.ts", toolNames: ["orders.place"], workerRoles: [{ id: "order_worker", invocation: "workflow_step", execution: "worker", entry: "./place-order.ts" }] }] }]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
