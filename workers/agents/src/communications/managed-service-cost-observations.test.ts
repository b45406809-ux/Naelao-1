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

  it("reports settled OpenRouter decision costs from the existing ledger with exact project scope", async () => {
    const f = fixture();
    const insert = `INSERT INTO decision_call_reservations(
      id,org_id,space_id,project_id,run_id,model_id,price_snapshot,input_usd_per_token,output_usd_per_token,
      max_tokens,max_credits,status,actual_tokens,cost_credits,rate_card_version,provider_generation_id,
      provider_cost_usd,usage_evidence_source,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const save = (id: string, projectId: string, status: string, cost: number, source: string) => f.db.prepare(insert).bind(
      id, scope.tenantId, scope.spaceId, projectId, `run-${id}`, "openai/gpt-4o-mini", "2026-11-12T01:00:00.000Z",
      0.0000001, 0.0000004, 1000, 100, status, 12, 1, `openrouter:generation:gen-${id}`, `gen-${id}`,
      cost, source, "2026-11-12 01:00:00", "2026-11-12 01:01:00",
    ).run();
    await save("decision-a", "project-a", "settled", 0.001, "openrouter_response");
    await save("decision-b", "project-a", "settled", 0.002, "openrouter_generation_api");
    await save("decision-c", "project-b", "settled", 0.004, "openrouter_generation_api");
    await save("decision-pending", "project-a", "uncertain", 0.5, "openrouter_generation_api");

    const dashboard = await getManagedServiceDashboard(f.env, { ...scope, projectId: "project-a" }, new Date("2026-11-12T02:00:00.000Z"));
    expect(dashboard.decisionModelCosts30d).toEqual([
      { provider: "openrouter", modelId: "openai/gpt-4o-mini", currency: "USD", providerCostMicros: 2000,
        receiptCount: 1, evidenceSource: "openrouter_generation_api" },
      { provider: "openrouter", modelId: "openai/gpt-4o-mini", currency: "USD", providerCostMicros: 1000,
        receiptCount: 1, evidenceSource: "openrouter_response" },
    ]);
  });
});
