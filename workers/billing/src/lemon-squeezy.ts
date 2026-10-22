/**
 * Lemon Squeezy webhook handler (spec Appendix H / CLAUDE.md #9).
 *
 * On payment.success / subscription.created: wake the Space Assistant agent
 * via POST /agents/{agentId}/script/run so it can fulfil the order, send
 * welcome emails, provision entitlements, etc.
 *
 * Event dispatch logic:
 *   payment.success (order_created / subscription_payment_success / order_refunded→refund.issued)
 *     → fire "order_completed" goal on the space's default agent
 *   subscription.created / subscription.updated
 *     → fire "subscription_changed" goal
 *   subscription.cancelled / subscription.paused
 *     → fire "subscription_cancelled" goal
 *   payment.failed
 *     → fire "payment_failed" goal (dunning workflow)
 */

import { LemonSqueezyProvider, computeResellerAttribution, isLedgerEvent, billingPeriod } from "@naelao/billing-core";
import type { NormalizedBillingEvent, BillingRelationship } from "@naelao/billing-core";
import { mintInternalToken, readBoundedRequestText, readBoundedResponseText } from "@naelao/http";
import { normalizeFeeBps } from "./fee-policy.js";
import { invalidateQuotaCache } from "./quota.js";
import { settleTemplateSubscriptionPayment } from "./settlement.js";
import { settleMarketplaceLicenseEvent } from "./marketplace-licenses.js";

async function responseDetail(response: Response): Promise<string> {
  try { return (await readBoundedResponseText(response, 8 * 1024)).slice(0, 300); }
  catch { return "response_body_unavailable"; }
}

function requiredMetadataString(metadata: Record<string, unknown>, key: string, context: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${context} webhook is missing valid ${key} metadata`);
  }
  return value.trim();
}

function requiredPositiveMetadataInteger(metadata: Record<string, unknown>, key: string, context: string): number {
  const value = metadata[key];
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${context} webhook is missing valid ${key} metadata`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${context} webhook ${key} exceeds the safe integer range`);
  return parsed;
}

function requiredEventSpaceId(event: NormalizedBillingEvent, context: string): string {
  if (!event.spaceId || event.spaceId.length > 256) throw new Error(`${context} webhook is missing a valid space id`);
  return event.spaceId;
}

function requiredRevenuePeriods(metadata: Record<string, unknown>, context: string): { periods: string[]; charges?: number[] } {
  const rawPeriods = requiredMetadataString(metadata, "periods", context);
  const periods = rawPeriods.split(",");
  if (periods.length > 120 || periods.some((period) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) || new Set(periods).size !== periods.length) {
    throw new Error(`${context} webhook has invalid revenue periods`);
  }
  if (metadata["period_charges"] === undefined) return { periods };
  const rawCharges = requiredMetadataString(metadata, "period_charges", context);
  const charges = rawCharges.split(",");
  if (charges.length !== periods.length || charges.some((charge) => !/^(0|[1-9]\d*)$/.test(charge) || !Number.isSafeInteger(Number(charge)))) {
    throw new Error(`${context} webhook has invalid period charges`);
  }
  return { periods, charges: charges.map(Number) };
}

/**
 * ARCH-REVENUE-6: the maximum builder revenue share, in basis points. A builder configures their
 * slice of a child business's sales (productConfig.commerce.builderFeeBps); this ceiling stops a
 * builder from setting a confiscatory rate, and combined with the Naelao fee is additionally
 * clamped so a settlement can never exceed the gross or drive the business wallet negative.
 */
const BUILDER_FEE_BPS_CEILING = 3000; // 30%

export interface BuilderShare {
  builderFeeCents: number;
  parentTenantId: string;
  childTenantId: string;
  childSpaceId: string;
}

/**
 * ARCH-REVENUE-6: resolve the builder's revenue share for a child business's sale. Returns null
 * (no share) when: the checkout carried no positive builder_fee_bps; the selling space is not a
 * child under a reseller builder (a top-level builder selling directly has no separate builder to
 * pay — it IS the space owner); or the computed share would be zero. builder_fee_bps is read from
 * the checkout metadata (stamped at checkout time, so a later config change can't retroactively
 * re-price an in-flight order), capped at the ceiling, and clamped so naelao_fee + builder_fee
 * never exceeds gross.
 */
export async function resolveBuilderShare(
  event: NormalizedBillingEvent,
  gross: number,
  naelaoFee: number,
  env: LemonSqueezyEnv
): Promise<BuilderShare | null> {
  if (!event.spaceId) return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  const rawBps = custom["builder_fee_bps"] ? parseInt(String(custom["builder_fee_bps"]), 10) : 0;
  if (!Number.isFinite(rawBps) || rawBps <= 0) return null;
  const bps = Math.min(rawBps, BUILDER_FEE_BPS_CEILING);

  const space = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) return null;

  const hierarchy = await env.PLATFORM_DB.prepare(
    "SELECT parent_tenant_id FROM tenant_hierarchy WHERE child_tenant_id = ? AND status = 'active'"
  ).bind(space.tenant_id).first<{ parent_tenant_id: string }>();
  if (!hierarchy) return null; // not a child business under a reseller builder — no separate builder

  // Clamp: the two fees together can never exceed the gross (never settle the wallet negative).
  const builderFeeCents = Math.min(Math.round((gross * bps) / 10_000), Math.max(0, gross - naelaoFee));
  if (builderFeeCents <= 0) return null;
  return { builderFeeCents, parentTenantId: hierarchy.parent_tenant_id, childTenantId: space.tenant_id, childSpaceId: event.spaceId };
}

/**
 * ARCH-REVENUE-6: attribute the builder's slice to their payout balance as a reseller_ledger row
 * with kind='builder_revenue_share'. `reverse` writes a negative-margin row of the same kind on a
 * refund so the payout balance nets to zero (never deletes the original — audit trail). Idempotent
 * via a per-order provider_event_id (suffixed for the reversal so it never collides with the grant).
 */
export async function recordBuilderRevenueShare(
  db: D1Database,
  share: BuilderShare,
  event: NormalizedBillingEvent,
  builderFeeCents: number,
  providerEventId: string,
  reverse: boolean
): Promise<void> {
  const margin = reverse ? -builderFeeCents : builderFeeCents;
  await db.prepare(
    `INSERT OR IGNORE INTO reseller_ledger
       (id, parent_tenant_id, child_tenant_id, child_space_id, event_type,
        retail_cents, wholesale_cents, margin_cents, currency, period, provider_event_id, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builder_revenue_share')`
  ).bind(
    crypto.randomUUID(), share.parentTenantId, share.childTenantId, share.childSpaceId,
    reverse ? "refund.issued" : event.type, event.amountCents ?? 0, 0, margin,
    event.currency ?? "USD", billingPeriod(), `${reverse ? "refund" : "builder"}:${providerEventId}`
  ).run();
  console.log(`[billing/ls] Builder revenue share ${reverse ? "reversed" : "recorded"}: parent=${share.parentTenantId} margin=${margin}c`);
}

export interface LemonSqueezyEnv {
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  LAUNCHPAD_FEE_BPS?: string;
  AGENTS_WORKER?: Fetcher;
  SPACES_WORKER?: Fetcher;
  PLATFORM_DB: D1Database;
  /** For minting the internal HMAC token the direct (non-router) SPACES_WORKER call below needs. */
  PLATFORM_SECRET: string;
  /** Optional — platform-plan upserts invalidate the org's quota cache so a paid upgrade takes
   *  effect immediately instead of after the KV TTL. Degrades to a no-op when unbound. */
  QUOTA_CACHE?: KVNamespace;
}

/**
 * Activate a paid seat (member/seat billing — the third payer class). On a seat payment,
 * add the buyer to the space's members in SpaceDO and record the fee in launchpad_orders
 * (so seat revenue shows in the same rollup). Returns the order id, or null when the event
 * is not a seat purchase. Idempotent on the provider event id.
 */
