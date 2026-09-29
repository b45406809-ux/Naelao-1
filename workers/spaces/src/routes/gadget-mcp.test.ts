import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerGadgetMcpRoutes } from "./gadget-mcp.js";

describe("space-wide gadget MCP mounting", () => {
  it("mounts sibling projects onto one actor and exposes writes immediately", async () => {
    const actorNames: string[] = [];
    const records = new Map<string, unknown>();
    const stub = { fetch: async (request: Request) => {
      const rpc = await request.json() as any;
      const args = rpc.params.arguments;
      if (rpc.params.name.endsWith("_insert")) { records.set(args.record.id, args.record); return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { inserted: true } } }); }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: [...records.values()] } });
    } };
    const namespace = {
      idFromName(name: string) { actorNames.push(name); return { name } as unknown as DurableObjectId; },
      get() { return stub; },
    };
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) };
    const app = new Hono<any>();
    registerGadgetMcpRoutes(app);
    const env = { MICRO_APP_DO: namespace, PLATFORM_DB: db };
    const call = (projectId: string, body: unknown) => app.request("/spaces/space_102/apps/crm_directory/mcp", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-project-id": projectId }, body: JSON.stringify(body) }, env);
    await call("project_a", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "app_crm_directory_insert", arguments: { table: "contacts", record: { id: "lead_1", name: "Ada" } } } });
    const queried = await (await call("project_b", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "app_crm_directory_list", arguments: { table: "contacts" } } })).json() as any;
    expect(actorNames).toEqual(["gadget:crm_directory:space:space_102", "gadget:crm_directory:space:space_102"]);
    expect(queried.result.structuredContent).toEqual([{ id: "lead_1", name: "Ada" }]);
  });
});
