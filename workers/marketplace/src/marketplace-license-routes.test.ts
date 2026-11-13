import { mintInternalToken } from "@naelao/http";
import { certifyStateDeltaArtifact } from "@naelao/security";
import { describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

const secret = "marketplace-license-test-secret";
async function database(input: { purchased?: boolean; forked?: boolean } = {}) {
  const artifact = { id: "type-a", version: 1 };
  const certificate = await certifyStateDeltaArtifact(artifact, {}, {
    runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0,
    tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [],
  }, secret, "author-tenant");
  if (!certificate) throw new Error("test_certificate_unavailable");
  const listing = {
    id: "listing-a", tenant_id: "author-tenant", developer_user_id: "author-user", name: "Support template",
    description: "A support template.", status: "published", pricing_model: "fixed_license", price_cents: 2500,
    ls_license_variant_id: "variant-1", space_type_id: "type-a", conformance_artifact_json: JSON.stringify(artifact),
    conformance_certificate_json: JSON.stringify(certificate),
  };
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        queries.push({ sql, values });
        return {
          async first() {
            if (sql.includes("FROM marketplace_listings")) return listing;
            if (sql.includes("FROM marketplace_license_purchases")) return input.purchased ? { id: "purchase-a" } : null;
            if (sql.includes("FROM marketplace_forks")) return input.forked ? { id: "fork-a" } : null;
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
          async all() { return { results: [] }; },
        };
      }};
    },
  };
  return { db, queries };
}

async function headers(tenantId = "buyer-tenant") {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-user-id": "buyer-user",
    "x-naelao-role": "owner",
    "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
  };
}

describe("marketplace listing license lifecycle", () => {
  it("reports license and fork state only for the authenticated buyer tenant", async () => {
    const state = await database({ purchased: true, forked: false });
    const response = await app.request("/v1/marketplace/listing-a/license-status", {
      headers: await headers(),
    }, { ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: state.db } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ listing_id: "listing-a", licensed: true, forked: false, status: "available" });
    expect(state.queries.map(query => query.values[0])).toEqual(["listing-a", "buyer-tenant", "buyer-tenant"]);
  });

  it("fails closed before billing when the trusted Marketplace return origin is not configured", async () => {
    const state = await database();
    const billing = { fetch: vi.fn(async () => Response.json({ checkout_url: "https://billing.example/checkout" })) };
    const response = await app.request("/v1/marketplace/listing-a/license-checkout", {
      method: "POST", headers: await headers(), body: "{}",
    }, { ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: state.db, BILLING_WORKER: billing } as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error_code: "marketplace_checkout_return_url_unconfigured" });
    expect(billing.fetch).not.toHaveBeenCalled();
  });

  it("passes a fixed configured listing return URL through the signed billing request", async () => {
    const state = await database();
    const billing = { fetch: vi.fn(async (request: Request) => {
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ checkout_url: "https://billing.example/checkout", price_cents: 2500, currency: "USD" });
    }) };
    const response = await app.request("/v1/marketplace/listing-a/license-checkout", {
      method: "POST", headers: await headers(), body: "{}",
    }, { ENVIRONMENT: "test", PLATFORM_SECRET: secret, PLATFORM_DB: state.db, BILLING_WORKER: billing,
      MARKETPLACE_WEB_URL: "https://marketplace.example" } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkout_url: "https://billing.example/checkout", price_cents: 2500, currency: "USD" });
    const billingRequest = billing.fetch.mock.calls[0]?.[0];
    expect(JSON.parse(await billingRequest?.text()!)).toEqual({
      listing_id: "listing-a", buyer_tenant_id: "buyer-tenant",
      success_url: "https://marketplace.example/listing/listing-a?license=complete",
    });
  });
});