async function recordSeatActivation(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<string | null> {
  if (event.type !== "payment.success") return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "seat" || !event.spaceId) return null;

  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) throw new Error("paid seat webhook references a missing space");

  const gross = event.amountCents ?? 0;
  const feeBps = normalizeFeeBps(custom["fee_bps"], env.LAUNCHPAD_FEE_BPS);
  const fee = Math.min(Math.max(0, gross), Math.round((Math.max(0, gross) * feeBps) / 10_000));
  // ARCH-REVENUE-6: builder's slice on a child business's seat sale (same as product sales).
  const builderShare = await resolveBuilderShare(event, gross, fee, env);
  const builderFee = builderShare?.builderFeeCents ?? 0;
  const net = Math.max(0, gross - fee - builderFee);
  const id = crypto.randomUUID();
  // S0.3: prefer the real provider event id (LS's data.id) over a synthetic key — a synthetic
  // key built from type+customer+amount+space collides across two genuinely distinct purchases
  // at the same price.
  const providerEventId = event.providerEventId ?? event.subscriptionId ?? `seat:${event.customerId ?? ""}:${gross}:${event.spaceId}`;

  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO launchpad_orders
       (id, space_id, tenant_id, product_id, customer_email, gross_cents, fee_cents, builder_fee_cents, net_cents,
        currency, ls_subscription_id, status, provider_event_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    id, event.spaceId, space.tenant_id, event.customerId ?? null,
    gross, fee, builderFee, net, event.currency ?? "USD", event.subscriptionId ?? null, providerEventId
  ).run();
  // Settle the seat's net proceeds into the SELLING space's own wallet — the same P0-5 loop
  // recordProductOrder closes (a business's own sales fund its own agent's compute). Was missing
  // here: seat net_cents was recorded but went nowhere (stranded in Naelao's LS account), and the
  // consolidated wallet view's "net settled" total counts it. Settled UNCONDITIONALLY + idempotently
  // (settle:${providerEventId}) so a retry completes a settlement the first delivery missed — same
  // reasoning as recordProductOrder. A space with no wallet (a top-level builder charging seats,
  // not a business) is a no-op (settleOrderToWallet returns false on a null wallet project).
  await settleOrderToWallet(event.spaceId, space.tenant_id, net, `settle:${providerEventId}`, "sale_settlement", env);
  if (builderShare && builderFee > 0) {
    await recordBuilderRevenueShare(env.PLATFORM_DB, builderShare, event, builderFee, providerEventId, false);
  }

  // Activate the member in SpaceDO (idempotent — addMember upserts).
  // A Lemon Squeezy customer id is provider-scoped and must never be treated as a Naelao user id.
  // Older checkout links without a Naelao identity remain recorded, but they cannot auto-enroll.
  const userId = custom["user_id"] ? String(custom["user_id"]) : "";
  if (userId) {
    if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for paid seat activation");
    try {
      const activation = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(event.spaceId)}/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": space.tenant_id,
          "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, space.tenant_id),
        },
        body: JSON.stringify({ space_id: event.spaceId, user_id: userId, role: "member" }),
      }));
      if (!activation.ok) throw new Error(`member activation ${activation.status}: ${await responseDetail(activation)}`);
    } catch (err) {
      console.error("[billing/ls] Seat member activation failed:", (err as Error).message);
      throw err;
    }
  }
  console.log(`[billing/ls] Seat activated space=${event.spaceId} user=${userId} gross=${gross}c fee=${fee}c`);
  return id;
}

/**
 * Record a customer product order on payment.success, capturing the platform fee. Driven by
 * the custom_data the commerce checkout carried (product_id, fee_bps). Idempotent on the
 * provider event id so webhook retries don't double-write. Returns the order id (or null
 * when this event is not a product sale — e.g. a builder's own plan subscription).
 */
async function recordProductOrder(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<string | null> {
  if (event.type !== "payment.success") return null;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  const productId = custom["product_id"] ? String(custom["product_id"]) : null;
  if (!productId || !event.spaceId) return null; // not a Launchpad product sale

  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) throw new Error("paid product order webhook references a missing space");

  const gross = event.amountCents ?? 0;
  const feeBps = normalizeFeeBps(custom["fee_bps"], env.LAUNCHPAD_FEE_BPS);
  const fee = Math.min(Math.max(0, gross), Math.round((Math.max(0, gross) * feeBps) / 10_000));
  // ARCH-REVENUE-6: a second deduction — the builder's configured slice of this child business's
  // sale. Zero for a top-level builder's direct sale (no parent reseller). The business wallet
  // receives gross - naelao_fee - builder_fee.
  const builderShare = await resolveBuilderShare(event, gross, fee, env);
  const builderFee = builderShare?.builderFeeCents ?? 0;
  const net = Math.max(0, gross - fee - builderFee);
  const id = crypto.randomUUID();
  // S0.3: prefer the real provider event id — the synthetic fallback collided across two
  // genuinely distinct same-price purchases of the same product by the same customer.
  const providerEventId = event.providerEventId ?? event.subscriptionId ?? `${event.type}:${event.customerId ?? ""}:${gross}:${productId}`;

  // INSERT OR IGNORE on the unique provider_event_id index → idempotent (a retry re-inserts nothing
  // but still re-attempts the idempotent settlement below).
  await env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO launchpad_orders
       (id, space_id, tenant_id, product_id, customer_email, gross_cents, fee_cents, builder_fee_cents, net_cents,
        currency, ls_subscription_id, status, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).bind(
    id, event.spaceId, space.tenant_id, productId, event.customerId ?? null,
    gross, fee, builderFee, net, event.currency ?? "USD", event.subscriptionId ?? null, providerEventId
  ).run();
  console.log(`[billing/ls] Recorded order space=${event.spaceId} product=${productId} gross=${gross}c fee=${fee}c builderFee=${builderFee}c`);

  // P0-5: net_cents used to sit in this row and go nowhere — Naelao's own Lemon Squeezy account
  // kept 100% of every storefront sale, and the seller got a database row. Settle it into the
  // SAME space's auto-provisioned wallet (seedWallet, P0-4) — the wallet is already the payer of
  // last resort for that space's own project-scoped agent runs (P0-2), so this closes the loop:
  // a business's own sales now fund its own agent's compute.
  //
  // Settlement is ALWAYS attempted (not only on a first insert) and is idempotent via
  // `settle:${providerEventId}` on wallet_ledger — so a webhook RETRY after a transient settlement
  // failure completes the settlement instead of being skipped. Previously this was gated on
  // insertResult.meta.changes > 0, which meant a retry (order row already present → changes=0)
  // never re-settled, permanently losing the revenue if the first settlement had failed.
  await settleOrderToWallet(event.spaceId, space.tenant_id, net, `settle:${providerEventId}`, "sale_settlement", env);
  if (builderShare && builderFee > 0) {
    await recordBuilderRevenueShare(env.PLATFORM_DB, builderShare, event, builderFee, providerEventId, false);
  }
  return id;
}

/**
 * P0-5: credit or debit the SELLING space's own wallet for a storefront sale/refund. The wallet's
 * identity is never named in checkout metadata (unlike grantWalletTopupPurchase, an explicit
 * buyer-initiated top-up of a project the buyer chose) — it's the space's own auto-provisioned
 * kind='wallet' project, resolved the same way NaelaoAgentDO's wallet gate resolves it.
 * A missing wallet (a space provisioned before P0-4 shipped) is a permanent no-op. Missing service
 * binding, transient lookup errors, and failed credits throw so the webhook can retry instead of
 * acknowledging a paid order without settling its proceeds.
 */
