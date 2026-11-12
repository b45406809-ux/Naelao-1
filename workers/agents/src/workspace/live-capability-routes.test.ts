import { describe, expect, it, vi } from "vitest";
import { app } from "../index.js";

const digest = `sha256:${"a".repeat(64)}`;
const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };

function binding() {
  const statements: string[] = [];
  const row = { tenant_id: scope.tenantId, space_id: scope.spaceId, project_id: scope.projectId, state: "running", branch: "main",
    filesystem_mode: "live_mount", allocation_generation: 4, template_id: "cloudflare-live", template_version: "v1",
    allocation_id: "allocation-a", generation: 4, allocation_status: "active", provider: "cloudflare", image_digest: digest,
    connection_provider: "cloudflare", connection_status: "verified", region: "wnam", template_digest: digest,
    template_status: "verified", template_valid_until: new Date(Date.now() + 60 * 60_000).toISOString() };
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return { bind() { return { async first() { return sql.includes("FROM sandbox_computers c") ? row : null; } }; } };
    },
    async batch(items: unknown[]) {
      statements.push(`BATCH:${items.length}`);
      return items.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { value: { PLATFORM_SECRET: "platform-secret", PLATFORM_DB: db, LIVE_RUNTIME_OPERATOR_SECRET: "operator-secret" } as never, statements };
}

function input() {
  return { scope, runtimeId: "computer-a", allocationId: "allocation-a", allocationGeneration: 4,
    runtimeType: "cloudflare-computer", templateId: "cloudflare-live", templateDigest: digest, region: "wnam",
    residencyPolicyId: "residency-global-v1", capabilities: { liveMountReady: true, fuseReady: true, incrementalSyncReady: true,
      flushReady: true, reconnectGenerationCheck: true, authenticatedTransport: true, runtimeAccountingReady: true,
      residencyAllowed: true, jurisdiction: "global" }, billingReservationId: "billing-a", budgetReservationId: "budget-a",
    evidence: [{ url: "https://ci.example.test/runs/42", checkedAt: new Date().toISOString(), sha256: "b".repeat(64) }],
    reason: "Observed runtime mount, flush, reconnect, and authorization checks.", validUntil: new Date(Date.now() + 60_000).toISOString() };
}

describe("live runtime capability routes", () => {
  it("requires the separate operator secret before persisting runtime observations", async () => {
    const env = binding();
    const response = await app.request("/operator/workspaces/live-runtime-observations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input()),
    }, env.value);
    expect(response.status).toBe(403);
    expect(env.statements).toEqual([]);
  });

  it("persists an operator observation only for the exact current project allocation", async () => {
    const env = binding();
    const response = await app.request("/operator/workspaces/live-runtime-observations", {
      method: "POST", headers: { "content-type": "application/json", "x-runtime-operator-secret": "operator-secret", "x-runtime-operator-id": "operator-a" },
      body: JSON.stringify(input()),
    }, env.value);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ observed: true, runtimeId: "computer-a", allocationId: "allocation-a", allocationGeneration: 4 });
    expect(env.statements.some(sql => sql.includes("INSERT INTO workspace_live_runtime_observations"))).toBe(true);
    expect(env.statements.some(sql => sql.includes("workspace_live_runtime_observation_audit"))).toBe(true);
  });

  it("rejects an operator observation whose allocation is no longer current", async () => {
    const env = binding();
    const db = env.value as { PLATFORM_DB: { prepare: (sql: string) => { bind: (...values: unknown[]) => { first: () => Promise<unknown> } } } };
    vi.spyOn(db.PLATFORM_DB, "prepare").mockImplementation((sql: string) => ({ bind: () => ({ first: async () =>
      sql.includes("FROM sandbox_computers c") ? { ...({} as object), state: "sleeping" } : null }) }));
    const response = await app.request("/operator/workspaces/live-runtime-observations", {
      method: "POST", headers: { "content-type": "application/json", "x-runtime-operator-secret": "operator-secret", "x-runtime-operator-id": "operator-a" },
      body: JSON.stringify(input()),
    }, env.value);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "live_runtime_allocation_not_current" });
  });
});
