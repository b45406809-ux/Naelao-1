import {
  badRequest,
  errorResponse,
  internalError,
  notFound,
  requestId,
  readBoundedRequestText,
  readBoundedRequestBytes,
  readBoundedResponseJson,
  RequestBodyTooLargeError,
  requireInternalHmac,
} from "@naelao/http";
// G-D05: Billing worker — Lemon Squeezy webhooks, checkout, subscription sync.
// Vendor cutover: Lemon Squeezy is the ONLY billing provider — the builder's own platform-plan
// checkout/portal (previously the last Stripe-backed path) now runs through the same LS store as
// every other money path. stripe.ts is deleted; /webhooks/stripe removed.
import { Hono } from "hono";
import { checkQuota, checkWindowedQuota, recordUsageEvent, getUsageSummary, PLAN_LIMITS, llmReservationAdmission } from "./quota.js";
import { handleLemonSqueezyWebhook, markEventProcessedOnce, recordPlatformPlanSubscription, recordProductUserPlanSubscription, sha256Hex, unmarkEventProcessed } from "./lemon-squeezy.js";
import { normalizePlanTier, PLANS, BILLING_CORE_RATE_CARD_VERSION } from "@naelao/billing-core";
import { registerPartnerPortalRoutes } from "./partner-portal.js";
import { reconcileDeveloperPayouts } from "./payout-reconciliation.js";
import { dispatchDunningOutbox } from "./dunning-outbox.js";
import { validateDecisionUsageReceipt } from "./decision-usage.js";
import { registerMarketplaceLicenseRoutes } from "./marketplace-licenses.js";
import { recordManagedProviderCostReceipts, summarizeManagedProviderCostReceipts, type ManagedProviderCostReceiptInput } from "./managed-service-provider-costs.js";
import { isDevelopmentCheckoutAllowed } from "./checkout-policy.js";
import { isDunningEventMessage } from "@naelao/types";
export { settleTemplateSubscriptionPayment } from "./settlement.js";

export interface BillingEnv {
  /** Optional native developer payout rail. */
  STRIPE_CONNECT_SECRET_KEY?: string;
  ENVIRONMENT: string;
  /** Explicit local/test-only opt-in for the simulated platform-plan checkout URL. */
  ALLOW_DEV_CHECKOUTS?: string;
  /** Shared inter-worker HMAC secret (mintInternalToken/requireInternalHmac, @naelao/http) —
   *  needed to call spaces worker's internal routes directly (bypassing naelao-router). */
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  QUOTA_CACHE: KVNamespace;
  BILLING_EVENTS: Queue;
  DUNNING_EVENTS: Queue;
  /** Separate operator key for enabling verified managed-service plan entitlements. */
  MANAGED_SERVICES_OPERATOR_SECRET?: string;
  // Lemon Squeezy (the ONLY billing provider — spec Appendix H / CLAUDE.md #9)
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  /** LS subscription variant ids for the builder's own platform plans (created once in the
   *  Naelao LS store, like STRIPE_*_PRICE_ID used to be). Optional — /billing/checkout degrades
   *  to the same dev-placeholder flow when its platform-plan variant is unset. */
  LEMON_SQUEEZY_GROWTH_VARIANT_ID?: string;
  LEMON_SQUEEZY_BUSINESS_VARIANT_ID?: string;
  /** Customer Products have their own checkout variants, independent of Naelao's org plan. */
  LEMON_SQUEEZY_CUSTOMER_GROWTH_VARIANT_ID?: string;
  LEMON_SQUEEZY_CUSTOMER_BUSINESS_VARIANT_ID?: string;
  // Whop is retained only as an optional provider for Naelao platform plans.
  /** Naelao's own Whop company API key (a normal seller key, like any Whop creator has — no
   *  invite needed). Optional — /billing/checkout falls through to Lemon Squeezy, then the dev
   *  placeholder, when unset. */
  WHOP_API_KEY?: string;
  /** Plan ids for Naelao's own Growth/Business platform plans, created once in Naelao's Whop
   *  company dashboard (like LEMON_SQUEEZY_*_VARIANT_ID). */
  WHOP_GROWTH_PLAN_ID?: string;
  WHOP_BUSINESS_PLAN_ID?: string;
  WHOP_CUSTOMER_GROWTH_PLAN_ID?: string;
  WHOP_CUSTOMER_BUSINESS_PLAN_ID?: string;
  /** Naelao's own company's webhook signing secret. */
  WHOP_PLATFORM_PLAN_WEBHOOK_SECRET?: string;
}

interface ManagedServiceMeterOutboxRow { event_id: string; org_id: string; payload_json: string; attempt_count: number }

/** Dispatch committed managed-service meter intents at least once. D1 retains the intent until
 * Queue acknowledges it; the Queue consumer records the stable event ID before acknowledging. */
export async function dispatchManagedServiceMeterOutbox(env: BillingEnv, now = new Date(), limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("managed_service_meter_outbox_limit_invalid");
  const at = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
  const claimed = await env.PLATFORM_DB.prepare(`UPDATE managed_service_meter_outbox SET status='leased',lease_until=?,
      attempt_count=attempt_count+1,updated_at=? WHERE event_id IN (
        SELECT event_id FROM managed_service_meter_outbox WHERE
          (status='pending' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?)
        ORDER BY next_attempt_at,created_at,event_id LIMIT ?
      ) AND ((status='pending' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?))
      RETURNING event_id,org_id,payload_json,attempt_count`)
    .bind(leaseUntil,at,at,at,limit,at,at).all<ManagedServiceMeterOutboxRow>();
  let sent = 0, deferred = 0;
  for (const row of claimed.results ?? []) {
    let payload: BillingQueueMessage | null = null;
    try {
      payload = JSON.parse(row.payload_json) as BillingQueueMessage;
      if (payload.type !== "meter" || payload.event_id !== row.event_id || payload.org_id !== row.org_id) throw new Error("outbox_payload_invalid");
      await env.BILLING_EVENTS.send(payload);
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_meter_outbox SET status='sent',lease_until=NULL,sent_at=?,
        last_error=NULL,updated_at=? WHERE event_id=? AND org_id=? AND status='leased' AND lease_until=?`)
        .bind(at,at,row.event_id,row.org_id,leaseUntil).run();
      sent++;
    } catch {
      const backoffSeconds = Math.min(6 * 60 * 60, 30 * 2 ** Math.min(10, Math.max(0,row.attempt_count - 1)));
      await env.PLATFORM_DB.prepare(`UPDATE managed_service_meter_outbox SET status='pending',lease_until=NULL,
        next_attempt_at=?,last_error=?,updated_at=? WHERE event_id=? AND org_id=? AND status='leased' AND lease_until=?`)
        .bind(new Date(now.getTime() + backoffSeconds * 1000).toISOString(),payload ? "queue_send_failed" : "outbox_payload_invalid",
          at,row.event_id,row.org_id,leaseUntil).run();
      deferred++;
    }
  }
  return { claimed: claimed.results?.length ?? 0, sent, deferred };
}

// G-A11: Validate required secrets at startup. Vendor cutover: the STRIPE_* requirement is gone
// (Lemon Squeezy is the only provider, and its own vars are optional-with-honest-degradation like
// every other LS caller in this file); PLATFORM_SECRET is what every HMAC-gated route and direct
// spaces-worker call actually depends on.
function validateEnv(env: BillingEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

/** Billing-profile mutations and portal links are organization-admin operations. The router
 * strips caller-supplied identity headers and forwards role from the verified JWT. Keep this
 * check at the billing service boundary as well, since service bindings can bypass the router. */
function isOrgBillingAdmin(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: BillingEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });
registerMarketplaceLicenseRoutes(app);
registerPartnerPortalRoutes(app);

// ── GET /billing/subscription ─────────────────────────────────────────────────
// Authenticated — router sets x-naelao-tenant-id from validated JWT
app.get("/billing/subscription", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId)
    return c.json(
      { error_code: "unauthorized", message: "Missing tenant" },
      401
    );

  const sub = await c.env.PLATFORM_DB.prepare(
    `SELECT plan_tier, status,
            current_period_start, current_period_end, cancel_at_period_end, trial_ends_at
     FROM subscriptions WHERE org_id = ?`
  )
    .bind(orgId)
    .first<{
      plan_tier: string;
      status: string;
      current_period_start: string | null;
      current_period_end: string | null;
      cancel_at_period_end: number;
      trial_ends_at: string | null;
    }>();

  const planTier = sub?.plan_tier ?? "free";
  const unifiedPlan = PLANS[normalizePlanTier(planTier)];

  // Fetch quota current/limit for all three metrics in parallel
  const [spacesQuota, kbDocsQuota, apiCallsQuota] = await Promise.all([
    checkQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "spaces", planTier),
    checkQuota(
      c.env.QUOTA_CACHE,
      c.env.PLATFORM_DB,
      orgId,
      "kb_docs",
      planTier
    ),
    checkQuota(
      c.env.QUOTA_CACHE,
      c.env.PLATFORM_DB,
      orgId,
      "api_calls",
      planTier
    ),
  ]);

  return c.json({
    plan_tier: planTier,
    plan: unifiedPlan,
    status: sub?.status ?? "active",
    current_period_start: sub?.current_period_start ?? null,
    current_period_end: sub?.current_period_end ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end === 1,
    trial_ends_at: sub?.trial_ends_at ?? null,
    quota: {
      spaces: spacesQuota,
      kb_docs: kbDocsQuota,
      api_calls: apiCallsQuota,
    },
  });
});

// ── POST /billing/checkout ────────────────────────────────────────────────────
app.post("/billing/checkout", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!orgId)
    return c.json(
      { error_code: "unauthorized", message: "Missing tenant" },
      401
    );
  if (!isOrgBillingAdmin(c.req.header("x-naelao-role"))) {
    return c.json({ error_code: "forbidden", message: "Only organization owners and admins can change billing plans" }, 403);
  }

  const body = await c.req.json<{
    plan: "growth" | "business";
    success_url: string;
    /** Accepted for back-compat with existing clients; Lemon Squeezy checkouts have no
     *  cancel-redirect concept (the buyer just closes the hosted page), so it is unused. */
    cancel_url?: string;
  }>();

  if (!body.plan || !body.success_url) {
    throw badRequest("plan and success_url are required");
  }
  if (body.plan !== "growth" && body.plan !== "business") {
    throw badRequest("plan must be 'growth' or 'business'");
  }

  const variantId =
    body.plan === "growth"
      ? c.env.LEMON_SQUEEZY_GROWTH_VARIANT_ID
      : c.env.LEMON_SQUEEZY_BUSINESS_VARIANT_ID;

  // The buyer email prefills the checkout (same lookup the Stripe path used to do).
  const owner = await c.env.PLATFORM_DB.prepare(
    "SELECT u.email FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? LIMIT 1"
  )
    .bind(userId)
    .first<{ email: string }>();

  // Try Whop first (AUDIT_TODO.md AI-7 pivot — Naelao's own normal Whop seller account, not the
  // invite-gated Platforms API). Falls through to Lemon Squeezy, then the dev placeholder, when
  // Naelao's own Whop plan ids aren't configured.
  const whopPlanId = body.plan === "growth" ? c.env.WHOP_GROWTH_PLAN_ID : c.env.WHOP_BUSINESS_PLAN_ID;
  if (c.env.WHOP_API_KEY && whopPlanId) {
    const { createWhopPlatformPlanCheckout } = await import("@naelao/billing-core");
    try {
      const { checkout_url } = await createWhopPlatformPlanCheckout(c.env.WHOP_API_KEY, {
        planId: whopPlanId,
        ...(owner?.email ? { customerEmail: owner.email } : {}),
        redirectUrl: body.success_url,
        // metadata.kind="platform_plan" is what routes the resulting webhook to
        // recordPlatformPlanSubscription — same contract the LS path below uses.
        metadata: { kind: "platform_plan", org_id: orgId, plan: body.plan },
      });
      return c.json({ checkout_url, plan: body.plan, provider: "whop" });
    } catch (err) {
      console.warn(`[billing/checkout] Whop platform-plan checkout failed, falling back to LS: ${(err as Error).message}`);
    }
  }

  // A simulated checkout must never make an unavailable provider look purchasable in a shared
  // environment. Local tests may opt in explicitly; staging and production always fail closed.
  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !variantId) {
    if (!isDevelopmentCheckoutAllowed({ environment: c.env.ENVIRONMENT, allowDevCheckouts: c.env.ALLOW_DEV_CHECKOUTS })) {
      console.warn("billing.checkout.provider_unavailable", { environment: c.env.ENVIRONMENT });
      return c.json({ error_code: "checkout_provider_unavailable", message: "Checkout is not configured for this environment" }, 503);
    }
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/platform-plan/${body.plan}`,
      plan: body.plan,
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  // metadata.kind="platform_plan" is what routes the resulting subscription.* / payment.success
  // webhooks to recordPlatformPlanSubscription (lemon-squeezy.ts) — an ORG-level event with no
  // space to resolve, handled before the webhook's space-dispatch machinery.
  const { url } = await provider.createCheckout({
    spaceId: orgId, // no space involved — carries the org through custom.spaceId harmlessly
    variantOrPriceId: variantId,
    ...(owner?.email ? { customerEmail: owner.email } : {}),
    successUrl: body.success_url,
    metadata: { kind: "platform_plan", org_id: orgId, plan: body.plan },
  });

  return c.json({ checkout_url: url, plan: body.plan });
});

// Product end-users buy their own Space allowance. The Spaces Worker reaches this route with
// an HMAC token after it verifies the Product account; no shared team org plan is consulted.
app.use("/internal/product-user-checkout", requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.post("/internal/product-user-checkout", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ product_id?: string; end_user_id?: string; plan?: string; success_url?: string }>();
  if (!tenantId || !body.product_id || !body.end_user_id || !body.success_url || !["growth", "business"].includes(body.plan ?? ""))
    throw badRequest("product_id, end_user_id, plan, and success_url are required");
  const account = await c.env.PLATFORM_DB.prepare(
    `SELECT p.id, u.email FROM products p JOIN product_end_users u ON u.product_space_id=p.id
     WHERE p.id=? AND p.tenant_id=? AND p.status='active' AND u.end_user_id=? AND u.suspended_at IS NULL AND u.deleted_at IS NULL`
  ).bind(body.product_id, tenantId, body.end_user_id).first<{ id: string; email: string | null }>();
  if (!account) return c.json({ error_code: "product_account_not_found" }, 404);
  const plan = body.plan as "growth" | "business";
  const variantId = plan === "growth" ? c.env.LEMON_SQUEEZY_CUSTOMER_GROWTH_VARIANT_ID : c.env.LEMON_SQUEEZY_CUSTOMER_BUSINESS_VARIANT_ID;
  const custom = { kind: "product_user_plan", product_id: account.id, end_user_id: body.end_user_id, plan };
  const whopPlanId = plan === "growth" ? c.env.WHOP_CUSTOMER_GROWTH_PLAN_ID : c.env.WHOP_CUSTOMER_BUSINESS_PLAN_ID;
  if (c.env.WHOP_API_KEY && whopPlanId) {
    const { createWhopPlatformPlanCheckout } = await import("@naelao/billing-core");
    const result = await createWhopPlatformPlanCheckout(c.env.WHOP_API_KEY, { planId: whopPlanId,
      ...(account.email ? { customerEmail: account.email } : {}), redirectUrl: body.success_url, metadata: custom });
    return c.json({ checkout_url: result.checkout_url, plan, provider: "whop" });
  }
  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !variantId)
    return c.json({ error_code: "customer_billing_unavailable" }, 503);
  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({ LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY, LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID });
  const result = await provider.createCheckout({ spaceId: account.id, variantOrPriceId: variantId,
    ...(account.email ? { customerEmail: account.email } : {}), successUrl: body.success_url, metadata: custom });
  return c.json({ checkout_url: result.url, plan, provider: "lemon_squeezy" });
});

