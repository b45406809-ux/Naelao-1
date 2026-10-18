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

  it("stores connector attempts with an opaque customer subject and leaves provider cost unassigned", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    const metered: unknown[] = [];
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await billingWorker.fetch(new Request("https://billing.naelao.com/billing/usage", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ schema_version: 2, event_type: "connector_calls", quantity: 1, unit: "invocations",
        space_id: "space-a", project_id: "project-a", installation_id: "install-a", run_id: "run-a",
        connector_provider: "whatsapp", subject_hash: "c".repeat(64), payer_kind: "unknown", decision: "failed",
        idempotency_key: "channel-delivery:install-a:run-a" }),
    }), { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db,
      QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} },
      BILLING_EVENTS: { async send(event: unknown) { metered.push(event); } } } as never, ctx);
    expect(response.status).toBe(201);
    expect(db.db.prepare("SELECT event_type,unit,cost_credits,project_id,installation_id,run_id,connector_provider,subject_hash,payer_kind,decision FROM usage_events").get())
      .toEqual({ event_type: "connector_calls", unit: "invocations", cost_credits: null, project_id: "project-a",
        installation_id: "install-a", run_id: "run-a", connector_provider: "whatsapp", subject_hash: "c".repeat(64),
        payer_kind: "unknown", decision: "failed" });
    expect(metered).toHaveLength(1);
    db.db.close();
  });

  it("stores measured Knowledge R2 bytes as usage while leaving storage cost unpriced", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    const metered: unknown[] = [];
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await billingWorker.fetch(new Request("https://billing.naelao.com/billing/usage", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ schema_version: 2, event_type: "storage_bytes_written", quantity: 1536, unit: "bytes",
        space_id: "space-a", project_id: "project-a", payer_kind: "unknown", decision: "allowed", idempotency_key: "knowledge-storage:doc-a" }),
    }), { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db,
      QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} },
      BILLING_EVENTS: { async send(event: unknown) { metered.push(event); } } } as never, ctx);
    expect(response.status).toBe(201);
    expect(db.db.prepare("SELECT event_type,unit,quantity,cost_credits,project_id,payer_kind,decision FROM usage_events").get())
      .toEqual({ event_type: "storage_bytes_written", unit: "bytes", quantity: 1536, cost_credits: null,
        project_id: "project-a", payer_kind: "unknown", decision: "allowed" });
    expect(metered).toHaveLength(1);
    db.db.close();
  });

  it("scopes caller-supplied idempotency keys to the verified tenant", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db,
      QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} }, BILLING_EVENTS: { async send() {} } } as never;
    for (const tenant of ["tenant-a", "tenant-b"]) {
      const token = await mintInternalToken(SECRET, tenant);
      const response = await billingWorker.fetch(new Request("https://billing.naelao.com/billing/usage", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenant, "x-naelao-internal-token": token },
        body: JSON.stringify({ schema_version: 2, event_type: "connector_calls", quantity: 1, unit: "invocations",
          payer_kind: "unknown", decision: "allowed", idempotency_key: "same-event-id" }),
      }), env, ctx);
      expect(response.status).toBe(201);
    }
    expect(db.db.prepare("SELECT org_id FROM usage_events ORDER BY org_id").all()).toEqual([{ org_id: "tenant-a" }, { org_id: "tenant-b" }]);
    db.db.close();
  });

  it("returns an admin-facing project usage summary scoped to its tenant, space, and project", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    const insert = db.db.prepare(`INSERT INTO usage_events(id,org_id,space_id,event_type,quantity,recorded_at,unit,cost_credits,
      project_id,installation_id,provider,connector_provider,payer_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("p1", "tenant-a", "space-a", "project_llm_tokens", 1, new Date().toISOString(), "tokens", 4, "project-a", "install-a", "openrouter", null, "space_wallet");
    insert.run("p2", "tenant-a", "space-a", "connector_calls", 3, new Date().toISOString(), "invocations", null, "project-a", "install-a", null, "whatsapp", "unknown");
    insert.run("other-project", "tenant-a", "space-a", "connector_calls", 99, new Date().toISOString(), "invocations", 99, "project-b", "install-b", null, "telegram", "space_wallet");
    insert.run("other-tenant", "tenant-b", "space-a", "connector_calls", 99, new Date().toISOString(), "invocations", 99, "project-a", "install-b", null, "telegram", "space_wallet");

    const token = await mintInternalToken(SECRET, "tenant-a");
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db,
      QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} }, BILLING_EVENTS: { async send() {} } } as never;
    const response = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/usage/project-summary?space_id=space-a&project_id=project-a&days=30", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project_id: "project-a", space_id: "space-a", days: 30,
      cost_credits: 4, event_count: 2, unpriced_event_count: 1,
      breakdown: [
        { event_type: "project_llm_tokens", unit: "tokens", payer_kind: "space_wallet", installation_id: "install-a", provider: "openrouter", event_count: 1, quantity: 1, cost_credits: 4, unpriced_event_count: 0 },
        { event_type: "connector_calls", unit: "invocations", payer_kind: "unknown", installation_id: "install-a", connector_provider: "whatsapp", event_count: 1, quantity: 3, cost_credits: null, unpriced_event_count: 1 },
      ],
    });
    const invalidPeriod = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/usage/project-summary?space_id=space-a&project_id=project-a&days=2", {
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    }), env, ctx);
    expect(invalidPeriod.status).toBe(400);
    db.db.close();
  });
});
