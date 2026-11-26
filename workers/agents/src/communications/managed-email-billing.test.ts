// MS-40: billing for Managed Naelao Email inboxes. Local only: the real Naelao Email app over in-memory SQLite is the NAELAO_EMAIL binding,
// Billing is a recording fake, and the agents tables come from the real migrations. Nothing here uses a network or a provider.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import emailApp from "../../../email/src/index.js";
import { fixture as emailFixture, seedTenant, SECRET, type Fixture as EmailFixture } from "../../../email/src/test-helpers.js";
import { fixture as commsFixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { createNaelaoEmailAdapter } from "./providers/naelao-email.js";
import { reactivateManagedResource, ResourceLifecycleError } from "./managed-resource-lifecycle.js";
import { addMonthMs, emailOverageCredits, NAELAO_EMAIL_SUBSCRIPTION_TYPE, parseEmailInboxPricing, sweepNaelaoEmailSubscriptions } from "./managed-email-billing.js";

const migration = (name: string) => readFileSync(new URL(`../../../../infra/migrations/${name}`, import.meta.url), "utf8");
const SEED = readFileSync(new URL("../../../../docs/operations/managed-offerings-seed.sql", import.meta.url), "utf8");
const NOW = new Date("2026-11-26T12:00:00Z");
const PERIOD_END = new Date("2026-12-26T12:00:00Z");
const NEXT_END = new Date("2027-01-26T12:00:00Z");
const POLICY = { includedSends: 1000, usageUnitQty: 1000, usageUnitCredits: 10 };

type BillingCall = { action: string; body: Record<string, unknown> };

function harness(opts: { subscriptions?: boolean } = {}) {
  const email = emailFixture();
  email.db.prepare("INSERT INTO orgs(id) VALUES(?)").run(scope.tenantId);
  const f = commsFixture();
  const sql = f.db.db;
  for (const name of ["0291_managed_offerings_agreements_resources.sql", "0292_managed_offering_testing_allowlist_and_telnyx_classification.sql", "0300_managed_naelao_email_tenants.sql",
    "0301_managed_service_subscriptions.sql", "0302_managed_service_offering_quotes.sql", "0305_managed_subscription_charges.sql"]) {
    try { sql.exec(migration(name)); } catch (e) { if (!/duplicate column|already exists/i.test(String(e))) throw e; }
  }
  sql.exec(SEED);
  sql.prepare("UPDATE managed_service_capability_versions SET status='verified',verified_by='op-1',verified_at='2026-11-26T00:00:00Z',valid_until='2099-01-01T00:00:00Z',evidence_json=? WHERE provider='naelao' AND service_id='email' AND version=1")
    .run('[{"url":"https://example.test/evidence","checkedAt":"2026-11-26T00:00:00Z"}]');
  sql.prepare("UPDATE managed_service_commercial_agreements SET verification_status='approved',approved_by='op-1',approved_at=1795651200000,evidence_sha256=? WHERE id='agreement-naelao-email-first-party'").run("a".repeat(64));
  sql.prepare("UPDATE managed_service_offerings SET testing_tenant_ids_json=? WHERE id='off_naelao_email_inbox_v1'").run(JSON.stringify([scope.tenantId]));
  for (const operation of ["renew", "usage"]) sql.prepare(`INSERT INTO managed_service_plan_entitlements(
    plan_tier,provider,service_id,capability_version,operation_name,region,price_version,max_credits_per_operation,credits_per_operation,max_operations_per_period,
    status,verified_by,verified_at,valid_until,created_at,updated_at) VALUES('free','naelao','email',1,?,'global','naelao-email-v1',100000,NULL,NULL,'active','op',?,'2099-01-01T00:00:00Z',datetime('now'),datetime('now'))`)
    .run(operation, NOW.toISOString());
  const billing: BillingCall[] = [];
  const failures = new Set<string>();
  const operationOf = new Map<string, string>();
  const BILLING_WORKER = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split("/").pop()!;
    const body = await request.json() as Record<string, unknown>;
    billing.push({ action, body });
    if (action === "reserve") operationOf.set(String(body.reservation_id), String(body.operation_name));
    if (failures.has(`${action}:${action === "reserve" ? body.operation_name : operationOf.get(String(body.reservation_id)) ?? ""}`)) return Response.json({ error_code: "insufficient_credits" }, { status: 402 });
    return Response.json({ reservation_id: body.reservation_id, status: "held" });
  } } as unknown as Fetcher;
  const binding = { fetch: (request: Request) => emailApp.fetch(request, email.env as never) } as unknown as Fetcher;
  const env = Object.assign(f.env, { PLATFORM_SECRET: SECRET, MANAGED_OFFERINGS_ENABLED: "true", MANAGED_SUBSCRIPTIONS_ENABLED: opts.subscriptions === false ? "false" : "true", NAELAO_EMAIL: binding, BILLING_WORKER }) as unknown as AgentsEnv;
  const adapter = createNaelaoEmailAdapter(env, () => NOW);
  const provision = (extra: Record<string, unknown> = {}) => adapter.provision!({ tenantId: scope.tenantId, region: "global", reservationId: "res-1", localPart: "box", spaceId: scope.spaceId, userId: scope.userId, ...extra }, { operation_id: "op-1", idempotency_key: "idem-1" });
  let n = 0;
  /** `count` sent messages for an inbox, created at `at` (UTC "YYYY-MM-DD HH:MM:SS"). */
  const sends = (email2: EmailFixture, tenant: string, inbox: string, count: number, at: string) => {
    email2.db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const id = `msg_t${++n}`;
      email2.db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,received_at) VALUES(?,?,?, 'outbound', ?)").run(id, tenant, inbox, at);
      email2.db.prepare("INSERT INTO nemail_usage(id,nemail_tenant_id,meter,quantity,message_id,outcome,period,created_at) VALUES(?,?, 'email.message.sent', 1, ?, 'sent', ?, ?)").run(`use_t${n}`, tenant, id, at.slice(0, 7), at);
    }
    email2.db.exec("COMMIT");
  };
  const sub = () => sql.prepare("SELECT * FROM managed_service_subscriptions WHERE subscription_type=?").get(NAELAO_EMAIL_SUBSCRIPTION_TYPE) as Record<string, unknown> | undefined;
  const charges = () => sql.prepare("SELECT kind,period_start,usage_count,credits,status,error_code FROM managed_service_subscription_charges ORDER BY kind").all() as Array<Record<string, unknown>>;
  const reserves = (name?: string) => billing.filter(b => b.action === "reserve" && (!name || b.body.operation_name === name));
  return { email, sql, env, adapter, billing, failures, provision, sends, sub, charges, reserves, sweep: (at: Date) => sweepNaelaoEmailSubscriptions(env, adapter, at) };
}

