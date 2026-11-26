// MS-40 (V-spec §9.4 `email.message.sent`, OD-3, MR-COM-2/5): bill Managed Naelao Email inboxes.
//
// A Managed inbox (provisioned through the naelao-email adapter) is enrolled in a `naelao_email_inbox` subscription. At every period
// end the subscription handler (1) reads the inbox's sent-message count for the period that ended from the email worker (HMAC route,
// never the tenant key), (2) settles the overage once for that period and (3) charges the rental for the next period. All prices come
// from the offering's charge components, nothing is hard-coded here: rental credits, the included sends, and the usage rate.
//
// Overage (OD-3, D8): credits = ceil(extra sends / unit qty) * unit credits, rounded up ONCE per settlement, so 1,001 sends with 1,000
// included is 10 credits and 2,001 is 20. Idempotent per (subscription, period): `managed_service_subscription_charges` stores the
// first computed count and the outcome, and the Billing reservation id is derived from the row, so a replay settles nothing twice.
//
// Direct (non-Managed) Naelao Email tenants never get a subscription row and the email worker refuses to report their usage.
// Everything is behind MANAGED_SUBSCRIPTIONS_ENABLED (enrollment and sweep) and MANAGED_OFFERINGS_ENABLED (the adapter).
import { releaseManagedServiceCredits, reserveManagedServiceCredits, settleManagedServiceCredits } from "./managed-service-billing.js";
import { enrollManagedSubscription, managedSubscriptionsEnabled, resolveOfferingGraceDays, sweepManagedSubscriptions, type ManagedSubscription,
  type RenewalResult, type SubscriptionSweepResult, type SubscriptionTypeHandler } from "./managed-subscriptions.js";
import { offeringPriceVersion, parseChargeComponents, type QuoteComponent } from "./managed-quotes.js";
import type { NaelaoEmailAdapter } from "./providers/naelao-email.js";
import type { AgentsEnv } from "../index.js";

export const NAELAO_EMAIL_SUBSCRIPTION_TYPE = "naelao_email_inbox";
const PROVIDER = "naelao";
const SERVICE = "email";
const METER = "email.message.sent";
type Db = AgentsEnv["PLATFORM_DB"];

export interface EmailInboxPricing {
  rentalCredits: number;
  /** Sends included in each period before overage applies. */
  includedSends: number;
  usageUnitQty: number;
  usageUnitCredits: number;
  priceVersion: string;
}

/** Reads the rental and the `email.message.sent` usage component. Throws on anything missing or malformed (fail closed). */
export async function parseEmailInboxPricing(offeringId: string, chargeComponents: unknown): Promise<EmailInboxPricing> {
  const components: QuoteComponent[] = parseChargeComponents(chargeComponents);
  const rental = components.find((c): c is Extract<QuoteComponent, { kind: "rental" }> => c.kind === "rental" && c.interval === "month");
  const usage = components.find((c): c is Extract<QuoteComponent, { kind: "usage" }> => c.kind === "usage" && c.meter === METER);
  if (!rental || rental.credits < 1 || !usage || usage.unitCredits < 1) throw new Error("managed_email_pricing_invalid");
  return { rentalCredits: rental.credits, includedSends: usage.included, usageUnitQty: usage.unitQty, usageUnitCredits: usage.unitCredits,
    priceVersion: await offeringPriceVersion(offeringId, components) };
}

/** Overage credits for a period: whole units of `unitQty` extra sends, rounded up once. Zero within the allowance. */
export function emailOverageCredits(sentCount: number, pricing: Pick<EmailInboxPricing, "includedSends" | "usageUnitQty" | "usageUnitCredits">): number {
  if (!Number.isSafeInteger(sentCount) || sentCount < 0) throw new Error("managed_email_usage_invalid");
  const extra = sentCount - pricing.includedSends;
  return extra > 0 ? Math.ceil(extra / pricing.usageUnitQty) * pricing.usageUnitCredits : 0;
}

