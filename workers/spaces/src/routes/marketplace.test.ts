import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { certifyArtifact, MIN_MARKETPLACE_FIXTURES, type ConformanceSuite } from "@naelao/security";
import { registerMarketplaceRoutes } from "./marketplace.js";

function buildSuite(): ConformanceSuite {
  return {
    rules: [{ id: "flagged", match: "prohibited" }],
    fixtures: Array.from({ length: MIN_MARKETPLACE_FIXTURES }, (_, index) => ({
      id: `fixture-${index}`,
      text: index % 2 ? "This is prohibited." : "This is compliant.",
      expected: index % 2 ? "violation" as const : "compliant" as const,
    })),
  };
}

function harness() {
  let listing: Record<string, unknown> | null = null;
  let updates = 0;
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.startsWith("INSERT INTO marketplace_listings")) {
                listing = {
                  id: values[0], space_type_id: values[1], tenant_id: values[2],
                  pricing_model: values[8], price_cents: values[9], plan_gated_features_json: values[10],
                  conformance_artifact_json: values[11], conformance_certificate_json: values[12],
                };
              } else if (query.startsWith("UPDATE marketplace_listings")) updates++;
              return { success: true };
            },
            async first() {
              return listing;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const app = new Hono<{ Bindings: { PLATFORM_DB: D1Database; PLATFORM_SECRET: string } }>();
  registerMarketplaceRoutes(app);
  return { app, bindings: { PLATFORM_DB: db, PLATFORM_SECRET: "secret" }, updates: () => updates, tamper: () => { if (listing) listing.conformance_artifact_json = JSON.stringify({ id: "changed" }); } };
}

describe("marketplace conformance publication gate", () => {
  it("blocks submissions without a server-signed, artifact-bound 50-fixture receipt", async () => {
    const h = harness();
    const response = await h.app.request("/marketplace/listings", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ space_type_id: "type-a", author_name: "A", name: "Test", description: "Test", pricing_model: "freemium_tiered", price_cents: 0 }),
    }, h.bindings);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error_code: "conformance_certificate_invalid" });
  });

  it("requires and rechecks the persisted receipt immediately before publishing", async () => {
    const h = harness();
    const artifact = { id: "type-a", version: 1 };
    const { certificate } = await certifyArtifact(artifact, buildSuite(), "secret");
    const submitted = await h.app.request("/marketplace/listings", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ space_type_id: "type-a", author_name: "A", name: "Test", description: "Test", pricing_model: "freemium_tiered", price_cents: 0, conformance_artifact: artifact, conformance_certificate: certificate }),
    }, h.bindings);
    expect(submitted.status).toBe(201);
    const { id } = await submitted.json<{ id: string }>();
    const published = await h.app.request(`/marketplace/listings/${id}/publish`, {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-a" },
    }, h.bindings);
    expect(published.status).toBe(200);
    expect(h.updates()).toBe(1);
  });

  it("blocks publication if the stored artifact changed after certification", async () => {
    const h = harness();
    const artifact = { id: "type-a", version: 1 };
    const { certificate } = await certifyArtifact(artifact, buildSuite(), "secret");
    const submitted = await h.app.request("/marketplace/listings", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ space_type_id: "type-a", author_name: "A", name: "Test", description: "Test", pricing_model: "freemium_tiered", price_cents: 0, conformance_artifact: artifact, conformance_certificate: certificate }),
    }, h.bindings);
    const { id } = await submitted.json<{ id: string }>();
    h.tamper();
    const response = await h.app.request(`/marketplace/listings/${id}/publish`, {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-a" },
    }, h.bindings);
    expect(response.status).toBe(422);
    expect(h.updates()).toBe(0);
  });
});