async function settleOrderToWallet(
  spaceId: string,
  tenantId: string,
  cents: number,
  idempotencyKey: string,
  reason: "sale_settlement" | "refund_clawback",
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (cents <= 0) return false;
  if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for wallet settlement");
  const headers = {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
  };
  // A network/parse error reaching the wallet-project lookup is TRANSIENT — let it throw so the
  // webhook returns non-200 and Lemon Squeezy retries (see handleLemonSqueezyWebhook), rather than
  // silently dropping a business's earned revenue. Idempotency_key makes the eventual retry safe.
  const wpRes = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/wallet-project`, { headers }));
  if (!wpRes.ok) throw new Error(`wallet-project lookup ${wpRes.status} for space=${spaceId}`);
  const { project_id } = await wpRes.json<{ project_id: string | null }>();
  if (!project_id) return false; // no wallet ever provisioned for this space — nothing to settle to (permanent, not retriable)

  const op = reason === "sale_settlement" ? "credit" : "debit";
  const resp = await env.SPACES_WORKER.fetch(new Request(
    `http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(project_id)}/wallet/${op}`,
    { method: "POST", headers, body: JSON.stringify({ cents, reason, idempotency_key: idempotencyKey }) }
  ));
  if (!resp.ok) {
    // A refund clawback that 402s (insufficient balance — the seller already spent the proceeds
    // running their agent) is a real, documented, NON-retriable limitation: debit AT MOST what the
    // wallet holds, never a negative balance. Return false (no retry). Any OTHER non-2xx on the
    // credit path (a sale settlement) is transient → throw so the webhook retries instead of losing
    // the business's earned revenue.
    const bodyText = await responseDetail(resp);
    if (op === "debit" && resp.status === 402) {
      console.warn(`[billing/ls] wallet debit insufficient-balance (documented) for space=${spaceId} project=${project_id}: ${bodyText}`);
      return false;
    }
    throw new Error(`wallet ${op} ${resp.status} for space=${spaceId} project=${project_id}: ${bodyText}`);
  }
  console.log(`[billing/ls] wallet ${op} ${cents}c for space=${spaceId} project=${project_id} (${reason})`);
  return true;
}

/**
 * P0-5: claw back a storefront sale's settled proceeds when Lemon Squeezy reports a refund.
 * order_refunded is a status transition on the SAME underlying LS order resource as the original
 * order_created event, so it carries the identical resource id — providerEventId here matches
 * the ORIGINAL order's own provider_event_id in launchpad_orders, letting this look the order up
 * directly rather than recomputing anything from the refund event's own (less reliable for
 * partial refunds) amount field. Deliberately claws back the FULL originally-settled net_cents
 * even for a partial refund — a known simplification (documented, not silently wrong): this
 * repo's LS integration doesn't yet distinguish a partial refund amount from the order's original
 * total, so it treats every refund as a full one for wallet-settlement purposes.
 */
async function recordOrderRefund(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<void> {
  if (event.type !== "refund.issued" || !event.providerEventId) return;

  const order = await env.PLATFORM_DB.prepare(
    "SELECT space_id, tenant_id, net_cents, builder_fee_cents, status FROM launchpad_orders WHERE provider_event_id = ?"
  ).bind(event.providerEventId).first<{ space_id: string; tenant_id: string; net_cents: number; builder_fee_cents: number; status: string }>();
  if (!order || order.status === "refunded") return; // unknown order, or already clawed back (idempotent)
  // Do retryable/idempotent side effects before the durable refunded state. If the wallet or
  // reseller ledger is unavailable, the webhook releases its event claim; leaving the order paid
  // lets that retry finish the missing clawback instead of incorrectly short-circuiting here.
  await settleOrderToWallet(order.space_id, order.tenant_id, order.net_cents, `refund:${event.providerEventId}`, "refund_clawback", env);

  // ARCH-REVENUE-6: claw back the builder's share too — a refund reverses BOTH deductions, not
  // just the wallet net. Reverse the reseller_ledger builder_revenue_share row with a matching
  // negative-margin entry so the builder's payout balance nets to zero for this order.
  if (order.builder_fee_cents > 0) {
    const hierarchy = await env.PLATFORM_DB.prepare(
      "SELECT parent_tenant_id FROM tenant_hierarchy WHERE child_tenant_id = ? AND status = 'active'"
    ).bind(order.tenant_id).first<{ parent_tenant_id: string }>();
    if (hierarchy) {
      await recordBuilderRevenueShare(
        env.PLATFORM_DB,
        { builderFeeCents: order.builder_fee_cents, parentTenantId: hierarchy.parent_tenant_id, childTenantId: order.tenant_id, childSpaceId: order.space_id },
        event, order.builder_fee_cents, event.providerEventId, true
      );
    }
  }
  await env.PLATFORM_DB.prepare(
    "UPDATE launchpad_orders SET status = 'refunded' WHERE provider_event_id = ? AND status != 'refunded'"
  ).bind(event.providerEventId).run();
}

/**
 * F-29 (monetary loss): the refund handler above only matches launchpad_orders rows (product
 * sales + seats). A refunded wallet top-up, credit pack, or revenue-cut surcharge left the granted
 * value in place — free platform spend, repeatable. This routes a refund by the ORIGINAL checkout
 * kind (LS preserves the order's custom_data on the order_refunded event, same as the mark-billed
 * path relies on) and reverses the matching grant:
 *   - wallet_topup  → debit the wallet (the 402-tolerant refund_clawback path already exists)
 *   - credit_pack   → negative credit_ledger entry via the deduct sink
 *   - revenue_cut_surcharge → un-mark the periods so the cut is re-billable
 * Idempotent: the top-level processed_webhook_events gate already prevents a refund event running
 * twice; each downstream grant/debit is additionally keyed on `refund:{providerEventId}`.
 */
async function recordNonOrderRefundClawback(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<void> {
  if (event.type !== "refund.issued") return;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  const kind = typeof custom["kind"] === "string" ? custom["kind"] : null;
  if (!kind) return;
  if (!["wallet_topup", "credit_pack", "revenue_cut_surcharge"].includes(kind)) return;
  if (!event.providerEventId) throw new Error(`${kind} refund webhook is missing provider event id`);
  const spaceId = requiredEventSpaceId(event, kind);
  if (["wallet_topup", "credit_pack", "revenue_cut_surcharge"].includes(kind) && !env.SPACES_WORKER) {
    throw new Error(`Spaces worker is not bound for ${kind} refund clawback`);
  }
  if (!env.SPACES_WORKER) throw new Error(`Spaces worker is not bound for ${kind} refund clawback`);

  const space = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(spaceId).first<{ tenant_id: string }>();
  if (!space) throw new Error(`${kind} refund webhook references a missing space`);
  const headers = {
    "content-type": "application/json",
    "x-naelao-tenant-id": space.tenant_id,
    "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, space.tenant_id),
  };
  const idempotencyKey = `refund:${event.providerEventId}`;

  if (kind === "wallet_topup") {
    const projectId = requiredMetadataString(custom, "project_id", kind);
    const cents = requiredPositiveMetadataInteger(custom, "cents", kind);
    const resp = await env.SPACES_WORKER.fetch(new Request(
      `http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/wallet/debit`,
      { method: "POST", headers, body: JSON.stringify({ cents, reason: "refund_clawback", idempotency_key: idempotencyKey }) }
    ));
    if (!resp.ok) {
      const detail = await responseDetail(resp);
      // The wallet cannot go negative; a depleted balance is the documented refund shortfall.
      // Other errors are transient or indicate a broken clawback and must trigger provider retry.
      if (resp.status === 402) console.warn(`[billing/ls] wallet_topup refund shortfall space=${event.spaceId} project=${projectId}: ${detail}`);
      else throw new Error(`wallet_topup refund clawback ${resp.status}: ${detail}`);
    }
    return;
  }

  if (kind === "credit_pack") {
    const endUserId = requiredMetadataString(custom, "end_user_id", kind);
    const productSpaceId = requiredMetadataString(custom, "product_space_id", kind);
    const credits = requiredPositiveMetadataInteger(custom, "credits", kind);
    const resp = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/credit-packs/clawback", {
      method: "POST", headers,
      body: JSON.stringify({ product_space_id: productSpaceId, end_user_id: endUserId, credits, idempotency_key: idempotencyKey }),
    }));
    if (!resp.ok) throw new Error(`credit_pack refund clawback ${resp.status} for end_user=${endUserId}: ${await responseDetail(resp)}`);
    return;
  }

  if (kind === "revenue_cut_surcharge") {
    const { periods, charges } = requiredRevenuePeriods(custom, kind);
    // F-27: reverse exactly the delta that was charged per period (LS preserves the order's
    // custom_data on the refund event), so a refund re-opens only that much for re-billing.
    const resp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/revenue-tracking/unmark-billed`, {
      method: "POST", headers, body: JSON.stringify({ periods, ...(charges ? { charges } : {}) }),
    }));
    if (!resp.ok) throw new Error(`surcharge refund unmark ${resp.status} for space=${spaceId}: ${await responseDetail(resp)}`);
    return;
  }
}

/** Map Lemon Squeezy's own subscription status vocabulary onto business_subscriptions' narrower
 *  CHECK-constrained enum. "on_trial" and "unpaid" don't have their own column value — trialing
 *  counts as active access, unpaid is a stronger past_due (the builder's UI doesn't currently
 *  need to distinguish them; add a value if that changes). */
function mapSubscriptionStatus(event: NormalizedBillingEvent): string {
  if (event.type === "payment.failed") return "past_due";
  switch (event.type) {
    case "subscription.cancelled": return "cancelled";
    case "subscription.paused": return "paused";
    case "subscription.resumed": return "active";
    case "subscription.expired": return "expired";
    default: break;
  }
  switch (event.providerStatus) {
    case "active":
    case "on_trial": return "active";
    case "past_due":
    case "unpaid": return "past_due";
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    default: return "active";
  }
}

/**
 * Vendor cutover (Lemon Squeezy is the ONLY billing provider): the BUILDER's own platform plan
 * (growth/business), previously the last Stripe-backed path. Fires on every subscription.* /
 * payment.success event whose checkout metadata carries kind="platform_plan" (set by
 * POST /billing/checkout). This is an ORG-level event — there is no space to resolve and no
 * agent to wake, so handleLemonSqueezyWebhook branches here BEFORE its space-dispatch machinery.
 *
 * Writes BOTH plan_tier locations on purpose:
 *   - `subscriptions` (org-unique row) — what GET /billing/subscription displays;
 *   - `orgs.plan_tier` — what EntitlementsChecker.getTenantTier actually enforces platform-wide
 *     (free-tier template gating, space/seat quotas). The old Stripe webhook only ever wrote
 *     `subscriptions`, so a paid upgrade never actually unlocked entitlements — a real,
 *     previously-undetected bug this cutover closes, not just relocates.
 *
 * `event.provider` picks WHICH id-columns get written (ls_* vs whop_*, migration 0067) — Whop was
 * added as a second platform provider tried before LS (AUDIT_TODO.md AI-7); the other provider's
 * columns are left untouched (COALESCE), so an org that switched provider keeps its historical id
 * from the one it's no longer on rather than clobbering it with NULL.
 */