/** Same day next month, clamped to the month's last day; `anchorDay` keeps a 31st from drifting after a short month. */
export function addMonthMs(ms: number, anchorDay: number): number {
  const source = new Date(ms);
  const next = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 1, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next.getTime();
}

interface Commitment { provider: string; service: string; inbox_id: string; space_id: string; project_id: string | null; user_id: string; region: string; anchor_day: number }

export async function enrollNaelaoEmailInboxSubscription(db: Db, input: {
  tenantId: string; inboxId: string; offeringId: string; chargeComponents: unknown; spaceId: string; projectId: string | null; userId: string; region: string; now: Date;
}): Promise<boolean> {
  const pricing = await parseEmailInboxPricing(input.offeringId, input.chargeComponents);
  const nowMs = input.now.getTime();
  const anchorDay = input.now.getUTCDate();
  const commitment: Commitment = { provider: PROVIDER, service: SERVICE, inbox_id: input.inboxId, space_id: input.spaceId, project_id: input.projectId, user_id: input.userId, region: input.region, anchor_day: anchorDay };
  return enrollManagedSubscription(db, {
    tenantId: input.tenantId, resourceId: input.inboxId, subscriptionType: NAELAO_EMAIL_SUBSCRIPTION_TYPE, offeringId: input.offeringId,
    priceVersion: pricing.priceVersion, periodStart: nowMs, periodEnd: addMonthMs(nowMs, anchorDay),
    graceDays: await resolveOfferingGraceDays(db, input.offeringId), notifyUserId: input.userId, upstreamCommitment: commitment, now: nowMs,
  });
}

async function sha256Hex(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
}

type ChargeRow = { id: string; status: "pending" | "settled" | "skipped"; usage_count: number | null; credits: number };
type ChargeOutcome = { ok: true } | { ok: false; code: string } | { busy: true };

/** Entitlement Billing will demand for this plan, provider operation and region (same predicate the AgentMail resolver uses). */
async function resolveEntitlement(db: Db, tenantId: string, operation: "renew" | "usage", region: string, now: Date) {
  const org = await db.prepare("SELECT plan_tier FROM orgs WHERE id=? AND status='active'").bind(tenantId).first<{ plan_tier: string }>();
  if (!org) throw new Error("managed_service_tenant_unavailable");
  const e = await db.prepare(`SELECT e.capability_version,e.price_version FROM managed_service_plan_entitlements e JOIN managed_service_capability_versions c
      ON c.provider=e.provider AND c.service_id=e.service_id AND c.version=e.capability_version
    WHERE e.plan_tier=? AND e.provider=? AND e.service_id=? AND e.operation_name=? AND e.region=?
      AND e.status='active' AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL AND e.valid_until>?
      AND c.status='verified' AND c.valid_until>?
      AND EXISTS(SELECT 1 FROM json_each(c.operations_json) WHERE value=e.operation_name)
      AND EXISTS(SELECT 1 FROM json_each(c.regions_json) WHERE value=e.region)
      AND EXISTS(SELECT 1 FROM json_each(c.account_modes_json) WHERE value='naelao_managed') LIMIT 1`)
    .bind(org.plan_tier, PROVIDER, SERVICE, operation, region, now.toISOString(), now.toISOString())
    .first<{ capability_version: number; price_version: string }>();
  if (!e) throw new Error("managed_service_price_unconfigured");
  return { planTier: org.plan_tier, capabilityVersion: e.capability_version, priceVersion: e.price_version };
}

/**
 * Reserve then settle `credits` for one charge row. A rental (`renew`) is a recurring spend, so it carries a consumed quote bound to the
 * operation by request hash (offering policy `required_for_recurring`); overage (`usage`) is metered and carries none. Idempotent: every
 * id is derived from the charge row, a complete operation is not charged again, and a failure releases an unsettled reservation.
 */