// ── POST /billing/portal ──────────────────────────────────────────────────────
// Lemon Squeezy's hosted customer portal (subscription management / cancel / update card), OR
// Whop's fixed self-serve orders page when the org's active subscription is Whop-backed — Whop
// has no API-mintable per-customer portal session (see whop-platform-plan.ts's header), so this
// branch just returns that fixed URL rather than a personalized one.
app.post("/billing/portal", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId)
    return c.json(
      { error_code: "unauthorized", message: "Missing tenant" },
      401
    );
  if (!isOrgBillingAdmin(c.req.header("x-naelao-role"))) {
    return c.json({ error_code: "forbidden", message: "Only organization owners and admins can manage billing" }, 403);
  }

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT ls_customer_id, whop_customer_id FROM subscriptions WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{ ls_customer_id: string | null; whop_customer_id: string | null }>();

  if (sub?.whop_customer_id && !sub?.ls_customer_id) {
    const { WHOP_CUSTOMER_ORDERS_URL } = await import("@naelao/billing-core");
    return c.json({ portal_url: WHOP_CUSTOMER_ORDERS_URL, provider: "whop" });
  }

  const customerId = sub?.ls_customer_id;
  if (!customerId) {
    throw notFound("Billing profile (subscribe to a plan first)");
  }
  if (!c.env.LEMON_SQUEEZY_API_KEY) {
    return c.json({ error_code: "billing_unavailable", message: "Lemon Squeezy is not configured" }, 503);
  }

  // LS exposes a signed customer-portal URL on the customer object itself.
  const resp = await fetch(`https://api.lemonsqueezy.com/v1/customers/${encodeURIComponent(customerId)}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${c.env.LEMON_SQUEEZY_API_KEY}`,
      Accept: "application/vnd.api+json",
    },
  });
  if (!resp.ok) {
    throw internalError(`Lemon Squeezy customer lookup failed (${resp.status})`);
  }
  const data = await readBoundedResponseJson<{ data?: { attributes?: { urls?: { customer_portal?: string } } } }>(resp, 1024 * 1024);
  const portalUrl = data.data?.attributes?.urls?.customer_portal;
  if (!portalUrl) {
    throw internalError("Lemon Squeezy returned no customer portal URL");
  }

  return c.json({ portal_url: portalUrl });
});

// ── POST /billing/usage ───────────────────────────────────────────────────────
// Internal route — called by other workers via service binding. P0-3: this had NO auth gate at
// all despite its own "internal route" comment, AND trusted a client-supplied body.org_id for
// the actual write — so a legitimately-authenticated caller for tenant A could post
// {org_id: "tenant-B", quantity: 999999999} and pollute tenant B's usage_events, potentially
// tripping tenant B's quota AND triggering a fake Stripe metering event against their
// subscription (see the BILLING_EVENTS enqueue below). Confirmed zero production callers exist
// today (grepped the whole repo) — not actively exploited, but the first real caller
// (NaelaoAgentDO's llm_tokens recording, P0-3) must not inherit this. Gated with the same
// requireInternalHmac every other internal-only route in this file uses, and the org to record
// against is now the VERIFIED x-naelao-tenant-id header (the only field the HMAC signature
// actually covers), never the request body.
app.use("/billing/usage", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/billing/usage", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{
    space_id?: string;
    user_id?: string;
    event_type: string;
    quantity?: number;
    schema_version?: number;
    unit?: "tokens" | "credits" | "milliseconds" | "bytes" | "messages" | "invocations" | "units";
    rate_card_version?: string;
    cost_credits?: number;
    project_id?: string;
    installation_id?: string;
    run_id?: string;
    model_id?: string;
    provider?: string;
    connector_provider?: string;
    runtime_tier?: number;
    /** Opaque irreversible digest only; never send provider contact IDs to this ledger. */
    subject_hash?: string;
    payer_kind?: "plan_quota" | "platform" | "unknown";
    decision?: "allowed" | "denied" | "charged" | "released" | "failed" | "not_billable";
    // G-AN09: Caller may supply an idempotency key; if absent, one is computed
    idempotency_key?: string;
  }>().catch(() => null);

  if (!body || typeof body.event_type !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(body.event_type)) return c.json({ error_code: "invalid_usage_event" }, 400);

  const quantity = body.quantity ?? 1;
  const schemaVersion = body.schema_version ?? 1;
  const units = new Set(["tokens", "credits", "milliseconds", "bytes", "messages", "invocations", "units"]);
  const unit = body.unit ?? (body.event_type === "llm_tokens" ? "tokens" : body.event_type === "infra_credits" ? "credits" : "units");
  if (!Number.isSafeInteger(quantity) || quantity < 0 || ![1, 2].includes(schemaVersion)
    || !units.has(unit) || (schemaVersion === 2 && (!body.unit || !body.idempotency_key))
    || (body.idempotency_key !== undefined && (typeof body.idempotency_key !== "string" || body.idempotency_key.length < 1 || body.idempotency_key.length > 200))
    || (body.cost_credits !== undefined && (!Number.isSafeInteger(body.cost_credits) || body.cost_credits < 0))
    || (body.subject_hash !== undefined && !/^[a-f0-9]{64}$/.test(body.subject_hash))
    || (body.rate_card_version !== undefined && (body.rate_card_version.length < 1 || body.rate_card_version.length > 80))
    || (body.project_id !== undefined && body.project_id.length > 128)
    || (body.installation_id !== undefined && body.installation_id.length > 128)
    || (body.run_id !== undefined && body.run_id.length > 160)
    || (body.provider !== undefined && (body.provider.length < 1 || body.provider.length > 80))
    || (body.model_id !== undefined && (body.model_id.length < 1 || body.model_id.length > 160))
    || (body.connector_provider !== undefined && (body.connector_provider.length < 1 || body.connector_provider.length > 80))
    || (body.runtime_tier !== undefined && (!Number.isInteger(body.runtime_tier) || body.runtime_tier < 1 || body.runtime_tier > 6))) {
    return c.json({ error_code: "invalid_usage_event" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // G-AN09: Compute stable event hash for idempotency.
  // Truncate timestamp to the minute so retries within the same minute are deduplicated.
  // Format: sha256(org_id:space_id:user_id:event_type:YYYY-MM-DDTHH:MM)
  let eventHash: string | null = null;
  if (body.idempotency_key) {
    // Caller-supplied key takes precedence, but uniqueness is tenant-scoped: the same run or
    // event identifier in two organizations must never cause one tenant's usage row to suppress
    // the other's.
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${orgId}:${body.idempotency_key}`));
    eventHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } else {
    const minuteBucket = now.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const hashInput = `${orgId}:${body.space_id ?? ""}:${body.user_id ?? ""}:${body.event_type}:${minuteBucket}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
    eventHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // G-AN09: INSERT OR IGNORE on event_hash — if duplicate, silently skip (idempotent)
  const result = await c.env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO usage_events (id, org_id, space_id, event_type, quantity, recorded_at, event_hash,
       schema_version,unit,rate_card_version,cost_credits,project_id,installation_id,run_id,provider,model_id,connector_provider,runtime_tier,subject_hash,payer_kind,decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      orgId,
      body.space_id ?? null,
      body.event_type,
      quantity,
      now,
      eventHash,
      schemaVersion,
      unit,
      body.rate_card_version ?? null,
      body.cost_credits ?? null,
      body.project_id ?? null,
      body.installation_id ?? null,
      body.run_id ?? null,
      body.provider ?? null,
      body.model_id ?? null,
      body.connector_provider ?? null,
      body.runtime_tier ?? null,
      body.subject_hash ?? null,
      body.payer_kind ?? null,
      body.decision ?? null,
    )
    .run();

  // If INSERT was ignored (duplicate), return success without re-enqueuing
  if (result.meta.changes === 0) {
    return c.json({ recorded: false, deduplicated: true, id }, 200);
  }

  // F12: invalidate the KV quota cache instead of incrementing it — the next checkQuota call
  // recomputes fresh from D1's atomic COUNT/SUM aggregate rather than trusting a number a
  // concurrent writer could have raced.
  if (body.event_type === "api_call") {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "api_calls");
  } else if (body.event_type === "kb_doc") {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "kb_docs");
  } else if (body.event_type === "llm_tokens" && (schemaVersion === 1 || body.payer_kind === "plan_quota")) {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "llm_tokens");
  } else if (body.event_type === "infra_credits" && (schemaVersion === 1 || ["plan_quota", "platform", "unknown"].includes(body.payer_kind ?? ""))) {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "infra_credits");
  }

  // Only plan/platform usage is forwarded to subscription metering.
  if (schemaVersion === 1 || body.payer_kind === "plan_quota" || body.payer_kind === "platform" || body.payer_kind === "unknown") await c.env.BILLING_EVENTS.send({
    type: "meter",
    org_id: orgId,
    space_id: body.space_id,
    event_type: body.event_type,
    quantity,
    event_id: id,
    event_hash: eventHash,
    recorded_at: now,
    schema_version: schemaVersion,
    unit,
    ...(body.rate_card_version ? { rate_card_version: body.rate_card_version } : {}),
    ...(body.cost_credits !== undefined ? { cost_credits: body.cost_credits } : {}),
    ...(body.project_id ? { project_id: body.project_id } : {}),
    ...(body.installation_id ? { installation_id: body.installation_id } : {}),
    ...(body.run_id ? { run_id: body.run_id } : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model_id ? { model_id: body.model_id } : {}),
    ...(body.connector_provider ? { connector_provider: body.connector_provider } : {}),
    ...(body.runtime_tier !== undefined ? { runtime_tier: body.runtime_tier } : {}),
    ...(body.subject_hash ? { subject_hash: body.subject_hash } : {}),
    ...(body.payer_kind ? { payer_kind: body.payer_kind } : {}),
    ...(body.decision ? { decision: body.decision } : {}),
  });

  return c.json({ recorded: true, id }, 201);
});

// ── Workflow budget holds ───────────────────────────────────────────────────
// A workflow's declared budget is held before its durable instance starts. The conditional
// INSERT accounts for both recorded monthly infra usage and unexpired holds in one D1 statement,
// so two concurrent dispatches cannot both consume the same remaining allowance.
app.use("/internal/workflows/budget/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.use("/internal/managed-services/credits/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));