export async function recordPlatformPlanSubscription(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "platform_plan") return false;
  const orgId = requiredMetadataString(custom, "org_id", "platform plan");
  const plan = requiredMetadataString(custom, "plan", "platform plan");
  if (plan !== "growth" && plan !== "business") throw new Error("platform plan webhook contains an unsupported plan");

  // A failed renewal may mark an existing subscription delinquent, but it must never create a
  // paid org tier by itself. Refund events are acknowledged without changing entitlement state;
  // the subscription lifecycle event is the source of truth for access removal.
  if (event.type === "payment.failed") {
    // Payment notifications can arrive after a user has replaced their subscription. Only let a
    // failure for the subscription currently recorded on the org update its state; a failure for
    // an older subscription (or an initial payment with no row yet) must not downgrade new access.
    if (!event.subscriptionId) return true;
    const subscriptionColumn = event.provider === "whop" ? "whop_subscription_id" : "ls_subscription_id";
    await env.PLATFORM_DB.prepare(
      `UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
       WHERE org_id = ? AND plan_tier = ? AND ${subscriptionColumn} = ?`
    ).bind(orgId, plan, event.subscriptionId).run();
    return true;
  }
  if (event.type === "refund.issued") return true;
  if (event.type !== "payment.success" && !event.type.startsWith("subscription.")) return true;

  const status = mapSubscriptionStatus(event);
  // Access policy: cancelled keeps the paid tier until LS sends subscription.expired at period
  // end (LS's own grace semantics); expired drops the org back to free. past_due keeps the tier
  // (dunning may still recover the payment) but surfaces the status.
  const planTier = status === "expired" ? "free" : plan;
  const isWhop = event.provider === "whop";

  await env.PLATFORM_DB.prepare(
    `INSERT INTO subscriptions
       (id, org_id, plan_tier, status, ls_customer_id, ls_subscription_id,
        whop_customer_id, whop_subscription_id, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(org_id) DO UPDATE SET
       plan_tier          = excluded.plan_tier,
       status             = excluded.status,
       ls_customer_id       = COALESCE(excluded.ls_customer_id, subscriptions.ls_customer_id),
       ls_subscription_id   = COALESCE(excluded.ls_subscription_id, subscriptions.ls_subscription_id),
       whop_customer_id     = COALESCE(excluded.whop_customer_id, subscriptions.whop_customer_id),
       whop_subscription_id = COALESCE(excluded.whop_subscription_id, subscriptions.whop_subscription_id),
       current_period_end = excluded.current_period_end,
       updated_at         = datetime('now')`
  ).bind(
    crypto.randomUUID(), orgId, planTier, status,
    isWhop ? null : (event.customerId ?? null), isWhop ? null : (event.subscriptionId ?? null),
    isWhop ? (event.customerId ?? null) : null, isWhop ? (event.subscriptionId ?? null) : null,
    event.currentPeriodEnd ?? null
  ).run();

  await env.PLATFORM_DB.prepare(
    "UPDATE orgs SET plan_tier = ? WHERE id = ?"
  ).bind(planTier, orgId).run();

  if (env.QUOTA_CACHE) await invalidateQuotaCache(env.QUOTA_CACHE, orgId);
  console.log(`[billing/ls] Platform plan ${status}: org=${orgId} tier=${planTier}`);
  return true;
}

/**
 * Phase E (§A1.17): a business subscribing to one of its product's builder-defined plans
 * (productConfig.pricingConfig.plans). Fires on every subscription.* event whose checkout
 * metadata carries kind="business_subscription" (set by POST /internal/business-subscriptions/
 * checkout). Upserts by business_space_id (a business has at most one current plan — switching
 * plans overwrites the row rather than accumulating history; reseller_ledger is the historical
 * revenue record) so a webhook retry or a later status transition is a no-op / in-place update,
 * never a duplicate row.
 */
async function recordBusinessSubscription(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "business_subscription") return false;
  const businessSpaceId = requiredEventSpaceId(event, "business subscription");
  const planId = requiredMetadataString(custom, "plan_id", "business subscription");
  const productSpaceId = requiredMetadataString(custom, "product_space_id", "business subscription");
  if (event.type === "refund.issued") return true;
  if (event.type !== "payment.success" && event.type !== "payment.failed" && !event.type.startsWith("subscription.")) return true;

  if (event.type === "payment.failed") {
    // Do not let a late failed charge from a replaced subscription downgrade the business's
    // current plan, or downgrade a different plan that happens to belong to the same business.
    if (!event.subscriptionId) return true;
    await env.PLATFORM_DB.prepare(
      `UPDATE business_subscriptions SET status = 'past_due', updated_at = ?
       WHERE business_space_id = ? AND product_space_id = ? AND plan_id = ? AND ls_subscription_id = ?`
    ).bind(new Date().toISOString(), businessSpaceId, productSpaceId, planId, event.subscriptionId).run();
    return true;
  }

  const status = mapSubscriptionStatus(event);
  await env.PLATFORM_DB.prepare(
    `INSERT INTO business_subscriptions
       (id, business_space_id, product_space_id, plan_id, status, ls_subscription_id, ls_customer_id, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(business_space_id) DO UPDATE SET
       product_space_id = excluded.product_space_id,
       plan_id = excluded.plan_id,
       status = excluded.status,
       ls_subscription_id = excluded.ls_subscription_id,
       ls_customer_id = excluded.ls_customer_id,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at`
  ).bind(
    crypto.randomUUID(), businessSpaceId, productSpaceId, planId, status,
    event.subscriptionId ?? null, event.customerId ?? null, event.currentPeriodEnd ?? null,
    new Date().toISOString()
  ).run();
  console.log(`[billing/ls] Business subscription ${status}: business=${businessSpaceId} plan=${planId}`);
  return true;
}

/** Record native template royalties only on a captured provider payment event. */
async function settleNativeTemplateRoyalty(event: NormalizedBillingEvent, env: LemonSqueezyEnv): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const mapped = event.subscriptionId
    ? (await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE provider_subscription_id = ? AND space_id = ?")
      .bind(event.subscriptionId, event.spaceId).first<{ id: string }>())?.id
    : undefined;
  if (event.metadata?.kind !== "template_subscription" && !mapped) return false;
  const subscriptionId = event.metadata?.template_subscription_id ?? mapped;
  if (!subscriptionId || !event.providerEventId || !Number.isSafeInteger(event.amountCents) || event.amountCents <= 0) {
    throw new Error("captured template payment is missing an id, subscription, or positive amount");
  }
  const subscription = await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE id = ? AND space_id = ? AND status IN ('active','paused')")
    .bind(subscriptionId, event.spaceId).first<{ id: string }>();
  if (!subscription) throw new Error("captured template payment has no active matching subscription");
  await settleTemplateSubscriptionPayment(env.PLATFORM_DB, event.spaceId, event.amountCents, event.providerEventId, event.subscriptionId);
  return true;
}

async function syncNativeTemplateSubscriptionStatus(event: NormalizedBillingEvent, env: LemonSqueezyEnv): Promise<boolean> {
  if (!event.type.startsWith("subscription.")) return false;
  const id = event.metadata?.kind === "template_subscription" ? event.metadata.template_subscription_id : undefined;
  if (!id && !event.subscriptionId) return false;
  const status = event.type === "subscription.cancelled" || event.type === "subscription.expired" || event.providerStatus === "cancelled" || event.providerStatus === "expired"
    ? "cancelled"
    : event.type === "subscription.paused" || event.providerStatus === "paused" || event.providerStatus === "past_due" || event.providerStatus === "unpaid"
      ? "paused"
      : event.type === "subscription.resumed" || event.type === "subscription.updated" ? "active" : "paused";
  const result = await env.PLATFORM_DB.prepare(`UPDATE template_subscriptions SET
    status = CASE WHEN paid_cycles_total > 0 THEN ? WHEN ? = 'cancelled' THEN 'cancelled' ELSE 'paused' END,
    provider_subscription_id = COALESCE(provider_subscription_id, ?), updated_at = datetime('now')
    WHERE space_id = ? AND ((? IS NOT NULL AND id = ?) OR (? IS NOT NULL AND provider_subscription_id = ?))`)
    .bind(status, status, event.subscriptionId, event.spaceId, id ?? null, id ?? null, event.subscriptionId, event.subscriptionId).run();
  return result.meta.changes > 0;
}

/**
 * Phase E: an end user buying a one-time credit pack for their OWN ProductUserDO balance. Fires
 * on payment.success with checkout metadata kind="credit_pack". Grants via the spaces worker
 * (only it holds the PRODUCT_USER_DO binding) with a stable idempotency_key so a webhook retry
 * never double-grants — ProductUserDO's own credit_ledger enforces this with a unique partial
 * index (see workers/spaces/src/do/ProductUserDO.ts migration v2).
 */