async function provisioned(opts: { sent?: number } = {}) {
  const h = harness();
  const { resource } = await h.provision();
  if (opts.sent) h.sends(h.email, `naelao-${scope.tenantId}`, resource.provider_resource_ref, opts.sent, "2026-12-01 10:00:00");
  return { h, inbox: resource.provider_resource_ref };
}

describe("pricing helpers", () => {
  it("rounds the overage up once per settlement: 1,001 -> 10 credits, 2,001 -> 20, allowance -> 0", () => {
    expect(emailOverageCredits(0, POLICY)).toBe(0);
    expect(emailOverageCredits(1000, POLICY)).toBe(0);
    expect(emailOverageCredits(1001, POLICY)).toBe(10);
    expect(emailOverageCredits(2000, POLICY)).toBe(10);
    expect(emailOverageCredits(2001, POLICY)).toBe(20);
    expect(emailOverageCredits(1_000_001, POLICY)).toBe(10_000);
    expect(() => emailOverageCredits(-1, POLICY)).toThrow();
  });

  it("reads rental, allowance and rate from the offering components and refuses anything malformed", async () => {
    const seeded = [{ kind: "rental", interval: "month", credits: 100, included_sends: 1000 }, { kind: "usage", meter: "email.message.sent", included: 1000, unit_credits_per: { qty: 1000, credits: 10 } }];
    expect(await parseEmailInboxPricing("o", seeded)).toMatchObject({ rentalCredits: 100, includedSends: 1000, usageUnitQty: 1000, usageUnitCredits: 10 });
    // A repriced offering is honoured (nothing hard-coded).
    expect(await parseEmailInboxPricing("o", [{ ...seeded[0], credits: 150 }, { ...seeded[1], included: 2000, unit_credits_per: { qty: 500, credits: 7 } }]))
      .toMatchObject({ rentalCredits: 150, includedSends: 2000, usageUnitQty: 500, usageUnitCredits: 7 });
    await expect(parseEmailInboxPricing("o", [])).rejects.toThrow();
    await expect(parseEmailInboxPricing("o", [seeded[0]])).rejects.toThrow();
    await expect(parseEmailInboxPricing("o", [seeded[1]])).rejects.toThrow();
    await expect(parseEmailInboxPricing("o", [{ ...seeded[0], credits: 0 }, seeded[1]])).rejects.toThrow();
    await expect(parseEmailInboxPricing("o", [{ kind: "mystery" }])).rejects.toThrow();
  });

  it("keeps the day of month across short months", () => {
    expect(new Date(addMonthMs(Date.parse("2026-01-31T00:00:00Z"), 31)).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(new Date(addMonthMs(Date.parse("2026-02-28T00:00:00Z"), 31)).toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });
});

describe("enrollment at provision", () => {
  it("enrolls a monthly naelao_email_inbox subscription from the offering components", async () => {
    const { h, inbox } = await provisioned();
    expect(h.sub()).toMatchObject({ tenant_id: scope.tenantId, resource_id: inbox, subscription_type: NAELAO_EMAIL_SUBSCRIPTION_TYPE, offering_id: "off_naelao_email_inbox_v1",
      renewal_state: "active", current_period_start: NOW.getTime(), current_period_end: PERIOD_END.getTime(), notify_user_id: scope.userId });
    expect(String(h.sub()!.price_version)).toMatch(/^off_naelao_email_inbox_v1@/);
    // A replay of the same provision enrolls nothing new.
    await h.provision();
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_subscriptions").get()).toEqual({ n: 1 });
  });

  it("flag off: no subscription, no scope requirement, no sweep, no Billing call", async () => {
    const h = harness({ subscriptions: false });
    const { resource } = await h.provision({ spaceId: undefined, userId: undefined });
    expect(resource.status).toBe("active");
    expect(h.sub()).toBeUndefined();
    h.sends(h.email, `naelao-${scope.tenantId}`, resource.provider_resource_ref, 5000, "2026-12-01 10:00:00");
    expect(await h.sweep(new Date(PERIOD_END.getTime() + 1))).toBeNull();
    expect(h.billing).toHaveLength(0);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_subscription_charges").get()).toEqual({ n: 0 });
  });

  it("flag on without a billing scope refuses before any inbox is created", async () => {
    const h = harness();
    await expect(h.provision({ spaceId: undefined })).rejects.toMatchObject({ code: "subscription_scope_required" });
    await expect(h.provision({ userId: undefined })).rejects.toMatchObject({ code: "subscription_scope_required" });
    expect(h.email.db.prepare("SELECT COUNT(*) AS n FROM nemail_inboxes").get()).toEqual({ n: 0 });
  });

  it("the sweep needs both flags", async () => {
    const { h } = await provisioned({ sent: 3000 });
    const at = new Date(PERIOD_END.getTime() + 1);
    expect(await sweepNaelaoEmailSubscriptions({ ...h.env, MANAGED_OFFERINGS_ENABLED: "false" } as AgentsEnv, h.adapter, at)).toBeNull();
    expect(await sweepNaelaoEmailSubscriptions({ ...h.env, MANAGED_SUBSCRIPTIONS_ENABLED: "false" } as AgentsEnv, h.adapter, at)).toBeNull();
    expect(h.billing).toHaveLength(0);
  });
});

describe("period-end settlement", () => {
  it("within the included allowance only the next rental is charged", async () => {
    const { h } = await provisioned({ sent: 1000 });
    expect(await h.sweep(PERIOD_END)).toMatchObject({ checked: 1, renewed: 1, held: 0 });
    expect(h.reserves("usage")).toHaveLength(0);
    expect(h.reserves("renew")).toHaveLength(1);
    expect(h.reserves("renew")[0]!.body).toMatchObject({ provider: "naelao", service_id: "email", credits: 100, payer_id: scope.tenantId });
    expect(h.charges()).toEqual([
      { kind: "overage", period_start: NOW.getTime(), usage_count: 1000, credits: 0, status: "skipped", error_code: null },
      { kind: "rental", period_start: PERIOD_END.getTime(), usage_count: null, credits: 100, status: "settled", error_code: null },
    ]);
    expect(h.sub()).toMatchObject({ renewal_state: "active", current_period_start: PERIOD_END.getTime(), current_period_end: NEXT_END.getTime() });
    expect(h.billing.filter(b => b.action === "settle").map(b => b.body.credits)).toEqual([100]);
  });

  it.each([[1001, 10], [2000, 10], [2001, 20], [5500, 50]])("%i sends in the period settle %i overage credits (rounded up once)", async (sent, credits) => {
    const { h } = await provisioned({ sent });
    await h.sweep(PERIOD_END);
    const usage = h.reserves("usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.body).toMatchObject({ credits, operation_name: "usage", provider: "naelao", service_id: "email" });
    expect(usage[0]!.body.quote_id).toBeUndefined();
    expect(h.billing.filter(b => b.action === "settle" && b.body.reservation_id === usage[0]!.body.reservation_id).map(b => b.body.credits)).toEqual([credits]);
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ usage_count: sent, credits, status: "settled" });
    expect(h.sub()).toMatchObject({ renewal_state: "active", current_period_end: NEXT_END.getTime() });
  });

  it("counts only this inbox's sends inside the period that ended", async () => {
    const { h, inbox } = await provisioned({ sent: 1001 });
    const tenant = `naelao-${scope.tenantId}`;
    // Before the period, at its end instant and after it: none of these belong to the settled period.
    h.sends(h.email, tenant, inbox, 50, "2026-11-26 11:59:59");
    h.sends(h.email, tenant, inbox, 50, "2026-12-26 12:00:00");
    // Another inbox of the same Managed tenant has its own allowance.
    const other = ((await (await emailApp.fetch(new Request("https://email.test/v1/inboxes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await (async () => { const { decryptAuthenticated, deriveKek } = await import("@naelao/crypto"); const row = h.sql.prepare("SELECT key_envelope_json FROM managed_naelao_email_tenants").get() as { key_envelope_json: string }; return decryptAuthenticated(JSON.parse(row.key_envelope_json), await deriveKek(SECRET, scope.tenantId), `naelao-email-api-key:${scope.tenantId}`); })()}` }, body: JSON.stringify({ local_part: "other-box" }) }), h.email.env as never)).json()) as { data: { id: string } }).data.id;
    h.sends(h.email, tenant, other, 4000, "2026-12-02 10:00:00");
    await h.sweep(PERIOD_END);
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ usage_count: 1001, credits: 10 });
  });

  it("is idempotent per period: a second sweep and a crash retry never settle twice", async () => {
    const { h, inbox } = await provisioned({ sent: 2001 });
    // The rental step fails after the overage was settled: grace, nothing advanced.
    h.failures.add("reserve:renew");
    expect(await h.sweep(PERIOD_END)).toMatchObject({ renewed: 0, held: 1 });
    expect(h.sub()).toMatchObject({ renewal_state: "grace", current_period_end: PERIOD_END.getTime() });
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ credits: 20, status: "settled" });
    // More sends arrive late with timestamps inside the closed period: the stored count stays authoritative.
    h.sends(h.email, `naelao-${scope.tenantId}`, inbox, 3000, "2026-12-20 10:00:00");
    h.failures.clear();
    expect(await h.sweep(new Date(PERIOD_END.getTime() + 60_000))).toMatchObject({ renewed: 1, held: 0 });
    expect(h.reserves("usage")).toHaveLength(1);
    expect(h.billing.filter(b => b.action === "settle" && b.body.credits === 20)).toHaveLength(1);
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ usage_count: 2001, credits: 20, status: "settled" });
    expect(h.charges().filter(c => c.kind === "rental" && c.status === "settled")).toHaveLength(1);
    const before = h.billing.length;
    // Nothing is due any more; replaying the sweep at the same instant changes nothing.
    expect(await h.sweep(new Date(PERIOD_END.getTime() + 60_000))).toMatchObject({ checked: 0 });
    expect(h.billing).toHaveLength(before);
    expect(h.sub()).toMatchObject({ renewal_state: "active", current_period_end: NEXT_END.getTime() });
  });

  it("a failed overage settlement does not renew, releases the reservation and retries with the same count", async () => {
    const { h } = await provisioned({ sent: 1500 });
    h.failures.add("settle:usage");
    const first = await h.sweep(PERIOD_END);
    expect(first).toMatchObject({ renewed: 0, held: 1 });
    // settle for the usage reservation was refused: it is released and no rental was reserved.
    expect(h.billing.map(b => b.action)).toEqual(["reserve", "settle", "release"]);
    expect(h.reserves("renew")).toHaveLength(0);
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ status: "pending", usage_count: 1500, credits: 10 });
    expect(h.sub()).toMatchObject({ renewal_state: "grace" });
  });

  it("bills the final period of a deleted inbox and then stops renewing", async () => {
    const { h, inbox } = await provisioned({ sent: 1200 });
    await h.adapter.deprovision!({ tenantId: scope.tenantId, provider_resource_ref: inbox }, { operation_id: "op-d", idempotency_key: "idem-d" });
    await h.sweep(PERIOD_END);
    expect(h.charges()).toEqual([expect.objectContaining({ kind: "overage", credits: 10, status: "settled" })]);
    expect(h.reserves("renew")).toHaveLength(0);
    expect(h.sub()).toMatchObject({ renewal_state: "cancelled" });
  });

  it("an unconfigured entitlement holds the renewal instead of charging", async () => {
    const { h } = await provisioned({ sent: 1500 });
    h.sql.prepare("DELETE FROM managed_service_plan_entitlements WHERE provider='naelao'").run();
    await h.sweep(PERIOD_END);
    expect(h.billing).toHaveLength(0);
    expect(h.sub()).toMatchObject({ renewal_state: "grace" });
    expect(h.charges().find(c => c.kind === "overage")).toMatchObject({ status: "pending", error_code: "managed_service_price_unconfigured" });
  });
});

