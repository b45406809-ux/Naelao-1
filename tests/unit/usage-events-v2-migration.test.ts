import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "usage-events-test-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("usage events v2 migration", () => {
  it("preserves legacy rows while adding scoped reconciliation dimensions and constraints", () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    db.db.exec("INSERT INTO usage_events(id,org_id,event_type,quantity,recorded_at) VALUES('old','tenant','llm_tokens',50,'2026-01-01T00:00:00Z')");
    const row = db.db.prepare("SELECT schema_version,unit,project_id,payer_kind FROM usage_events WHERE id='old'").get();
    expect(row).toEqual({ schema_version: 1, unit: "units", project_id: null, payer_kind: null });
    expect(() => db.db.exec("UPDATE usage_events SET payer_kind='unknown-value' WHERE id='old'")).toThrow();
    db.db.close();
  });

  it("writes a project wallet event through the real route without duplicating subscription metering", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    const metered: unknown[] = [];
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await billingWorker.fetch(new Request("https://billing.naelao.com/billing/usage", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ schema_version: 2, event_type: "project_llm_tokens", quantity: 100, unit: "tokens", cost_credits: 2,
        space_id: "space-a", project_id: "project-a", installation_id: "install-a", run_id: "run-a", provider: "openrouter",
        model_id: "openrouter/vendor/model", connector_provider: "whatsapp", runtime_tier: 2, subject_hash: "b".repeat(64),
        payer_kind: "space_wallet", decision: "allowed", rate_card_version: "openrouter:catalog-1", idempotency_key: "event-a" }),
    }), { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db, QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} },
      BILLING_EVENTS: { async send(event: unknown) { metered.push(event); } } } as never, ctx);
    expect(response.status).toBe(201);
    expect(db.db.prepare("SELECT schema_version,unit,cost_credits,project_id,installation_id,run_id,provider,model_id,connector_provider,runtime_tier,subject_hash,payer_kind,decision,rate_card_version FROM usage_events").get())
      .toMatchObject({ schema_version: 2, unit: "tokens", cost_credits: 2, project_id: "project-a", installation_id: "install-a", run_id: "run-a",
        provider: "openrouter", model_id: "openrouter/vendor/model", connector_provider: "whatsapp", runtime_tier: 2, subject_hash: "b".repeat(64),
        payer_kind: "space_wallet", decision: "allowed", rate_card_version: "openrouter:catalog-1" });
    expect(metered).toEqual([]);
    db.db.close();
  });
});