async function grantCreditPackPurchase(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "credit_pack") return false;
  requiredEventSpaceId(event, "credit pack");
  const endUserId = requiredMetadataString(custom, "end_user_id", "credit pack");
  const productSpaceId = requiredMetadataString(custom, "product_space_id", "credit pack");
  const credits = requiredPositiveMetadataInteger(custom, "credits", "credit pack");
  if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for credit-pack grants");

  const product = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(productSpaceId).first<{ tenant_id: string }>();
  if (!product) throw new Error("credit pack webhook references a missing product space");

  // F-30: prefer the LS order id (providerEventId) — stable across webhook retries but UNIQUE per
  // real purchase. The old synthetic fallback was identical for every purchase of the same pack by
  // the same customer, so a legitimate second purchase (running low again) collided with the first
  // on credit_ledger's unique idempotency index and was silently swallowed — customer paid, got
  // nothing. subscriptionId is null for one-time orders, so it was never the real key anyway.
  const idempotencyKey = event.providerEventId ?? event.subscriptionId ?? `credit_pack:${event.customerId ?? ""}:${event.amountCents}:${endUserId}:${credits}`;
  try {
    const resp = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/credit-packs/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": product.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, product.tenant_id),
      },
      body: JSON.stringify({ product_space_id: productSpaceId, end_user_id: endUserId, credits, idempotency_key: idempotencyKey }),
    }));
    if (!resp.ok) {
      // Transient — throw so the webhook retries rather than the paying customer getting nothing.
      // The grant is idempotency-keyed, so a retry never double-grants.
      throw new Error(`credit pack grant ${resp.status} for end_user=${endUserId}: ${await responseDetail(resp)}`);
    }
    console.log(`[billing/ls] Granted ${credits} credits to end_user=${endUserId} product=${productSpaceId}`);
    return true;
  } catch (err) {
    // Re-throw: a transient grant failure must surface to the orchestrator so the webhook returns
    // non-200 and Lemon Squeezy retries (idempotency-keyed → safe). Swallowing here silently
    // dropped a paid credit pack.
    console.error("[billing/ls] Credit pack grant error:", (err as Error).message);
    throw err;
  }
}

/**
 * Phase 4 (money): an end user buying/renewing their OWN personal-plan tier. Fires on
 * payment.success (a one-time LS variant is the simplest real thing to provision here, matching
 * credit_pack's own precedent — a true recurring-subscription tier would need its own
 * subscription-lifecycle handling like recordBusinessSubscription's, deferred as a real, scoped
 * follow-up rather than half-built here) with checkout metadata kind="personal_plan". Grants via
 * /internal/personal-plan/grant — plan_tier/set is naturally idempotent (setting the same tier
 * twice is a no-op effect), so unlike credit-pack's additive ledger this needs no idempotency key
 * of its own to stay safe under a webhook retry.
 */
export async function grantPersonalPlanPurchase(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  // Deliberately NOT gated on event.spaceId: a Whop-originated personal-plan purchase is created
  // against Naelao's own seller account (no per-space checkout), so it carries its scope entirely
  // in metadata. The three fields actually needed are validated immediately below, which is the
  // real requirement — spaceId was never used for anything here beyond this guard.
  if (custom["kind"] !== "personal_plan") return false;
  const endUserId = requiredMetadataString(custom, "end_user_id", "personal plan");
  const productSpaceId = requiredMetadataString(custom, "product_space_id", "personal plan");
  const tier = requiredMetadataString(custom, "tier", "personal plan");
  if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for personal-plan grants");

  const product = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(productSpaceId).first<{ tenant_id: string }>();
  if (!product) throw new Error("personal plan webhook references a missing product space");

  try {
    const resp = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/personal-plan/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": product.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, product.tenant_id),
      },
      body: JSON.stringify({ product_space_id: productSpaceId, end_user_id: endUserId, tier }),
    }));
    if (!resp.ok) {
      throw new Error(`personal plan grant ${resp.status} for end_user=${endUserId}: ${await responseDetail(resp)}`);
    }
    console.log(`[billing/ls] Set personal plan tier=${tier} for end_user=${endUserId} product=${productSpaceId}`);
    return true;
  } catch (err) {
    console.error("[billing/ls] Personal plan grant error:", (err as Error).message);
    throw err;
  }
}

/**
 * Launchpad Wallet (user-directed feature): a business topping up its OWN wallet_ledger balance
 * (a project flagged kind='wallet') — same shape as grantCreditPackPurchase above, but the
 * proceeds land on the BUSINESS's stored-value balance, not an individual end user's. Fires on
 * payment.success with checkout metadata kind="wallet_topup". idempotency_key mirrors
 * credit-pack's own convention (prefer the LS-stable subscriptionId/event id, fall back to a
 * synthetic key derived from stable order attributes) — wallet_ledger enforces this with the
 * same unique-partial-index shape as credit_ledger.
 */
async function grantWalletTopupPurchase(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "wallet_topup") return false;
  const spaceId = requiredEventSpaceId(event, "wallet top-up");
  const projectId = requiredMetadataString(custom, "project_id", "wallet top-up");
  const cents = requiredPositiveMetadataInteger(custom, "cents", "wallet top-up");
  if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for wallet top-up grants");

  const space = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(spaceId).first<{ tenant_id: string }>();
  if (!space) throw new Error("wallet top-up webhook references a missing business space");

  // F-30: same fix as credit packs — key on the LS order id so two legitimate top-ups of the same
  // amount to the same project don't collide on wallet_ledger's idempotency index and drop the second.
  const idempotencyKey = event.providerEventId ?? event.subscriptionId ?? `wallet_topup:${event.customerId ?? ""}:${event.amountCents}:${projectId}:${cents}`;
  try {
    const resp = await env.SPACES_WORKER.fetch(new Request("http://spaces-worker/internal/wallet-topups/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": space.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, space.tenant_id),
      },
      body: JSON.stringify({ business_space_id: spaceId, project_id: projectId, cents, idempotency_key: idempotencyKey }),
    }));
    if (!resp.ok) {
      // Transient — throw so the webhook retries (idempotency-keyed → safe) rather than silently
      // dropping the business's own topped-up capital.
      throw new Error(`wallet top-up grant ${resp.status} for space=${spaceId} project=${projectId}: ${await responseDetail(resp)}`);
    }
    console.log(`[billing/ls] Granted ${cents} wallet cents to space=${spaceId} project=${projectId}`);
    return true;
  } catch (err) {
    console.error("[billing/ls] Wallet top-up grant error:", (err as Error).message);
    throw err;
  }
}

/**
 * Go-live monetization pass: once a POST /internal/revenue-cut-surcharge/checkout is paid, mark
 * the periods it covered as billed (SpaceDO's external_revenue_snapshots) so the next checkout
 * only bills genuinely-new tracked revenue, never the same period twice. Naelao's/the builder's
 * cut of the payment itself is ALREADY captured — recordResellerAttribution (unconditional, step
 * 4 of handleLemonSqueezyWebhook) treats every payment.success as a revenue event and computes
 * the wholesale/referral split the same way it does for every other payer class; this function's
 * only job is closing the loop on which periods were paid for.
 */
async function recordRevenueCutSurchargePayment(
  event: NormalizedBillingEvent,
  env: LemonSqueezyEnv
): Promise<boolean> {
  if (event.type !== "payment.success") return false;
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] !== "revenue_cut_surcharge") return false;
  const spaceId = requiredEventSpaceId(event, "revenue-cut surcharge");
  const { periods, charges } = requiredRevenuePeriods(custom, "revenue-cut surcharge");
  if (!env.SPACES_WORKER) throw new Error("Spaces worker is not bound for revenue-cut settlement");
  // F-27: the per-period delta actually charged (parallel to periods) — added to billed_cents so a
  // later correction bills only the new delta. Absent (a checkout minted before this fix) → the
  // SpaceDO handler falls back to marking the period fully billed.
  const space = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(spaceId).first<{ tenant_id: string }>();
  if (!space) throw new Error("revenue-cut surcharge webhook references a missing space");

  try {
    const resp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/revenue-tracking/mark-billed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": space.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, space.tenant_id),
      },
      body: JSON.stringify({ periods, ...(charges ? { charges } : {}) }),
    }));
    if (!resp.ok) {
      throw new Error(`revenue-cut mark-billed ${resp.status} for space=${spaceId}: ${await responseDetail(resp)}`);
    }
    console.log(`[billing/ls] Marked revenue-cut periods billed for space=${spaceId}: ${periods.join(",")}`);
    return true;
  } catch (err) {
    console.error("[billing/ls] revenue-cut mark-billed error:", (err as Error).message);
    throw err;
  }
}

const GOAL_MAP: Record<NormalizedBillingEvent["type"], string> = {
  "payment.success": "A new payment was completed. Fulfil the order, send confirmation, and provision access.",
  "payment.failed": "A payment has failed. Trigger the dunning flow and notify the customer.",
  "subscription.created": "A new subscription has been created. Provision entitlements and send a welcome message.",
  "subscription.updated": "A subscription has been updated. Sync entitlements and notify the customer if needed.",
  "subscription.cancelled": "A subscription has been cancelled. Schedule access removal and send a goodbye message.",
  "subscription.paused": "A subscription has been paused. Temporarily remove access and notify the customer.",
  "subscription.resumed": "A subscription has been resumed. Restore access and notify the customer.",
  "subscription.expired": "A subscription has expired (grace period over). Remove access and send a win-back message.",
  "refund.issued": "A refund has been issued. Revoke access and send confirmation to the customer.",
};

/** Look up the default agent for a space from D1. Returns null if the space is not found. */
export async function resolveDefaultAgent(
  spaceId: string,
  db: D1Database
): Promise<{ agentId: string; tenantId: string } | null> {
  const row = await db.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(spaceId).first<{ tenant_id: string }>();
  if (!row) return null;
  // The default agent is always "naelao-agent" — provisioned by DEFAULT_NAELAO_AGENT profile
  return { agentId: "naelao-agent", tenantId: row.tenant_id };
}

