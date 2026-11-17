import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { app } from "../index.js";

const secret = "runtime-budget-reservations-route-secret";

async function fixture(role: "owner" | "admin" | "member" = "owner") {
  const db = createFakeD1([`CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL);
    CREATE TABLE workflow_budget_reservations(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT NOT NULL,workflow_id TEXT NOT NULL,
      budget_key TEXT NOT NULL,credits INTEGER NOT NULL,status TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      project_id TEXT,installation_id TEXT,runtime_tier INTEGER);
    CREATE TABLE usage_events(org_id TEXT NOT NULL,space_id TEXT NOT NULL,project_id TEXT,run_id TEXT,event_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,recorded_at TEXT NOT NULL);`]);
  await db.prepare("INSERT INTO spaces(id,tenant_id,status) VALUES('space-a','tenant-a','active')").run();
  await db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('tenant-a','user-a',?)").bind(role).run();
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
    SPACES_WORKER: { fetch: async () => Response.json({ project_id: "project-a" }) },
  } as never;
  const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a",
    "x-naelao-role": role, "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
  return { db, env, headers };
}

describe("Project runtime budget reservation status", () => {
  it("shows only exact Project Tier 5 container holds and settled internal-credit usage", async () => {
    const f = await fixture("admin");
    const insert = (id: string, status: string, project: string, tier: number, budgetKey: string, installationId: string | null = null) => f.db.prepare(`INSERT INTO workflow_budget_reservations
      (id,org_id,space_id,workflow_id,budget_key,credits,status,expires_at,created_at,updated_at,project_id,installation_id,runtime_tier)
      VALUES(?,?,?,?,?,300,?,'2099-01-01T00:00:00.000Z',?,'2026-11-17T10:01:00.000Z',?,?,?)`)
      .bind(id, "tenant-a", "space-a", id, budgetKey, status, id.endsWith("settled") ? "2026-11-17T10:00:01.000Z" : "2026-11-17T10:00:00.000Z", project, installationId, tier).run();
    await insert("container:held", "held", "project-a", 5, "container:space-a:project-a");
    await insert("container:settled", "settled", "project-a", 5, "container:space-a:project-a");
    await insert("container:other-project", "held", "project-b", 5, "container:space-a:project-b");
    await insert("workflow:other-tier", "held", "project-a", 4, "container:space-a:project-a");
    await insert("container:sidecar", "held", "project-a", 5, "container:space-a:project-a", "install-a");
    await f.db.prepare(`INSERT INTO usage_events(org_id,space_id,project_id,run_id,event_type,quantity,recorded_at)
      VALUES('tenant-a','space-a','project-a','container:settled','infra_credits',120,'2026-11-17T10:02:00.000Z')`).run();

    const response = await app.request("/spaces/space-a/projects/project-a/runtime-budget-reservations", { headers: f.headers }, f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ source: "workflow_budget_reservations_and_usage_events", costUnit: "internal_credits",
      providerInvoiceVerified: false, reservations: [
        { reservationId: "container:settled", status: "settled", reservedCredits: 300, chargedCredits: 120,
          createdAt: "2026-11-17T10:00:01.000Z", updatedAt: "2026-11-17T10:01:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" },
        { reservationId: "container:held", status: "held", reservedCredits: 300, chargedCredits: null,
          createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:01:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" },
      ] });
  });

  it("denies members before reading reservation records", async () => {
    const f = await fixture("member");
    const response = await app.request("/spaces/space-a/projects/project-a/runtime-budget-reservations", { headers: f.headers }, f.env);
    expect(response.status).toBe(403);
  });
});
