import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";
import { loadShellCatalog, loadTemplateCatalogOrNull, resolveOrgPlanTier } from "./template-catalog.js";

const TEMPLATE = { id: "free-template", name: "Free Template", free_tier_eligible: true };

function db() {
  return createFakeD1(["CREATE TABLE orgs (id TEXT PRIMARY KEY, plan_tier TEXT NOT NULL DEFAULT 'free');"]);
}

describe("template catalog dependency boundaries", () => {
  it("uses bounded cached data, and refetches malformed cache entries", async () => {
    const values = new Map<string, unknown>([["launchpad-template-catalog:v6", { unexpected: true }]]);
    const kv = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, JSON.parse(value)); },
    };
    const fetch = vi.fn(async () => Response.json({ templates: [TEMPLATE] }));
    const result = await loadTemplateCatalogOrNull({ NAELAO_CONFIG_KV: kv as never, AGENTS_WORKER: { fetch } as never });
    expect(result?.[0]).toMatchObject({ id: "free-template", free_tier_eligible: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(values.get("launchpad-template-catalog:v6")).toMatchObject({ templates: [{ id: "free-template" }] });
  });

  it("treats malformed, oversized, and unavailable provider results as unavailable", async () => {
    const malformed = await loadTemplateCatalogOrNull({ AGENTS_WORKER: { fetch: async () => Response.json({ templates: [{ id: "bad/id", name: "bad" }] }) } as never });
    expect(malformed).toBeNull();
    const oversized = await loadTemplateCatalogOrNull({ AGENTS_WORKER: { fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) } as never });
    expect(oversized).toBeNull();
    const unavailable = await loadTemplateCatalogOrNull({ AGENTS_WORKER: { fetch: async () => { throw new Error("offline"); } } as never });
    expect(unavailable).toBeNull();
  });

  it("does not let unknown stored plan values bypass free-tier eligibility", async () => {
    const fakeDb = db();
    fakeDb.db.exec("INSERT INTO orgs (id, plan_tier) VALUES ('tenant', 'unrecognized')");
    expect(await resolveOrgPlanTier(fakeDb, "tenant")).toBe("free");
  });

  it("normalizes known plan tiers and falls back to free when the lookup fails", async () => {
    const fakeDb = db();
    fakeDb.db.exec("INSERT INTO orgs (id, plan_tier) VALUES ('paid', 'GROWTH')");
    expect(await resolveOrgPlanTier(fakeDb, "paid")).toBe("growth");
    expect(await resolveOrgPlanTier(fakeDb, "missing")).toBe("free");
    expect(await resolveOrgPlanTier({ prepare: () => { throw new Error("db offline"); } } as never, "x")).toBe("free");
  });

  it("degrades shell catalogue cache/provider errors to safe bounded empty lists", async () => {
    const kv = { get: async () => { throw new Error("KV unavailable"); } };
    expect(await loadShellCatalog({ NAELAO_CONFIG_KV: kv as never })).toEqual({ project_templates: [], agents: [] });
    expect(await loadShellCatalog({ AGENTS_WORKER: { fetch: async () => Response.json({ agents: "not-an-array" }) } as never }))
      .toEqual({ project_templates: [], agents: [] });
    const result = await loadShellCatalog({ AGENTS_WORKER: { fetch: async () => Response.json({
      project_templates: [{ id: "starter", name: "Starter", kind: "workspace" }],
      agents: [{ id: "assistant", name: "Assistant", description: "General helper" }],
    }) } as never });
    expect(result).toEqual({
      project_templates: [{ id: "starter", name: "Starter", kind: "workspace" }],
      agents: [{ id: "assistant", name: "Assistant", description: "General helper" }],
    });
  });
});