async function chargeRow(env: AgentsEnv, sub: ManagedSubscription, commit: Commitment, row: ChargeRow, kind: "rental" | "overage", pricing: EmailInboxPricing, now: Date): Promise<ChargeOutcome> {
  const db = env.PLATFORM_DB;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const digest = await sha256Hex(row.id);
  const operationId = `nemail_${kind}_${digest.slice(0, 40)}`;
  const reservationId = `nemail_res_${digest.slice(0, 40)}`;
  const operationName = kind === "rental" ? "renew" : "usage";
  const scope = { tenantId: sub.tenant_id, spaceId: commit.space_id, ...(commit.project_id ? { projectId: commit.project_id } : {}), userId: commit.user_id, role: "product_end_user" as const };
  const fail = async (code: string, reserved: boolean, settled: boolean): Promise<ChargeOutcome> => {
    if (reserved && !settled) await releaseManagedServiceCredits(env, scope, reservationId, "no_effect").catch(() => undefined);
    await db.prepare("UPDATE managed_service_operations SET status=?,lease_until=NULL,error_code=?,updated_at=? WHERE operation_id=? AND status='running'")
      .bind(settled ? "complete" : "held", code, nowIso, operationId).run().catch(() => undefined);
    await db.prepare("UPDATE managed_service_subscription_charges SET error_code=?,updated_at=? WHERE id=?").bind(code, nowMs, row.id).run().catch(() => undefined);
    return { ok: false, code };
  };
  let entitlement;
  try { entitlement = await resolveEntitlement(db, sub.tenant_id, operationName, commit.region, now); }
  catch (error) { return fail(error instanceof Error && /^[a-z][a-z0-9_]{1,80}$/.test(error.message) ? error.message : "managed_service_price_unconfigured", false, false); }
  // A rental is priced by the offering (the pinned quote is the price authority); a metered settlement by the entitlement's price version.
  const priceVersion = kind === "rental" ? pricing.priceVersion : entitlement.priceVersion;
  const requestHash = await sha256Hex(JSON.stringify({ sub: sub.id, kind, periodStart: sub.current_period_start, charge: row.id, credits: row.credits, priceVersion }));
  const quoteId = kind === "rental" ? `msq_${digest.slice(0, 32)}` : null;
  await db.prepare(`INSERT OR IGNORE INTO managed_service_operations(
    operation_id,tenant_id,space_id,project_id,account_id,provider,service_id,capability_version,operation_name,region,idempotency_key,
    request_sha256,status,quote_id,price_version,reserved_credits,created_at,updated_at)
    VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`)
    .bind(operationId, sub.tenant_id, commit.space_id, commit.project_id, PROVIDER, SERVICE, entitlement.capabilityVersion, operationName, commit.region, operationId,
      requestHash, quoteId, priceVersion, row.credits, nowIso, nowIso).run();
  if (quoteId) {
    await db.prepare(`INSERT OR IGNORE INTO managed_service_operation_quotes(
      quote_id,tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,service_id,operation_name,region,
      capability_version,price_version,credits,request_sha256,status,operation_id,expires_at,consumed_at,created_at,offering_id,configuration_sha256)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'consumed',?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM managed_service_operations WHERE operation_id=? AND tenant_id=? AND quote_id=? AND request_sha256=?)`)
      .bind(quoteId, sub.tenant_id, commit.space_id, commit.project_id, commit.user_id, entitlement.planTier, PROVIDER, SERVICE, operationName, commit.region,
        entitlement.capabilityVersion, priceVersion, row.credits, requestHash, operationId, new Date(nowMs + 180_000).toISOString(), nowIso, nowIso,
        sub.offering_id, await sha256Hex(row.id), operationId, sub.tenant_id, quoteId, requestHash).run();
  }
  const prior = await db.prepare("SELECT request_sha256,status,quote_id FROM managed_service_operations WHERE operation_id=? AND tenant_id=?")
    .bind(operationId, sub.tenant_id).first<{ request_sha256: string; status: string; quote_id: string | null }>();
  if (!prior || prior.request_sha256 !== requestHash || prior.quote_id !== quoteId) return fail("managed_service_operation_conflict", false, false);
  if (prior.status === "complete") {
    await db.prepare("UPDATE managed_service_subscription_charges SET status='settled',operation_id=?,reservation_id=?,error_code=NULL,updated_at=? WHERE id=? AND status='pending'")
      .bind(operationId, reservationId, nowMs, row.id).run();
    return { ok: true };
  }
  const claim = await db.prepare(`UPDATE managed_service_operations SET status='running',lease_until=?,error_code=NULL,updated_at=?
    WHERE operation_id=? AND tenant_id=? AND (status IN ('pending','held') OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))`)
    .bind(new Date(nowMs + 120_000).toISOString(), nowIso, operationId, sub.tenant_id, nowIso).run();
  if (!claim.meta.changes) return { busy: true };
  let reserved = false, settled = false;
  try {
    await reserveManagedServiceCredits(env, scope, { reservationId, operationId, provider: PROVIDER, serviceId: SERVICE, operationName, region: commit.region,
      credits: row.credits, priceVersion, ...(quoteId ? { quoteId } : {}) });
    reserved = true;
    await db.prepare("UPDATE managed_service_operations SET reservation_id=?,updated_at=? WHERE operation_id=? AND status='running'").bind(reservationId, nowIso, operationId).run();
    await settleManagedServiceCredits(env, scope, reservationId, row.credits);
    settled = true;
    await db.prepare("UPDATE managed_service_operations SET status='complete',lease_until=NULL,error_code=NULL,result_ref=?,updated_at=? WHERE operation_id=? AND status='running'")
      .bind(commit.inbox_id, nowIso, operationId).run();
    await db.prepare("UPDATE managed_service_subscription_charges SET status='settled',operation_id=?,reservation_id=?,error_code=NULL,updated_at=? WHERE id=?")
      .bind(operationId, reservationId, nowMs, row.id).run();
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "managed_email_charge_failed";
    return fail(code, reserved, settled);
  }
}

