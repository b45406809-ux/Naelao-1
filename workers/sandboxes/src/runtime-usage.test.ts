import { describe, expect, it } from "vitest";
import { summarizeSandboxRuntimeUsage } from "./runtime-usage.js";

describe("sandbox runtime usage summary", () => {
  it("reads settled Tier 5 credits from the authoritative billing ledger with explicit provenance", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { values = next; return statement; },
          async first() {
            calls.push({ sql, values });
            return { event_count: 2, credits: 15, cost_credits: 15, unpriced_event_count: 0 };
          },
          async all() {
            calls.push({ sql, values });
            return { results: [{ space_id: "space-a", project_id: "project-a", installation_id: null,
              rate_card_version: "billing-core-v3", payer_kind: "plan_quota", event_count: 2,
              credits: 15, cost_credits: 15, unpriced_event_count: 0 }] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const result = await summarizeSandboxRuntimeUsage(database, {
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", days: 30,
    });
    expect(result).toMatchObject({
      provenance: "naelao_credit_ledger", unit: "credits", credits: 15, eventCount: 2,
      breakdown: [{ spaceId: "space-a", projectId: "project-a", rateCardVersion: "billing-core-v3", payerKind: "plan_quota" }],
    });
    expect(result.note).toContain("not provider cost");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("event_type='infra_credits'");
      expect(call.sql).toContain("runtime_tier=5");
      expect(call.sql).toContain("decision='charged'");
      expect(call.sql).toContain("space_id=?");
      expect(call.sql).toContain("project_id=?");
      expect(call.values).toEqual(["tenant-a", "-30 days", "space-a", "project-a"]);
    }
  });

  it("rejects unscoped project requests and unsupported periods", async () => {
    const db = { prepare: () => { throw new Error("must_not_query"); } } as unknown as D1Database;
    await expect(summarizeSandboxRuntimeUsage(db, { tenantId: "tenant-a", projectId: "project-a", days: 30 }))
      .rejects.toThrow("sandbox_runtime_usage_invalid");
    await expect(summarizeSandboxRuntimeUsage(db, { tenantId: "tenant-a", days: 365 }))
      .rejects.toThrow("sandbox_runtime_usage_invalid");
  });
});
