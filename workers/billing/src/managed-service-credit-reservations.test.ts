import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";
import { dispatchManagedServiceMeterOutbox } from "./index.js";
import { createFakeD1 } from "../../../tests/stubs/d1-sqlite.js";

const secret = "managed-service-test-secret";

function harness(planTier = "free") {
  const db = createFakeD1([
    `CREATE TABLE orgs(id TEXT PRIMARY KEY,plan_tier TEXT); INSERT INTO orgs VALUES('org-a','${planTier}'); CREATE TABLE subscriptions(org_id TEXT PRIMARY KEY); CREATE TABLE invoices(stripe_invoice_id TEXT);`,
    `CREATE TABLE assistant_agentmail_accounts(id TEXT PRIMARY KEY,tenant_id TEXT,space_id TEXT,project_id TEXT,mode TEXT,inbox_id TEXT,pod_id TEXT,agentport_agent_id TEXT,agentport_account_id TEXT,owner_user_id TEXT,status TEXT,email_address TEXT,created_at TEXT,updated_at TEXT);`,
    readFileSync(join(__dirname, "../../../infra/migrations/0179_managed_services_control_plane.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0007_billing_meters.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0032_usage_events_idempotency.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0081_workflow_budget_reservations.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0109_usage_events_v2.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0180_managed_service_credit_reservations.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0181_managed_service_ownership_and_audit.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0182_managed_service_plan_entitlements.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0188_managed_service_model_entitlements.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0209_managed_service_model_price_contract.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0210_managed_model_operation_results.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0220_managed_service_operation_quotes.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0221_managed_service_exact_prices_and_quote_binding.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0192_managed_service_provider_cost_receipts.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0194_agentport_scoped_managed_service_spend.sql"), "utf8"),
    readFileSync(join(__dirname, "../../../infra/migrations/0201_managed_service_meter_outbox.sql"), "utf8"),
  ]);
  const quotaValues = new Map<string, string>();
  const queueState: { messages: Array<Record<string, unknown>>; failNext: boolean } = { messages: [], failNext: false };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: secret,
    MANAGED_SERVICES_OPERATOR_SECRET: "operator-test-secret",
    PLATFORM_DB: db,
    QUOTA_CACHE: {
      get: async (key: string) => quotaValues.get(key) ?? null,
      put: async (key: string, value: string) => quotaValues.set(key, value),
      delete: async (key: string) => quotaValues.delete(key),
    },
    BILLING_EVENTS: { send: async (message: Record<string, unknown>) => {
      if (queueState.failNext) { queueState.failNext = false; throw new Error("queue_send_failed"); }
      queueState.messages.push(message);
    } },
  };
  const post = async (path: string, body: Record<string, unknown>, authorized = true) => {
    const token = authorized ? await mintInternalToken(secret, "org-a") : "invalid";
    return worker.fetch(new Request(`https://billing.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "org-a",
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify(body),
    }), env as never, {} as never);
  };
  const operator = async (path: string, body: Record<string, unknown>, key = "operator-test-secret") => worker.fetch(new Request(`https://billing.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-managed-services-operator-key": key, "x-managed-services-operator-id": "operator-1" },
    body: JSON.stringify(body),
  }), env as never, {} as never);
  return { db, post, operator, queueState, env };
}