/**
 * Fallback fulfillment agent id, used only when the manifest-driven lookup below can't resolve
 * one (SPACES_WORKER unbound, the space/manifest lookup fails, or a pre-WS-6 test double that
 * doesn't model the manifest fetch) — kept in sync by convention with
 * workers/agents/src/launchpad/spacetype.ts's launchpad-fulfillment-v1 definition. The real,
 * SpaceType-driven source of truth is `manifest.backend.fulfillment.agentId` (WS-6, audit plan):
 * shared billing code no longer needs a second SpaceType's agent id added to its own source —
 * a SpaceType declares this in its own manifest, or it's absent and this billing worker never
 * routes anything to a specialist for it.
 */
const FULFILLMENT_AGENT_ID = "launchpad-fulfillment-v1";

const FULFILLMENT_PROJECT_NAME_FALLBACK = "orders";

/**
 * WS-6: resolve the fulfillment specialist's agent id + its project-name fallback from the
 * space's own SpaceType manifest instead of hardcoded Launchpad literals. Best-effort — falls
 * back to today's Launchpad-shaped values on any failure, so an unbound SPACES_WORKER, a lookup
 * error, or a manifest that simply hasn't declared `backend.fulfillment` all degrade to the exact
 * behavior this pass found in place, never a silent no-route regression for Launchpad spaces.
 */
async function resolveFulfillmentConfig(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<{ agentId: string; projectNameFallback: string }> {
  const fallback = { agentId: FULFILLMENT_AGENT_ID, projectNameFallback: FULFILLMENT_PROJECT_NAME_FALLBACK };
  if (!env.SPACES_WORKER) return fallback;
  try {
    const spaceRow = await env.PLATFORM_DB.prepare(
      "SELECT spacetype_id FROM spaces WHERE id = ?"
    ).bind(spaceId).first<{ spacetype_id?: string }>();
    if (!spaceRow?.spacetype_id) return fallback;
    const resp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/internal/space-types/${encodeURIComponent(spaceRow.spacetype_id)}`, {
      headers: {
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
    }));
    if (!resp.ok) return fallback;
    const manifest = await resp.json<{ backend?: { fulfillment?: { agentId?: string; projectNameFallback?: string } } }>();
    const fulfillment = manifest.backend?.fulfillment;
    if (!fulfillment?.agentId) return fallback;
    return { agentId: fulfillment.agentId, projectNameFallback: fulfillment.projectNameFallback ?? FULFILLMENT_PROJECT_NAME_FALLBACK };
  } catch {
    return fallback;
  }
}

/**
 * Resolve a pre-seeded project bound to the fulfillment agent for this space, if the builder's
 * template created one (creator-store/newsletter-business/micro-saas seed one — e.g. "Orders" —
 * via bootstrap.projects with default_agent_id: "launchpad-fulfillment-v1"; see
 * launchpad/spacetype.ts). When present, a billing event is scoped to that project
 * (workspace-scoped, its own approval gates and execution ceiling apply) instead of running
 * space-wide — the Space Assistant does the general coordination, but the actual order-handling
 * work has a dedicated home a builder can rename, reassign, or remove.
 *
 * Matches on default_agent_id first (the real binding — survives a rename). Falls back to a
 * project literally named "Orders" for a space provisioned before projects.default_agent_id
 * existed, or where a builder manually created an "Orders" project without setting the binding.
 * Best-effort: returns undefined (never throws) when SPACES_WORKER is unbound, the lookup fails,
 * or no matching project exists — the caller falls back to the space-wide Space Assistant run
 * exactly as before, so a builder who deletes/reassigns the project doesn't break anything.
 */
type SpaceProject = { id: string; name: string; status?: string; default_agent_id?: string | null };

async function fetchSpaceProjects(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<SpaceProject[] | undefined> {
  if (!env.SPACES_WORKER) return undefined;
  try {
    const resp = await env.SPACES_WORKER.fetch(new Request(`http://spaces-worker/spaces/${encodeURIComponent(spaceId)}/projects`, {
      headers: {
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
      },
    }));
    if (!resp.ok) return undefined;
    const { data } = await resp.json<{ data: SpaceProject[] }>();
    return data;
  } catch {
    return undefined;
  }
}

