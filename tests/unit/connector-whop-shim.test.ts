import { describe, it, expect } from "vitest";
import { TOOLS, toolList } from "../../workers/connector-whop/src/index.js";
import { getConnector } from "../../workers/agents/src/connectors/catalogue.js";

// The Whop MCP shim makes the Whop connector live. These tests lock the tool surface +
// the reserved-money-in invariant, and check the shim ↔ catalogue stay in sync.

describe("Whop MCP shim", () => {
  it("exposes the expected read tools and write tools", () => {
    const names = Object.keys(TOOLS);
    for (const t of ["list_memberships", "get_membership", "list_members", "list_products", "list_payments", "list_plans"]) {
      expect(names).toContain(t);
    }
    expect(names).toContain("send_message");
    expect(names).toContain("post_announcement");
  });

  it("exposes NO money-in tool (Whop processes payments; this is the automation layer)", () => {
    for (const name of Object.keys(TOOLS)) {
      expect(/checkout|charge|payout|refund|collect.?payment|create.?payment/i.test(name)).toBe(false);
    }
  });

  it("builds correct Whop v5 paths", () => {
    expect(TOOLS["list_memberships"]!.path({})).toBe("/v5/company/memberships");
    expect(TOOLS["list_memberships"]!.path({ status: "active", page: 2 })).toBe("/v5/company/memberships?status=active&page=2");
    expect(TOOLS["get_membership"]!.path({ id: "mem_123" })).toBe("/v5/company/memberships/mem_123");
    expect(TOOLS["list_payments"]!.path({})).toBe("/v5/company/payments");
  });

  it("write tools carry a body builder; read tools do not", () => {
    expect(typeof TOOLS["send_message"]!.body).toBe("function");
    expect(TOOLS["send_message"]!.body!({ to_user_id: "u1", message: "hi" })).toEqual({ to_user_id: "u1", message: "hi" });
    expect(TOOLS["list_memberships"]!.body).toBeUndefined();
  });

  it("tools/list returns every tool with a description + input schema", () => {
    const list = toolList();
    expect(list.length).toBe(Object.keys(TOOLS).length);
    for (const t of list) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("the shim's tools cover the catalogue's declared Whop operations", () => {
    const catalogueOps = (getConnector("whop")?.operations ?? []).map((o) => o.name);
    for (const op of catalogueOps) {
      expect(Object.keys(TOOLS), `catalogue op ${op} missing from shim`).toContain(op);
    }
  });
});