function enableAgentMailEntitlement(db: ReturnType<typeof createFakeD1>["db"], planTier = "free") {
  db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='test-operator',verified_at=datetime('now'),
    valid_until='2099-01-01T00:00:00.000Z',regions_json='["us"]',operations_json='["provision","renew"]',account_modes_json='["naelao_managed"]'
    WHERE provider='agentmail' AND service_id='agentmail' AND version=1`).run();
  for (const operationName of ["provision","renew"]) db.prepare(`INSERT INTO managed_service_plan_entitlements(
    plan_tier,provider,service_id,capability_version,operation_name,region,price_version,max_credits_per_operation,credits_per_operation,max_operations_per_period,status,verified_by,verified_at,valid_until,created_at,updated_at)
    VALUES(?, 'agentmail','agentmail',1,?,'us','agentmail-rental-v1',10000,300,NULL,'active','test-operator',datetime('now'),'2099-01-01T00:00:00.000Z',datetime('now'),datetime('now'))`)
    .run(planTier,operationName);
}

function addAgentMailMandate(db: ReturnType<typeof createFakeD1>["db"], maxCredits = 300, autoRenew = 1) {
  db.prepare(`INSERT INTO managed_service_payer_mandates(id,tenant_id,payer_type,payer_id,mandate_key,authorized_by_user_id,
    operation_scopes_json,max_credits_per_operation,auto_renew,status,created_at,updated_at,agentport_agent_id,max_credits_per_period,period_days)
    VALUES('mandate-agentmail','org-a','organization','org-a','agentmail:agent-a','user-a',?, ?, ?, 'active',datetime('now'),datetime('now'),'agent-a',?,30)`)
    .run(JSON.stringify(["agentmail:agentmail:provision","agentmail:agentmail:renew"]),maxCredits,autoRenew,maxCredits*2);
}

function allowAgentMailPayer(db: ReturnType<typeof createFakeD1>["db"], maxCredits = 300, autoRenew = 1, planTier = "free") {
  enableAgentMailEntitlement(db,planTier);
  addAgentMailMandate(db,maxCredits,autoRenew);
}

function createOperation(db: ReturnType<typeof createFakeD1>["db"], input: typeof reservation, region = "us") {
  const quoteId=`msq_${createHash("sha256").update(input.operation_id).digest("hex").slice(0,32)}`;
  (input as typeof reservation & {quote_id?:string;requester_user_id?:string}).quote_id=quoteId;
  (input as typeof reservation & {quote_id?:string;requester_user_id?:string}).requester_user_id="user-a";
  db.prepare(`UPDATE managed_service_plan_entitlements SET credits_per_operation=? WHERE plan_tier='free' AND provider=? AND service_id=? AND operation_name=? AND region=?`)
    .run(input.credits,input.provider,input.service_id,input.operation_name,region);
  db.prepare(`INSERT INTO managed_service_operations(operation_id,tenant_id,space_id,provider,service_id,operation_name,region,capability_version,idempotency_key,request_sha256,status,quote_id,created_at,updated_at)
    VALUES(?,'org-a',? ,?,?,?, ?,1,?,?, 'running',?,datetime('now'),datetime('now'))`)
    .run(input.operation_id,input.space_id,input.provider,input.service_id,input.operation_name,region,input.operation_id,"0".repeat(64),quoteId);
  db.prepare(`INSERT INTO managed_service_operation_quotes(quote_id,tenant_id,space_id,requester_user_id,plan_tier,provider,service_id,operation_name,
      region,capability_version,price_version,credits,request_sha256,status,operation_id,expires_at,consumed_at,created_at)
    VALUES(?,'org-a',?,'user-a','free',?,?,?,?,1,?,?,?,'consumed',?,datetime('now','+3 minutes'),datetime('now'),datetime('now'))`)
    .run(quoteId,input.space_id,input.provider,input.service_id,input.operation_name,region,input.price_version,input.credits,"0".repeat(64),input.operation_id);
}

const reservation = {
  reservation_id: "agentmail-rent-op-a",
  operation_id: "agentmail-op-a",
  space_id: "space-a",
  provider: "agentmail",
  service_id: "agentmail",
  operation_name: "provision",
  region: "us",
  payer_type: "organization",
  payer_id: "org-a",
  agentport_agent_id: "agent-a",
  credits: 300,
  price_version: "agentmail-rental-v1",
};

describe("managed service credit reservations", () => {
  it("authorizes internal calls, deduplicates holds, retains uncertain outcomes, and settles once", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db);
    createOperation(h.db.db,reservation);
    const denied = await h.post("/internal/managed-services/credits/reserve", reservation, false);
    expect(denied.status).toBe(403);

    const held = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(held.status).toBe(201);
    expect(await held.json()).toMatchObject({ reserved: true, status: "held", credits: 300 });
    const duplicate = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ reserved: true, deduplicated: true });

    const uncertain = await h.post("/internal/managed-services/credits/uncertain", { reservation_id: reservation.reservation_id });
    expect(uncertain.status).toBe(200);
    expect(h.db.db.prepare("SELECT status,expires_at FROM managed_service_credit_reservations WHERE id=?").get(reservation.reservation_id)).toEqual({ status: "uncertain", expires_at: null });

    const settled = await h.post("/internal/managed-services/credits/settle", { reservation_id: reservation.reservation_id, credits: 175 });
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ settled: true, credits: 175 });
    const replay = await h.post("/internal/managed-services/credits/settle", { reservation_id: reservation.reservation_id, credits: 175 });
    expect(await replay.json()).toMatchObject({ settled: true, deduplicated: true });
    const resumed = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(await resumed.json()).toMatchObject({ reserved: true, status: "settled", deduplicated: true });
    const resumedSettlement = await h.post("/internal/managed-services/credits/settle", { reservation_id: reservation.reservation_id, credits: 175 });
    expect(await resumedSettlement.json()).toMatchObject({ settled: true, deduplicated: true });
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE event_type='infra_credits'").get()).toEqual({ count: 1 });
    expect(h.db.db.prepare("SELECT quantity,provider,model_id,run_id,payer_kind,decision FROM usage_events WHERE id=?").get(`managed-service:org-a:${reservation.reservation_id}`)).toEqual({
      quantity: 175,
      provider: "agentmail",
      model_id: null,
      run_id: "agentmail-op-a",
      payer_kind: "plan_quota",
      decision: "charged",
    });
    expect(h.db.db.prepare("SELECT status,attempt_count FROM managed_service_meter_outbox WHERE event_id=?").get(`managed-service:org-a:${reservation.reservation_id}`))
      .toEqual({ status: "sent", attempt_count: 1 });
    expect(h.queueState.messages).toHaveLength(1);
  });

  it("retries a managed-service meter intent after a queue send failure without settling twice", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db);
    createOperation(h.db.db,reservation);
    await h.post("/internal/managed-services/credits/reserve", reservation);
    h.queueState.failNext = true;
    const settled = await h.post("/internal/managed-services/credits/settle", { reservation_id: reservation.reservation_id, credits: 175 });
    expect(settled.status).toBe(200);
    expect(h.db.db.prepare("SELECT status,attempt_count,last_error FROM managed_service_meter_outbox WHERE event_id=?")
      .get(`managed-service:org-a:${reservation.reservation_id}`)).toMatchObject({ status: "pending", attempt_count: 1, last_error: "queue_send_failed" });
    expect(h.queueState.messages).toHaveLength(0);

    const retry = await dispatchManagedServiceMeterOutbox(h.env as never, new Date(Date.now() + 10 * 60_000));
    expect(retry).toEqual({ claimed: 1, sent: 1, deferred: 0 });
    expect(h.queueState.messages).toHaveLength(1);
    expect(h.queueState.messages[0]).toMatchObject({ type: "meter", event_id: `managed-service:org-a:${reservation.reservation_id}`, quantity: 175 });
    expect(h.db.db.prepare("SELECT status,attempt_count,last_error FROM managed_service_meter_outbox WHERE event_id=?")
      .get(`managed-service:org-a:${reservation.reservation_id}`)).toMatchObject({ status: "sent", attempt_count: 2, last_error: null });

    const replay = await h.post("/internal/managed-services/credits/settle", { reservation_id: reservation.reservation_id, credits: 175 });
    expect(await replay.json()).toMatchObject({ settled: true, deduplicated: true });
    expect(h.queueState.messages).toHaveLength(1);
  });

  it("counts workflow holds and unresolved managed effects against the same allowance", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db);
    createOperation(h.db.db,reservation);
    h.db.db.prepare(`INSERT INTO workflow_budget_reservations(id,org_id,space_id,workflow_id,budget_key,credits,status,expires_at)
      VALUES('workflow-a','org-a','space-a','workflow-a','shared',4800,'held',datetime('now','+1 hour'))`).run();
    const overQuotaOperation={...reservation,reservation_id:"agentmail-over-quota",operation_id:"agentmail-over-quota-op",credits:201};
    createOperation(h.db.db,overQuotaOperation);
    const overQuota = await h.post("/internal/managed-services/credits/reserve", overQuotaOperation);
    expect(overQuota.status).toBe(402);

    h.db.db.prepare("UPDATE workflow_budget_reservations SET status='released' WHERE id='workflow-a'").run();
    h.db.db.prepare("UPDATE managed_service_plan_entitlements SET credits_per_operation=300 WHERE operation_name='provision'").run();
    const held = await h.post("/internal/managed-services/credits/reserve", { ...reservation, credits: 300 });
    expect(held.status).toBe(201);
    await h.post("/internal/managed-services/credits/uncertain", { reservation_id: reservation.reservation_id });
    const next={...reservation,reservation_id:"agentmail-rent-op-b",operation_id:"agentmail-op-b",credits:4801};createOperation(h.db.db,next);
    const stillOverQuota = await h.post("/internal/managed-services/credits/reserve", next);
    expect(stillOverQuota.status).toBe(402);
  });

  it("uses the D1 conditional insert as the concurrency boundary for simultaneous reservations", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db, 10_000, 1);
    const first = { ...reservation, reservation_id: "agentmail-race-a", operation_id: "agentmail-race-op-a", credits: 3_000 };
    const second = { ...reservation, reservation_id: "agentmail-race-b", operation_id: "agentmail-race-op-b", credits: 3_000 };
    createOperation(h.db.db, first);
    createOperation(h.db.db, second);
    const results = await Promise.all([
      h.post("/internal/managed-services/credits/reserve", first),
      h.post("/internal/managed-services/credits/reserve", second),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 402]);
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_credit_reservations WHERE status='held'").get()).toEqual({ count: 1 });
    expect(h.db.db.prepare("SELECT SUM(credits) AS total FROM managed_service_credit_reservations WHERE status='held'").get()).toEqual({ total: 3_000 });
  });

  it("enforces the operation-count entitlement atomically and still resumes its own expired hold", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db, 10_000, 1);
    h.db.db.prepare("UPDATE managed_service_plan_entitlements SET max_operations_per_period=1 WHERE operation_name='provision'").run();
    const first = { ...reservation, reservation_id: "agentmail-count-a", operation_id: "agentmail-count-op-a" };
    const second = { ...reservation, reservation_id: "agentmail-count-b", operation_id: "agentmail-count-op-b" };
    createOperation(h.db.db, first);
    createOperation(h.db.db, second);

    const results = await Promise.all([
      h.post("/internal/managed-services/credits/reserve", first),
      h.post("/internal/managed-services/credits/reserve", second),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 402]);
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_credit_reservations WHERE operation_name='provision' AND status='held'").get())
      .toEqual({ count: 1 });

    const held = h.db.db.prepare("SELECT id,operation_id FROM managed_service_credit_reservations WHERE operation_name='provision' AND status='held'").get() as {id:string;operation_id:string};
    const admitted = held.operation_id === first.operation_id ? first : second;
    expect((await h.post("/internal/managed-services/credits/reserve", admitted)).status).toBe(200);
    h.db.db.prepare("UPDATE managed_service_credit_reservations SET expires_at=datetime('now','-1 minute') WHERE id=?").run(held.id);
    expect((await h.post("/internal/managed-services/credits/reserve", admitted)).status).toBe(200);
    expect(h.db.db.prepare("SELECT status,expires_at>? AS active FROM managed_service_credit_reservations WHERE id=?").get(new Date().toISOString(),held.id))
      .toEqual({ status: "held", active: 1 });
  });

  it("requires explicit no-effect resolution before releasing an uncertain reservation", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db);
    createOperation(h.db.db,reservation);
    await h.post("/internal/managed-services/credits/reserve", reservation);
    await h.post("/internal/managed-services/credits/uncertain", { reservation_id: reservation.reservation_id });
    expect((await h.post("/internal/managed-services/credits/release", { reservation_id: reservation.reservation_id })).status).toBe(409);
    const released = await h.post("/internal/managed-services/credits/release", { reservation_id: reservation.reservation_id, outcome: "no_effect" });
    expect(released.status).toBe(200);
    expect(h.db.db.prepare("SELECT status FROM managed_service_credit_reservations WHERE id=?").get(reservation.reservation_id)).toEqual({ status: "released" });
  });

  it("requires an active scoped payer mandate and enforces its per-operation limit", async () => {
    const h = harness();
    enableAgentMailEntitlement(h.db.db);
    createOperation(h.db.db,reservation);
    expect((await h.post("/internal/managed-services/credits/reserve", reservation)).status).toBe(403);
    addAgentMailMandate(h.db.db,200,0);
    expect((await h.post("/internal/managed-services/credits/reserve", reservation)).status).toBe(402);
    h.db.db.prepare("UPDATE managed_service_payer_mandates SET max_credits_per_operation=300").run();
    const renewal={...reservation,reservation_id:"agentmail-rent-renew",operation_id:"agentmail-op-renew",operation_name:"renew"};
    createOperation(h.db.db,renewal);
    expect((await h.post("/internal/managed-services/credits/reserve",renewal)).status).toBe(403);
  });

  it("requires an exact AgentMail quote and replays it after active price changes",async()=>{
    const h=harness();allowAgentMailPayer(h.db.db);createOperation(h.db.db,reservation);
    const noQuote=await h.post("/internal/managed-services/credits/reserve",{...reservation,quote_id:undefined,requester_user_id:undefined});
    expect(noQuote.status).toBe(400);
    expect(await noQuote.json()).toMatchObject({error_code:"bad_request"});
    const underpriced=await h.post("/internal/managed-services/credits/reserve",{...reservation,credits:299});
    expect(underpriced.status).toBe(409);
    expect(await underpriced.json()).toMatchObject({error_code:"managed_service_price_conflict"});
    const admitted=await h.post("/internal/managed-services/credits/reserve",reservation);
    expect(admitted.status).toBe(201);
    h.db.db.prepare(`UPDATE managed_service_plan_entitlements SET price_version='agentmail-rental-v3',credits_per_operation=250
      WHERE plan_tier='free' AND provider='agentmail' AND service_id='agentmail' AND operation_name='provision'`).run();
    const replay=await h.post("/internal/managed-services/credits/reserve",reservation);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({reserved:true,status:"held",credits:300,deduplicated:true});
  });

  it("binds reservations to the delegated AgentPort agent and enforces its rolling spend cap", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db, 300, 1);
    createOperation(h.db.db, reservation);
    const otherAgent = await h.post("/internal/managed-services/credits/reserve", { ...reservation, agentport_agent_id: "agent-b" });
    expect(otherAgent.status).toBe(403);

    const held = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(held.status).toBe(201);
    expect(h.db.db.prepare("SELECT agentport_agent_id,payer_mandate_id FROM managed_service_credit_reservations WHERE id=?")
      .get(reservation.reservation_id)).toEqual({ agentport_agent_id: "agent-a", payer_mandate_id: "mandate-agentmail" });

    const second = { ...reservation, reservation_id: "agentmail-rent-op-b", operation_id: "agentmail-op-b" };
    createOperation(h.db.db, second);
    expect((await h.post("/internal/managed-services/credits/reserve", second)).status).toBe(201);
    const third = { ...reservation, reservation_id: "agentmail-rent-op-c", operation_id: "agentmail-op-c", credits: 1 };
    createOperation(h.db.db, third);
    const overScopedCap = await h.post("/internal/managed-services/credits/reserve", third);
    expect(overScopedCap.status).toBe(402);
    expect(await overScopedCap.json()).toMatchObject({ error_code: "payer_mandate_period_limit_exceeded", period_days: 30 });
  });

  it("revalidates held operations before reuse and renews an expired hold under both quota guards", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db, 300, 1);
    createOperation(h.db.db, reservation);
    expect((await h.post("/internal/managed-services/credits/reserve", reservation)).status).toBe(201);
    h.db.db.prepare("UPDATE managed_service_credit_reservations SET expires_at=datetime('now','-1 hour') WHERE id=?").run(reservation.reservation_id);

    const renewed = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ status: "held", deduplicated: true });
    expect(h.db.db.prepare("SELECT expires_at>? AS active FROM managed_service_credit_reservations WHERE id=?").get(new Date().toISOString(),reservation.reservation_id))
      .toEqual({ active: 1 });

    h.db.db.prepare("UPDATE managed_service_plan_entitlements SET status='disabled' WHERE operation_name='provision'").run();
    const disabledRetry = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(disabledRetry.status).toBe(403);
    expect(await disabledRetry.json()).toMatchObject({ error_code: "managed_service_not_entitled" });
    h.db.db.prepare("UPDATE managed_service_plan_entitlements SET status='active' WHERE operation_name='provision'").run();
    h.db.db.prepare("UPDATE managed_service_payer_mandates SET status='revoked' WHERE id='mandate-agentmail'").run();
    const revokedRetry = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(revokedRetry.status).toBe(403);
    expect(await revokedRetry.json()).toMatchObject({ error_code: "payer_mandate_required" });
  });

  it("rechecks a held operation against a subsequently lowered agent spend cap", async () => {
    const h = harness();
    allowAgentMailPayer(h.db.db, 300, 1);
    createOperation(h.db.db, reservation);
    expect((await h.post("/internal/managed-services/credits/reserve", reservation)).status).toBe(201);

    const second = { ...reservation, reservation_id: "agentmail-rent-op-cap", operation_id: "agentmail-op-cap" };
    createOperation(h.db.db, second);
    expect((await h.post("/internal/managed-services/credits/reserve", second)).status).toBe(201);
    h.db.db.prepare("UPDATE managed_service_payer_mandates SET max_credits_per_period=500 WHERE id='mandate-agentmail'").run();

    const retry = await h.post("/internal/managed-services/credits/reserve", reservation);
    expect(retry.status).toBe(402);
    expect(await retry.json()).toMatchObject({ error_code: "payer_mandate_period_limit_exceeded", period_days: 30 });
  });

  it("requires the org plan's active provider, operation, region and price entitlement", async () => {
    const h=harness("free");
    allowAgentMailPayer(h.db.db,300,1,"business");
    createOperation(h.db.db,reservation);
    const denied=await h.post("/internal/managed-services/credits/reserve",reservation);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({error_code:"managed_service_not_entitled"});
  });

  it("lets only a keyed operator enable an entitlement tied to current verified capability evidence", async () => {
    const h=harness();
    const at=new Date().toISOString(),validUntil=new Date(Date.now()+60*86400_000).toISOString();
    h.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='operator-1',verified_at=?,valid_until=?,
      regions_json='["us"]',operations_json='["provision"]',account_modes_json='["naelao_managed"]',
      metering_json='{"priceVersion":"agentmail-rental-v1","chargeModel":"monthly-rental"}',evidence_json='[{"url":"https://docs.agentmail.to/messages","checkedAt":"2026-11-11T00:00:00.000Z"}]'
      WHERE provider='agentmail' AND service_id='agentmail' AND version=1`).run(at,validUntil);
    const body={plan_tier:"free",provider:"agentmail",service_id:"agentmail",operation_name:"provision",region:"us",price_version:"agentmail-rental-v1",
      credits_per_operation:240,max_credits_per_operation:300,max_operations_per_period:10,valid_until:validUntil,reason:"Current product and region allowance reviewed for the provider pilot."};
    const missingExact={...body,credits_per_operation:undefined};
    expect((await h.operator("/internal/managed-services/entitlements/verify",missingExact)).status).toBe(400);
    expect((await h.operator("/internal/managed-services/entitlements/verify",{...body,credits_per_operation:301})).status).toBe(400);
    expect((await h.operator("/internal/managed-services/entitlements/verify",body,"wrong")).status).toBe(403);
    const verified=await h.operator("/internal/managed-services/entitlements/verify",body);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({verified:true,planTier:"free",provider:"agentmail",serviceId:"agentmail",operation:"provision",region:"us",creditsPerOperation:240,capabilityVersion:1});
    expect(h.db.db.prepare("SELECT status,price_version,credits_per_operation,max_credits_per_operation,max_operations_per_period,verified_by FROM managed_service_plan_entitlements WHERE plan_tier='free'").get())
      .toMatchObject({status:"active",price_version:"agentmail-rental-v1",credits_per_operation:240,max_credits_per_operation:300,max_operations_per_period:10,verified_by:"operator-1"});
    expect(h.db.db.prepare("SELECT action,actor_id FROM managed_service_entitlement_audit").get()).toMatchObject({action:"verified",actor_id:"operator-1"});
    const disabled=await h.operator("/internal/managed-services/entitlements/disable",{plan_tier:"free",provider:"agentmail",service_id:"agentmail",operation_name:"provision",region:"us",reason:"The subscription allowance is paused for review."});
    expect(disabled.status).toBe(200);
    expect(h.db.db.prepare("SELECT status FROM managed_service_plan_entitlements WHERE plan_tier='free'").get()).toEqual({status:"disabled"});
  });

  it("requires an operator-verified exact model entitlement and records that model in the shared ledger", async () => {
    const h=harness();
    const validUntil=new Date(Date.now()+60*86_400_000).toISOString();
    h.db.db.prepare(`INSERT INTO managed_service_capability_versions(provider,service_id,version,category,operations_json,regions_json,account_modes_json,
      isolation_model,metering_json,evidence_json,status,verified_by,verified_at,valid_until,created_at,updated_at)
      VALUES('higgsfield','higgsfield',1,'generation','["generate"]','["us"]','["naelao_managed"]','operator-scoped-broker',
      '{"priceVersion":"higgsfield-models-v1"}','[{"url":"https://open.higgsfield.ai/quick-start","checkedAt":"2026-11-11T00:00:00.000Z"}]',
      'verified','operator-1',datetime('now'),?,datetime('now'),datetime('now'))`).run(validUntil);
    const entitlement={plan_tier:"free",provider:"higgsfield",service_id:"higgsfield",operation_name:"generate",model_id:"higgsfield/flux-pro",region:"us",
      price_version:"higgsfield-models-v1",credits_per_operation:50,max_output_tokens:1024,max_credits_per_operation:100,max_operations_per_period:4,valid_until:validUntil,
      reason:"Exact model and price were reviewed for the brokered pilot.",evidence:[{url:"https://open.higgsfield.ai/quick-start",checkedAt:"2026-11-11T00:00:00.000Z",note:"Model API contract"}]};
    expect((await h.operator("/internal/managed-services/model-entitlements/verify",entitlement,"wrong")).status).toBe(403);
    const verified=await h.operator("/internal/managed-services/model-entitlements/verify",entitlement);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({verified:true,provider:"higgsfield",modelId:"higgsfield/flux-pro",region:"us",evidenceSha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
    h.db.db.prepare(`INSERT INTO managed_service_payer_mandates(id,tenant_id,payer_type,payer_id,mandate_key,authorized_by_user_id,
      operation_scopes_json,max_credits_per_operation,auto_renew,status,created_at,updated_at,agentport_agent_id,max_credits_per_period,period_days)
      VALUES('mandate-higgsfield','org-a','organization','org-a','project-a','user-a','["higgsfield:higgsfield:generate"]',100,0,'active',datetime('now'),datetime('now'),'agent-a',200,30)`).run();
    const modelOperation={...reservation,quote_id:undefined,requester_user_id:undefined,reservation_id:"higgsfield-model-reservation",operation_id:"higgsfield-model-operation",provider:"higgsfield",
      service_id:"higgsfield",operation_name:"generate",model_id:"higgsfield/flux-pro",credits:50,price_version:"higgsfield-models-v1",payer_mandate_id:"mandate-higgsfield"};
    h.db.db.prepare(`INSERT INTO managed_service_operations(operation_id,tenant_id,space_id,provider,service_id,operation_name,model_id,region,capability_version,
      idempotency_key,request_sha256,status,created_at,updated_at) VALUES(?, 'org-a', ?, 'higgsfield','higgsfield','generate',?,'us',1,?,?,'running',datetime('now'),datetime('now'))`)
      .run(modelOperation.operation_id,modelOperation.space_id,modelOperation.model_id,modelOperation.operation_id,"1".repeat(64));
    const underpriced=await h.post("/internal/managed-services/credits/reserve",{...modelOperation,credits:49,reservation_id:"higgsfield-model-underpriced"});
    expect(underpriced.status).toBe(409);
    expect(await underpriced.json()).toMatchObject({error_code:"managed_service_model_price_conflict"});
    const held=await h.post("/internal/managed-services/credits/reserve",modelOperation);
    expect(held.status).toBe(201);
    const undercharged=await h.post("/internal/managed-services/credits/settle",{reservation_id:modelOperation.reservation_id,credits:37});
    expect(undercharged.status).toBe(409);
    const wrongOperation={...modelOperation,reservation_id:"higgsfield-model-wrong-mandate",operation_id:"higgsfield-model-wrong-operation"};
    h.db.db.prepare(`INSERT INTO managed_service_operations(operation_id,tenant_id,space_id,provider,service_id,operation_name,model_id,region,capability_version,
      idempotency_key,request_sha256,status,created_at,updated_at) VALUES(?, 'org-a', ?, 'higgsfield','higgsfield','generate',?,'us',1,?,?,'running',datetime('now'),datetime('now'))`)
      .run(wrongOperation.operation_id,wrongOperation.space_id,wrongOperation.model_id,wrongOperation.operation_id,"2".repeat(64));
    const wrongMandate=await h.post("/internal/managed-services/credits/reserve",{...wrongOperation,payer_mandate_id:"missing-mandate"});
    expect(wrongMandate.status).toBe(403);
    expect(await wrongMandate.json()).toMatchObject({error_code:"payer_mandate_required"});
    const settled=await h.post("/internal/managed-services/credits/settle",{reservation_id:modelOperation.reservation_id,credits:50});
    expect(settled.status).toBe(200);
    expect(h.db.db.prepare("SELECT model_id,quantity FROM usage_events WHERE id=?").get(`managed-service:org-a:${modelOperation.reservation_id}`))
      .toEqual({model_id:"higgsfield/flux-pro",quantity:50});
    const disabled=await h.operator("/internal/managed-services/model-entitlements/disable",{...entitlement,reason:"Model policy paused after the review."});
    expect(disabled.status).toBe(200);
  });

  it("accepts a documented Cloudflare @cf model ID in operator pricing admission", async () => {
    const h=harness();
    const at=new Date().toISOString(),validUntil=new Date(Date.now()+60*86_400_000).toISOString();
    h.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='operator-1',verified_at=?,valid_until=?,
      regions_json='["global"]',operations_json='["generate-text"]',account_modes_json='["naelao_managed"]',
      metering_json='{"priceVersion":"cf-llama-fixed-v1"}'
      WHERE provider='cloudflare' AND service_id='workers-ai' AND version=1`).run(at,validUntil);
    const entitlement={plan_tier:"free",provider:"cloudflare",service_id:"workers-ai",operation_name:"generate-text",
      model_id:"@cf/meta/llama-3.1-8b-instruct-fp8",region:"global",price_version:"cf-llama-fixed-v1",credits_per_operation:55,
      max_output_tokens:768,max_credits_per_operation:100,max_operations_per_period:5,valid_until:validUntil,
      reason:"Exact model, provider terms and fixed credit price were reviewed for this gated service.",
      evidence:[{url:"https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/",checkedAt:at,note:"Model API and availability"}]};
    const response=await h.operator("/internal/managed-services/model-entitlements/verify",entitlement);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({verified:true,provider:"cloudflare",modelId:entitlement.model_id,region:"global"});
  });

  it("requires the exact consumed operation quote at the Cloudflare model credit boundary", async () => {
    const h=harness();
    const at=new Date().toISOString(),validUntil=new Date(Date.now()+60*86_400_000).toISOString();
    h.db.db.prepare(`UPDATE managed_service_capability_versions SET status='verified',verified_by='operator-1',verified_at=?,valid_until=?,
      regions_json='["global"]',operations_json='["generate-text"]',account_modes_json='["naelao_managed"]'
      WHERE provider='cloudflare' AND service_id='workers-ai' AND version=1`).run(at,validUntil);
    h.db.db.prepare(`INSERT INTO managed_service_model_entitlements(
      plan_tier,provider,service_id,capability_version,operation_name,model_id,region,price_version,max_credits_per_operation,
      max_operations_per_period,evidence_json,evidence_sha256,status,verified_by,verified_at,valid_until,created_at,updated_at,
      credits_per_operation,max_output_tokens)
      VALUES('free','cloudflare','workers-ai',1,'generate-text','@cf/meta/llama-3.1-8b-instruct-fp8','global','cf-llama-fixed-v1',100,5,
        '[]',?,'active','operator-1',?,?,?, ?,55,768)`)
      .run("a".repeat(64),at,validUntil,at,at);
    h.db.db.prepare(`INSERT INTO managed_service_payer_mandates(id,tenant_id,payer_type,payer_id,mandate_key,authorized_by_user_id,
      operation_scopes_json,max_credits_per_operation,auto_renew,status,created_at,updated_at,max_credits_per_period,period_days)
      VALUES('mandate-model','org-a','organization','org-a','model-op','owner','["cloudflare:workers-ai:generate-text"]',55,0,'active',datetime('now'),datetime('now'),55,30)`).run();
    const quoteId=`msq_${"a".repeat(32)}`,operationId="model-operation-with-quote";
    h.db.db.prepare(`INSERT INTO managed_service_operations(operation_id,tenant_id,space_id,provider,service_id,operation_name,model_id,region,
      capability_version,idempotency_key,request_sha256,status,price_version,quote_id,created_at,updated_at)
      VALUES(?,'org-a','space-a','cloudflare','workers-ai','generate-text','@cf/meta/llama-3.1-8b-instruct-fp8','global',1,?,?,'running','cf-llama-fixed-v1',?,datetime('now'),datetime('now'))`)
      .run(operationId,operationId,"c".repeat(64),quoteId);
    h.db.db.prepare(`INSERT INTO managed_service_operation_quotes(quote_id,tenant_id,space_id,requester_user_id,plan_tier,provider,service_id,
      operation_name,model_id,region,capability_version,price_version,credits,max_output_tokens,status,operation_id,expires_at,consumed_at,created_at)
      VALUES(?,'org-a','space-a','owner','free','cloudflare','workers-ai','generate-text','@cf/meta/llama-3.1-8b-instruct-fp8','global',1,
        'cf-llama-fixed-v1',55,768,'consumed',?,'2099-01-01T00:00:00.000Z',datetime('now'),datetime('now'))`).run(quoteId,operationId);
    const request={reservation_id:"model-reservation",operation_id:operationId,space_id:"space-a",provider:"cloudflare",service_id:"workers-ai",
      operation_name:"generate-text",model_id:"@cf/meta/llama-3.1-8b-instruct-fp8",region:"global",payer_type:"organization",payer_id:"org-a",
      payer_mandate_id:"mandate-model",requester_user_id:"owner",credits:55,price_version:"cf-llama-fixed-v1"};
    const noQuote=await h.post("/internal/managed-services/credits/reserve",request);
    expect(noQuote.status).toBe(400);
    const wrongQuote=await h.post("/internal/managed-services/credits/reserve",{...request,quote_id:`msq_${"b".repeat(32)}`});
    expect(wrongQuote.status).toBe(409);
    expect(await wrongQuote.json()).toMatchObject({error_code:"managed_service_operation_not_admitted"});
    const wrongOwner=await h.post("/internal/managed-services/credits/reserve",{...request,requester_user_id:"other",quote_id:quoteId});
    expect(wrongOwner.status).toBe(409);
    expect(await wrongOwner.json()).toMatchObject({error_code:"managed_service_operation_quote_required"});
    const admitted=await h.post("/internal/managed-services/credits/reserve",{...request,quote_id:quoteId});
    expect(admitted.status).toBe(201);
    expect(h.db.db.prepare("SELECT quote_id,credits,price_version FROM managed_service_credit_reservations WHERE id='model-reservation'").get())
      .toEqual({quote_id:quoteId,credits:55,price_version:"cf-llama-fixed-v1"});
  });

  it("imports provider-cost evidence with hashed references, idempotent reconciliation, and separate credit accounting", async () => {
    const h = harness();
    const receipt = {
      provider: "agentmail", serviceId: "agentmail", statementRef: "invoice-nov-2026", receiptRef: "line-1",
      accountRef: "sensitive-provider-account", operationRef: "managed-op-private", usageKind: "email", quantityUnit: "message",
      periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-11-30T23:59:59.999Z", quantityMicros: 1_000_000,
      providerCostMicros: 125_000, currency: "USD", evidenceSha256: "b".repeat(64),
    };
    const payload = { tenant_id: "org-a", space_id: "space-a", project_id: "project-a", receipts: [receipt] };
    expect((await h.operator("/internal/managed-services/provider-cost-receipts/import", payload, "wrong-key")).status).toBe(403);
    const inserted = await h.operator("/internal/managed-services/provider-cost-receipts/import", payload);
    expect(inserted.status).toBe(201);
    expect(await inserted.json()).toEqual({ inserted: 1, replayed: 0, provenance: "operator_imported" });
    const replay = await h.operator("/internal/managed-services/provider-cost-receipts/import", payload);
    expect(await replay.json()).toEqual({ inserted: 0, replayed: 1, provenance: "operator_imported" });

    const row = h.db.db.prepare("SELECT account_ref_hash,operation_ref_hash,provider_cost_micros,currency,provenance FROM managed_service_provider_cost_receipts").get() as Record<string, unknown>;
    expect(row).toMatchObject({ provider_cost_micros: 125_000, currency: "USD", provenance: "operator_imported" });
    expect(JSON.stringify(row)).not.toContain("sensitive-provider-account");
    expect(JSON.stringify(row)).not.toContain("managed-op-private");
    const conflict = await h.operator("/internal/managed-services/provider-cost-receipts/import", {
      ...payload, receipts: [{ ...receipt, providerCostMicros: 130_000 }],
    });
    expect(conflict.status).toBe(409);

    const summary = await h.operator("/internal/managed-services/provider-cost-receipts/summary", {
      tenant_id: "org-a", space_id: "space-a", provider: "agentmail", service_id: "agentmail",
      period_start: receipt.periodStart, period_end: receipt.periodEnd, currency: "USD",
    });
    expect(await summary.json()).toMatchObject({ provenance: "operator_imported", usage: [{ serviceId: "agentmail", kind: "email", providerCostMicros: 125_000 }] });
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM managed_service_credit_reservations").get()).toEqual({ count: 0 });
  });
});
