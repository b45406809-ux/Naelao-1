import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { recordAgent37ProviderUsageSnapshot } from "../../workers/sandboxes/src/agent37-provider-usage.js";

describe("Agent37 provider API usage snapshots", () => {
  it("stores minimized account-level cost evidence idempotently", async () => {
    const db = createFakeD1([readFileSync(new URL("../../infra/migrations/0214_agent37_provider_usage_snapshots.sql", import.meta.url), "utf8")]);
    const input = { tenantId: "tenant-a", ownerId: "owner-a", connectionRef: "connection-private-ref", observedAt: "2026-11-12T12:00:00.000Z",
      usage: { from: "2026-11-01", to: "2026-11-30", totalMicros: 125000,
        byIntegration: [{ kind: "compute" as const, costMicros: 50000, awakeMinutes: 12 }, { kind: "llm" as const, costMicros: 75000 }] } };

    await expect(recordAgent37ProviderUsageSnapshot(db as unknown as D1Database, input)).resolves.toMatchObject({
      inserted: true, provenance: "provider_api_observed", sourceApi: "agent37.usage", currency: "USD", totalMicros: 125000,
    });
    await expect(recordAgent37ProviderUsageSnapshot(db as unknown as D1Database, input)).resolves.toMatchObject({ inserted: false, replayed: true });
    const rows = await db.prepare("SELECT * FROM sandbox_agent37_usage_snapshots").all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results?.[0]).toMatchObject({
      tenant_id: "tenant-a", owner_id: "owner-a", period_start: "2026-11-01", period_end: "2026-11-30",
      total_cost_micros: 125000, source_api: "agent37.usage", observed_at: "2026-11-12T12:00:00.000Z",
    });
    expect(String(rows.results?.[0]?.connection_ref_sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rows.results?.[0]?.usage_json)).not.toContain("connection-private-ref");
    expect(String(rows.results?.[0]?.usage_json)).not.toContain("instance");
  });

  it("rejects oversized periods and duplicate metric categories before writing", async () => {
    const db = createFakeD1([readFileSync(new URL("../../infra/migrations/0214_agent37_provider_usage_snapshots.sql", import.meta.url), "utf8")]);
    const input = { tenantId: "tenant-a", ownerId: "owner-a", connectionRef: "connection-private-ref",
      usage: { from: "2026-01-01", to: "2026-04-01", totalMicros: 1, byIntegration: [] } };
    await expect(recordAgent37ProviderUsageSnapshot(db as unknown as D1Database, input)).rejects.toThrow("agent37_usage_snapshot_invalid");
    await expect(recordAgent37ProviderUsageSnapshot(db as unknown as D1Database, { ...input, usage: { ...input.usage,
      from: "2026-01-01", to: "2026-01-01", byIntegration: [
        { kind: "compute" as const, costMicros: 1 }, { kind: "compute" as const, costMicros: 1 },
      ] } })).rejects.toThrow("agent37_usage_snapshot_invalid");
    expect((await db.prepare("SELECT count(*) AS count FROM sandbox_agent37_usage_snapshots").first<{ count: number }>())?.count).toBe(0);
  });
});
