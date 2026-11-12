import { describe, expect, it } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { getManagedServiceDashboard } from "./managed-service-dashboard.js";
import { providerCostToMicros, recordProviderApiCostObservation } from "./managed-service-cost-observations.js";

describe("managed provider API cost observations", () => {
  it("converts decimal amounts to micros without floating point and rounds half up", () => {
    expect(providerCostToMicros("0.004500")).toBe(4500);
    expect(providerCostToMicros("1.0000005")).toBe(1_000_001);
    expect(providerCostToMicros("1.0000004")).toBe(1_000_000);
    expect(() => providerCostToMicros("-0.01")).toThrow("provider_cost_amount_invalid");
  });

  it("stores hashed provider references idempotently and exposes provenance in the owner dashboard", async () => {
    const f = fixture();
    const input = { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: null, provider: "telnyx", serviceId: "phone-number",
      operationRef: "telnyx-message-private-123", accountRef: "provider-account-private-123", usageKind: "sms" as const,
      quantityUnit: "message", quantityMicros: 1_000_000, providerCost: "0.004500", currency: "USD",
      periodStart: "2026-11-12T01:00:00.000Z", sourceApi: "telnyx.messages.get", observedAt: "2026-11-12T01:01:00.000Z" };
    await expect(recordProviderApiCostObservation(f.db, input)).resolves.toMatchObject({
      inserted: true, replayed: false, provenance: "provider_api_observed", providerCostMicros: 4500,
    });
    await expect(recordProviderApiCostObservation(f.db, input)).resolves.toMatchObject({ inserted: false, replayed: true });
    const stored = await f.db.prepare("SELECT operation_ref_sha256,account_ref_sha256,evidence_sha256,source_api,provider_cost_micros FROM managed_service_provider_cost_observations")
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({ source_api: "telnyx.messages.get", provider_cost_micros: 4500 });
    expect(stored?.operation_ref_sha256).not.toBe(input.operationRef);
    expect(stored?.account_ref_sha256).not.toBe(input.accountRef);
    expect(JSON.stringify(stored)).not.toContain("private");

    const dashboard = await getManagedServiceDashboard(f.env, scope, new Date("2026-11-12T02:00:00.000Z"));
    expect(dashboard.providerCosts30d).toEqual([{
      provider: "telnyx", serviceId: "phone-number", usageKind: "sms", currency: "USD",
      providerCostMicros: 4500, receiptCount: 1, provenance: "provider_api_observed",
    }]);
  });
});
