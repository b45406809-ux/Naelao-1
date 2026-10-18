import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "llm-reservation-v2-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("LLM quota reservation v2 settlement", () => {
  it("settles a run into one plan quota event with model and cost provenance", async () => {
    const db = createFakeD1([
      `CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE);`,
      readFileSync(join(__dirname, "../../infra/migrations/0098_llm_token_reservations.sql"), "utf8"),
      readFileSync(join(__dirname, "../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    ]);
    db.db.prepare(`INSERT INTO llm_token_reservations(id,org_id,space_id,run_id,estimated_tokens,status,expires_at)
      VALUES(?,?,?,?,?,'held',datetime('now','+10 minutes'))`).run("hold-1", "tenant-a", "space-a", "run-a", 500);
    const metered: Array<Record<string, unknown>> = [];
    const token = await mintInternalToken(SECRET, "tenant-a");
    const response = await billingWorker.fetch(new Request("https://billing.naelao.com/internal/usage/llm-tokens/reservations/settle", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      body: JSON.stringify({ run_id: "run-a", actual_tokens: 240, model_id: "openai/gpt-4.1-mini", cost_credits: 4, rate_card_version: "catalog-2026-10-18" }),
    }), { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, PLATFORM_DB: db, QUOTA_CACHE: { async get() { return null; }, async put() {}, async delete() {} },
      BILLING_EVENTS: { async send(event: Record<string, unknown>) { metered.push(event); } } } as never, ctx);

    expect(response.status).toBe(200);
    expect(db.db.prepare("SELECT schema_version,unit,quantity,cost_credits,rate_card_version,provider,model_id,payer_kind,decision FROM usage_events").get())
      .toEqual({ schema_version: 2, unit: "tokens", quantity: 240, cost_credits: 4,
        rate_card_version: "catalog-2026-10-18", provider: "openai", model_id: "openai/gpt-4.1-mini",
        payer_kind: "plan_quota", decision: "charged" });
    expect(db.db.prepare("SELECT status FROM llm_token_reservations WHERE id='hold-1'").get()).toEqual({ status: "settled" });
    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({ schema_version: 2, unit: "tokens", payer_kind: "plan_quota", cost_credits: 4 });
    db.db.close();
  });
});
