import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "workflow-budget-v2-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("workflow budget v2 settlement", () => {
  it("retains project, installation and tier scope through one plan quota settlement", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0081_workflow_budget_reservations.sql"), "utf8"),
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
      readFileSync(join(__dirname, "../../infra/migrations/0110_workflow_usage_dimensions.sql"), "utf8"),
    ]);
    const metered: Array<Record<string, unknown>> = [];
    const token = await mintInternalToken(SECRET, "tenant-a");
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db,
      QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} },
      BILLING_EVENTS: { async send(event: Record<string, unknown>) { metered.push(event); } } } as never;
    const headers = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token };
    const reserved = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/workflows/budget/reserve", {
      method: "POST", headers, body: JSON.stringify({ reservation_id: "run-a", workflow_id: "run-a", space_id: "space-a",
        budget_key: "workflow:vertical_extension:project-a", credits: 9, project_id: "project-a", installation_id: "install-a", runtime_tier: 5,
        expires_at: new Date(Date.now() + 60_000).toISOString() }),
    }), env, ctx);
    expect(reserved.status).toBe(201);
    const mismatchedReplay = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/workflows/budget/reserve", {
      method: "POST", headers, body: JSON.stringify({ reservation_id: "run-a", workflow_id: "run-a", space_id: "space-a",
        budget_key: "workflow:vertical_extension:project-b", credits: 9, project_id: "project-b", installation_id: "install-a", runtime_tier: 5,
        expires_at: new Date(Date.now() + 60_000).toISOString() }),
    }), env, ctx);
    expect(mismatchedReplay.status).toBe(409);

    const settled = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/workflows/budget/settle", {
      method: "POST", headers, body: JSON.stringify({ reservation_id: "run-a", quantity: 6 }),
    }), env, ctx);
    expect(settled.status).toBe(200);
    expect(db.db.prepare("SELECT schema_version,unit,quantity,cost_credits,project_id,installation_id,run_id,runtime_tier,payer_kind,decision FROM usage_events").get())
      .toEqual({ schema_version: 2, unit: "credits", quantity: 6, cost_credits: 6, project_id: "project-a",
        installation_id: "install-a", run_id: "run-a", runtime_tier: 5, payer_kind: "plan_quota", decision: "charged" });
    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({ schema_version: 2, unit: "credits", project_id: "project-a", installation_id: "install-a", runtime_tier: 5 });
    db.db.close();
  });
});
