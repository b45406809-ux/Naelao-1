import { describe, it, expect } from "vitest";
import { TOOLS, toolList } from "../../workers/connector-gumroad/src/index.js";
import { getConnector, availableConnectors, pollableConnectorIds } from "../../workers/agents/src/connectors/catalogue.js";

// Connector #2 — proves the shim pattern repeats: a catalogue row flipped to available + a
// sibling shim worker, no core changes.

describe("Gumroad MCP shim (connector #2)", () => {
  it("Gumroad is exposed as a standard external connector with read-only operations", () => {
    const g = getConnector("gumroad");
    expect(g?.status).toBe("available");
    expect(g?.mcp_endpoint).toContain("gumroad");
    expect((g?.operations ?? []).length).toBeGreaterThan(0);
    expect(availableConnectors().map((c) => c.id)).toContain("gumroad");
    expect(availableConnectors().map((c) => c.id)).toContain("whop");
  });

  it("exposes the expected read tools and no money-in tool", () => {
    for (const t of ["list_products", "get_product", "list_sales", "list_subscribers"]) {
      expect(Object.keys(TOOLS)).toContain(t);
    }
    for (const name of Object.keys(TOOLS)) {
      expect(/checkout|charge|payout|refund|collect.?payment|create.?payment/i.test(name)).toBe(false);
    }
  });

  it("builds correct Gumroad v2 paths", () => {
    expect(TOOLS["list_products"]!.path({})).toBe("/products");
    expect(TOOLS["get_product"]!.path({ product_id: "prod_1" })).toBe("/products/prod_1");
    expect(TOOLS["list_subscribers"]!.path({ product_id: "prod_1" })).toBe("/products/prod_1/subscribers");
    expect(TOOLS["list_sales"]!.path({})).toBe("/sales");
  });

  it("the shim's tools cover the catalogue's declared Gumroad operations", () => {
    const ops = (getConnector("gumroad")?.operations ?? []).map((o) => o.name);
    for (const op of ops) expect(Object.keys(TOOLS), `op ${op}`).toContain(op);
    expect(toolList().length).toBe(Object.keys(TOOLS).length);
  });

  it("Gumroad and Whop are polled when their catalogue entries have no webhook declaration", () => {
    // The cron poller targets available connectors WITHOUT a webhook spec.
    expect(pollableConnectorIds()).toContain("gumroad");
    expect(pollableConnectorIds()).toContain("whop");
  });
});