// Holds estimated builder LLM tokens before provider dispatch so concurrent Space Assistant
// runs share the same day/week/month quota envelope. Holds are separate from usage_events and
// only actual post-run token counts become billable usage.
app.use("/internal/usage/llm-tokens/reservations/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.use("/internal/decisions/reservations/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/decisions/reservations/reserve", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ reservation_id?: string; run_id?: string; space_id?: string; project_id?: string | null; model_id?: string; price_snapshot?: string; input_usd_per_token?: number; output_usd_per_token?: number; max_tokens?: number; max_credits?: number }>().catch(() => null);
  if (!orgId || !body?.reservation_id || !body.run_id || !body.space_id || !body.model_id || !body.price_snapshot || body.reservation_id.length > 200 || body.run_id.length > 128 || body.space_id.length > 160 || body.model_id.length > 160 || !Number.isFinite(Date.parse(body.price_snapshot)) || Date.now() - Date.parse(body.price_snapshot) < 0 || Date.now() - Date.parse(body.price_snapshot) > 15 * 60_000 || !Number.isFinite(body.input_usd_per_token) || (body.input_usd_per_token ?? -1) < 0 || !Number.isFinite(body.output_usd_per_token) || (body.output_usd_per_token ?? -1) < 0 || !Number.isSafeInteger(body.max_tokens) || (body.max_tokens ?? 0) < 1 || !Number.isSafeInteger(body.max_credits) || (body.max_credits ?? 0) < 1 || (body.max_credits ?? Infinity) > 10_000_000) return c.json({ error_code: "bad_request" }, 400);
  const prior = await c.env.PLATFORM_DB.prepare("SELECT * FROM decision_call_reservations WHERE id=? AND org_id=?").bind(body.reservation_id, orgId).first<Record<string, unknown>>();
  if (prior) {
    const same = prior.run_id === body.run_id && prior.space_id === body.space_id && prior.project_id === (body.project_id ?? null) && prior.model_id === body.model_id && prior.price_snapshot === body.price_snapshot && prior.max_tokens === body.max_tokens && prior.max_credits === body.max_credits;
    return same && prior.status === "held" ? c.json({ reserved: true, reservation_id: body.reservation_id, status: prior.status, deduplicated: true }) : c.json({ error_code: prior.status === "uncertain" ? "reservation_outcome_uncertain" : "reservation_identity_conflict" }, 409);
  }
  const tier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);
  const limits = PLAN_LIMITS[tier] ?? PLAN_LIMITS.free!;
  const admission = llmReservationAdmission(orgId, body.max_tokens!, limits, await resolveAllowOverage(c.env.PLATFORM_DB, orgId));
  const withinQuota = await c.env.PLATFORM_DB.prepare(`SELECT 1 WHERE ${admission.predicate}`).bind(...admission.bindings).first();
  if (!withinQuota) return c.json({ error_code: "quota_exceeded" }, 402);
  const inserted = await c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO decision_call_reservations(id,org_id,space_id,project_id,run_id,model_id,price_snapshot,input_usd_per_token,output_usd_per_token,max_tokens,max_credits,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'held')`)
    .bind(body.reservation_id, orgId, body.space_id, body.project_id ?? null, body.run_id, body.model_id, body.price_snapshot, body.input_usd_per_token, body.output_usd_per_token, body.max_tokens, body.max_credits).run();
  if (!inserted.meta.changes) return c.json({ error_code: "reservation_conflict" }, 409);
  await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "llm_tokens");
  return c.json({ reserved: true, reservation_id: body.reservation_id }, 201);
});
app.post("/internal/decisions/reservations/settle", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ reservation_id?: string; outcome?: "confirmed" | "uncertain"; input_tokens?: number; output_tokens?: number; cost_usd?: number; generation_id?: string; evidence_source?: "openrouter_response" | "openrouter_generation_api"; model_id?: string }>().catch(() => null);
  if (!orgId || !body?.reservation_id || !["confirmed", "uncertain"].includes(String(body.outcome))) return c.json({ error_code: "bad_request" }, 400);
  const prior = await c.env.PLATFORM_DB.prepare("SELECT * FROM decision_call_reservations WHERE id=? AND org_id=?").bind(body.reservation_id, orgId).first<Record<string, unknown>>();
  if (!prior) return c.json({ error_code: "reservation_not_found" }, 404);
  if (prior.status === "settled") {
    if (body.generation_id && prior.provider_generation_id !== body.generation_id) return c.json({ error_code: "decision_generation_receipt_conflict" }, 409);
    return c.json({ settled: true, deduplicated: true, reservation_id: body.reservation_id, cost_credits: prior.cost_credits });
  }
  if (body.outcome === "uncertain") {
    const generationId = body.generation_id;
    if (generationId !== undefined && (typeof generationId !== "string" || !/^gen-[A-Za-z0-9-]{1,124}$/.test(generationId) || body.model_id !== prior.model_id)) return c.json({ error_code: "bad_request" }, 400);
    const updated = await c.env.PLATFORM_DB.prepare("UPDATE decision_call_reservations SET status='uncertain',provider_generation_id=COALESCE(provider_generation_id,?),updated_at=datetime('now') WHERE id=? AND org_id=? AND status IN ('held','uncertain') AND (provider_generation_id IS NULL OR provider_generation_id=?)").bind(generationId ?? null, body.reservation_id, orgId, generationId ?? null).run();
    if (!updated.meta.changes) return c.json({ error_code: "decision_generation_receipt_conflict" }, 409);
    return c.json({ settled: false, uncertain: true, reservation_id: body.reservation_id });
  }
  const receipt = body.generation_id && body.model_id && body.evidence_source && body.input_tokens !== undefined && body.output_tokens !== undefined && body.cost_usd !== undefined
    ? { generation_id: body.generation_id, model_id: body.model_id, evidence_source: body.evidence_source, input_tokens: body.input_tokens, output_tokens: body.output_tokens, cost_usd: body.cost_usd }
    : null;
  const validated = receipt && validateDecisionUsageReceipt({ status: String(prior.status), model_id: String(prior.model_id), max_tokens: Number(prior.max_tokens), max_credits: Number(prior.max_credits), provider_generation_id: prior.provider_generation_id as string | null }, receipt);
  if (!validated) return c.json({ error_code: "decision_usage_receipt_invalid" }, 409);
  const { tokens, costCredits } = validated;
  const generationId = receipt.generation_id;
  const rateCardVersion = `openrouter:generation:${generationId}`;
  const eventHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`decision:${orgId}:${body.reservation_id}`)))].map(byte => byte.toString(16).padStart(2,"0")).join("");
  const now = new Date().toISOString();
  const result = await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("UPDATE decision_call_reservations SET status='settled',actual_tokens=?,cost_credits=?,rate_card_version=?,provider_generation_id=?,provider_cost_usd=?,usage_evidence_source=?,updated_at=? WHERE id=? AND org_id=? AND status IN ('held','uncertain') AND (provider_generation_id IS NULL OR provider_generation_id=?)").bind(tokens, costCredits, rateCardVersion, generationId, receipt.cost_usd, receipt.evidence_source, now, body.reservation_id, orgId, generationId),
    c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO usage_events(id,org_id,space_id,event_type,quantity,recorded_at,event_hash,schema_version,unit,rate_card_version,cost_credits,project_id,run_id,provider,model_id,payer_kind,decision) VALUES(?,?,?,'decision_tokens',?,?,?,2,'tokens',?,?,?,?,?,?,'plan_quota','charged')`).bind(`decision:${orgId}:${body.reservation_id}`, orgId, prior.space_id, tokens, now, eventHash, rateCardVersion, costCredits, prior.project_id, prior.run_id, "openrouter", prior.model_id),
  ]);
  if (!result[0]?.meta.changes && prior.status !== "settled") return c.json({ error_code: "decision_settlement_race" }, 409);
  await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "llm_tokens");
  return c.json({ settled: true, reservation_id: body.reservation_id, cost_credits: costCredits, generation_id: generationId });
});
app.post("/internal/decisions/reservations/status", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ reservation_id?: string; run_id?: string; space_id?: string }>().catch(() => null);
  if (!orgId || !body?.reservation_id || !body.run_id || !body.space_id) return c.json({ error_code: "bad_request" }, 400);
  const row = await c.env.PLATFORM_DB.prepare("SELECT status,run_id,space_id,model_id,price_snapshot,actual_tokens,cost_credits,rate_card_version,provider_generation_id,provider_cost_usd,usage_evidence_source,max_tokens,max_credits,created_at FROM decision_call_reservations WHERE id=? AND org_id=?").bind(body.reservation_id, orgId).first<Record<string, unknown>>();
  if (!row || row.run_id !== body.run_id || row.space_id !== body.space_id) return c.json({ error_code: "reservation_not_found" }, 404);
  return c.json({ status: row.status, model_id: row.model_id, rate_card_version: row.rate_card_version, actual_tokens: row.actual_tokens, cost_credits: row.cost_credits, generation_id: row.provider_generation_id, cost_usd: row.provider_cost_usd, evidence_source: row.usage_evidence_source, max_tokens: row.max_tokens, max_credits: row.max_credits, created_at: row.created_at });
});
app.post("/internal/usage/llm-tokens/reservations/reserve", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ reservation_id?: string; run_id?: string; space_id?: string; estimated_tokens?: number; expires_in_seconds?: number }>().catch(() => null);
  const id = body?.reservation_id ?? "", runId = body?.run_id ?? "", spaceId = body?.space_id ?? "", tokens = body?.estimated_tokens ?? 0;
  const expiresInSeconds = body?.expires_in_seconds ?? 15 * 60;
  if (!orgId || !id || id.length > 200 || !runId || runId.length > 128 || !spaceId || !Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 10_000_000
    || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 30 * 86400) return c.json({ error_code: "bad_request" }, 400);
  const existing = await c.env.PLATFORM_DB.prepare("SELECT run_id,estimated_tokens,status FROM llm_token_reservations WHERE id=? AND org_id=?").bind(id, orgId).first<{ run_id: string; estimated_tokens: number; status: string }>();
  if (existing) return existing.run_id === runId && existing.estimated_tokens === tokens && existing.status === "held"
    ? c.json({ reserved: true, deduplicated: true, reservation_id: id })
    : c.json({ error_code: "reservation_id_conflict" }, 409);
  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);
  const allowOverage = await resolveAllowOverage(c.env.PLATFORM_DB, orgId);
  const limits = PLAN_LIMITS[planTier] ?? PLAN_LIMITS.free!;
  const admission = llmReservationAdmission(orgId, tokens, limits, allowOverage);
  const binds: unknown[] = [id, orgId, spaceId, runId, tokens, new Date(Date.now() + expiresInSeconds * 1000).toISOString()];
  binds.push(...admission.bindings);
  const result = await c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO llm_token_reservations(id,org_id,space_id,run_id,estimated_tokens,status,expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?, 'held', ?,datetime('now'),datetime('now') WHERE ${admission.predicate}`).bind(...binds).run();
  if (!result.meta.changes) return c.json({ error_code: "quota_exceeded", message: "Estimated LLM request would exceed the daily, weekly, or monthly token quota" }, 402);
  return c.json({ reserved: true, reservation_id: id, estimated_tokens: tokens }, 201);
});
app.post("/internal/usage/llm-tokens/reservations/release", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ run_id?: string }>().catch(() => null);
  if (!orgId || !body?.run_id) return c.json({ error_code: "bad_request" }, 400);
  const result = await c.env.PLATFORM_DB.prepare("UPDATE llm_token_reservations SET status='released',updated_at=datetime('now') WHERE org_id=? AND run_id=? AND status='held'").bind(orgId, body.run_id).run();
  return c.json({ released: result.meta.changes > 0 });
});
app.post("/internal/usage/llm-tokens/reservations/settle", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{
    run_id?: string; actual_tokens?: number; model_id?: string; cost_credits?: number; rate_card_version?: string;
  }>().catch(() => null);
  if (!orgId || !body?.run_id || !Number.isSafeInteger(body.actual_tokens) || (body.actual_tokens ?? -1) < 0
    || (body.model_id !== undefined && (typeof body.model_id !== "string" || body.model_id.length < 1 || body.model_id.length > 160))
    || (body.cost_credits !== undefined && (!Number.isSafeInteger(body.cost_credits) || body.cost_credits < 0))
    || (body.rate_card_version !== undefined && (typeof body.rate_card_version !== "string" || body.rate_card_version.length < 1 || body.rate_card_version.length > 80))) return c.json({ error_code: "bad_request" }, 400);
  const prior = await c.env.PLATFORM_DB.prepare("SELECT actual_tokens FROM llm_token_run_settlements WHERE org_id=? AND run_id=?").bind(orgId, body.run_id).first<{ actual_tokens: number }>();
  if (prior) return c.json({ settled: true, deduplicated: true, actual_tokens: prior.actual_tokens });
  const held = await c.env.PLATFORM_DB.prepare("SELECT space_id FROM llm_token_reservations WHERE org_id=? AND run_id=? AND status='held' LIMIT 1").bind(orgId, body.run_id).first<{ space_id: string }>();
  if (!held) return c.json({ settled: false, error_code: "reservation_not_found" }, 409);
  const now = new Date().toISOString();
  const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`llm-token-reservation:${orgId}:${body.run_id}`));
  const eventHash = Array.from(new Uint8Array(hashBytes)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const eventId = `llm-run:${body.run_id}`;
  const provider = body.model_id?.startsWith("@cf/") ? "cloudflare"
    : body.model_id?.startsWith("claude-") ? "anthropic" : body.model_id?.startsWith("gemini") ? "google"
      : body.model_id?.includes("/") ? body.model_id.split("/")[0] ?? "unknown" : "unknown";
  const batch = await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("UPDATE llm_token_reservations SET status='settled',updated_at=? WHERE org_id=? AND run_id=? AND status='held'").bind(now, orgId, body.run_id),
    c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO llm_token_run_settlements(org_id,run_id,actual_tokens,settled_at) VALUES(?,?,?,?)").bind(orgId, body.run_id, body.actual_tokens, now),
    c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO usage_events
      (id,org_id,space_id,event_type,quantity,recorded_at,event_hash,schema_version,unit,rate_card_version,cost_credits,provider,model_id,payer_kind,decision)
      VALUES(?,?,?,'llm_tokens',?,?,?,2,'tokens',?,?,?,?,'plan_quota','charged')`)
      .bind(eventId, orgId, held.space_id, body.actual_tokens, now, eventHash,
        body.rate_card_version ?? null, body.cost_credits ?? null, body.model_id ? provider : null, body.model_id ?? null),
  ]);
  if ((batch[2]?.meta.changes ?? 0) > 0 && (body.actual_tokens ?? 0) > 0) {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "llm_tokens");
    await c.env.BILLING_EVENTS.send({
      type: "meter", org_id: orgId, space_id: held.space_id, event_type: "llm_tokens", quantity: body.actual_tokens!,
      event_id: eventId, event_hash: eventHash, recorded_at: now, schema_version: 2, unit: "tokens",
      payer_kind: "plan_quota", decision: "charged",
      ...(body.rate_card_version ? { rate_card_version: body.rate_card_version } : {}),
      ...(body.cost_credits !== undefined ? { cost_credits: body.cost_credits } : {}),
      ...(body.model_id ? { model_id: body.model_id, provider } : {}),
    });
  }
  return c.json({ settled: true, actual_tokens: body.actual_tokens, deduplicated: (batch[2]?.meta.changes ?? 0) === 0 });
});

