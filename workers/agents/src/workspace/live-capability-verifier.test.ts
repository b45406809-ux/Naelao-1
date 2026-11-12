import { describe, expect, it } from "vitest";
import { searchAndVerifyLiveRuntime } from "./live-capability-verifier.js";

const scope = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" as const };
const digest = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-11-11T12:00:00.000Z");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    runtime_id: "computer-a", tenant_id: scope.tenantId, owner_id: "user-a", space_id: scope.spaceId, project_id: scope.projectId,
    branch: "main", computer_state: "running", filesystem_mode: "live_mount", computer_generation: 4, template_id: "cloudflare-live",
    template_version: "v1", template_digest: digest, template_status: "verified", template_valid_until: "2026-11-12T12:00:00.000Z",
    allocation_id: "allocation-a", allocation_generation: 4, allocation_status: "active", allocation_image_digest: digest,
    connection_provider: "cloudflare", connection_status: "verified", connection_region: "wnam",
    observation_runtime_type: "cloudflare-computer", observation_template_id: "cloudflare-live", observation_template_digest: digest,
    observation_region: "wnam", residency_policy_id: "residency-global-v1",
    capability_observations_json: JSON.stringify({ liveMountReady: true, fuseReady: true, incrementalSyncReady: true, flushReady: true,
      reconnectGenerationCheck: true, authenticatedTransport: true, runtimeAccountingReady: true, residencyAllowed: true, jurisdiction: "global" }),
    billing_reservation_id: "billing-a", budget_reservation_id: "budget-a",
    evidence_json: JSON.stringify([{ url: "https://ci.example.test/runs/123", checkedAt: "2026-11-11T11:59:00.000Z", sha256: "b".repeat(64) }]),
    verified_by: "operator-a", verified_at: "2026-11-11T11:59:00.000Z", valid_until: "2026-11-11T12:04:00.000Z",
    ...overrides,
  };
}

function database(rows: Array<Record<string, unknown>>, options: { membership?: boolean; billing?: boolean; budget?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind() {
          return {
            async all() { return { success: true, results: rows }; },
            async first() {
              if (sql.includes("FROM spaces s WHERE")) return options.membership === false ? null : { active: 1 };
              if (sql.includes("FROM managed_service_credit_reservations")) return options.billing === false ? null : { id: "billing-a" };
              if (sql.includes("FROM workflow_budget_reservations")) return options.budget === false ? null : { id: "budget-a" };
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database & { calls: string[] };
}

describe("authority-backed live capability verification", () => {
  it("returns only DB-observed evidence with active allocation, current owner membership, billing and budget holds", async () => {
    const db = database([candidate()]);
    const result = await searchAndVerifyLiveRuntime(db, {
      scope, actorId: "user-a", preferredRuntimeId: "computer-a", preferredAllocationGeneration: 4, now,
    });
    expect(result).toMatchObject({ verified: true, candidateSearchPerformed: false,
      evidence: { runtimeId: "computer-a", allocationId: "allocation-a", allocationGeneration: 4,
        authorized: true, billingReserved: true, budgetReserved: true, fuseReady: true } });
    expect(db.calls.some(sql => sql.includes("workspace_live_runtime_observations"))).toBe(true);
  });

  it("does not accept a caller's preferred runtime when its generation is stale", async () => {
    const db = database([candidate({ allocation_generation: 3 })]);
    const result = await searchAndVerifyLiveRuntime(db, {
      scope, actorId: "user-a", preferredRuntimeId: "computer-a", preferredAllocationGeneration: 4, requireExact: true, now,
    });
    expect(result.verified).toBe(false);
    expect(result.missing).toContain("allocationGeneration");
  });

  it("fails closed when any active reservation or membership has been revoked", async () => {
    const db = database([candidate()], { membership: false, billing: false });
    const result = await searchAndVerifyLiveRuntime(db, {
      scope, actorId: "user-a", preferredRuntimeId: "computer-a", preferredAllocationGeneration: 4, now,
    });
    expect(result.verified).toBe(false);
    expect(result.missing).toContain("currentMembership");
    expect(result.missing).toContain("billingReservation");
  });

  it("searches the project scope when the preferred runtime is not current and reports that choice", async () => {
    const db = database([candidate({ runtime_id: "computer-b" })]);
    const result = await searchAndVerifyLiveRuntime(db, {
      scope, actorId: "user-a", preferredRuntimeId: "computer-old", preferredAllocationGeneration: 2, now,
    });
    expect(result).toMatchObject({ verified: true, candidateSearchPerformed: true, evidence: { runtimeId: "computer-b" } });
  });
});