describe("suspension pauses sending (MS-41)", () => {
  const paused = (h: Awaited<ReturnType<typeof provisioned>>["h"], inbox: string) =>
    h.email.db.prepare("SELECT sending_paused AS p, sending_pause_reason AS r FROM nemail_inboxes WHERE id=?").get(inbox) as { p: number; r: string | null };

  it("grace keeps sending; suspension pauses that inbox through the email worker; recovery lifts only that pause", async () => {
    const { h, inbox } = await provisioned();
    h.failures.add("reserve:renew");
    await h.sweep(PERIOD_END);
    expect(h.sub()).toMatchObject({ renewal_state: "grace" });
    expect(paused(h, inbox)).toEqual({ p: 0, r: null });
    expect(await h.sweep(new Date(PERIOD_END.getTime() + 8 * 86_400_000))).toMatchObject({ suspended: 1 });
    expect(h.sub()).toMatchObject({ renewal_state: "suspended" });
    expect(paused(h, inbox)).toEqual({ p: 1, r: "subscription_suspended" });
    // Recovery: the adapter lifts the pause it owns.
    await expect(h.adapter.setSendingPaused({ tenantId: scope.tenantId, provider_resource_ref: inbox, paused: false })).resolves.toEqual({ sendingPaused: false });
    expect(paused(h, inbox)).toEqual({ p: 0, r: null });
  });

  it("a failed pause at suspension (and its in-sweep retry) is retried by the next sweep", async () => {
    const { h, inbox } = await provisioned();
    h.failures.add("reserve:renew");
    await h.sweep(PERIOD_END);
    const real = h.adapter.setSendingPaused;
    let calls = 0;
    h.adapter.setSendingPaused = async (req) => { if (calls++ < 2) throw new Error("outcome_unknown"); return real(req); };
    await h.sweep(new Date(PERIOD_END.getTime() + 8 * 86_400_000));
    expect(h.sub()).toMatchObject({ renewal_state: "suspended" });
    expect(paused(h, inbox).p).toBe(0);
    await h.sweep(new Date(PERIOD_END.getTime() + 9 * 86_400_000));
    expect(paused(h, inbox)).toEqual({ p: 1, r: "subscription_suspended" });
  });

  it("a healthy renewal never touches sending", async () => {
    const { h, inbox } = await provisioned();
    await h.sweep(PERIOD_END);
    expect(h.sub()).toMatchObject({ renewal_state: "active" });
    expect(paused(h, inbox)).toEqual({ p: 0, r: null });
  });
});