app.post("/internal/workflows/budget/reserve", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{
    reservation_id?: string; workflow_id?: string; space_id?: string; budget_key?: string; credits?: number; expires_at?: string;
    project_id?: string; installation_id?: string; runtime_tier?: number;
  }>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error_code: "bad_request" }, 400);
  const id = body.reservation_id ?? body.workflow_id ?? "";
  const workflowId = body.workflow_id ?? "";
  const credits = body.credits;
  if (typeof id !== "string" || !id || typeof workflowId !== "string" || !workflowId || id !== workflowId || id.length > 160
    || typeof body.space_id !== "string" || !body.space_id || body.space_id.length > 160
    || typeof body.budget_key !== "string" || !body.budget_key || body.budget_key.length > 200
    || !Number.isSafeInteger(credits) || (credits ?? 0) <= 0 || (credits ?? 0) > 10_000_000
    || (body.expires_at !== undefined && typeof body.expires_at !== "string")) return c.json({ error_code: "bad_request" }, 400);
  const expiryMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 86400_000;
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() || expiryMs > Date.now() + 91 * 86400_000) return c.json({ error_code: "bad_request", message: "Invalid workflow reservation expiry" }, 400);
  const expiry = new Date(expiryMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  if ((body.project_id !== undefined && (typeof body.project_id !== "string" || body.project_id.length > 128))
    || (body.installation_id !== undefined && (typeof body.installation_id !== "string" || body.installation_id.length > 128))
    || (body.runtime_tier !== undefined && (!Number.isInteger(body.runtime_tier) || body.runtime_tier < 1 || body.runtime_tier > 6))) return c.json({ error_code: "bad_request" }, 400);
  const existing = await c.env.PLATFORM_DB.prepare("SELECT id,status,credits,space_id,budget_key,project_id,installation_id,runtime_tier FROM workflow_budget_reservations WHERE org_id = ? AND workflow_id = ?")
    .bind(orgId, workflowId).first<{ id: string; status: string; credits: number; space_id: string; budget_key: string; project_id: string | null; installation_id: string | null; runtime_tier: number | null }>();
  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);
  const quota = await checkQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "infra_credits", planTier);
  if (existing) {
    if (existing.id !== id || existing.space_id !== body.space_id || existing.budget_key !== body.budget_key || existing.credits !== credits
      || existing.project_id !== (body.project_id ?? null) || existing.installation_id !== (body.installation_id ?? null)
      || existing.runtime_tier !== (body.runtime_tier ?? null)) return c.json({ error_code: "reservation_scope_conflict" }, 409);
    if (existing.status === "released") {
      const renewed = await c.env.PLATFORM_DB.prepare("UPDATE workflow_budget_reservations SET status='held', credits=?, expires_at=?, updated_at=datetime('now') WHERE id=? AND org_id=? AND status='released' AND ? + (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id=? AND event_type='infra_credits' AND recorded_at>=datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) + (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id=? AND status='held' AND julianday(expires_at)>julianday('now')) + (SELECT COALESCE(SUM(credits),0) FROM managed_service_credit_reservations WHERE org_id=? AND (status='uncertain' OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) <= ?")
        .bind(credits, expiry, existing.id, orgId, credits, orgId, orgId, orgId, quota.limit).run();
      if (!renewed.meta.changes) return c.json({ error_code: "infra_quota_exceeded", message: "Workflow retry budget is unavailable" }, 402);
    }
    if (existing.status === "settled") return c.json({ error_code: "reservation_already_settled" }, 409);
    return c.json({ reserved: true, reservation_id: existing.id, status: existing.status === "released" ? "held" : existing.status, credits }, 200);
  }
  const inserted = await c.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO workflow_budget_reservations
      (id,org_id,space_id,workflow_id,budget_key,project_id,installation_id,runtime_tier,credits,status,expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,'held',?,datetime('now'),datetime('now')
    WHERE ? +
      (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id = ? AND event_type = 'infra_credits' AND recorded_at >= datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) +
      (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id = ? AND status = 'held' AND julianday(expires_at) > julianday('now')) +
      (SELECT COALESCE(SUM(credits),0) FROM managed_service_credit_reservations WHERE org_id = ? AND (status='uncertain' OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) <= ?
  `).bind(id, orgId, body.space_id, workflowId, body.budget_key, body.project_id ?? null, body.installation_id ?? null,
    body.runtime_tier ?? null, credits, expiry, credits, orgId, orgId, orgId, quota.limit).run();
  if (inserted.meta.changes === 0) {
    // Concurrent idempotent launches can both pass the initial read. If the other request
    // won the unique workflow insert, return its reservation instead of a false quota error.
    const raced = await c.env.PLATFORM_DB.prepare("SELECT id,status,credits,space_id,budget_key,project_id,installation_id,runtime_tier FROM workflow_budget_reservations WHERE org_id = ? AND workflow_id = ?")
      .bind(orgId, workflowId).first<{ id: string; status: string; credits: number; space_id: string; budget_key: string; project_id: string | null; installation_id: string | null; runtime_tier: number | null }>();
    if (raced) {
      if (raced.id !== id || raced.status !== "held" || raced.credits !== credits || raced.space_id !== body.space_id || raced.budget_key !== body.budget_key
        || raced.project_id !== (body.project_id ?? null) || raced.installation_id !== (body.installation_id ?? null) || raced.runtime_tier !== (body.runtime_tier ?? null))
        return c.json({ error_code: "reservation_scope_conflict" }, 409);
      return c.json({ reserved: true, reservation_id: raced.id, status: "held", credits }, 200);
    }
    const idCollision = await c.env.PLATFORM_DB.prepare("SELECT id FROM workflow_budget_reservations WHERE id = ?").bind(id).first<{ id: string }>();
    if (idCollision) return c.json({ error_code: "reservation_scope_conflict" }, 409);
    return c.json({ error_code: "infra_quota_exceeded", message: "Workflow budget is unavailable for this billing period", limit: quota.limit }, 402);
  }
  return c.json({ reserved: true, reservation_id: id, status: "held", credits }, 201);
});

app.post("/internal/workflows/budget/release", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ reservation_id?: string }>();
  if (!body.reservation_id) return c.json({ error_code: "bad_request", message: "reservation_id is required" }, 400);
  const result = await c.env.PLATFORM_DB.prepare("UPDATE workflow_budget_reservations SET status = 'released', updated_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'held'")
    .bind(body.reservation_id, orgId).run();
  return c.json({ released: result.meta.changes > 0, reservation_id: body.reservation_id });
});

app.post("/internal/workflows/budget/settle", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ reservation_id?: string; quantity?: number }>();
  if (!body.reservation_id) return c.json({ error_code: "bad_request", message: "reservation_id is required" }, 400);
  if (body.quantity !== undefined && (!Number.isSafeInteger(body.quantity) || body.quantity < 0)) return c.json({ error_code: "bad_request", message: "quantity must be a non-negative integer" }, 400);
  const eventHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`workflow-budget:${orgId}:${body.reservation_id}:settle`));
  const eventHash = Array.from(new Uint8Array(eventHashBuffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const quantity = body.quantity ?? 0;
  const now = new Date().toISOString();
  const reservation = await c.env.PLATFORM_DB.prepare("SELECT space_id,workflow_id,credits,project_id,installation_id,runtime_tier FROM workflow_budget_reservations WHERE id = ? AND org_id = ? AND status = 'held'")
    .bind(body.reservation_id, orgId).first<{ space_id: string; workflow_id: string; credits: number; project_id: string | null; installation_id: string | null; runtime_tier: number | null }>();
  if (!reservation) {
    const prior = await c.env.PLATFORM_DB.prepare("SELECT r.status,u.quantity FROM workflow_budget_reservations r LEFT JOIN usage_events u ON u.org_id=r.org_id AND u.run_id=r.workflow_id AND u.event_type='infra_credits' WHERE r.id=? AND r.org_id=?")
      .bind(body.reservation_id, orgId).first<{ status: string; quantity: number | null }>();
    if (prior?.status === "settled") return c.json({ settled: true, reservation_id: body.reservation_id, charged: prior.quantity ?? 0, deduplicated: true });
    return c.json({ settled: false, reservation_id: body.reservation_id });
  }
  const charged = Math.min(quantity, reservation.credits);
  const batch = await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("UPDATE workflow_budget_reservations SET status = 'settled', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'held'").bind(now, body.reservation_id, orgId),
    c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO usage_events
      (id,org_id,space_id,event_type,quantity,recorded_at,event_hash,schema_version,unit,rate_card_version,cost_credits,project_id,installation_id,run_id,runtime_tier,payer_kind,decision)
      SELECT ?,?,?,'infra_credits',?,?,?,2,'credits',?,?,?,?,?,?,'plan_quota','charged'
      WHERE EXISTS (SELECT 1 FROM workflow_budget_reservations WHERE id=? AND org_id=? AND status='settled')`)
      .bind(`workflow-run:${orgId}:${body.reservation_id}`, orgId, reservation.space_id, charged, now, eventHash,
        BILLING_CORE_RATE_CARD_VERSION, charged, reservation.project_id, reservation.installation_id, reservation.workflow_id, reservation.runtime_tier, body.reservation_id, orgId),
  ]);
  if (charged > 0 && (batch[1]?.meta.changes ?? 0) > 0) {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "infra_credits");
    await c.env.BILLING_EVENTS.send({
      type: "meter", org_id: orgId, space_id: reservation.space_id, event_type: "infra_credits", quantity: charged,
      event_id: body.reservation_id, event_hash: eventHash, recorded_at: now, schema_version: 2, unit: "credits",
      rate_card_version: BILLING_CORE_RATE_CARD_VERSION, cost_credits: charged, run_id: reservation.workflow_id,
      ...(reservation.project_id ? { project_id: reservation.project_id } : {}),
      ...(reservation.installation_id ? { installation_id: reservation.installation_id } : {}),
      ...(reservation.runtime_tier !== null ? { runtime_tier: reservation.runtime_tier } : {}),
      payer_kind: "plan_quota", decision: "charged",
    });
  }
  if ((batch[0]?.meta.changes ?? 0) === 0 && (batch[1]?.meta.changes ?? 0) === 0) {
    const state = await c.env.PLATFORM_DB.prepare("SELECT status FROM workflow_budget_reservations WHERE id=? AND org_id=?")
      .bind(body.reservation_id, orgId).first<{ status: string }>();
    if (state?.status !== "settled") return c.json({ settled: false, reservation_id: body.reservation_id });
  }
  return c.json({ settled: true, reservation_id: body.reservation_id, charged, deduplicated: (batch[1]?.meta.changes ?? 0) === 0 });
});

// Provider operations share the existing monthly infra-credit allowance and usage ledger.
// Unlike short-lived workflow holds, an uncertain external effect has no automatic expiry.
function operatorKeyMatches(expected:string|undefined,provided:string){
  if(!expected||expected.length!==provided.length)return false;
  let difference=0;for(let index=0;index<expected.length;index++)difference|=expected.charCodeAt(index)^provided.charCodeAt(index);
  return difference===0;
}

app.post("/internal/managed-services/provider-cost-receipts/import",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const actorId=c.req.header("x-managed-services-operator-id")??"";
  const body=await readBoundedRequestText(c.req.raw,256*1024).then(text=>JSON.parse(text) as {
    tenant_id?:string;space_id?:string;project_id?:string|null;receipts?:ManagedProviderCostReceiptInput[];
  }).catch(()=>null);
  if(!body||typeof body.tenant_id!=="string"||typeof body.space_id!=="string"||!Array.isArray(body.receipts))return c.json({error_code:"managed_provider_cost_receipts_invalid"},400);
  try{return c.json(await recordManagedProviderCostReceipts(c.env.PLATFORM_DB,{tenantId:body.tenant_id,spaceId:body.space_id,
    ...(body.project_id===undefined?{}:{projectId:body.project_id}),actorId,receipts:body.receipts}),201);}
  catch(error){const code=error instanceof Error&&error.message.startsWith("managed_provider_cost_")?error.message:"managed_provider_cost_receipt_failed";
    return c.json({error_code:code},code.includes("conflict")?409:400);}
});

app.post("/internal/managed-services/provider-cost-receipts/summary",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const body=await readBoundedRequestText(c.req.raw,16*1024).then(text=>JSON.parse(text) as {
    tenant_id?:string;space_id?:string;provider?:string;service_id?:string;period_start?:string;period_end?:string;currency?:string;
  }).catch(()=>null);
  if(!body||typeof body.tenant_id!=="string"||typeof body.provider!=="string"||typeof body.period_start!=="string"
    ||typeof body.period_end!=="string"||typeof body.currency!=="string")return c.json({error_code:"managed_provider_cost_summary_invalid"},400);
  try{return c.json(await summarizeManagedProviderCostReceipts(c.env.PLATFORM_DB,{tenantId:body.tenant_id,
    ...(body.space_id?{spaceId:body.space_id}:{}),provider:body.provider,...(body.service_id?{serviceId:body.service_id}:{}),
    periodStart:body.period_start,periodEnd:body.period_end,currency:body.currency}));}
  catch(error){const code=error instanceof Error&&error.message.startsWith("managed_provider_cost_")?error.message:"managed_provider_cost_summary_failed";
    return c.json({error_code:code},400);}
});

app.post("/internal/managed-services/entitlements/verify",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const body=await readBoundedRequestText(c.req.raw,64*1024).then(value=>JSON.parse(value) as {
    plan_tier?:string;provider?:string;service_id?:string;operation_name?:string;region?:string;price_version?:string;
    credits_per_operation?:number;max_credits_per_operation?:number;max_operations_per_period?:number|null;valid_until?:string;reason?:string;
  }).catch(()=>null);
  const actorId=c.req.header("x-managed-services-operator-id")??"";
  const allowedTiers=["free","growth","business","enterprise"];
  const now=new Date(),validUntil=Date.parse(body?.valid_until??"");
  if(!body||!allowedTiers.includes(body.plan_tier??"")||! /^[a-z][a-z0-9_-]{1,63}$/.test(body.provider??"")
    ||! /^[a-z][a-z0-9_.:-]{1,128}$/.test(body.service_id??"")||! /^[a-z][a-z0-9_.:-]{1,128}$/.test(body.operation_name??"")
    ||! /^[a-z0-9][a-z0-9-]{0,31}$/.test(body.region??"")||! /^[A-Za-z0-9._:-]{1,100}$/.test(body.price_version??"")
    ||(body.credits_per_operation!==undefined&&(!Number.isSafeInteger(body.credits_per_operation)||body.credits_per_operation<1||body.credits_per_operation>body.max_credits_per_operation!))
    ||(body.provider==="agentmail"&&body.service_id==="agentmail"&&["provision","renew"].includes(body.operation_name??"")&&body.credits_per_operation===undefined)
    ||!Number.isSafeInteger(body.max_credits_per_operation)||body.max_credits_per_operation!<1||body.max_credits_per_operation!>10_000_000
    ||(body.max_operations_per_period!==undefined&&body.max_operations_per_period!==null&&(!Number.isSafeInteger(body.max_operations_per_period)||body.max_operations_per_period<1||body.max_operations_per_period>100_000))
    ||!Number.isFinite(validUntil)||validUntil<=now.getTime()||validUntil>now.getTime()+180*86_400_000
    ||!actorId.match(/^[A-Za-z0-9._:@-]{1,160}$/)||!body.reason||body.reason.trim().length<10||body.reason.length>500){
    return c.json({error_code:"managed_service_entitlement_verification_invalid"},400);
  }
  const capability=await c.env.PLATFORM_DB.prepare(`SELECT version,operations_json,regions_json,account_modes_json,metering_json,status,valid_until
    FROM managed_service_capability_versions WHERE provider=? AND service_id=? ORDER BY version DESC LIMIT 1`)
    .bind(body.provider,body.service_id).first<{version:number;operations_json:string;regions_json:string;account_modes_json:string;metering_json:string;status:string;valid_until:string|null}>();
  if(!capability||capability.status!=="verified"||!capability.valid_until||capability.valid_until<=now.toISOString())return c.json({error_code:"managed_service_capability_unverified"},409);
  try{
    const operations=JSON.parse(capability.operations_json) as unknown[],regions=JSON.parse(capability.regions_json) as unknown[],modes=JSON.parse(capability.account_modes_json) as unknown[];
    const metering=JSON.parse(capability.metering_json) as Record<string,unknown>;
    if(!operations.includes(body.operation_name)||!regions.includes(body.region)||!modes.includes("naelao_managed")||metering.priceVersion!==body.price_version)
      return c.json({error_code:"managed_service_entitlement_evidence_mismatch"},409);
  }catch{return c.json({error_code:"managed_service_capability_invalid"},409);}
  const at=now.toISOString(),auditId=`msea_${crypto.randomUUID().replaceAll("-","")}`;
  const result=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_plan_entitlements(
      plan_tier,provider,service_id,capability_version,operation_name,region,price_version,max_credits_per_operation,max_operations_per_period,
      credits_per_operation,status,verified_by,verified_at,valid_until,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?, ?,?)
      ON CONFLICT(plan_tier,provider,service_id,operation_name,region) DO UPDATE SET capability_version=excluded.capability_version,
        price_version=excluded.price_version,max_credits_per_operation=excluded.max_credits_per_operation,max_operations_per_period=excluded.max_operations_per_period,
        credits_per_operation=excluded.credits_per_operation,
        status='active',verified_by=excluded.verified_by,verified_at=excluded.verified_at,valid_until=excluded.valid_until,updated_at=excluded.updated_at`)
      .bind(body.plan_tier,body.provider,body.service_id,capability.version,body.operation_name,body.region,body.price_version,body.max_credits_per_operation,
        body.max_operations_per_period??null,body.credits_per_operation??null,actorId,at,new Date(validUntil).toISOString(),at,at),
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_entitlement_audit(id,plan_tier,provider,service_id,operation_name,region,action,actor_id,reason,created_at)
      SELECT ?,?,?,?,?,?,'verified',?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_plan_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND region=? AND status='active' AND verified_at=?)`)
      .bind(auditId,body.plan_tier,body.provider,body.service_id,body.operation_name,body.region,actorId,body.reason.trim(),at,
        body.plan_tier,body.provider,body.service_id,body.operation_name,body.region,at),
  ]);
  if(!result[0]?.meta.changes||!result[1]?.meta.changes)return c.json({error_code:"managed_service_entitlement_verification_conflict"},409);
  return c.json({verified:true,planTier:body.plan_tier,provider:body.provider,serviceId:body.service_id,operation:body.operation_name,region:body.region,
    ...(body.credits_per_operation!==undefined?{creditsPerOperation:body.credits_per_operation}:{}),capabilityVersion:capability.version,validUntil:new Date(validUntil).toISOString()});
});

