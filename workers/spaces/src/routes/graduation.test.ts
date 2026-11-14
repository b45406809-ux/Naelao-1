import { certifyStateDeltaArtifact } from "@naelao/security";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import type { Env } from "../index.js";
import { registerGraduationRoutes } from "./graduation.js";

const blueprint = {
  id: "tpl_graduation_test",
  schemaVersion: "2.0",
  metadata: { name: "Graduation test" },
  templateCategory: "other",
  projects: [],
  requiredExtensions: [],
  requiredCredentials: [],
};
const suite = {
  fixtures: Array.from({ length: 50 }, (_, index) => ({
    id: `fixture-${index}`,
  })),
};
const report = {
  runner: "naelao-state-delta-v1" as const,
  passed: 50,
  total: 50,
  securityViolations: 0,
  tokensUsed: 0,
  maximumCostUpperBoundUsd: 0.025,
  diagnostics: [],
};

function harness(envelope: unknown) {
  const batches: unknown[][] = [], storage = createDOStorage();
  storage.sql.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE blueprint_export_jobs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,artifact_key TEXT NOT NULL);
    CREATE TABLE marketplace_listings(
      id TEXT PRIMARY KEY,space_type_id TEXT NOT NULL,tenant_id TEXT NOT NULL,developer_user_id TEXT NOT NULL,author_name TEXT NOT NULL,
      name TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,pricing TEXT NOT NULL,pricing_model TEXT NOT NULL,
      price_cents INTEGER NOT NULL,plan_gated_features_json TEXT NOT NULL,status TEXT NOT NULL,blueprint_id TEXT NOT NULL,
      published_at TEXT NOT NULL,conformance_artifact_json TEXT NOT NULL,conformance_certificate_json TEXT NOT NULL
    );
    CREATE TABLE fde_graduations(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,developer_id TEXT NOT NULL,
      stage TEXT NOT NULL,blueprint_id TEXT,listing_id TEXT,UNIQUE(space_id,stage));
    CREATE TABLE developer_partner_profiles(user_id TEXT PRIMARY KEY,handle TEXT NOT NULL UNIQUE,status TEXT NOT NULL,pioneer_rank INTEGER);`);
  storage.sql.exec("INSERT INTO spaces(id,tenant_id,name,status) VALUES('space-a','tenant-a','Studio','active')");
  storage.sql.exec("INSERT INTO blueprint_export_jobs(id,tenant_id,space_id,artifact_key) VALUES('job-a','tenant-a','space-a','exports/job-a.json')");
  const db = {
    prepare(query: string) {
      return {
        bind: (...values: unknown[]) => ({ query, values,
          async first() {
            return storage.sql.exec(query, ...values).toArray()[0] ?? null;
          },
          async run() { const result = storage.sql.exec(query, ...values); return { success: true, meta: { changes: result.rowsWritten } }; },
        }),
      };
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
      storage.transactionSync(() => {
        for (const statement of statements as Array<{ query: string; values: unknown[] }>) storage.sql.exec(statement.query, ...statement.values);
      });
      return [];
    },
  } as unknown as D1Database;
  const app = new Hono<{ Bindings: Env }>();
  registerGraduationRoutes(app);
  const bindings = {
    PLATFORM_DB: db,
    PLATFORM_SECRET: "graduation-secret",
    SCRIPTS_R2: {
      get: async (key: string) => {
        if (key === "exports/job-a.json")
          return { json: async () => ({ blueprint }) };
        if (key === `blueprints/tenant-a/${blueprint.id}.json` || key === `blueprints/${blueprint.id}.json`)
          return { json: async () => envelope };
        return null;
      },
    },
  } as unknown as Env;
  return { app, bindings, batches, storage };
}

describe("tenant-owned certified Space Template graduation", () => {
  it("publishes only the exact tenant-certified export", async () => {
    const certificate = await certifyStateDeltaArtifact(
      blueprint,
      suite,
      report,
      "graduation-secret",
      "tenant-a"
    );
    if (!certificate) throw new Error("test_certificate_not_issued");
    const h = harness({
      blueprint: { ...blueprint, securityRating: "low" },
      conformanceCertificate: certificate,
    });
    const response = await h.app.request(
      "/spaces/space-a/graduate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "owner-a",
          "x-naelao-role": "owner",
        },
        body: JSON.stringify({ conformance_job_id: "job-a" }),
      },
      h.bindings
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      space_id: "space-a",
      stage: "marketplace_published",
      blueprint_id: blueprint.id,
    });
    expect(h.batches).toHaveLength(1);
  });

  it("rejects stale or cross-tenant certification before writing a marketplace listing", async () => {
    const certificate = await certifyStateDeltaArtifact(
      blueprint,
      suite,
      report,
      "graduation-secret",
      "another-tenant"
    );
    if (!certificate) throw new Error("test_certificate_not_issued");
    const h = harness({ blueprint, conformanceCertificate: certificate });
    const response = await h.app.request(
      "/spaces/space-a/graduate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": "owner-a",
          "x-naelao-role": "owner",
        },
        body: JSON.stringify({ conformance_job_id: "job-a" }),
      },
      h.bindings
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error_code: "conformance_certificate_invalid",
    });
    expect(h.batches).toHaveLength(0);
  });

  it("returns the existing listing on a lost-response retry without writing a second listing", async () => {
    const certificate = await certifyStateDeltaArtifact(
      blueprint,
      suite,
      report,
      "graduation-secret",
      "tenant-a"
    );
    if (!certificate) throw new Error("test_certificate_not_issued");
    const h = harness({ blueprint, conformanceCertificate: certificate });
    const request = () => h.app.request("/spaces/space-a/graduate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-user-id": "owner-a",
        "x-naelao-role": "owner",
      },
      body: JSON.stringify({ conformance_job_id: "job-a" }),
    }, h.bindings);
    const first = await request(), firstBody = await first.json() as { listing_id: string };
    expect(first.status).toBe(201);
    const retry = await request(), retryBody = await retry.json() as { listing_id: string; alreadyPublished?: boolean };
    expect(retry.status).toBe(200);
    expect(retryBody).toMatchObject({ listing_id: firstBody.listing_id, alreadyPublished: true });
    expect(h.batches).toHaveLength(1);
  });

  it("serializes concurrent duplicate graduation requests to one published listing", async () => {
    const certificate = await certifyStateDeltaArtifact(blueprint, suite, report, "graduation-secret", "tenant-a");
    if (!certificate) throw new Error("test_certificate_not_issued");
    const h = harness({ blueprint, conformanceCertificate: certificate });
    const request = () => h.app.request("/spaces/space-a/graduate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        "x-naelao-user-id": "owner-a",
        "x-naelao-role": "owner",
      },
      body: JSON.stringify({ conformance_job_id: "job-a" }),
    }, h.bindings);
    const responses = await Promise.all([request(), request()]);
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ listing_id: string }>));
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(bodies[0]?.listing_id).toBe(bodies[1]?.listing_id);
    expect(h.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM marketplace_listings WHERE status='published'").toArray())
      .toEqual([{ count: 1 }]);
    expect(h.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM fde_graduations WHERE stage='marketplace_published'").toArray())
      .toEqual([{ count: 1 }]);
  });
});