export async function resolveFulfillmentProjectId(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<string | undefined> {
  const data = await fetchSpaceProjects(spaceId, tenantId, env);
  if (!data) return undefined;
  const { agentId: fulfillmentAgentId, projectNameFallback } = await resolveFulfillmentConfig(spaceId, tenantId, env);
  const byBinding = data.find((p) => p.default_agent_id === fulfillmentAgentId && p.status !== "archived");
  if (byBinding) return byBinding.id;
  const byName = data.find((p) => p.name?.trim().toLowerCase() === projectNameFallback && p.status !== "archived");
  return byName?.id;
}

/**
 * Whether launchpad-fulfillment-v1 is actually bound to a project in this space — the STRONG
 * signal (a real default_agent_id, set only when the builder's template installed this exact
 * agent), unlike resolveFulfillmentProjectId's looser name-only "Orders" fallback above (kept
 * for scoping an already-decided Space Assistant run, not for deciding WHICH agent to wake — a
 * space that merely happens to have a project literally named "Orders" without the agent
 * actually being provisioned must not get routed to an agent that 404s). Used by the routing
 * decision in handleLemonSqueezyWebhook. Best-effort: false (never throws) on any failure — the
 * caller falls back to the Space Assistant, exactly as every billing event did before this fix.
 */
export async function isFulfillmentAgentBound(
  spaceId: string,
  tenantId: string,
  env: LemonSqueezyEnv
): Promise<boolean> {
  const data = await fetchSpaceProjects(spaceId, tenantId, env);
  if (!data) return false;
  const { agentId: fulfillmentAgentId } = await resolveFulfillmentConfig(spaceId, tenantId, env);
  return data.some((p) => p.default_agent_id === fulfillmentAgentId && p.status !== "archived");
}

/** POST to agents worker: wake the agent with a billing event goal. */
export async function wakeAgent(
  spaceId: string,
  agentId: string,
  tenantId: string,
  event: NormalizedBillingEvent,
  agentsWorker: Fetcher,
  platformSecret: string,
  orderId?: string | null,
  projectId?: string
): Promise<void> {
  const goal = GOAL_MAP[event.type] ?? `Handle billing event: ${event.type}`;
  const sessionId = `billing-${event.type}-${Date.now()}`;

  // S0.2: mint a real internal HMAC token — the endpoint no longer accepts the static
  // x-naelao-internal header, since that trusted a caller-chosen tenantId with no proof.
  const internalToken = await mintInternalToken(platformSecret, tenantId);
  const resp = await agentsWorker.fetch(
    new Request(`http://agents-worker/agents/${agentId}/script/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-space-id": spaceId,
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": internalToken,
      },
      body: JSON.stringify({
        goal,
        sessionId,
        ...(projectId ? { projectId } : {}),
        context: {
          trigger: "billing_event",
          event_type: event.type,
          provider: event.provider,
          customer_id: event.customerId,
          subscription_id: event.subscriptionId,
          amount_cents: event.amountCents,
          currency: event.currency,
          metadata: event.metadata,
          ...(orderId ? { order_id: orderId } : {}),
        },
      }),
    })
  );

  if (!resp.ok) {
    const body = await responseDetail(resp);
    throw new Error(`Agent wake failed (${resp.status}): ${body}`);
  } else {
    console.log(`[billing/ls] Woke agent ${agentId} for space ${spaceId}${projectId ? ` project=${projectId}` : ""} — event=${event.type}`);
  }
}

/** Fallback dedup key for the pathological case of an event carrying no provider id at all. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * S0.3: the top-level idempotency gate — checked BEFORE any side effect (reseller ledger, order
 * recording, business subscription, credit-pack grant, wakeAgent). Lemon Squeezy retries on any
 * non-2xx response or timeout, which previously re-ran the ENTIRE handler on every retry; only
 * launchpad_orders had its own (separately keyed) idempotency, so a plain retry of e.g. a
 * subscription.updated event re-woke the agent every time. INSERT OR IGNORE on the
 * (provider, event_id) primary key: `event_id` is a signed-body fingerprint at webhook ingress,
 * not Lemon Squeezy's resource ID, because a resource can emit many distinct lifecycle events.
 * Exact re-deliveries map to the same fingerprint; changed payloads for the same resource remain
 * processable while money effects retain their separate resource/payment idempotency keys.
 */
export async function markEventProcessedOnce(
  provider: string,
  eventId: string,
  eventType: string,
  db: D1Database
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO processed_webhook_events (provider, event_id, event_type) VALUES (?, ?, ?)`
  ).bind(provider, eventId, eventType).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Reverse markEventProcessedOnce so a later delivery of the same event is reprocessed. Called when
 * a money side-effect failed TRANSIENTLY (see handleLemonSqueezyWebhook): the event was reserved to
 * dedupe concurrent deliveries, but since it didn't fully succeed we release the reservation and
 * return a non-200 so Lemon Squeezy retries. Every money handler is idempotent, so reprocessing is
 * safe — the parts that succeeded are no-ops, the failed part completes.
 */
export async function unmarkEventProcessed(provider: string, eventId: string, db: D1Database): Promise<void> {
  try {
    await db.prepare(`DELETE FROM processed_webhook_events WHERE provider = ? AND event_id = ?`).bind(provider, eventId).run();
  } catch { /* best-effort — a failed delete just means the retry is deduped, no worse than today */ }
}

/**
 * F-21 / F-28 (money leak): checkout kinds that must NEVER accrue a reseller/referral builder
 * margin. The decided revenue model (ARCH-REVENUE) keeps 100% of subscription-class revenue for
 * Naelao and treats a wallet top-up as the business's own capital (passthrough), so attributing a
 * builder cut on any of them creates obligations exceeding money-in — WORST case a builder
 * colluding with a child business loops wallet_topups to farm payout balance. revenue_cut_surcharge
 * is excluded too (F-28): the surcharge IS the mechanism that already collects the cut, so running
 * it through attribution as well double-pays a referral-mode builder for the same revenue. Genuine
 * end-customer revenue — product sales (product_id, no kind) and seats — still attributes normally.
 */
const RESELLER_ATTRIBUTION_BLOCKED_KINDS = new Set([
  "business_subscription",
  "credit_pack",
  "wallet_topup",
  "revenue_cut_surcharge",
]);

/**
 * If the billing event belongs to a child tenant under a reseller, attribute it to the
 * parent and write a reseller-ledger entry (consolidated invoicing — spec G-AS34/G-AS35).
 * No-op when the space's tenant is not a child tenant or the relationship is "platform".
 */
async function recordResellerAttribution(
  event: NormalizedBillingEvent,
  db: D1Database
): Promise<void> {
  if (!isLedgerEvent(event.type)) return;

  // F-21 / F-28: filter by the checkout kind BEFORE any attribution work.
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const kind = meta["kind"];
  if (typeof kind === "string" && RESELLER_ATTRIBUTION_BLOCKED_KINDS.has(kind)) return;

  // ARCH-REVENUE-6: if this sale carries an explicit builder_fee_bps, the builder's cut is handled
  // by the dedicated builder_revenue_share mechanism (recordBuilderRevenueShare) — do NOT also
  // accrue referral/wholesale margin on the same sale, or the builder gets paid twice for it.
  const builderBps = meta["builder_fee_bps"] ? parseInt(String(meta["builder_fee_bps"]), 10) : 0;
  if (Number.isFinite(builderBps) && builderBps > 0) return;

  // Resolve the space's tenant, then its parent reseller (if any).
  const space = await db.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ?"
  ).bind(event.spaceId).first<{ tenant_id: string }>();
  if (!space) return;

  const hierarchy = await db.prepare(
    "SELECT parent_tenant_id FROM tenant_hierarchy WHERE child_tenant_id = ? AND status = 'active'"
  ).bind(space.tenant_id).first<{ parent_tenant_id: string }>();
  if (!hierarchy) return;

  const reseller = await db.prepare(
    "SELECT billing_relationship, wholesale_cents, referral_share_pct FROM reseller_accounts WHERE tenant_id = ? AND status = 'active'"
  ).bind(hierarchy.parent_tenant_id).first<{
    billing_relationship: string;
    wholesale_cents: number | null;
    referral_share_pct: number;
  }>();
  if (!reseller) return;

  const attribution = computeResellerAttribution(event, {
    billingRelationship: reseller.billing_relationship as BillingRelationship,
    wholesaleCents: reseller.wholesale_cents,
    referralSharePct: reseller.referral_share_pct,
  });
  if (!attribution) return;

  // The same order resource ID is used on both payment and refund events. Qualify the ledger
  // idempotency key by normalized event type so a refund can create its negative adjustment while
  // duplicate deliveries of either lifecycle event remain no-ops at this unique index.
  const ledgerEventId = event.providerEventId ? `${event.type}:${event.providerEventId}` : null;
  await db.prepare(
    `INSERT OR IGNORE INTO reseller_ledger
       (id, parent_tenant_id, child_tenant_id, child_space_id, event_type,
        retail_cents, wholesale_cents, margin_cents, currency, period, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    hierarchy.parent_tenant_id,
    space.tenant_id,
    event.spaceId,
    event.type,
    attribution.retailCents,
    attribution.wholesaleCents,
    attribution.marginCents,
    attribution.currency,
    billingPeriod(),
    ledgerEventId
  ).run();
  console.log(`[billing/ls] Reseller ledger: parent=${hierarchy.parent_tenant_id} margin=${attribution.marginCents}c (${attribution.relationship})`);
}

/** Handle an inbound Lemon Squeezy webhook POST. */
export async function handleLemonSqueezyWebhook(
  request: Request,
  env: LemonSqueezyEnv
): Promise<Response> {
  const provider = new LemonSqueezyProvider({
    ...(env.LEMON_SQUEEZY_API_KEY ? { LEMON_SQUEEZY_API_KEY: env.LEMON_SQUEEZY_API_KEY } : {}),
    ...(env.LEMON_SQUEEZY_WEBHOOK_SECRET ? { LEMON_SQUEEZY_WEBHOOK_SECRET: env.LEMON_SQUEEZY_WEBHOOK_SECRET } : {}),
    ...(env.LEMON_SQUEEZY_STORE_ID ? { LEMON_SQUEEZY_STORE_ID: env.LEMON_SQUEEZY_STORE_ID } : {}),
  });

  let rawBody: string;
  try { rawBody = await readBoundedRequestText(request, 1024 * 1024); }
  catch { return Response.json({ error: "payload_too_large" }, { status: 413 }); }

  // 1. Verify HMAC signature
  const valid = await provider.verifyWebhook(rawBody, request.headers);
  if (!valid) {
    console.warn("[billing/ls] Webhook signature verification failed");
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  // 2. Parse + normalize event
  let event: NormalizedBillingEvent;
  try {
    event = provider.parseWebhookEvent(rawBody);
  } catch (err) {
    console.warn("[billing/ls] Unrecognised event:", (err as Error).message);
    // Return 200 so Lemon Squeezy doesn't retry unknown events
    return Response.json({ ok: true, skipped: true });
  }

  // 2b. Platform-plan events (the builder's own growth/business subscription) are ORG-level:
  // there is no space to resolve and no agent to wake, so they branch off here — before the
  // space-dispatch machinery — with their own exactly-once gate and retry-release, mirroring
  // the main path's semantics below.
  const topCustom = (event.metadata ?? {}) as Record<string, unknown>;
  if (event.type === "refund.issued" && !event.providerEventId) {
    return Response.json({ error: "missing_provider_event_id" }, { status: 500 });
  }
  const spaceBoundKind = topCustom["kind"];
  const requiresSpace =
    (spaceBoundKind === "business_subscription" &&
      (event.type === "payment.success" || event.type === "payment.failed" || event.type.startsWith("subscription."))) ||
    ((spaceBoundKind === "seat" || (typeof topCustom["product_id"] === "string" && topCustom["product_id"].trim().length > 0)) &&
      event.type === "payment.success") ||
    (["credit_pack", "wallet_topup", "revenue_cut_surcharge"].includes(String(spaceBoundKind)) &&
      (event.type === "payment.success" || event.type === "refund.issued"));
  if (requiresSpace && (!event.spaceId || event.spaceId.length > 256)) {
    return Response.json({ error: "missing_space_id" }, { status: 500 });
  }

  if (topCustom["kind"] === "template_subscription" &&
      (typeof topCustom["template_subscription_id"] !== "string" || !topCustom["template_subscription_id"].trim()) &&
      !event.subscriptionId) {
    return Response.json({ error: "missing_template_subscription_id" }, { status: 500 });
  }
  if (topCustom["kind"] === "platform_plan") {
    // data.id identifies the subscription resource, not a webhook delivery. Creation, renewal,
    // cancellation, and expiry can all share it. Hash the signed body for delivery dedupe while
    // retaining providerEventId separately for subscription matching and money-ledger joins.
    const planEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", planEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) {
      console.log(`[billing/ls] Duplicate delivery of platform-plan event=${planEventId} — no-op`);
      return Response.json({ ok: true, duplicate: true });
    }
    try {
      await recordPlatformPlanSubscription(event, env);
    } catch (err) {
      console.error("[billing/ls] platform plan recording failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", planEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["platform plan recording"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "platform_plan" });
  }

  // Marketplace license purchases are platform-native one-time sales, not a business's
  // userland order. Grant the tenant fork and developer earning before the generic space flow.
  if (topCustom["kind"] === "marketplace_license") {
    const licenseEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", licenseEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) return Response.json({ ok: true, duplicate: true, kind: "marketplace_license" });
    try {
      await settleMarketplaceLicenseEvent(event, env);
    } catch (err) {
      console.error("[billing/ls] marketplace license settlement failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", licenseEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["marketplace license settlement"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "marketplace_license" });
  }

  const mappedTemplateSubscription = event.subscriptionId
    ? await env.PLATFORM_DB.prepare("SELECT id FROM template_subscriptions WHERE provider_subscription_id = ? AND space_id = ?")
      .bind(event.subscriptionId, event.spaceId).first<{ id: string }>()
    : null;
  const templateSubscriptionId = topCustom["kind"] === "template_subscription"
    ? String(topCustom["template_subscription_id"] ?? "")
    : mappedTemplateSubscription?.id;
  if (templateSubscriptionId) {
    const templateEventId = `body:${await sha256Hex(rawBody)}`;
    const firstDelivery = await markEventProcessedOnce("lemon_squeezy", templateEventId, event.type, env.PLATFORM_DB);
    if (!firstDelivery) return Response.json({ ok: true, duplicate: true, kind: "template_subscription" });
    try {
      if (event.type === "payment.success") await settleNativeTemplateRoyalty(event, env);
      else if (event.type.startsWith("subscription.")) await syncNativeTemplateSubscriptionStatus(event, env);
    } catch (err) {
      console.error("[billing/ls] template royalty/status failed:", (err as Error).message);
      await unmarkEventProcessed("lemon_squeezy", templateEventId, env.PLATFORM_DB);
      return Response.json({ error: "processing_failed", failed: ["template subscription settlement"] }, { status: 500 });
    }
    return Response.json({ ok: true, kind: "template_subscription" });
  }

  // 3. Resolve the Naelao space from spaceId in the event
  if (!event.spaceId) {
    console.warn("[billing/ls] Event missing spaceId — cannot dispatch to agent");
    return Response.json({ ok: true, skipped: true });
  }

  // 3b. S0.3: top-level exactly-once gate — checked BEFORE any side effect below. A retry of an
  // event already processed (any event type, not just payment.success) is a silent no-op 200,
  // never re-running reseller attribution, order recording, or waking the agent a second time.
  // Lemon Squeezy's data.id is commonly a long-lived order/subscription resource ID, not a
  // delivery ID. A later refund/cancellation uses the same resource ID as the original payment.
  // Hash the complete signed body for delivery dedupe; resource IDs stay on NormalizedBillingEvent
  // for the idempotency keys and ledger lookups that intentionally join lifecycle events.
  const eventId = `body:${await sha256Hex(rawBody)}`;
  const isFirstDelivery = await markEventProcessedOnce("lemon_squeezy", eventId, event.type, env.PLATFORM_DB);
  if (!isFirstDelivery) {
    console.log(`[billing/ls] Duplicate delivery of event=${eventId} type=${event.type} — no-op`);
    return Response.json({ ok: true, duplicate: true });
  }

  // Every money side-effect below is idempotent (INSERT OR IGNORE / ON CONFLICT / a settlement or
  // grant keyed by an idempotency_key). So a transient failure in ANY of them must NOT be silently
  // swallowed with a 200 (which would permanently lose the money — Lemon Squeezy never retries a
  // 200). Instead we collect the failures, and if any occurred we RELEASE the exactly-once
  // reservation and return a 500 so LS retries the whole event; the retry re-runs every handler,
  // the succeeded ones no-op, the failed one completes. Each handler still runs even if a prior one
  // failed, so as much as possible settles on the first pass.
  const failures: string[] = [];
  const runHandler = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(`[billing/ls] ${label} failed:`, (err as Error).message);
      failures.push(label);
    }
  };

  // 4. Reseller attribution — if this space is a child tenant under a reseller, roll the
  //    event up into the parent's consolidated ledger (G-AS34/G-AS35).
  await runHandler("reseller attribution", () => recordResellerAttribution(event, env.PLATFORM_DB));

  // 5. Record money-in (idempotent). A seat purchase activates a member; otherwise a
  //    product sale is fulfilled. Plan/subscription events for the builder skip both.
  let orderId: string | null = null;
  await runHandler("order recording", async () => {
    orderId = (await recordSeatActivation(event, env)) ?? (await recordProductOrder(event, env));
  });

  // 5b. Phase E: business subscription state (subscription.* events only) and credit-pack grants
  //     (payment.success only) — both keyed off checkout metadata.kind, so they never collide
  //     with the seat/product paths above (each event matches at most one of these four kinds).
  await runHandler("business subscription recording", () => recordBusinessSubscription(event, env));
  await runHandler("native template subscription status", () => syncNativeTemplateSubscriptionStatus(event, env));
  await runHandler("native template royalty settlement", () => settleNativeTemplateRoyalty(event, env));
  await runHandler("credit pack grant", () => grantCreditPackPurchase(event, env));
  await runHandler("personal plan grant", () => grantPersonalPlanPurchase(event, env));
  await runHandler("wallet top-up grant", () => grantWalletTopupPurchase(event, env));
  await runHandler("order refund clawback", () => recordOrderRefund(event, env));
  await runHandler("non-order refund clawback", () => recordNonOrderRefundClawback(event, env));
  await runHandler("revenue-cut surcharge mark-billed", () => recordRevenueCutSurchargePayment(event, env));

  // If any money side-effect failed transiently, release the exactly-once reservation and 500 so
  // Lemon Squeezy retries (all handlers are idempotent → the retry is safe and completes the gap).
  if (failures.length > 0) {
    await unmarkEventProcessed("lemon_squeezy", eventId, env.PLATFORM_DB);
    console.warn(`[billing/ls] event=${eventId} had ${failures.length} failed side-effect(s) [${failures.join(", ")}] — released for retry`);
    return Response.json({ error: "processing_failed", failed: failures }, { status: 500 });
  }

  // Space suspension/deactivation disables agent execution, but must not discard payment,
  // refund, subscription, or wallet accounting. Resolve the active agent only after those durable
  // money effects have completed.
  let agent: Awaited<ReturnType<typeof resolveDefaultAgent>>;
  try {
    agent = await resolveDefaultAgent(event.spaceId, env.PLATFORM_DB);
  } catch (err) {
    console.error(`[billing/ls] active-space lookup failed for event=${eventId}:`, (err as Error).message);
    await unmarkEventProcessed("lemon_squeezy", eventId, env.PLATFORM_DB);
    return Response.json({ error: "space_lookup_failed" }, { status: 503 });
  }
  if (!agent) {
    console.warn(`[billing/ls] No active space agent for spaceId=${event.spaceId}; accounting processed`);
    return Response.json({ ok: true, event_type: event.type, space_id: event.spaceId, order_id: orderId, agent_skipped: true });
  }

  // 6. Wake an agent asynchronously (ctx.waitUntil equivalent: fire-and-forget). Pass the order
  //    id so the fulfilment agent can look it up and deliver the product, and scope the run to
  //    the space's "Orders" project when the template seeded one (best-effort — falls back to a
  //    space-wide run when there isn't one).
  if (!env.AGENTS_WORKER) {
    console.error(`[billing/ls] Agents worker is not bound for event=${eventId}; releasing for retry`);
    await unmarkEventProcessed("lemon_squeezy", eventId, env.PLATFORM_DB);
    return Response.json({ error: "agent_delivery_unavailable" }, { status: 503 });
  }
  const projectId = await resolveFulfillmentProjectId(event.spaceId, agent.tenantId, env);

  // F: routing decision (spec §11 / appendix A1.16.x) — LaunchpadAgentDefinition.trigger for
  // launchpad-fulfillment-v1 is `{ type: "webhook", event: "order.completed" }`, but nothing
  // ever woke that agent; every order fired against the generic Space Assistant instead, so the
  // specialist's own system prompt AND its own requires_approval_for gates (customer_email_send,
  // refund_issue — see approval-gates-structural.test.ts) never actually applied to a real order.
  // Decision: an order-completed event ("payment.success") routes to the fulfillment specialist's
  // OWN agent DO instead of the Space Assistant, but ONLY when isFulfillmentAgentBound confirms
  // the specialist is actually provisioned in this space (a real default_agent_id binding — not
  // the looser "a project happens to be named Orders" fallback resolveFulfillmentProjectId also
  // accepts for scoping, since routing to an agent that was never installed would just 404 and
  // silently drop the order). No binding (a space provisioned before projects.default_agent_id
  // existed, a manually reassigned/removed project, or a raw core-agents install with no
  // template) falls back to the Space Assistant exactly as before — never left unhandled. Every
  // OTHER billing event type (subscription changes, payment failures, refunds) keeps waking the
  // Space Assistant unchanged: order-completed is the only event this SpaceType defines a
  // specialist trigger for. Only one agent is ever woken per event — never both.
  const fulfillmentBound = event.type === "payment.success" && (await isFulfillmentAgentBound(event.spaceId, agent.tenantId, env));
  const targetAgentId = fulfillmentBound ? (await resolveFulfillmentConfig(event.spaceId, agent.tenantId, env)).agentId : agent.agentId;
  try {
    await wakeAgent(event.spaceId, targetAgentId, agent.tenantId, event, env.AGENTS_WORKER, env.PLATFORM_SECRET, orderId, projectId);
  } catch (err) {
    // The provider event is only acknowledged after the agent accepted it. Accounting handlers
    // above are idempotent, so releasing the event claim lets a webhook retry recover delivery.
    console.error(`[billing/ls] agent wake failed for event=${eventId}:`, (err as Error).message);
    await unmarkEventProcessed("lemon_squeezy", eventId, env.PLATFORM_DB);
    return Response.json({ error: "agent_delivery_failed" }, { status: 503 });
  }

  return Response.json({ ok: true, event_type: event.type, space_id: event.spaceId, order_id: orderId });
}