app.post("/internal/managed-services/entitlements/disable",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const body=await readBoundedRequestText(c.req.raw,16*1024).then(value=>JSON.parse(value) as {plan_tier?:string;provider?:string;service_id?:string;operation_name?:string;region?:string;reason?:string}).catch(()=>null);
  const actorId=c.req.header("x-managed-services-operator-id")??"";
  if(!body||!body.plan_tier||!body.provider||!body.service_id||!body.operation_name||!body.region||!body.reason||body.reason.trim().length<10||body.reason.length>500||! /^[A-Za-z0-9._:@-]{1,160}$/.test(actorId))return c.json({error_code:"managed_service_entitlement_disable_invalid"},400);
  const key=[body.plan_tier,body.provider,body.service_id,body.operation_name,body.region];
  const prior=await c.env.PLATFORM_DB.prepare(`SELECT status FROM managed_service_plan_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND region=?`)
    .bind(...key).first<{status:string}>();
  if(!prior)return c.json({error_code:"managed_service_entitlement_not_found"},404);
  if(prior.status==="disabled")return c.json({disabled:true,deduplicated:true});
  const at=new Date().toISOString(),auditId=`msea_${crypto.randomUUID().replaceAll("-","")}`;
  const result=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`UPDATE managed_service_plan_entitlements SET status='disabled',updated_at=? WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND region=? AND status IN ('draft','active')`)
      .bind(at,...key),
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_entitlement_audit(id,plan_tier,provider,service_id,operation_name,region,action,actor_id,reason,created_at)
      SELECT ?,?,?,?, ?,?,'disabled',?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_plan_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND region=? AND status='disabled' AND updated_at=?)`)
      .bind(auditId,...key,actorId,body.reason.trim(),at,...key,at),
  ]);
  if(!result[0]?.meta.changes||!result[1]?.meta.changes)return c.json({error_code:"managed_service_entitlement_disable_conflict"},409);
  return c.json({disabled:true});
});

app.post("/internal/managed-services/model-entitlements/verify",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const body=await readBoundedRequestText(c.req.raw,64*1024).then(value=>JSON.parse(value) as {
    plan_tier?:string;provider?:string;service_id?:string;operation_name?:string;model_id?:string;region?:string;price_version?:string;
    credits_per_operation?:number;max_output_tokens?:number;max_credits_per_operation?:number;max_operations_per_period?:number|null;valid_until?:string;reason?:string;evidence?:unknown;
  }).catch(()=>null);
  const actorId=c.req.header("x-managed-services-operator-id")??"";
  const tiers=["free","growth","business","enterprise"],now=new Date(),until=Date.parse(body?.valid_until??"");
  const evidence=Array.isArray(body?.evidence)?body.evidence:[];
  const validEvidence=evidence.length>0&&evidence.length<=10&&evidence.every(candidate=>{
    if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))return false;
    const item=candidate as Record<string,unknown>;
    if(typeof item.url!=="string"||typeof item.checkedAt!=="string")return false;
    try{const url=new URL(item.url),checked=Date.parse(item.checkedAt);return url.protocol==="https:"&&!url.username&&!url.password&&Number.isFinite(checked)&&checked<=now.getTime()+60_000
      &&(item.note===undefined||typeof item.note==="string"&&item.note.length<=500);}catch{return false;}
  });
  if(!body||!tiers.includes(body.plan_tier??"")||! /^[a-z][a-z0-9_-]{1,63}$/.test(body.provider??"")
    ||! /^[a-z][a-z0-9_.:-]{1,128}$/.test(body.service_id??"")||! /^[a-z][a-z0-9_.:-]{1,128}$/.test(body.operation_name??"")
    ||! /^@?[A-Za-z0-9][A-Za-z0-9@._:/-]{0,198}$/.test(body.model_id??"")||! /^[a-z0-9][a-z0-9-]{0,31}$/.test(body.region??"")
    ||! /^[A-Za-z0-9._:-]{1,100}$/.test(body.price_version??"")||!Number.isSafeInteger(body.credits_per_operation)
    ||body.credits_per_operation!<1||!Number.isSafeInteger(body.max_output_tokens)||body.max_output_tokens!<1||body.max_output_tokens!>4096
    ||!Number.isSafeInteger(body.max_credits_per_operation)||body.credits_per_operation!>body.max_credits_per_operation!
    ||body.max_credits_per_operation!<1||body.max_credits_per_operation!>10_000_000
    ||(body.max_operations_per_period!==undefined&&body.max_operations_per_period!==null&&(!Number.isSafeInteger(body.max_operations_per_period)||body.max_operations_per_period<1||body.max_operations_per_period>100_000))
    ||!Number.isFinite(until)||until<=now.getTime()||until>now.getTime()+180*86_400_000
    ||!validEvidence||! /^[A-Za-z0-9._:@-]{1,160}$/.test(actorId)||!body.reason||body.reason.trim().length<10||body.reason.length>500)
    return c.json({error_code:"managed_service_model_entitlement_verification_invalid"},400);
  const capability=await c.env.PLATFORM_DB.prepare(`SELECT version,operations_json,regions_json,account_modes_json,metering_json,status,valid_until
    FROM managed_service_capability_versions WHERE provider=? AND service_id=? ORDER BY version DESC LIMIT 1`)
    .bind(body.provider,body.service_id).first<{version:number;operations_json:string;regions_json:string;account_modes_json:string;metering_json:string;status:string;valid_until:string|null}>();
  if(!capability||capability.status!=="verified"||!capability.valid_until||capability.valid_until<=now.toISOString())return c.json({error_code:"managed_service_capability_unverified"},409);
  try{
    const operations=JSON.parse(capability.operations_json) as unknown[],regions=JSON.parse(capability.regions_json) as unknown[],modes=JSON.parse(capability.account_modes_json) as unknown[];
    const metering=JSON.parse(capability.metering_json) as Record<string,unknown>;
    if(!operations.includes(body.operation_name)||!regions.includes(body.region)||!modes.includes("naelao_managed")||metering.priceVersion!==body.price_version)
      return c.json({error_code:"managed_service_model_entitlement_evidence_mismatch"},409);
  }catch{return c.json({error_code:"managed_service_capability_invalid"},409);}
  if(until>Date.parse(capability.valid_until))return c.json({error_code:"managed_service_model_entitlement_outlives_capability"},400);
  const evidenceJson=JSON.stringify(evidence),evidenceSha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(evidenceJson)))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  const at=now.toISOString(),auditId=`msmea_${crypto.randomUUID().replaceAll("-","")}`;
  const result=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_model_entitlements
      (plan_tier,provider,service_id,capability_version,operation_name,model_id,region,price_version,max_credits_per_operation,max_operations_per_period,
       credits_per_operation,max_output_tokens,evidence_json,evidence_sha256,status,verified_by,verified_at,valid_until,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)
      ON CONFLICT(plan_tier,provider,service_id,operation_name,model_id,region) DO UPDATE SET capability_version=excluded.capability_version,
       price_version=excluded.price_version,max_credits_per_operation=excluded.max_credits_per_operation,max_operations_per_period=excluded.max_operations_per_period,
       credits_per_operation=excluded.credits_per_operation,max_output_tokens=excluded.max_output_tokens,
       evidence_json=excluded.evidence_json,evidence_sha256=excluded.evidence_sha256,status='active',verified_by=excluded.verified_by,
       verified_at=excluded.verified_at,valid_until=excluded.valid_until,updated_at=excluded.updated_at`)
      .bind(body.plan_tier,body.provider,body.service_id,capability.version,body.operation_name,body.model_id,body.region,body.price_version,
        body.max_credits_per_operation,body.max_operations_per_period??null,body.credits_per_operation,body.max_output_tokens,evidenceJson,evidenceSha256,actorId,at,new Date(until).toISOString(),at,at),
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_model_entitlement_audit
      (id,plan_tier,provider,service_id,operation_name,model_id,region,action,actor_id,reason,evidence_sha256,created_at)
      SELECT ?,?,?,?,?,?,?,'verified',?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_model_entitlements
       WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND model_id=? AND region=? AND status='active' AND verified_at=?)`)
      .bind(auditId,body.plan_tier,body.provider,body.service_id,body.operation_name,body.model_id,body.region,actorId,body.reason.trim(),evidenceSha256,at,
        body.plan_tier,body.provider,body.service_id,body.operation_name,body.model_id,body.region,at),
  ]);
  if(!result[0]?.meta.changes||!result[1]?.meta.changes)return c.json({error_code:"managed_service_model_entitlement_verification_conflict"},409);
  return c.json({verified:true,planTier:body.plan_tier,provider:body.provider,serviceId:body.service_id,operation:body.operation_name,
    modelId:body.model_id,region:body.region,creditsPerOperation:body.credits_per_operation,maxOutputTokens:body.max_output_tokens,
    capabilityVersion:capability.version,evidenceSha256,validUntil:new Date(until).toISOString()});
});

app.post("/internal/managed-services/model-entitlements/disable",async c=>{
  if(!c.env.MANAGED_SERVICES_OPERATOR_SECRET)return c.json({error_code:"managed_service_operator_key_unavailable"},503);
  if(!operatorKeyMatches(c.env.MANAGED_SERVICES_OPERATOR_SECRET,c.req.header("x-managed-services-operator-key")??""))return c.json({error_code:"forbidden"},403);
  const body=await readBoundedRequestText(c.req.raw,16*1024).then(value=>JSON.parse(value) as {plan_tier?:string;provider?:string;service_id?:string;operation_name?:string;model_id?:string;region?:string;reason?:string}).catch(()=>null);
  const actorId=c.req.header("x-managed-services-operator-id")??"";
  if(!body||!body.plan_tier||!body.provider||!body.service_id||!body.operation_name||!body.model_id||!body.region||!body.reason
    ||body.reason.trim().length<10||body.reason.length>500||! /^[A-Za-z0-9._:@-]{1,160}$/.test(actorId))return c.json({error_code:"managed_service_model_entitlement_disable_invalid"},400);
  const key=[body.plan_tier,body.provider,body.service_id,body.operation_name,body.model_id,body.region];
  const prior=await c.env.PLATFORM_DB.prepare(`SELECT status FROM managed_service_model_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND model_id=? AND region=?`)
    .bind(...key).first<{status:string}>();
  if(!prior)return c.json({error_code:"managed_service_model_entitlement_not_found"},404);
  if(prior.status==="disabled")return c.json({disabled:true,deduplicated:true});
  const at=new Date().toISOString(),auditId=`msmea_${crypto.randomUUID().replaceAll("-","")}`;
  const result=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare(`UPDATE managed_service_model_entitlements SET status='disabled',updated_at=?
      WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND model_id=? AND region=? AND status IN ('draft','active')`).bind(at,...key),
    c.env.PLATFORM_DB.prepare(`INSERT INTO managed_service_model_entitlement_audit
      (id,plan_tier,provider,service_id,operation_name,model_id,region,action,actor_id,reason,created_at)
      SELECT ?,?,?,?,?,?,?,'disabled',?,?,? WHERE EXISTS(SELECT 1 FROM managed_service_model_entitlements
       WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND model_id=? AND region=? AND status='disabled' AND updated_at=?)`)
      .bind(auditId,...key,actorId,body.reason.trim(),at,...key,at),
  ]);
  if(!result[0]?.meta.changes||!result[1]?.meta.changes)return c.json({error_code:"managed_service_model_entitlement_disable_conflict"},409);
  return c.json({disabled:true});
});

app.post("/internal/managed-services/credits/reserve", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{
    reservation_id?: string; operation_id?: string; space_id?: string; project_id?: string | null; requester_user_id?: string;
    provider?: string; service_id?: string; operation_name?: string; model_id?: string; quote_id?: string; region?: string; payer_type?: string; payer_id?: string; agentport_agent_id?: string; payer_mandate_id?:string;
    credits?: number; price_version?: string; expires_in_seconds?: number;
  }>().catch(() => null);
  const reservationId = body?.reservation_id ?? "", operationId = body?.operation_id ?? "";
  const credits = body?.credits ?? 0, expiresIn = body?.expires_in_seconds ?? 172800;
  const modelOperationRequiresQuote = body?.provider === "cloudflare" && body?.service_id === "workers-ai";
  const agentMailOperationRequiresQuote = body?.provider === "agentmail" && body?.service_id === "agentmail"
    && (body?.operation_name === "provision" || body?.operation_name === "renew");
  const operationRequiresQuote = modelOperationRequiresQuote || agentMailOperationRequiresQuote;
  if (!orgId || !/^[A-Za-z0-9._:-]{1,200}$/.test(reservationId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(operationId)
    || typeof body?.space_id !== "string" || body.space_id.length < 1 || body.space_id.length > 160
    || (body.project_id !== undefined && body.project_id !== null && (typeof body.project_id !== "string" || body.project_id.length > 128))
    || !/^[a-z][a-z0-9_-]{1,63}$/.test(body.provider ?? "") || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(body.service_id ?? "")
    || !/^[a-z][a-z0-9_.:-]{1,128}$/.test(body.operation_name ?? "")
    || (body.model_id !== undefined && !/^@?[A-Za-z0-9][A-Za-z0-9@._:/-]{0,198}$/.test(body.model_id))
    || (body.quote_id !== undefined && !/^msq_[A-Fa-f0-9]{32}$/.test(body.quote_id))
    || (operationRequiresQuote && body.quote_id === undefined)
    || (operationRequiresQuote && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.requester_user_id ?? "")))
    || (body.agentport_agent_id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.agentport_agent_id))
    || (body.payer_mandate_id !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(body.payer_mandate_id))
    || body.payer_type !== "organization" || body.payer_id !== orgId
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(body.region ?? "")
    || !Number.isSafeInteger(credits) || credits < 1 || credits > 10_000_000
    || !/^[A-Za-z0-9._:-]{1,100}$/.test(body.price_version ?? "")
    || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 91 * 86400) return c.json({ error_code: "bad_request" }, 400);
  const existing = await c.env.PLATFORM_DB.prepare(`SELECT id,space_id,project_id,provider,service_id,operation_name,model_id,quote_id,region,payer_type,payer_id,agentport_agent_id,payer_mandate_id,credits,price_version,status,expires_at
    FROM managed_service_credit_reservations WHERE org_id=? AND operation_id=?`).bind(orgId, operationId)
    .first<{ id:string;space_id:string;project_id:string|null;provider:string;service_id:string;operation_name:string;model_id:string|null;quote_id:string|null;region:string;payer_type:string;payer_id:string;agentport_agent_id:string|null;payer_mandate_id:string|null;credits:number;price_version:string;status:string;expires_at:string|null }>();
  let existingHeld = false;
  if (existing) {
    const priorMandate = existing.payer_mandate_id
      ? await c.env.PLATFORM_DB.prepare(`SELECT id,status,expires_at FROM managed_service_payer_mandates
          WHERE id=? AND tenant_id=? AND payer_type=? AND payer_id=? AND agentport_agent_id IS ? LIMIT 1`)
          .bind(existing.payer_mandate_id,orgId,body.payer_type,body.payer_id,body.agentport_agent_id ?? null)
          .first<{id:string;status:string;expires_at:string|null}>()
      : null;
    const same = existing.id === reservationId && existing.space_id === body.space_id && existing.project_id === (body.project_id ?? null)
      && existing.provider === body.provider && existing.service_id === body.service_id && existing.operation_name === body.operation_name
      && existing.model_id === (body.model_id ?? null)
      && existing.quote_id === (body.quote_id ?? null)
      && existing.region === body.region
      && existing.payer_type === body.payer_type && existing.payer_id === body.payer_id
      && existing.agentport_agent_id === (body.agentport_agent_id ?? null)
      && (body.payer_mandate_id === undefined || existing.payer_mandate_id === body.payer_mandate_id)
      && priorMandate?.id === existing.payer_mandate_id
      && existing.credits === credits && existing.price_version === body.price_version;
    if (!same) return c.json({ error_code: existing.status === "settled" ? "reservation_already_settled" : "reservation_identity_conflict" }, 409);
    // A retry after the caller lost the settlement response must be able to resume the
    // operation. Returning the already-settled reservation is safe: settle is idempotent
    // and the usage event has a stable ID.
    if (existing.status === "settled" || existing.status === "uncertain")
      return c.json({ reserved:true,reservation_id:existing.id,status:existing.status,credits,deduplicated:true });
    if (existing.status !== "held") return c.json({ error_code:"reservation_identity_conflict" },409);
    existingHeld = true;
  }
  const operationScope=`${body.provider}:${body.service_id}:${body.operation_name}`;
  const mandate=body.payer_mandate_id
    ? await c.env.PLATFORM_DB.prepare(`SELECT id,agentport_agent_id,max_credits_per_operation,max_credits_per_period,period_days,auto_renew FROM managed_service_payer_mandates
        WHERE id=? AND tenant_id=? AND payer_type=? AND payer_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
          AND agentport_agent_id IS ? AND EXISTS(SELECT 1 FROM json_each(operation_scopes_json) WHERE value=?) LIMIT 1`)
        .bind(body.payer_mandate_id,orgId,body.payer_type,body.payer_id,new Date().toISOString(),body.agentport_agent_id ?? null,operationScope)
        .first<{id:string;agentport_agent_id:string|null;max_credits_per_operation:number;max_credits_per_period:number|null;period_days:number;auto_renew:number}>()
    : await c.env.PLATFORM_DB.prepare(`SELECT id,agentport_agent_id,max_credits_per_operation,max_credits_per_period,period_days,auto_renew FROM managed_service_payer_mandates
        WHERE tenant_id=? AND payer_type=? AND payer_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
          AND agentport_agent_id IS ? AND EXISTS(SELECT 1 FROM json_each(operation_scopes_json) WHERE value=?) LIMIT 1`)
        .bind(orgId,body.payer_type,body.payer_id,new Date().toISOString(),body.agentport_agent_id ?? null,operationScope)
        .first<{id:string;agentport_agent_id:string|null;max_credits_per_operation:number;max_credits_per_period:number|null;period_days:number;auto_renew:number}>();
  if(!mandate)return c.json({error_code:"payer_mandate_required"},403);
  if(existingHeld && existing?.payer_mandate_id !== mandate.id)return c.json({error_code:"payer_mandate_changed"},403);
  if(credits>mandate.max_credits_per_operation)return c.json({error_code:"payer_mandate_limit_exceeded"},402);
  if(body.operation_name==="renew"&&mandate.auto_renew!==1)return c.json({error_code:"payer_mandate_auto_renew_required"},403);
  if(existingHeld && mandate.max_credits_per_period!==null){
    const scopedSpend=await c.env.PLATFORM_DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,credits) ELSE credits END),0) AS credits
      FROM managed_service_credit_reservations WHERE org_id=? AND agentport_agent_id IS ? AND payer_mandate_id=? AND operation_id<>?
        AND created_at>=datetime('now','-' || ? || ' days')
        AND (status IN ('settled','uncertain') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))`)
      .bind(orgId,body.agentport_agent_id??null,mandate.id,operationId,mandate.period_days).first<{credits:number}>();
    if((scopedSpend?.credits??0)+credits>mandate.max_credits_per_period)
      return c.json({error_code:"payer_mandate_period_limit_exceeded",period_days:mandate.period_days},402);
  }
  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);
  const entitlement = body.model_id
    ? await c.env.PLATFORM_DB.prepare(`SELECT capability_version,price_version,max_credits_per_operation,max_operations_per_period,credits_per_operation,valid_until
        FROM managed_service_model_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND model_id=? AND region=?
          AND status='active' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND valid_until>? LIMIT 1`)
        .bind(planTier,body.provider,body.service_id,body.operation_name,body.model_id,body.region,new Date().toISOString())
        .first<{capability_version:number;price_version:string;max_credits_per_operation:number;max_operations_per_period:number|null;credits_per_operation:number|null;valid_until:string}>()
    : await c.env.PLATFORM_DB.prepare(`SELECT capability_version,price_version,max_credits_per_operation,max_operations_per_period,credits_per_operation,valid_until
        FROM managed_service_plan_entitlements WHERE plan_tier=? AND provider=? AND service_id=? AND operation_name=? AND region=?
          AND status='active' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND valid_until>? LIMIT 1`)
        .bind(planTier,body.provider,body.service_id,body.operation_name,body.region,new Date().toISOString())
        .first<{capability_version:number;price_version:string;max_credits_per_operation:number;max_operations_per_period:number|null;credits_per_operation:number|null;valid_until:string}>();
  if(!entitlement)return c.json({error_code:"managed_service_not_entitled"},403);
  let acceptedPinnedQuote=false;
  let acceptedPinnedCapabilityVersion:number|null=null;
  if(operationRequiresQuote&&body.quote_id&&body.requester_user_id){
    const pinned=await c.env.PLATFORM_DB.prepare(`SELECT q.capability_version FROM managed_service_operation_quotes q
      JOIN managed_service_operations o ON o.operation_id=q.operation_id AND o.tenant_id=q.tenant_id
      WHERE q.quote_id=? AND q.tenant_id=? AND q.space_id=? AND q.project_id IS ? AND q.requester_user_id=? AND q.plan_tier=?
        AND q.provider=? AND q.service_id=? AND q.operation_name=? AND q.model_id IS ? AND q.region=?
        AND q.price_version=? AND q.credits=? AND q.status='consumed' AND q.operation_id=?
        AND o.quote_id=q.quote_id AND ((q.provider='agentmail' AND q.request_sha256 IS NOT NULL AND o.request_sha256=q.request_sha256)
          OR (q.provider='cloudflare' AND q.request_sha256 IS NULL)) AND o.status='running'
        AND o.provider=q.provider AND o.service_id=q.service_id AND o.operation_name=q.operation_name AND o.model_id IS q.model_id AND o.region=q.region
        AND o.capability_version=q.capability_version`).bind(body.quote_id,orgId,body.space_id,body.project_id??null,body.requester_user_id,
          planTier,body.provider,body.service_id,body.operation_name,body.model_id??null,body.region,body.price_version,credits,operationId)
      .first<{capability_version:number}>();
    acceptedPinnedQuote=!!pinned;
    acceptedPinnedCapabilityVersion=pinned?.capability_version??null;
  }
  // A consumed quote remains the price authority for that exact running operation after
  // repricing, but altered/unbound requests must still match the active price.
  if(entitlement.price_version!==body.price_version&&(!operationRequiresQuote||!acceptedPinnedQuote))
    return c.json({error_code:"managed_service_price_version_conflict"},409);
  const modelCreditsPerOperation:number|null="credits_per_operation" in entitlement&&typeof entitlement.credits_per_operation==="number"?entitlement.credits_per_operation:null;
  if(body.model_id&&(!Number.isSafeInteger(modelCreditsPerOperation)||modelCreditsPerOperation!<1))
    return c.json({error_code:"managed_service_model_price_unconfigured"},403);
  if(body.model_id&&credits!==modelCreditsPerOperation&&!acceptedPinnedQuote)
    return c.json({error_code:"managed_service_model_price_conflict"},409);
  if(agentMailOperationRequiresQuote&&credits!==modelCreditsPerOperation&&!acceptedPinnedQuote)
    return c.json({error_code:"managed_service_price_conflict"},409);
  if(credits>entitlement.max_credits_per_operation)return c.json({error_code:"managed_service_entitlement_limit_exceeded"},402);
  const admittedCapabilityVersion=acceptedPinnedCapabilityVersion??entitlement.capability_version;
  const capability=await c.env.PLATFORM_DB.prepare(`SELECT operations_json,regions_json,account_modes_json,status,valid_until FROM managed_service_capability_versions
    WHERE provider=? AND service_id=? AND version=?`).bind(body.provider,body.service_id,admittedCapabilityVersion)
    .first<{operations_json:string;regions_json:string;account_modes_json:string;status:string;valid_until:string|null}>();
  if(!capability||capability.status!=="verified"||!capability.valid_until||capability.valid_until<=new Date().toISOString())return c.json({error_code:"managed_service_capability_unverified"},403);
  try {
    if(!(JSON.parse(capability.operations_json) as unknown[]).includes(body.operation_name)
      ||!(JSON.parse(capability.regions_json) as unknown[]).includes(body.region)
      ||!(JSON.parse(capability.account_modes_json) as unknown[]).includes("naelao_managed"))return c.json({error_code:"managed_service_capability_unverified"},403);
  } catch { return c.json({error_code:"managed_service_capability_unverified"},403); }
  if(!existing&&entitlement.max_operations_per_period!==null){
    const count=await c.env.PLATFORM_DB.prepare(`SELECT COUNT(*) AS count FROM managed_service_credit_reservations WHERE org_id=? AND provider=? AND service_id=? AND operation_name=?
      AND ((? IS NULL AND model_id IS NULL) OR model_id=?) AND region=?
      AND operation_id<>?
      AND created_at>=datetime('now','start of month') AND (status IN ('uncertain','settled') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))`)
      .bind(orgId,body.provider,body.service_id,body.operation_name,body.model_id??null,body.model_id??null,body.region,operationId).first<{count:number}>();
    if((count?.count??0)>=entitlement.max_operations_per_period)return c.json({error_code:"managed_service_entitlement_period_limit"},402);
  }
  const operation=await c.env.PLATFORM_DB.prepare(`SELECT space_id,project_id,provider,service_id,operation_name,model_id,quote_id,capability_version,region,request_sha256,status
    FROM managed_service_operations WHERE operation_id=? AND tenant_id=? LIMIT 1`)
    .bind(operationId,orgId).first<{space_id:string;project_id:string|null;provider:string;service_id:string;operation_name:string;model_id:string|null;quote_id:string|null;capability_version:number|null;region:string|null;request_sha256:string;status:string}>();
  if(!operation||operation.space_id!==body.space_id||operation.project_id!==(body.project_id??null)
    ||operation.provider!==body.provider||operation.service_id!==body.service_id||operation.operation_name!==body.operation_name
    ||operation.model_id!==(body.model_id??null)||operation.quote_id!==(body.quote_id??null)
    ||operation.region!==body.region||operation.capability_version!==admittedCapabilityVersion||operation.status!=="running")
    return c.json({error_code:"managed_service_operation_not_admitted"},409);
  if (operationRequiresQuote) {
    const quote = await c.env.PLATFORM_DB.prepare(`SELECT tenant_id,space_id,project_id,requester_user_id,plan_tier,provider,
        service_id,operation_name,model_id,region,capability_version,price_version,credits,request_sha256,status,operation_id
      FROM managed_service_operation_quotes WHERE quote_id=? LIMIT 1`)
      .bind(body.quote_id).first<{tenant_id:string;space_id:string;project_id:string|null;requester_user_id:string;plan_tier:string;
        provider:string;service_id:string;operation_name:string;model_id:string|null;region:string;capability_version:number;
        price_version:string;credits:number;request_sha256:string|null;status:string;operation_id:string|null}>();
    if (!quote || quote.status!=="consumed" || quote.operation_id!==operationId || quote.tenant_id!==orgId
      || quote.space_id!==body.space_id || quote.project_id!==(body.project_id??null) || quote.requester_user_id!==body.requester_user_id || quote.plan_tier!==planTier
      || quote.provider!==body.provider || quote.service_id!==body.service_id || quote.operation_name!==body.operation_name
      || quote.model_id!==(body.model_id??null) || quote.region!==body.region || quote.capability_version!==admittedCapabilityVersion
      || quote.price_version!==body.price_version || quote.credits!==credits
      || (agentMailOperationRequiresQuote&&(!quote.request_sha256||quote.request_sha256!==operation.request_sha256)))
      return c.json({error_code:"managed_service_operation_quote_required"},409);
  }
  const quota = await checkQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "infra_credits", planTier);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  if (existingHeld) {
    if (!existing) return c.json({error_code:"reservation_identity_conflict"},409);
    if (!existing.expires_at || Date.parse(existing.expires_at) > Date.now())
      return c.json({reserved:true,reservation_id:existing.id,status:"held",credits,deduplicated:true});
    const renewed = await c.env.PLATFORM_DB.prepare(`UPDATE managed_service_credit_reservations SET expires_at=?,updated_at=?
      WHERE id=? AND org_id=? AND operation_id=? AND status='held' AND expires_at<=?
        AND (? IS NULL OR COALESCE((SELECT SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,credits) ELSE credits END)
          FROM managed_service_credit_reservations WHERE org_id=? AND agentport_agent_id IS ? AND payer_mandate_id=? AND operation_id<>?
            AND created_at>=datetime('now','-' || ? || ' days')
            AND (status IN ('settled','uncertain') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))),0) + ? <= ?)
        AND (? IS NULL OR (SELECT COUNT(*) FROM managed_service_credit_reservations WHERE org_id=? AND provider=? AND service_id=? AND operation_name=?
          AND ((? IS NULL AND model_id IS NULL) OR model_id=?) AND region=? AND operation_id<>?
          AND created_at>=datetime('now','start of month') AND (status IN ('uncertain','settled') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) < ?)
        AND ? +
          (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id=? AND event_type='infra_credits' AND recorded_at>=datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) +
          (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id=? AND status='held' AND julianday(expires_at)>julianday('now')) +
          (SELECT COALESCE(SUM(credits),0) FROM managed_service_credit_reservations WHERE org_id=? AND operation_id<>? AND (status='uncertain' OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) <= ?`)
      .bind(expiresAt,new Date().toISOString(),existing.id,orgId,operationId,new Date().toISOString(),mandate.max_credits_per_period,orgId,
        body.agentport_agent_id??null,mandate.id,operationId,mandate.period_days,credits,mandate.max_credits_per_period,
        entitlement.max_operations_per_period,orgId,body.provider,body.service_id,body.operation_name,body.model_id??null,body.model_id??null,
        body.region,operationId,entitlement.max_operations_per_period,
        credits,orgId,orgId,orgId,operationId,quota.limit).run();
    if (renewed.meta.changes) return c.json({reserved:true,reservation_id:existing.id,status:"held",credits,deduplicated:true});
    if (mandate.max_credits_per_period !== null) {
      const scopedSpend = await c.env.PLATFORM_DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,credits) ELSE credits END),0) AS credits
        FROM managed_service_credit_reservations WHERE org_id=? AND agentport_agent_id IS ? AND payer_mandate_id=? AND operation_id<>?
          AND created_at>=datetime('now','-' || ? || ' days')
          AND (status IN ('settled','uncertain') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))`)
        .bind(orgId,body.agentport_agent_id??null,mandate.id,operationId,mandate.period_days).first<{credits:number}>();
      if ((scopedSpend?.credits ?? 0) + credits > mandate.max_credits_per_period)
        return c.json({error_code:"payer_mandate_period_limit_exceeded",period_days:mandate.period_days},402);
    }
    return c.json({error_code:"infra_quota_exceeded",message:"Managed service credit allowance is unavailable",limit:quota.limit},402);
  }
  const inserted = await c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_credit_reservations
    (id,org_id,space_id,project_id,region,operation_id,provider,service_id,operation_name,model_id,payer_type,payer_id,credits,price_version,agentport_agent_id,payer_mandate_id,quote_id,status,expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'held',?,?,?
    WHERE (? IS NULL OR COALESCE((SELECT SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,credits) ELSE credits END)
      FROM managed_service_credit_reservations WHERE org_id=? AND agentport_agent_id IS ? AND payer_mandate_id=?
        AND created_at>=datetime('now','-' || ? || ' days')
        AND (status IN ('settled','uncertain') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))),0) + ? <= ?)
      AND (? IS NULL OR (SELECT COUNT(*) FROM managed_service_credit_reservations WHERE org_id=? AND provider=? AND service_id=? AND operation_name=?
        AND ((? IS NULL AND model_id IS NULL) OR model_id=?) AND region=? AND operation_id<>?
        AND created_at>=datetime('now','start of month') AND (status IN ('uncertain','settled') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) < ?)
      AND ? +
      (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id=? AND event_type='infra_credits' AND recorded_at>=datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) +
      (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id=? AND status='held' AND julianday(expires_at)>julianday('now')) +
      (SELECT COALESCE(SUM(credits),0) FROM managed_service_credit_reservations WHERE org_id=? AND (status='uncertain' OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))) <= ?`)
    .bind(reservationId,orgId,body.space_id,body.project_id??null,body.region,operationId,body.provider,body.service_id,body.operation_name,body.model_id??null,
      body.payer_type,body.payer_id,credits,body.price_version,body.agentport_agent_id??null,mandate.id,body.quote_id??null,expiresAt,new Date().toISOString(),new Date().toISOString(),
      mandate.max_credits_per_period,orgId,body.agentport_agent_id??null,mandate.id,mandate.period_days,credits,mandate.max_credits_per_period,
      entitlement.max_operations_per_period,orgId,body.provider,body.service_id,body.operation_name,body.model_id??null,body.model_id??null,
      body.region,operationId,entitlement.max_operations_per_period,
      credits,orgId,orgId,orgId,quota.limit).run();
  if (!inserted.meta.changes) {
    const raced = await c.env.PLATFORM_DB.prepare(`SELECT id,status,credits,space_id,project_id,region,provider,service_id,operation_name,model_id,payer_type,payer_id,agentport_agent_id,payer_mandate_id,price_version,quote_id
      FROM managed_service_credit_reservations WHERE org_id=? AND operation_id=?`)
      .bind(orgId,operationId).first<{id:string;status:string;credits:number;space_id:string;project_id:string|null;region:string;provider:string;service_id:string;operation_name:string;model_id:string|null;payer_type:string;payer_id:string;agentport_agent_id:string|null;payer_mandate_id:string|null;price_version:string;quote_id:string|null}>();
    if (raced) {
      const same=raced.id===reservationId&&raced.space_id===body.space_id&&raced.project_id===(body.project_id??null)&&raced.region===body.region
        &&raced.provider===body.provider&&raced.service_id===body.service_id&&raced.operation_name===body.operation_name&&raced.model_id===(body.model_id??null)
        &&raced.payer_type===body.payer_type&&raced.payer_id===body.payer_id
        &&raced.agentport_agent_id===(body.agentport_agent_id??null)&&raced.payer_mandate_id===mandate.id
        &&raced.credits===credits&&raced.price_version===body.price_version&&raced.quote_id===(body.quote_id??null);
      return same&&["held","uncertain","settled"].includes(raced.status)
        ? c.json({reserved:true,reservation_id:raced.id,status:raced.status,credits,deduplicated:true})
        : c.json({error_code:"reservation_identity_conflict"},409);
    }
    if (mandate.max_credits_per_period !== null) {
      const scopedSpend = await c.env.PLATFORM_DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(settled_credits,credits) ELSE credits END),0) AS credits
        FROM managed_service_credit_reservations WHERE org_id=? AND agentport_agent_id IS ? AND payer_mandate_id=?
          AND created_at>=datetime('now','-' || ? || ' days')
          AND (status IN ('settled','uncertain') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))`)
        .bind(orgId,body.agentport_agent_id ?? null,mandate.id,mandate.period_days).first<{credits:number}>();
      if ((scopedSpend?.credits ?? 0) + credits > mandate.max_credits_per_period)
        return c.json({error_code:"payer_mandate_period_limit_exceeded",period_days:mandate.period_days},402);
    }
    if (entitlement.max_operations_per_period !== null) {
      const count = await c.env.PLATFORM_DB.prepare(`SELECT COUNT(*) AS count FROM managed_service_credit_reservations WHERE org_id=? AND provider=? AND service_id=? AND operation_name=?
        AND ((? IS NULL AND model_id IS NULL) OR model_id=?) AND region=? AND created_at>=datetime('now','start of month')
        AND (status IN ('uncertain','settled') OR (status='held' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))))`)
        .bind(orgId,body.provider,body.service_id,body.operation_name,body.model_id??null,body.model_id??null,body.region).first<{count:number}>();
      if ((count?.count ?? 0) >= entitlement.max_operations_per_period)
        return c.json({error_code:"managed_service_entitlement_period_limit"},402);
    }
    return c.json({error_code:"infra_quota_exceeded",message:"Managed service credit allowance is unavailable",limit:quota.limit},402);
  }
  return c.json({reserved:true,reservation_id:reservationId,status:"held",credits},201);
});

app.post("/internal/managed-services/credits/uncertain", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{reservation_id?:string}>().catch(()=>null);
  if (!orgId || !body?.reservation_id || body.reservation_id.length > 200) return c.json({error_code:"bad_request"},400);
  const updated = await c.env.PLATFORM_DB.prepare(`UPDATE managed_service_credit_reservations
    SET status='uncertain',expires_at=NULL,updated_at=? WHERE id=? AND org_id=? AND status='held'`)
    .bind(new Date().toISOString(),body.reservation_id,orgId).run();
  if (updated.meta.changes) return c.json({uncertain:true,reservation_id:body.reservation_id});
  const row = await c.env.PLATFORM_DB.prepare("SELECT status FROM managed_service_credit_reservations WHERE id=? AND org_id=?")
    .bind(body.reservation_id,orgId).first<{status:string}>();
  return row?.status==="uncertain" ? c.json({uncertain:true,reservation_id:body.reservation_id,deduplicated:true})
    : row?.status==="settled" ? c.json({uncertain:false,reservation_id:body.reservation_id,settled:true})
      : c.json({error_code:"reservation_not_held"},409);
});

app.post("/internal/managed-services/credits/release", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{reservation_id?:string;outcome?:"no_effect"}>().catch(()=>null);
  if (!orgId || !body?.reservation_id || body.reservation_id.length > 200) return c.json({error_code:"bad_request"},400);
  const allowed = body.outcome === "no_effect" ? ["held","uncertain"] : ["held"];
  const placeholders = allowed.map(()=>"?").join(",");
  const released = await c.env.PLATFORM_DB.prepare(`UPDATE managed_service_credit_reservations SET status='released',expires_at=NULL,updated_at=?
    WHERE id=? AND org_id=? AND status IN (${placeholders})`)
    .bind(new Date().toISOString(),body.reservation_id,orgId,...allowed).run();
  if (released.meta.changes) return c.json({released:true,reservation_id:body.reservation_id});
  const prior = await c.env.PLATFORM_DB.prepare("SELECT status FROM managed_service_credit_reservations WHERE id=? AND org_id=?")
    .bind(body.reservation_id,orgId).first<{status:string}>();
  return prior?.status==="released" ? c.json({released:true,reservation_id:body.reservation_id,deduplicated:true})
    : c.json({error_code:prior?.status==="uncertain"?"uncertain_outcome_requires_resolution":"reservation_not_held"},409);
});

app.post("/internal/managed-services/credits/settle", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{reservation_id?:string;credits?:number}>().catch(()=>null);
  if (!orgId || !body?.reservation_id || body.reservation_id.length>200 || !Number.isSafeInteger(body.credits) || (body.credits??-1)<0)
    return c.json({error_code:"bad_request"},400);
  const reservation = await c.env.PLATFORM_DB.prepare(`SELECT * FROM managed_service_credit_reservations WHERE id=? AND org_id=?`)
    .bind(body.reservation_id,orgId).first<{space_id:string;project_id:string|null;operation_id:string;provider:string;service_id:string;operation_name:string;model_id:string|null;credits:number;price_version:string;status:string;settled_credits:number|null}>();
  if (!reservation) return c.json({error_code:"reservation_not_found"},404);
  if (reservation.model_id && body.credits !== reservation.credits) return c.json({error_code:"managed_service_model_price_conflict"},409);
  if (reservation.status==="settled") return reservation.settled_credits===body.credits
    ? c.json({settled:true,reservation_id:body.reservation_id,credits:body.credits,deduplicated:true})
    : c.json({error_code:"settlement_identity_conflict"},409);
  if (!["held","uncertain"].includes(reservation.status) || body.credits!>reservation.credits)
    return c.json({error_code:"reservation_not_settleable"},409);
  const now=new Date().toISOString();
  const eventId=`managed-service:${orgId}:${body.reservation_id}`;
  const eventHash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(eventId)))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  const statements=[c.env.PLATFORM_DB.prepare(`UPDATE managed_service_credit_reservations SET status='settled',settled_credits=?,expires_at=NULL,settled_at=?,updated_at=?
    WHERE id=? AND org_id=? AND status IN ('held','uncertain') AND credits>=?`).bind(body.credits,now,now,body.reservation_id,orgId,body.credits)];
  if (body.credits!>0) {
    statements.push(c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO usage_events
    (id,org_id,space_id,event_type,quantity,recorded_at,event_hash,schema_version,unit,rate_card_version,cost_credits,project_id,run_id,provider,model_id,payer_kind,decision)
    SELECT ?,?,?,'infra_credits',?,?,?,2,'credits',?,?,?,?,?,?,'plan_quota','charged'
    WHERE EXISTS(SELECT 1 FROM managed_service_credit_reservations WHERE id=? AND org_id=? AND status='settled' AND settled_credits=?)`)
    .bind(eventId,orgId,reservation.space_id,body.credits,now,eventHash,reservation.price_version,body.credits,reservation.project_id,reservation.operation_id,reservation.provider,reservation.model_id,body.reservation_id,orgId,body.credits));
    statements.push(c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_meter_outbox(event_id,org_id,payload_json,status,next_attempt_at,created_at,updated_at)
      SELECT id,org_id,json_object('type','meter','org_id',org_id,'space_id',space_id,'event_type',event_type,'quantity',quantity,
        'event_id',id,'event_hash',event_hash,'recorded_at',recorded_at,'schema_version',schema_version,'unit',unit,
        'rate_card_version',rate_card_version,'cost_credits',cost_credits,'run_id',run_id,'provider',provider,'model_id',model_id,
        'project_id',project_id,'payer_kind',payer_kind,'decision',decision),'pending',?,?,?
      FROM usage_events WHERE id=? AND org_id=? AND event_type='infra_credits'`)
      .bind(now,now,now,eventId,orgId));
  }
  const batch=await c.env.PLATFORM_DB.batch(statements);
  if (body.credits!>0 && (batch[1]?.meta.changes??0)>0) {
    await recordUsageEvent(c.env.QUOTA_CACHE,orgId,"infra_credits");
  }
  const final=await c.env.PLATFORM_DB.prepare("SELECT status,settled_credits FROM managed_service_credit_reservations WHERE id=? AND org_id=?")
    .bind(body.reservation_id,orgId).first<{status:string;settled_credits:number|null}>();
  if(final?.status!=="settled" || final.settled_credits!==body.credits) return c.json({error_code:"settlement_identity_conflict"},409);
  if(body.credits!>0) await dispatchManagedServiceMeterOutbox(c.env).catch(()=>undefined);
  return c.json({settled:true,reservation_id:body.reservation_id,credits:body.credits,deduplicated:(batch[1]?.meta.changes??0)===0});
});

/**
 * The org's plan tier, from the SAME authority everything else enforces against.
 *
 * `orgs.plan_tier` is what EntitlementsChecker.getTenantTier reads and what gates free-tier
 * templates; `subscriptions.plan_tier` is written by the billing webhook. These two routes read
 * only the latter, so an org whose tier was set on `orgs` alone — which is exactly what the docs
 * tell an operator to do for their own account — kept getting free-tier quotas and hit a 100k
 * token wall while showing as enterprise everywhere else. Item 45 fixed this same split-brain on
 * the write side (the webhook now writes both); this fixes the read side that was still missed.
 *
 * orgs wins, subscriptions is the fallback, and an unknown org resolves to "free" — the most
 * restrictive tier, failing closed, matching resolveOrgPlanTier's own posture.
 */
async function resolvePlanTier(db: D1Database, orgId: string): Promise<string> {
  try {
    const org = await db.prepare("SELECT plan_tier FROM orgs WHERE id = ?").bind(orgId).first<{ plan_tier: string }>();
    if (org?.plan_tier) return org.plan_tier;
  } catch {
    // Fall through to the subscription row rather than failing the whole check.
  }
  try {
    const sub = await db.prepare("SELECT plan_tier FROM subscriptions WHERE org_id = ?").bind(orgId).first<{ plan_tier: string }>();
    return sub?.plan_tier ?? "free";
  } catch {
    return "free";
  }
}

/** Phase 4 (money): `orgs.allow_quota_overage` — see migration 0072's own comment for what this
 *  is and, just as importantly, what it deliberately is not (not metered billing). Fails to
 *  `false` (the stricter, hard-gated default) on any read error, same posture as resolvePlanTier
 *  falling to "free" — an outage must never silently grant overage. */
async function resolveAllowOverage(db: D1Database, orgId: string): Promise<boolean> {
  try {
    const org = await db.prepare("SELECT allow_quota_overage FROM orgs WHERE id = ?").bind(orgId).first<{ allow_quota_overage: number }>();
    return (org?.allow_quota_overage ?? 0) === 1;
  } catch {
    return false;
  }
}

// ── GET /internal/usage/llm-tokens/check ─────────────────────────────────────
// P0-3: NaelaoAgentDO's pre-run gate for a builder (owner/admin/editor/viewer) chatting with
// their own Space Assistant (never a project-scoped run, never a signed-in product end user —
// those have their own separate credit gates). Internal-only, HMAC-gated like every
// sibling /internal/* route in this file; the org to check is the verified x-naelao-tenant-id
// header, same posture as /billing/usage above.
// Phase 4 (money): now checks day/week ceilings too (checkWindowedQuota), not just the monthly
// one — and honors the org's own allow_quota_overage toggle, which turns a real breach into a
// soft `overage: true` pass instead of a block. Response shape is additive (adds `window`/
// `overage`) so this stays backward-compatible with the pre-existing {allowed, current, limit}
// contract the caller already reads.
app.use("/internal/usage/llm-tokens/check", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.get("/internal/usage/llm-tokens/check", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const [planTier, allowOverage] = await Promise.all([
    resolvePlanTier(c.env.PLATFORM_DB, orgId),
    resolveAllowOverage(c.env.PLATFORM_DB, orgId),
  ]);

  const quota = await checkWindowedQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "llm_tokens", planTier, allowOverage);
  return c.json({ ...quota, plan_tier: planTier });
});

// ── GET /internal/usage/infra-credits/check ──────────────────────────────────
// §A1.26: the infra-usage counterpart to /internal/usage/llm-tokens/check above — same scoping
// (a builder chatting with their own Space Assistant; project/end-user runs have their own
// separate credit and spend-cap gates), same HMAC gate, same shape.
app.use("/internal/usage/infra-credits/check", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.get("/internal/usage/infra-credits/check", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);

  const quota = await checkQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "infra_credits", planTier);
  return c.json({ ...quota, plan_tier: planTier });
});

// ── GET /internal/usage/llm-tokens/summary ───────────────────────────────────
// §A1.27: day/week/month usage for the context-window usage UI (apps/shell) — distinct from
// /internal/usage/llm-tokens/check above, which is a single monthly allowed/blocked gate decision
// for enforceRunGates. This is a display-only summary across three windows, uncached (reads the
// D1 aggregate directly — see getUsageSummary's own comment on why that's the right tradeoff for
// a UI number instead of a gate check).
app.use("/internal/usage/llm-tokens/summary", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.get("/internal/usage/llm-tokens/summary", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);

  const summary = await getUsageSummary(c.env.PLATFORM_DB, orgId, "llm_tokens", planTier);
  return c.json({ ...summary, plan_tier: planTier });
});

// Owner/admin display summary for a single Project. The Spaces Worker performs project membership
// authorization before calling this service; HMAC authentication binds the tenant here.
app.use("/internal/usage/project-summary", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.get("/internal/usage/project-summary", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.query("space_id") ?? "";
  const projectId = c.req.query("project_id") ?? "";
  const days = Number(c.req.query("days") ?? "30");
  if (!orgId || !spaceId || spaceId.length > 128 || !projectId || projectId.length > 128 || ![1, 7, 30, 90].includes(days)) {
    return c.json({ error_code: "bad_request" }, 400);
  }
  const totals = await c.env.PLATFORM_DB.prepare(`SELECT COUNT(*) AS event_count,
      COALESCE(SUM(cost_credits),0) AS cost_credits,
      SUM(CASE WHEN cost_credits IS NULL THEN 1 ELSE 0 END) AS unpriced_event_count
    FROM usage_events WHERE org_id=? AND space_id=? AND project_id=? AND recorded_at>=datetime('now',?)`)
    .bind(orgId, spaceId, projectId, `-${days} days`).first<{
      event_count: number; cost_credits: number; unpriced_event_count: number;
    }>();
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT event_type,COALESCE(unit,'units') AS unit,
      COALESCE(payer_kind,'legacy') AS payer_kind,installation_id,provider,connector_provider,
      COUNT(*) AS event_count,COALESCE(SUM(quantity),0) AS quantity,
      SUM(cost_credits) AS cost_credits,SUM(CASE WHEN cost_credits IS NULL THEN 1 ELSE 0 END) AS unpriced_event_count
    FROM usage_events WHERE org_id=? AND space_id=? AND project_id=? AND recorded_at>=datetime('now',?)
    GROUP BY event_type,unit,payer_kind,installation_id,provider,connector_provider
    ORDER BY COALESCE(SUM(cost_credits),-1) DESC,event_type LIMIT 200`)
    .bind(orgId, spaceId, projectId, `-${days} days`).all<{
      event_type: string; unit: string; payer_kind: string; installation_id: string | null;
      provider: string | null; connector_provider: string | null; event_count: number; quantity: number;
      cost_credits: number | null; unpriced_event_count: number;
    }>();
  const breakdown = rows.results;
  return c.json({
    project_id: projectId, space_id: spaceId, days,
    cost_credits: totals?.cost_credits ?? 0,
    event_count: totals?.event_count ?? 0,
    unpriced_event_count: totals?.unpriced_event_count ?? 0,
    breakdown,
  });
});