describe("reactivation after suspension (MS-47 item 3)", () => {
  const paused = (h: Awaited<ReturnType<typeof provisioned>>["h"], inbox: string) =>
    h.email.db.prepare("SELECT sending_paused AS p, sending_pause_reason AS r FROM nemail_inboxes WHERE id=?").get(inbox) as { p: number; r: string | null };
  const SUSPENDED_AT = new Date(PERIOD_END.getTime() + 8 * 86_400_000);
  const REACTIVATE_AT = new Date(PERIOD_END.getTime() + 10 * 86_400_000);
  async function suspended() {
    const { h, inbox } = await provisioned();
    h.sql.prepare(`INSERT INTO managed_service_accounts(id,tenant_id,space_id,provider,service_id,connection_mode,provider_resource_ref,credential_ref,owner_type,owner_id,
      provider_payer_type,lifecycle_state,access_mode,metadata_json,created_at,updated_at)
      VALUES('res-1',?,?,'naelao','email','naelao_managed',?,'c','organization',?,'platform','active','managed','{}','x','x')`).run(scope.tenantId, scope.spaceId, inbox, scope.tenantId);
    h.failures.add("reserve:renew");
    await h.sweep(PERIOD_END);
    await h.sweep(SUSPENDED_AT);
    expect(h.sub()).toMatchObject({ renewal_state: "suspended" });
    expect(paused(h, inbox)).toEqual({ p: 1, r: "subscription_suspended" });
    return { h, inbox, reactivate: () => reactivateManagedResource(h.env, { tenantId: scope.tenantId, spaceId: scope.spaceId }, "res-1", h.adapter, REACTIVATE_AT) };
  }

  it("charges the overdue period first, then activates the subscription and lifts the billing pause", async () => {
    const { h, inbox, reactivate } = await suspended();
    const suspendedAt = h.sub()!.suspended_at;
    // The charge fails: nothing changes, sending stays paused, the release clock keeps its original start.
    await expect(reactivate()).rejects.toMatchObject({ code: "charge_failed" });
    expect(h.sub()).toMatchObject({ renewal_state: "suspended", suspended_at: suspendedAt });
    expect(paused(h, inbox).p).toBe(1);
    // Pay, then reactivate.
    h.failures.clear();
    const settlesBefore = h.billing.filter(b => b.action === "settle").length;
    await expect(reactivate()).resolves.toEqual({ resourceId: "res-1", status: "reactivated", sendingResumed: true });
    expect(h.sub()).toMatchObject({ renewal_state: "active", suspended_at: null, grace_started_at: null, current_period_start: PERIOD_END.getTime(), current_period_end: NEXT_END.getTime() });
    expect(h.billing.filter(b => b.action === "settle").length - settlesBefore).toBe(1);
    expect(h.charges().find(c => c.kind === "rental")).toMatchObject({ status: "settled", credits: 100 });
    expect(paused(h, inbox)).toEqual({ p: 0, r: null });
    // Nothing left to reactivate; a repeat does not charge again.
    const reserves = h.reserves().length;
    await expect(reactivate()).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.reserves().length).toBe(reserves);
  });

  it("keeps an owner's own suspend in force through a paid reactivation", async () => {
    const { h, inbox, reactivate } = await suspended();
    h.sql.prepare("UPDATE managed_service_accounts SET lifecycle_state='suspended',metadata_json='{\"suspended_by\":\"owner\"}' WHERE id='res-1'").run();
    h.failures.clear();
    await reactivate();
    expect(h.sub()).toMatchObject({ renewal_state: "active" });
    expect(paused(h, inbox)).toEqual({ p: 1, r: "owner_suspended" });
  });

  it("a resume that fails after the charge leaves a marker the next sweep retries", async () => {
    const { h, inbox, reactivate } = await suspended();
    h.failures.clear();
    const real = h.adapter.setSendingPaused;
    let down = true;
    h.adapter.setSendingPaused = async (req) => { if (down) throw new Error("outcome_unknown"); return real(req); };
    await expect(reactivate()).resolves.toMatchObject({ status: "reactivated", sendingResumed: false });
    expect(h.sub()).toMatchObject({ renewal_state: "active" });
    expect(paused(h, inbox).p).toBe(1);
    expect(h.sql.prepare("SELECT json_extract(metadata_json,'$.resume_pending') AS p FROM managed_service_accounts WHERE id='res-1'").get()).toEqual({ p: 1 });
    down = false;
    await h.sweep(new Date(REACTIVATE_AT.getTime() + 1000));
    expect(paused(h, inbox)).toEqual({ p: 0, r: null });
    expect(h.sql.prepare("SELECT json_extract(metadata_json,'$.resume_pending') AS p FROM managed_service_accounts WHERE id='res-1'").get()).toEqual({ p: 0 });
  });

  it("needs both flags and a suspended subscription", async () => {
    const { h, reactivate } = await suspended();
    await expect(reactivateManagedResource({ ...h.env, MANAGED_SUBSCRIPTIONS_ENABLED: "false" } as AgentsEnv, { tenantId: scope.tenantId, spaceId: scope.spaceId }, "res-1", h.adapter)).rejects.toBeInstanceOf(ResourceLifecycleError);
    h.sql.prepare("UPDATE managed_service_subscriptions SET renewal_state='active'").run();
    await expect(reactivate()).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("direct Naelao Email tenants", () => {
  it("are never billed: no subscription, no charge, no usage answer from the email worker", async () => {
    const { h } = await provisioned({ sent: 10 });
    const key = await seedTenant(h.email, "direct-tenant");
    const created = await emailApp.fetch(new Request("https://email.test/v1/inboxes", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ local_part: "direct-box" }) }), h.email.env as never);
    const directInbox = ((await created.json()) as { data: { id: string } }).data.id;
    h.sends(h.email, "direct-tenant", directInbox, 5000, "2026-12-01 10:00:00");
    await h.sweep(PERIOD_END);
    expect(h.sql.prepare("SELECT COUNT(*) AS n FROM managed_service_subscriptions WHERE resource_id=?").get(directInbox)).toEqual({ n: 0 });
    expect(h.reserves().every(b => b.body.payer_id === scope.tenantId)).toBe(true);
    expect(h.charges().every(c => c.usage_count === null || c.usage_count === 10)).toBe(true);
    // Even a correctly signed platform request cannot read a direct tenant's usage.
    const { mintInternalToken } = await import("@naelao/http");
    const res = await emailApp.fetch(new Request("https://email.test/internal/v1/usage/period", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "direct-tenant", "x-naelao-internal-token": await mintInternalToken(SECRET, "direct-tenant") },
      body: JSON.stringify({ inbox_id: directInbox, start_ms: NOW.getTime(), end_ms: PERIOD_END.getTime() }) }), h.email.env as never);
    expect(res.status).toBe(404);
  });
});