function readCommitment(sub: ManagedSubscription): Commitment | null {
  try {
    const c = JSON.parse(sub.upstream_commitment_json ?? "null") as Partial<Commitment> | null;
    if (c && c.provider === PROVIDER && c.service === SERVICE && typeof c.inbox_id === "string" && typeof c.space_id === "string" && typeof c.user_id === "string"
      && typeof c.region === "string" && Number.isInteger(c.anchor_day)) return { ...c, project_id: c.project_id ?? null } as Commitment;
  } catch { /* fall through */ }
  return null;
}

async function loadPricing(db: Db, offeringId: string): Promise<EmailInboxPricing> {
  const offering = await db.prepare("SELECT charge_components_json FROM managed_service_offerings WHERE id=?").bind(offeringId).first<{ charge_components_json: string }>();
  if (!offering) throw new Error("managed_email_pricing_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(offering.charge_components_json); } catch { throw new Error("managed_email_pricing_invalid"); }
  return parseEmailInboxPricing(offeringId, parsed);
}

/** Inserts the charge row once (INSERT OR IGNORE) and returns the stored row, so the first computed values stay authoritative. */
async function claimChargeRow(db: Db, sub: ManagedSubscription, kind: "rental" | "overage", periodStart: number, periodEnd: number, usageCount: number | null, credits: number, nowMs: number): Promise<ChargeRow> {
  const id = `msc_${sub.id}_${kind}_${periodStart}`;
  await db.prepare(`INSERT OR IGNORE INTO managed_service_subscription_charges(id,subscription_id,tenant_id,kind,period_start,period_end,usage_count,credits,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id, sub.id, sub.tenant_id, kind, periodStart, periodEnd, usageCount, credits, credits > 0 ? "pending" : "skipped", nowMs, nowMs).run();
  const row = await db.prepare("SELECT id,status,usage_count,credits FROM managed_service_subscription_charges WHERE id=?").bind(id).first<ChargeRow>();
  if (!row) throw new Error("managed_email_charge_unavailable");
  return row;
}

export function createNaelaoEmailSubscriptionHandler(adapter: Pick<NaelaoEmailAdapter, "usageForPeriod" | "lookup">): SubscriptionTypeHandler {
  return {
    async renew(env, sub, now): Promise<RenewalResult> {
      const commit = readCommitment(sub);
      if (!commit) return { status: "failed", code: "managed_email_commitment_invalid" };
      let pricing: EmailInboxPricing;
      try { pricing = await loadPricing(env.PLATFORM_DB, sub.offering_id); } catch { return { status: "failed", code: "managed_email_pricing_invalid" }; }
      const nowMs = now.getTime();
      const db = env.PLATFORM_DB;
      // (1) Overage for the period that ended. The count is read once and stored; a retry reuses it.
      let overage = await db.prepare("SELECT id,status,usage_count,credits FROM managed_service_subscription_charges WHERE subscription_id=? AND kind='overage' AND period_start=?")
        .bind(sub.id, sub.current_period_start).first<ChargeRow>();
      if (!overage) {
        let sent: number;
        try { sent = (await adapter.usageForPeriod({ tenantId: sub.tenant_id, provider_resource_ref: commit.inbox_id, startMs: sub.current_period_start, endMs: sub.current_period_end })).sentCount; }
        catch (error) { return { status: "failed", code: error instanceof Error && /^[a-z][a-z0-9_:-]{1,100}$/.test(error.message) ? error.message : "managed_email_usage_unavailable" }; }
        overage = await claimChargeRow(db, sub, "overage", sub.current_period_start, sub.current_period_end, sent, emailOverageCredits(sent, pricing), nowMs);
      }
      if (overage.status === "pending") {
        const outcome = await chargeRow(env, sub, commit, overage, "overage", pricing, now);
        if ("busy" in outcome) return { status: "noop" };
        if (!outcome.ok) return { status: "failed", code: outcome.code };
      }
      // (2) A deleted inbox is billed for its last period and then stops renewing.
      let alive: boolean;
      try { alive = (await adapter.lookup({ tenantId: sub.tenant_id, provider_resource_ref: commit.inbox_id })) !== null; }
      catch { return { status: "failed", code: "managed_email_lookup_unavailable" }; }
      if (!alive) return { status: "cancelled" };
      // (3) Rental for the next period, reserved and settled before the period advances (MR-COM-9 step 1).
      const rental = await claimChargeRow(db, sub, "rental", sub.current_period_end, addMonthMs(sub.current_period_end, commit.anchor_day), null, pricing.rentalCredits, nowMs);
      if (rental.status === "pending") {
        const outcome = await chargeRow(env, sub, commit, rental, "rental", pricing, now);
        if ("busy" in outcome) return { status: "noop" };
        if (!outcome.ok) return { status: "failed", code: outcome.code };
      }
      return { status: "renewed", periodEnd: addMonthMs(sub.current_period_end, commit.anchor_day), operationId: `nemail_${rental.id}`, billed: rental.credits > 0 || overage.credits > 0 };
    },
    async onSuspended() { /* Sending is not paused here; the engine's grace, notices and release gate apply (MS-36). */ },
  };
}

/** Sweeps due `naelao_email_inbox` subscriptions. A no-op unless MANAGED_SUBSCRIPTIONS_ENABLED and MANAGED_OFFERINGS_ENABLED are both "true". */
export async function sweepNaelaoEmailSubscriptions(env: AgentsEnv, adapter: Pick<NaelaoEmailAdapter, "usageForPeriod" | "lookup">, now = new Date()): Promise<SubscriptionSweepResult | null> {
  if (!managedSubscriptionsEnabled(env) || env.MANAGED_OFFERINGS_ENABLED !== "true" || !env.BILLING_WORKER) return null;
  return sweepManagedSubscriptions(env, { [NAELAO_EMAIL_SUBSCRIPTION_TYPE]: createNaelaoEmailSubscriptionHandler(adapter) }, now);
}
