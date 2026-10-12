import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { certifyStateDeltaArtifact, type ConformanceSuite } from "@naelao/security";
import { app } from "../../workers/marketplace/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

const suite: ConformanceSuite = {
  rules: [{ id: "prohibited", match: "prohibited" }],
  fixtures: Array.from({ length: 50 }, (_, i) => ({ id: `fixture-${i}`, text: i % 2 ? "prohibited" : "allowed", expected: i % 2 ? "violation" : "compliant" })),
};
function harness() {
  const db = createFakeD1(["0026_marketplace.sql", "0078_template_subscriptions.sql", "0079_fde_graduation.sql", "0083_marketplace_conformance_receipts.sql", "0084_marketplace_forks.sql", "0086_developer_settlement.sql", "0088_fde_royalty_events.sql", "0089_marketplace_license_sales.sql"].map(name => readFileSync(new URL(`../../infra/migrations/${name}`, import.meta.url), "utf8")));
  const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "secret", ENVIRONMENT: "test" };
  const request = (path: string, method = "GET", body?: unknown, role = "member", tenant = "tenant-a") => app.request(path, {
    method, headers: { "content-type": "application/json", "x-naelao-tenant-id": tenant, "x-naelao-user-id": "user-a", "x-naelao-role": role },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return { db, request };
}
async function submit(h: ReturnType<typeof harness>, price = 0) {
  const artifact = { id: "type-a", version: 1 };
  const certificate = await certifyStateDeltaArtifact(artifact, suite, { runner: "naelao-state-delta-v1", passed: 50, total: 50, securityViolations: 0, tokensUsed: 0, maximumCostUpperBoundUsd: 0.025, diagnostics: [] }, "secret", "tenant-a");
  const response = await h.request("/v1/marketplace", "POST", { space_type_id: "type-a", name: "Template", description: "Demo", category: "other", conformance_artifact: artifact, conformance_certificate: certificate, pricing_model: price ? "fixed_license" : "freemium_tiered", price_cents: price });
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
}
describe("marketplace routes with migrated SQLite", () => {
  it("blocks unsigned submissions and approval without admin authority", async () => {
    const h = harness();
    expect((await h.request("/v1/marketplace", "POST", { space_type_id: "type-a", name: "A", description: "B", category: "other" })).status).toBe(422);
    const id = await submit(h);
    expect((await h.request(`/v1/marketplace/${id}/review`, "PATCH", { action: "approve" })).status).toBe(403);
    h.db.db.close();
  });
  it("publishes, lists, reviews and replay-safely forks against the actual schema", async () => {
    const h = harness(); const id = await submit(h);
    expect((await h.request(`/v1/marketplace/${id}/review`, "PATCH", { action: "approve" }, "platform_admin")).status).toBe(200);
    expect(await (await h.request("/v1/marketplace?q=Template")).json()).toMatchObject({ meta: { total: 1 }, data: [{ id, tags: [] }] });
    expect(await (await h.request(`/v1/marketplace/${id}`)).json()).toMatchObject({ id, name: "Template" });
    for (const rating of [2, 5]) expect((await h.request(`/v1/marketplace/${id}/reviews`, "POST", { rating, body: "Useful" })).status).toBe(201);
    expect(await (await h.request(`/v1/marketplace/${id}`)).json()).toMatchObject({ avg_rating: 5, rating_count: 1 });
    for (let i = 0; i < 2; i++) expect((await h.request(`/v1/marketplace/${id}/fork`, "POST")).status).toBe(201);
    expect(await (await h.request(`/v1/marketplace/${id}`)).json()).toMatchObject({ install_count: 1 });
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM marketplace_forks").get()).toMatchObject({ n: 1 });
    h.db.db.close();
  });
  it("blocks tampered artifacts and bypassing paid-license billing", async () => {
    const h = harness(); const id = await submit(h, 4900);
    expect((await h.request(`/v1/marketplace/${id}/review`, "PATCH", { action: "approve" }, "platform_admin")).status).toBe(200);
    expect((await h.request(`/v1/marketplace/${id}/fork`, "POST")).status).toBe(402);
    h.db.db.prepare("UPDATE marketplace_listings SET conformance_artifact_json = ? WHERE id = ?").run('{"id":"type-a","version":2}', id);
    expect((await h.request(`/v1/marketplace/${id}/review`, "PATCH", { action: "approve" }, "platform_admin")).status).toBe(422);
    h.db.db.close();
  });
});