// ── POST /webhooks/lemon-squeezy ─────────────────────────────────────────────
// Primary billing provider (spec Appendix H). Unauthenticated — LS calls this directly.
// On payment/subscription events, wakes the Space Assistant agent via NaelaoAgentDO.
app.post("/webhooks/lemon-squeezy", async (c) => {
  return handleLemonSqueezyWebhook(c.req.raw, {
    ...(c.env.LEMON_SQUEEZY_WEBHOOK_SECRET ? { LEMON_SQUEEZY_WEBHOOK_SECRET: c.env.LEMON_SQUEEZY_WEBHOOK_SECRET } : {}),
    ...(c.env.LEMON_SQUEEZY_API_KEY ? { LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY } : {}),
    ...(c.env.LEMON_SQUEEZY_STORE_ID ? { LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID } : {}),
    PLATFORM_DB: c.env.PLATFORM_DB,
    PLATFORM_SECRET: c.env.PLATFORM_SECRET,
    // Platform-plan upserts invalidate the org's quota cache so a paid upgrade unlocks
    // entitlements immediately, not after the KV TTL.
    QUOTA_CACHE: c.env.QUOTA_CACHE,
  });
});

// ── POST /webhooks/whop-platform-plan ──────────────────────────────────────────
// Naelao's Whop company webhook (organization and Product-user subscriptions). Unauthenticated
// route; the Whop-Signature HMAC (verified against
// WHOP_PLATFORM_PLAN_WEBHOOK_SECRET) is the auth, same posture as every other webhook here.
app.post("/webhooks/whop-platform-plan", async (c) => {
  let rawBody: string;
  try { rawBody = await readBoundedRequestText(c.req.raw, 1024 * 1024); }
  catch { return c.json({ error_code: "payload_too_large" }, 413); }
  const { verifyWhopPlatformPlanWebhook, parseWhopPlatformPlanEvent } = await import("@naelao/billing-core");
  if (!c.env.WHOP_PLATFORM_PLAN_WEBHOOK_SECRET || !(await verifyWhopPlatformPlanWebhook(rawBody, c.req.raw.headers, c.env.WHOP_PLATFORM_PLAN_WEBHOOK_SECRET))) {
    return c.json({ error_code: "invalid_signature", message: "Whop-Signature verification failed" }, 401);
  }
  let event;
  try {
    event = parseWhopPlatformPlanEvent(rawBody);
  } catch (err) {
    console.warn(`[billing/whop-platform-plan] failed to parse event body: ${(err as Error).message}`);
    return c.json({ ok: true, skipped: true, reason: "unparseable body" });
  }
  const env = {
    PLATFORM_DB: c.env.PLATFORM_DB,
    PLATFORM_SECRET: c.env.PLATFORM_SECRET,
    QUOTA_CACHE: c.env.QUOTA_CACHE,
  };
  const eventKey = `body:${await sha256Hex(rawBody)}`;
  if (!await markEventProcessedOnce("whop", eventKey, event.type, env.PLATFORM_DB)) {
    return c.json({ ok: true, duplicate: true });
  }
  let handled: boolean;
  try {
    handled = event.metadata.kind === "product_user_plan"
      ? await recordProductUserPlanSubscription(event, env)
      : await recordPlatformPlanSubscription(event, env);
  } catch (err) {
    await unmarkEventProcessed("whop", eventKey, env.PLATFORM_DB);
    throw err;
  }
  return c.json({ ok: true, handled });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Queue message type ────────────────────────────────────────────────────────
interface BillingQueueMessage {
  type: string;
  org_id?: string;
  invoice_id?: string;
  event_type?: string;
  quantity?: number;
  event_id?: string;
  [key: string]: unknown;
}

// ── Queue consumer ────────────────────────────────────────────────────────────
// Handles messages from the BILLING_EVENTS queue
async function handleQueue(
  batch: MessageBatch<BillingQueueMessage>,
  _env: BillingEnv
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body;

    try {
      switch (msg.type) {
        case "dunning": {
          if (!isDunningEventMessage(msg)) {
            throw new Error("billing_dunning_message_invalid");
          }
          await _env.DUNNING_EVENTS.send(msg);
          message.ack();
          break;
        }

        case "meter": {
          if (typeof msg.event_id === "string" && msg.event_id.startsWith("managed-service:")) {
            const inserted = await _env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO managed_service_meter_deliveries(event_id,org_id,delivered_at)
              VALUES(?,?,?)`).bind(msg.event_id,msg.org_id ?? "",new Date().toISOString()).run();
            if (!inserted.meta.changes) { message.ack(); break; }
          }
          // G-D07: usage-metering stub. Vendor cutover note: this used to be a planned Stripe
          // Billing Meters call; with Lemon Squeezy as the only provider, usage-based add-on
          // billing (if ever needed beyond plan tiers) would go through LS usage records
          // instead. Today real enforcement runs on @naelao/entitlements' D1 aggregates, so
          // this remains a log-only intent record.
          console.log(
            `[billing/meter] org=${msg.org_id} event=${msg.event_type} qty=${msg.quantity} id=${msg.event_id} — metering intent logged`
          );
          message.ack();
          break;
        }

        default:
          console.warn(`[billing/queue] unknown message type: ${msg.type}`);
          message.ack();
      }
    } catch (err) {
      console.error(
        `[billing/queue] error processing message type=${msg.type}:`,
        err
      );
      // Retry on error by NOT calling ack — CF Queues will retry up to max_retries
      message.retry();
    }
  }
}

export default {
  async fetch(request: Request, env: BillingEnv, ctx: ExecutionContext): Promise<Response> {
    if (!request.body || request.method === "GET" || request.method === "HEAD") return app.fetch(request, env, ctx);
    try {
      const bytes = await readBoundedRequestBytes(request, 4 * 1024 * 1024);
      return app.fetch(new Request(request, { body: bytes }), env, ctx);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
      return errorResponse(error, "unknown");
    }
  },
  async scheduled(event: ScheduledController, env: BillingEnv, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.allSettled([
      reconcileDeveloperPayouts(env, Date.now(), event.cron === "0 0 * * *"),
      dispatchManagedServiceMeterOutbox(env),
      dispatchDunningOutbox(env),
    ]));
  },
  queue: handleQueue as unknown as ExportedHandlerQueueHandler<BillingEnv>,
} satisfies ExportedHandler<BillingEnv>;
