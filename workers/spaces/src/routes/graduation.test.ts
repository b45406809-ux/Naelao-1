import { certifyStateDeltaArtifact } from "@naelao/security";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
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
  const batches: unknown[][] = [];
  const db = {
    prepare(query: string) {
      return {
        bind: (..._values: unknown[]) => ({
          async first() {
            if (query.includes("FROM spaces WHERE id"))
              return { id: "space-a", name: "Studio" };
            if (query.includes("FROM blueprint_export_jobs"))
              return { artifact_key: "exports/job-a.json" };
            return null;
          },
        }),
      };
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
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
        if (key === `blueprints/${blueprint.id}.json`)
          return { json: async () => envelope };
        return null;
      },
    },
  } as unknown as Env;
  return { app, bindings, batches };
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
});
