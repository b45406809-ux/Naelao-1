import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certifyStateDeltaArtifact } from "../../packages/security/src/marketplace-conformance.js";
import { settleMarketplaceLicenseEvent } from "../../workers/billing/src/marketplace-licenses.js";
import { reserveDeveloperPayout } from "../../workers/billing/src/payout-reconciliation.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

describe("paid marketplace license settlement", () => {
  it("grants the certified tenant fork and developer earning once from a captured payment", async () => {
    const migrations = ["0026_marketplace.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0083_marketplace_conformance_receipts.sql", "0084_marketplace_forks.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql", "0090_marketplace_license_overpayments.sql"];
    const db = createFakeD1(migrations.map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
    const secret = "test-marketplace-secret";
    const artifact = { id: "blueprint-1", projects: [] };
    const suite = { fixtures: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, input: {}, seed: {}, assertions: [], expectedFiles: {} })) };
    const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, secret, "seller");
    db.db.prepare(`INSERT INTO marketplace_listings (id,space_type_id,tenant_id,developer_user_id,author_name,name,description,category,pricing,pricing_model,price_cents,conformance_artifact_json,conformance_certificate_json,status)
      VALUES ('listing','blueprint-1','seller','developer','Developer','Test Blueprint','Description','other','paid','fixed_license',4900,?,?,'published')`)
      .run(JSON.stringify(artifact), JSON.stringify(certificate));
    const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: secret };
    const event = { type: "payment.success", provider: "lemon_squeezy", spaceId: "buyer", customerId: "customer", subscriptionId: null,
      providerEventId: "ls-order-1", variantOrPriceId: "variant", amountCents: 4900, currency: "USD", metadata: { kind: "marketplace_license", listing_id: "listing", buyer_tenant_id: "buyer" } } as const;
    await expect(settleMarketplaceLicenseEvent(event, env)).resolves.toBe(true);
    await expect(settleMarketplaceLicenseEvent(event, env)).resolves.toBe(true);
    await expect(settleMarketplaceLicenseEvent({ ...event, providerEventId: "ls-order-duplicate" }, env)).resolves.toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_license_purchases").get()).toMatchObject({ n: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks WHERE tenant_id='buyer'").get()).toMatchObject({ n: 1 });
    expect(db.db.prepare("SELECT amount_cents FROM developer_license_earnings").get()).toMatchObject({ amount_cents: 4900 });
    expect(db.db.prepare("SELECT provider_event_id, status FROM marketplace_license_overpayments").get()).toMatchObject({ provider_event_id: "ls-order-duplicate", status: "refund_required" });
    const payout = await reserveDeveloperPayout(env.PLATFORM_DB, "developer");
    expect(payout?.amount_cents).toBe(4900);
    db.db.close();
  });
});
