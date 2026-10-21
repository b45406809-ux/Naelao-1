import {
  badRequest,
  errorResponse,
  internalError,
  notFound,
  requestId,
  readBoundedRequestText,
  readBoundedRequestBytes,
  RequestBodyTooLargeError,
  mintInternalToken,
  requireInternalHmac,
} from "@naelao/http";
// G-D05: Billing worker — Lemon Squeezy webhooks, checkout, subscription sync.
// Vendor cutover: Lemon Squeezy is the ONLY billing provider — the builder's own platform-plan
// checkout/portal (previously the last Stripe-backed path) now runs through the same LS store as
// every other money path. stripe.ts is deleted; /webhooks/stripe removed.
import { Hono } from "hono";
import { checkQuota, checkWindowedQuota, recordUsageEvent, getUsageSummary, PLAN_LIMITS, llmReservationAdmission } from "./quota.js";
import { handleLemonSqueezyWebhook, recordPlatformPlanSubscription, grantPersonalPlanPurchase } from "./lemon-squeezy.js";
import { createLsProductVariant, lsProductsConfig } from "./ls-products.js";
import { registerWhopWalletRoutes, handleWhopWebhook, renderPayoutApprovalPage, confirmPayoutApproval, routeWhopWalletCheckout, getSubMerchant } from "./whop-wallet.js";
import { createBusinessWhopOAuthCheckout } from "./whop-oauth-billing.js";
import { reserveOwnerPayout, settleSpaceWallet } from "./wallet-checkout.js";
import { normalizePlanTier, PLANS, BILLING_CORE_RATE_CARD_VERSION } from "@naelao/billing-core";
import { registerPartnerPortalRoutes } from "./partner-portal.js";
import { reconcileDeveloperPayouts } from "./payout-reconciliation.js";
import { registerMarketplaceLicenseRoutes } from "./marketplace-licenses.js";
export { settleTemplateSubscriptionPayment } from "./settlement.js";

export interface BillingEnv {
  /** Optional native FDE payout rail; separate from customer/business-wallet billing. */
  STRIPE_CONNECT_SECRET_KEY?: string;
  ENVIRONMENT: string;
  /** Shared inter-worker HMAC secret (mintInternalToken/requireInternalHmac, @naelao/http) —
   *  needed to call spaces worker's internal routes directly (bypassing naelao-router). */
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  QUOTA_CACHE: KVNamespace;
  BILLING_EVENTS: Queue;
  // Lemon Squeezy (the ONLY billing provider — spec Appendix H / CLAUDE.md #9)
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  /** LS subscription variant ids for the builder's own platform plans (created once in the
   *  Naelao LS store, like STRIPE_*_PRICE_ID used to be). Optional — /billing/checkout degrades
   *  to the same dev-placeholder flow as /internal/commerce/checkout when unset. */
  LEMON_SQUEEZY_GROWTH_VARIANT_ID?: string;
  LEMON_SQUEEZY_BUSINESS_VARIANT_ID?: string;
  /** Platform fee on customer product sales, basis points. Default 500 (5%). */
  LAUNCHPAD_FEE_BPS?: string;
  // Service binding to agents worker — billing events wake the Space Assistant agent
  AGENTS_WORKER?: Fetcher;
  // Service binding to spaces worker — seat purchases activate the member in SpaceDO
  SPACES_WORKER?: Fetcher;
  // ── Whop sub-merchant wallets (business-bank-account rail) ──
  /** Service binding to credentials worker — vaults payout destination details, AES-256-GCM
   *  encrypted (never D1 plaintext). */
  CREDENTIALS_WORKER?: Fetcher;
  /** Service binding to notifications worker — sends the one-time payout approval email. */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Naelao's ONE Whop master Platform account API key — universal-tools doctrine, like
   *  other platform-held provider credentials. Used to auto-provision a sub-merchant company per
   *  business, read balances, create checkouts, and issue withdrawals. Never platform billing
   *  custody (item 45 stands — Lemon Squeezy is still the only PLATFORM provider); this is the
   *  per-business revenue-custody rail. Optional — wallet routes degrade honestly
   *  (status='error'/503) when unset. */
  WHOP_PLATFORM_API_KEY?: string;
  /** Whop webhook signing secret for the platform's sub-merchant webhook endpoint. */
  WHOP_WEBHOOK_SECRET?: string;
  /** Public base URL webhooks are reachable at (e.g. https://api.naelao.com) — used to build the
   *  one-time payout approval link sent by email. Optional: the payout request still exists in
   *  the dashboard/shell without it, just with no emailed link. */
  PUBLIC_WEBHOOK_BASE_URL?: string;
  // ── Whop as a second PLATFORM billing provider (AUDIT_TODO.md AI-7), tried before Lemon
  // Squeezy — added because LS's own onboarding requires a Stripe-linked payout path unavailable
  // in some sellers' countries. Naelao's OWN normal Whop seller/company account (NOT the
  // invite-gated Platforms API WHOP_PLATFORM_API_KEY uses above — a completely different Whop
  // relationship, see whop-platform-plan.ts's header). ──
  /** Naelao's own Whop company API key (a normal seller key, like any Whop creator has — no
   *  invite needed). Optional — /billing/checkout falls through to Lemon Squeezy, then the dev
   *  placeholder, when unset. */
  WHOP_API_KEY?: string;
  /** Plan ids for Naelao's own Growth/Business platform plans, created once in Naelao's Whop
   *  company dashboard (like LEMON_SQUEEZY_*_VARIANT_ID). */
  WHOP_GROWTH_PLAN_ID?: string;
  WHOP_BUSINESS_PLAN_ID?: string;
  /** Naelao's OWN company's webhook signing secret — deliberately separate from
   *  WHOP_WEBHOOK_SECRET above (that one verifies a BUSINESS's sub-merchant company's webhook;
   *  this verifies Naelao's own company's webhook — two different Whop companies, two different
   *  secrets, never interchangeable). */
  WHOP_PLATFORM_PLAN_WEBHOOK_SECRET?: string;
  // Whop OAuth-delegated checkout (end-user subscriptions/credit-packs settling into a
  // BUSINESS's own connected Whop company, via the "Connect with Whop" OAuth flow,
  // whop-oauth-billing.ts) reuses the CREDENTIALS_WORKER + AGENTS_WORKER bindings already
  // declared above — no new binding needed.
}

/**
 * ARCH-REVENUE-6: resolve the builder's revenue-share bps for a selling space at CHECKOUT time,
 * by asking the spaces worker (which resolves it from the builder's parent reseller product's
 * effective productConfig.commerce.builderFeeBps). Best-effort: any failure (unbound worker, no
 * parent, lookup error) returns 0 — a builder share is never silently applied on an error, only
 * when explicitly configured. Never throws — a checkout must not fail over the builder-share lookup.
 */
async function resolveBuilderFeeBps(env: BillingEnv, spaceId: string): Promise<number> {
  if (!env.SPACES_WORKER) return 0;
  try {
    const spaceRow = await env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
      .bind(spaceId).first<{ tenant_id: string }>();
    if (!spaceRow) return 0;
    const resp = await env.SPACES_WORKER.fetch(new Request(
      `http://spaces-worker/internal/builder-fee-bps?space_id=${encodeURIComponent(spaceId)}`,
      { headers: { "x-naelao-tenant-id": spaceRow.tenant_id, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, spaceRow.tenant_id) } }
    ));
    if (!resp.ok) return 0;
    const { builder_fee_bps } = await resp.json<{ builder_fee_bps: number }>();
    return Number.isFinite(builder_fee_bps) && builder_fee_bps > 0 ? Math.floor(builder_fee_bps) : 0;
  } catch {
    return 0;
  }
}

// G-A11: Validate required secrets at startup. Vendor cutover: the STRIPE_* requirement is gone
// (Lemon Squeezy is the only provider, and its own vars are optional-with-honest-degradation like
// every other LS caller in this file); PLATFORM_SECRET is what every HMAC-gated route and direct
// spaces-worker call actually depends on.
function validateEnv(env: BillingEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: BillingEnv }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });
registerMarketplaceLicenseRoutes(app);
registerPartnerPortalRoutes(app);

app.post("/billing/business-wallet/settle", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  return settleSpaceWallet(c.env, tenantId, await c.req.json());
});

app.post("/billing/business-wallet/withdraw", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  return reserveOwnerPayout(c.env, tenantId, await c.req.json());
});

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

  // Without LS credentials or a provisioned plan variant (local/dev) return a deterministic
  // placeholder so the flow is testable end-to-end — the exact convention every other checkout
  // route in this file follows (/internal/commerce/checkout etc.).
  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !variantId) {
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
    headers: {
      Authorization: `Bearer ${c.env.LEMON_SQUEEZY_API_KEY}`,
      Accept: "application/vnd.api+json",
    },
  });
  if (!resp.ok) {
    throw internalError(`Lemon Squeezy customer lookup failed (${resp.status})`);
  }
  const data = await resp.json<{ data?: { attributes?: { urls?: { customer_portal?: string } } } }>();
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
    payer_kind?: "space_wallet" | "consumer_credits" | "plan_quota" | "platform" | "unknown";
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

  // Wallet/consumer-prepaid v2 usage is already charged to that payer and must not become a
  // second platform subscription meter event. Plan/platform events keep the existing async rail.
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

// Holds estimated builder LLM tokens before provider dispatch so concurrent Space Assistant
// runs share the same day/week/month quota envelope. Holds are separate from usage_events and
// only actual post-run token counts become billable usage.
app.use("/internal/usage/llm-tokens/reservations/*", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/usage/llm-tokens/reservations/reserve", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ reservation_id?: string; run_id?: string; space_id?: string; estimated_tokens?: number }>().catch(() => null);
  const id = body?.reservation_id ?? "", runId = body?.run_id ?? "", spaceId = body?.space_id ?? "", tokens = body?.estimated_tokens ?? 0;
  if (!orgId || !id || id.length > 200 || !runId || runId.length > 128 || !spaceId || !Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 10_000_000) return c.json({ error_code: "bad_request" }, 400);
  const existing = await c.env.PLATFORM_DB.prepare("SELECT run_id,estimated_tokens,status FROM llm_token_reservations WHERE id=? AND org_id=?").bind(id, orgId).first<{ run_id: string; estimated_tokens: number; status: string }>();
  if (existing) return existing.run_id === runId && existing.estimated_tokens === tokens && existing.status === "held"
    ? c.json({ reserved: true, deduplicated: true, reservation_id: id })
    : c.json({ error_code: "reservation_id_conflict" }, 409);
  const planTier = await resolvePlanTier(c.env.PLATFORM_DB, orgId);
  const allowOverage = await resolveAllowOverage(c.env.PLATFORM_DB, orgId);
  const limits = PLAN_LIMITS[planTier] ?? PLAN_LIMITS.free!;
  const admission = llmReservationAdmission(orgId, tokens, limits, allowOverage);
  const binds: unknown[] = [id, orgId, spaceId, runId, tokens, new Date(Date.now() + 15 * 60_000).toISOString()];
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
      const renewed = await c.env.PLATFORM_DB.prepare("UPDATE workflow_budget_reservations SET status='held', credits=?, expires_at=?, updated_at=datetime('now') WHERE id=? AND org_id=? AND status='released' AND ? + (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE org_id=? AND event_type='infra_credits' AND recorded_at>=datetime('now','start of month') AND (schema_version<2 OR payer_kind IN ('plan_quota','platform','unknown'))) + (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id=? AND status='held' AND julianday(expires_at)>julianday('now')) <= ?")
        .bind(credits, expiry, existing.id, orgId, credits, orgId, orgId, quota.limit).run();
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
      (SELECT COALESCE(SUM(credits),0) FROM workflow_budget_reservations WHERE org_id = ? AND status = 'held' AND julianday(expires_at) > julianday('now')) <= ?
  `).bind(id, orgId, body.space_id, workflowId, body.budget_key, body.project_id ?? null, body.installation_id ?? null,
    body.runtime_tier ?? null, credits, expiry, credits, orgId, orgId, quota.limit).run();
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
  if (!reservation) return c.json({ settled: false, reservation_id: body.reservation_id });
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
// those have their own separate wallet/credit gates). Internal-only, HMAC-gated like every
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
// separate wallet/spend-cap gates), same HMAC gate, same shape.
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

// ── POST /internal/commerce/checkout ─────────────────────────────────────────
// Called by the reserved `commerce` prebuilt script. The ONLY money-in path: creates a Lemon
// Squeezy checkout on Naelao's store for a product, carrying space_id + product_id + fee_bps in
// custom data so the webhook attributes the sale and captures the platform fee. A builder can
// never reach this with their own processor.
// F20 / A1.16.8: this used to be a static `x-naelao-internal: "commerce-script"` header check —
// forgeable by anyone reaching this worker directly, since workers_dev was also never set to
// false here (see wrangler.toml). A1.16.8 replaced this exact pattern with requireInternalHmac
// everywhere else; billing was missed. Same gate as workers/spaces/src/index.ts's /internal/*
// routes.
app.use("/internal/commerce/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/commerce/checkout", async (c) => {
  const body = await c.req.json<{ space_id: string; product_id: string; customer_email?: string }>();
  if (!body.space_id || !body.product_id) {
    return c.json({ error_code: "bad_request", message: "space_id and product_id are required" }, 400);
  }

  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, price_cents, currency, kind, ls_variant_id, status FROM launchpad_products WHERE id = ? AND space_id = ?"
  ).bind(body.product_id, body.space_id).first<{
    id: string; name: string; price_cents: number; currency: string; kind: "one_time" | "subscription"; ls_variant_id: string | null; status: string;
  }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
  if (product.status !== "published") {
    return c.json({ error_code: "not_purchasable", message: "Product is not published" }, 409);
  }

  const feeBps = parseInt(c.env.LAUNCHPAD_FEE_BPS ?? "500", 10);
  // ARCH-REVENUE-6: stamp the builder's revenue-share bps AT CHECKOUT (resolved from the builder's
  // reseller product's config via the spaces worker) so a later config change can't re-price this
  // order. Zero for a top-level space with no parent builder.
  const builderFeeBps = await resolveBuilderFeeBps(c.env, body.space_id);

  // Whop sub-merchant wallet: every business gets one auto-provisioned; once it's ACTIVE, a
  // Naelao-store product sale settles directly into the business's own Whop wallet (with
  // Naelao's platform fee auto-split) instead of Naelao's LS store. Still provisioning (not yet
  // active) → null → the existing Naelao-store path below runs byte-identically, so a brand-new
  // business can sell within its own store immediately, provisioning lag never blocks a sale.
  // Once ACTIVE, a broken rail fails CLOSED (503) rather than silently falling back — falling
  // back would settle the business's revenue into the wrong custody.
  const wallet = await getSubMerchant(c.env.PLATFORM_DB, body.space_id);
  if (wallet && wallet.status === "active") {
    try {
      const whopCheckout = await routeWhopWalletCheckout(c.env, {
        spaceId: body.space_id,
        productName: product.name,
        amountCents: product.price_cents,
        currency: product.currency,
        ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
        feeBps,
        metadata: { product_id: product.id },
      });
      if (whopCheckout) {
        return c.json({
          checkout_url: whopCheckout.checkout_url,
          product: { id: product.id, name: product.name, price_cents: product.price_cents, currency: product.currency },
          fee_bps: feeBps, builder_fee_bps: builderFeeBps,
          rail: "whop",
        });
      }
    } catch (err) {
      return c.json({ error_code: "whop_checkout_failed", message: (err as Error).message }, 503);
    }
  }

  // Without LS credentials (local/dev) return a deterministic placeholder so the flow is
  // testable end-to-end; production carries real store creds in Workers Secrets.
  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !product.ls_variant_id) {
    return c.json({
      checkout_url: `https://checkout.${"naelao.com"}/dev/${product.id}`,
      product: { id: product.id, name: product.name, price_cents: product.price_cents, currency: product.currency },
      fee_bps: feeBps, builder_fee_bps: builderFeeBps,
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.space_id,
    variantOrPriceId: product.ls_variant_id,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: { product_id: product.id, fee_bps: String(feeBps), ...(builderFeeBps > 0 ? { builder_fee_bps: String(builderFeeBps) } : {}) },
  });
  return c.json({
    checkout_url: url,
    product: { id: product.id, name: product.name, price_cents: product.price_cents, currency: product.currency },
    fee_bps: feeBps,
  });
});

// ── POST /internal/seats/checkout ────────────────────────────────────────────
// The third money-in payer class: a builder charges someone to join their space (a seat).
// Like product checkout, it runs through Naelao's Lemon Squeezy store so the platform fee
// applies — a builder can't collect seat fees outside Naelao. Called today by the
// commerce.seat_checkout op; a future portal "join" flow calls this the same way (mint its own
// token) — there is no special-cased caller identity string, requireInternalHmac only cares
// that the caller holds PLATFORM_SECRET.
// F20 / A1.16.8: replaces the static `x-naelao-internal in {"commerce-script","portal"}` header
// check (forgeable) with the same requireInternalHmac gate every other worker's /internal/*
// routes use.
app.use("/internal/seats/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/seats/checkout", async (c) => {
  const body = await c.req.json<{ space_id: string; user_id?: string; customer_email?: string }>();
  if (!body.space_id) return c.json({ error_code: "bad_request", message: "space_id is required" }, 400);

  // Resolve the space's seat pricing from its effective productConfig (via spaces worker).
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);
  const seatSpaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.space_id).first<{ tenant_id: string }>();
  if (!seatSpaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const cfgResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/member-billing?space_id=${encodeURIComponent(body.space_id)}`, {
      headers: {
        "x-naelao-tenant-id": seatSpaceRow.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, seatSpaceRow.tenant_id),
      },
    })
  );
  if (!cfgResp.ok) return c.json({ error_code: "not_configured", message: "Member billing is not enabled for this space" }, 409);
  const cfg = await cfgResp.json<{ seatPriceCents: number; currency: string; lsVariantId?: string }>();

  const feeBps = parseInt(c.env.LAUNCHPAD_FEE_BPS ?? "500", 10);
  const builderFeeBps = await resolveBuilderFeeBps(c.env, body.space_id); // ARCH-REVENUE-6

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !cfg.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/seat/${body.space_id}`,
      seat_price_cents: cfg.seatPriceCents, currency: cfg.currency, fee_bps: feeBps, builder_fee_bps: builderFeeBps, dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.space_id,
    variantOrPriceId: cfg.lsVariantId,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: { kind: "seat", fee_bps: String(feeBps), ...(builderFeeBps > 0 ? { builder_fee_bps: String(builderFeeBps) } : {}), ...(body.user_id ? { user_id: body.user_id } : {}) },
  });
  return c.json({ checkout_url: url, seat_price_cents: cfg.seatPriceCents, currency: cfg.currency, fee_bps: feeBps, builder_fee_bps: builderFeeBps });
});

// ── POST /internal/products/ls-variant ───────────────────────────────────────
// Called by the spaces worker when a product (or a member-billing seat) is published for the
// first time and ls_variant_id is not yet set. Creates a Lemon Squeezy product + default
// variant in Naelao's store so the builder's storefront can immediately accept payments.
// Dev path: returns a placeholder when LS creds are absent.
// F20 / A1.16.8: replaces the static `x-naelao-internal !== "publish"` header check (forgeable)
// with requireInternalHmac.
app.use("/internal/products/ls-variant", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/products/ls-variant", async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    price_cents: number;
    currency?: string;
    kind: "one_time" | "subscription";
  }>();
  if (!body.name || body.price_cents === undefined || !body.kind) {
    return c.json({ error_code: "bad_request", message: "name, price_cents, and kind are required" }, 400);
  }

  const cfg = lsProductsConfig(c.env);
  if (!cfg) {
    // Dev path — no LS creds; return deterministic placeholders so publish is testable.
    return c.json({
      ls_product_id: `dev-product-${Date.now()}`,
      ls_variant_id: `dev-variant-${Date.now()}`,
      dev: true,
    });
  }

  try {
    const result = await createLsProductVariant(cfg, {
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
      price_cents: body.price_cents,
      kind: body.kind,
    });
    return c.json({ ls_product_id: result.lsProductId, ls_variant_id: result.lsVariantId });
  } catch (err) {
    console.error("[billing/ls-products] auto-create failed:", (err as Error).message);
    return c.json({ error_code: "ls_api_failed", message: (err as Error).message }, 502);
  }
});

// ── POST /internal/business-subscriptions/checkout ───────────────────────────
// Phase E (§A1.17): a business subscribes to one of its product's builder-defined plans
// (productConfig.pricingConfig.plans, authored via PATCH /builder/products/:id/pricing). The
// catalog lives on the product ROOT, not the business itself, so resolution goes through the
// spaces worker's /internal/pricing-catalog (same parent-walk /internal/product-sessions/verify
// already established) rather than reading D1 directly here — this worker doesn't know the
// business/product space hierarchy rules, spaces worker does.
app.use("/internal/business-subscriptions/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/business-subscriptions/checkout", async (c) => {
  const body = await c.req.json<{ business_space_id: string; plan_id: string; customer_email?: string }>();
  if (!body.business_space_id || !body.plan_id) {
    return c.json({ error_code: "bad_request", message: "business_space_id and plan_id are required" }, 400);
  }
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);

  const spaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!spaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const catalogResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(body.business_space_id)}`, {
      headers: {
        "x-naelao-tenant-id": spaceRow.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, spaceRow.tenant_id),
      },
    })
  );
  if (!catalogResp.ok) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const catalog = await catalogResp.json<{ product_space_id: string; plans: Array<{ id: string; name: string; priceCents: number; interval: string; lsVariantId?: string }> }>();
  const plan = catalog.plans.find((p) => p.id === body.plan_id);
  if (!plan) return c.json({ error_code: "not_found", message: "Plan not found" }, 404);

  const feeBps = parseInt(c.env.LAUNCHPAD_FEE_BPS ?? "500", 10);

  // Try the business's own connected Whop account first (AUDIT_TODO.md AI-7 pivot) — settles
  // 100% into that business's own Whop balance; Naelao's cut is NOT auto-split here (no
  // Platforms-API payment-split on a normal OAuth token) and instead reaches the ledger via the
  // existing revenue-tracker prebuilt's periodic list_payments poll, exactly like any other Whop
  // sale on that account. Falls through to Lemon Squeezy, then the dev placeholder, when the
  // business has no Whop OAuth connection.
  const whopCheckout = await createBusinessWhopOAuthCheckout(c.env, {
    spaceId: body.business_space_id,
    tenantId: spaceRow.tenant_id,
    title: plan.name,
    priceCents: plan.priceCents,
    billingModel: "renewal",
    billingPeriodDays: plan.interval === "year" ? 365 : 30,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: { kind: "business_subscription", plan_id: plan.id, product_space_id: catalog.product_space_id },
  });
  if (whopCheckout) {
    return c.json({
      checkout_url: whopCheckout.checkout_url,
      plan: { id: plan.id, name: plan.name, price_cents: plan.priceCents, interval: plan.interval },
      fee_bps: feeBps,
      provider: "whop",
    });
  }

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !plan.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/business-subscription/${body.business_space_id}/${plan.id}`,
      plan: { id: plan.id, name: plan.name, price_cents: plan.priceCents, interval: plan.interval },
      fee_bps: feeBps,
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.business_space_id,
    variantOrPriceId: plan.lsVariantId,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: {
      kind: "business_subscription",
      plan_id: plan.id,
      product_space_id: catalog.product_space_id,
      fee_bps: String(feeBps),
    },
  });
  return c.json({
    checkout_url: url,
    plan: { id: plan.id, name: plan.name, price_cents: plan.priceCents, interval: plan.interval },
    fee_bps: feeBps,
  });
});

// ── POST /internal/credit-packs/checkout ──────────────────────────────────────
// Phase E: an end user buys a one-time credit pack for their OWN ProductUserDO balance (distinct
// from business-subscriptions above — the pack's catalog still lives on the product root, but the
// credits land on the buyer's individual balance, not the business).
app.use("/internal/credit-packs/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/credit-packs/checkout", async (c) => {
  const body = await c.req.json<{ business_space_id: string; pack_id: string; end_user_id: string; customer_email?: string }>();
  if (!body.business_space_id || !body.pack_id || !body.end_user_id) {
    return c.json({ error_code: "bad_request", message: "business_space_id, pack_id, and end_user_id are required" }, 400);
  }
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);

  const spaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!spaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const catalogResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(body.business_space_id)}`, {
      headers: {
        "x-naelao-tenant-id": spaceRow.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, spaceRow.tenant_id),
      },
    })
  );
  if (!catalogResp.ok) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const catalog = await catalogResp.json<{ product_space_id: string; credit_packs: Array<{ id: string; name: string; credits: number; priceCents: number; lsVariantId?: string }> }>();
  const pack = catalog.credit_packs.find((p) => p.id === body.pack_id);
  if (!pack) return c.json({ error_code: "not_found", message: "Credit pack not found" }, 404);

  const feeBps = parseInt(c.env.LAUNCHPAD_FEE_BPS ?? "500", 10);

  // Try the business's own connected Whop account first — same rationale as
  // business-subscriptions/checkout above. A credit pack is a one-time purchase (billingModel
  // "one_time"); mints a fresh Whop plan per purchase (documented v1 simplification, see
  // whop-oauth-checkout.ts's header).
  const whopCheckout = await createBusinessWhopOAuthCheckout(c.env, {
    spaceId: body.business_space_id,
    tenantId: spaceRow.tenant_id,
    title: pack.name,
    priceCents: pack.priceCents,
    billingModel: "one_time",
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: { kind: "credit_pack", pack_id: pack.id, credits: String(pack.credits), end_user_id: body.end_user_id, product_space_id: catalog.product_space_id },
  });
  if (whopCheckout) {
    return c.json({
      checkout_url: whopCheckout.checkout_url,
      pack: { id: pack.id, name: pack.name, credits: pack.credits, price_cents: pack.priceCents },
      fee_bps: feeBps,
      provider: "whop",
    });
  }

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !pack.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/credit-pack/${body.business_space_id}/${pack.id}`,
      pack: { id: pack.id, name: pack.name, credits: pack.credits, price_cents: pack.priceCents },
      fee_bps: feeBps,
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.business_space_id,
    variantOrPriceId: pack.lsVariantId,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: {
      kind: "credit_pack",
      pack_id: pack.id,
      credits: String(pack.credits),
      end_user_id: body.end_user_id,
      product_space_id: catalog.product_space_id,
      fee_bps: String(feeBps),
    },
  });
  return c.json({
    checkout_url: url,
    pack: { id: pack.id, name: pack.name, credits: pack.credits, price_cents: pack.priceCents },
    fee_bps: feeBps,
  });
});

// ── POST /internal/personal-plan/checkout ─────────────────────────────────────
// Phase 4 (money): an end user upgrades their OWN personal-plan tier (widens their slice of
// maxBusinessesPerEndUser + unlocks inviting others — see @naelao/billing-core's
// resolveEffectiveBusinessLimit/canPersonalPlanInvite).
//
// Rail order: Naelao's OWN Whop seller account first, then Lemon Squeezy, then the dev
// placeholder — the same order /billing/checkout already uses for builder platform plans. This
// is deliberately NOT the business's-own-connected-Whop branch that credit-packs and
// wallet-topups take: those are a business's revenue, whereas a personal plan is Naelao selling
// to an individual, which is the platform-plan shape.
app.use("/internal/personal-plan/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/personal-plan/checkout", async (c) => {
  const body = await c.req.json<{ business_space_id: string; plan_id: string; end_user_id: string; customer_email?: string }>();
  if (!body.business_space_id || !body.plan_id || !body.end_user_id) {
    return c.json({ error_code: "bad_request", message: "business_space_id, plan_id, and end_user_id are required" }, 400);
  }
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);

  const spaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!spaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const catalogResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(body.business_space_id)}`, {
      headers: {
        "x-naelao-tenant-id": spaceRow.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, spaceRow.tenant_id),
      },
    })
  );
  if (!catalogResp.ok) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const catalog = await catalogResp.json<{ product_space_id: string; personal_plans: Array<{ id: string; name: string; tier: string; priceCents: number; interval: string; whopPlanId?: string; lsVariantId?: string }> }>();
  const plan = catalog.personal_plans.find((p) => p.id === body.plan_id);
  if (!plan) return c.json({ error_code: "not_found", message: "Personal plan not found" }, 404);

  // Whop first — Naelao's own seller account, same rail as builder platform plans. Falls through
  // to LS (then the dev placeholder) when no Whop plan id is configured for this tier, so an
  // existing LS-provisioned deployment keeps working unchanged.
  if (c.env.WHOP_API_KEY && plan.whopPlanId) {
    const { createWhopPlatformPlanCheckout } = await import("@naelao/billing-core");
    try {
      const { checkout_url } = await createWhopPlatformPlanCheckout(c.env.WHOP_API_KEY, {
        planId: plan.whopPlanId,
        ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
        // Same metadata contract the LS branch below uses, so one webhook handler serves both.
        metadata: {
          kind: "personal_plan",
          plan_id: plan.id,
          tier: plan.tier,
          end_user_id: body.end_user_id,
          product_space_id: catalog.product_space_id,
        },
      });
      return c.json({
        checkout_url,
        plan: { id: plan.id, name: plan.name, tier: plan.tier, price_cents: plan.priceCents, interval: plan.interval },
        provider: "whop",
      });
    } catch (err) {
      console.warn(`[billing/personal-plan] Whop checkout failed, falling back to LS: ${(err as Error).message}`);
    }
  }

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !plan.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/personal-plan/${body.business_space_id}/${plan.id}`,
      plan: { id: plan.id, name: plan.name, tier: plan.tier, price_cents: plan.priceCents, interval: plan.interval },
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.business_space_id,
    variantOrPriceId: plan.lsVariantId,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: {
      kind: "personal_plan",
      plan_id: plan.id,
      tier: plan.tier,
      end_user_id: body.end_user_id,
      product_space_id: catalog.product_space_id,
    },
  });
  return c.json({
    checkout_url: url,
    plan: { id: plan.id, name: plan.name, tier: plan.tier, price_cents: plan.priceCents, interval: plan.interval },
  });
});

// ── POST /internal/wallet-topups/checkout ─────────────────────────────────────
// Launchpad Wallet (user-directed feature): a business tops up its OWN wallet_ledger balance
// (a project flagged kind='wallet' under the business space) via a fixed-price Lemon Squeezy
// checkout — same "pick a pre-configured pack, no arbitrary custom amount" shape as
// credit-packs/checkout above. Scope note (see workers/agents/src/script-engine/prebuilt/
// wallet.ts's header for the full writeup): this funds an INTERNAL, Naelao-held stored-value
// balance a business draws down for Naelao's own metered platform costs — it does not, and is
// not intended to, pay a third party (Whop/Shopify/Stripe) on the business's behalf. Lemon
// Squeezy itself has no API for that; building it for real would be a money-transmission /
// PCI-scope undertaking well beyond a checkout-and-webhook wiring pass.
app.use("/internal/wallet-topups/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/wallet-topups/checkout", async (c) => {
  const body = await c.req.json<{ business_space_id: string; project_id: string; topup_id: string; customer_email?: string }>();
  if (!body.business_space_id || !body.project_id || !body.topup_id) {
    return c.json({ error_code: "bad_request", message: "business_space_id, project_id, and topup_id are required" }, 400);
  }
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);

  const spaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!spaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const catalogResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(body.business_space_id)}`, {
      headers: {
        "x-naelao-tenant-id": spaceRow.tenant_id,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, spaceRow.tenant_id),
      },
    })
  );
  if (!catalogResp.ok) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const catalog = await catalogResp.json<{ product_space_id: string; wallet_topups: Array<{ id: string; name: string; priceCents: number; lsVariantId?: string }> }>();
  const topup = catalog.wallet_topups.find((p) => p.id === body.topup_id);
  if (!topup) return c.json({ error_code: "not_found", message: "Wallet top-up pack not found" }, 404);

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !topup.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/wallet-topup/${body.business_space_id}/${topup.id}`,
      topup: { id: topup.id, name: topup.name, price_cents: topup.priceCents },
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.business_space_id,
    variantOrPriceId: topup.lsVariantId,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: {
      kind: "wallet_topup",
      topup_id: topup.id,
      cents: String(topup.priceCents),
      project_id: body.project_id,
      product_space_id: catalog.product_space_id,
    },
  });
  return c.json({
    checkout_url: url,
    topup: { id: topup.id, name: topup.name, price_cents: topup.priceCents },
  });
});

// ── POST /internal/revenue-cut-surcharge/checkout ─────────────────────────────
// Go-live monetization pass: bills a builder-configured cut % of a business's TRACKED external
// revenue (external_revenue_snapshots, SpaceDO — see the revenue-tracker prebuilt) as a periodic
// surcharge, since that revenue never flows through Naelao's own Lemon Squeezy custody the way a
// storefront sale does. Sums every UNBILLED period's tracked revenue (a business that hasn't paid
// in N periods gets billed for all of them at once, not just the latest) and creates a checkout
// with a CUSTOM PRICE override — the variant provisioned by PATCH /builder/products/:id/pricing is
// a $1 placeholder; this is what actually sets the real amount. Once paid, the SAME reseller_ledger
// attribution every other payment.success event already gets (recordResellerAttribution,
// unconditional in handleLemonSqueezyWebhook) computes the builder's cut of it automatically — no
// new attribution code needed. The webhook side (recordRevenueCutSurchargePayment, lemon-squeezy.ts)
// marks the billed periods so they're never charged twice.
app.use("/internal/revenue-cut-surcharge/checkout", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.post("/internal/revenue-cut-surcharge/checkout", async (c) => {
  const body = await c.req.json<{ business_space_id: string; customer_email?: string }>();
  if (!body.business_space_id) {
    return c.json({ error_code: "bad_request", message: "business_space_id is required" }, 400);
  }
  if (!c.env.SPACES_WORKER) return c.json({ error_code: "unavailable", message: "spaces worker not bound" }, 503);

  const spaceRow = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ?")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!spaceRow) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const internalHeaders = {
    "x-naelao-tenant-id": spaceRow.tenant_id,
    "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, spaceRow.tenant_id),
  };

  const catalogResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/internal/pricing-catalog?space_id=${encodeURIComponent(body.business_space_id)}`, { headers: internalHeaders })
  );
  if (!catalogResp.ok) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const catalog = await catalogResp.json<{ product_space_id: string; external_revenue_cut: { enabled: boolean; cutBps: number; lsVariantId?: string } | null }>();
  const cut = catalog.external_revenue_cut;
  if (!cut || !cut.enabled) {
    return c.json({ error_code: "not_found", message: "Revenue-cut billing is not enabled for this product" }, 404);
  }

  const revenueResp = await c.env.SPACES_WORKER.fetch(
    new Request(`http://spaces-worker/spaces/${body.business_space_id}/revenue-tracking`, { headers: internalHeaders })
  );
  if (!revenueResp.ok) return c.json({ error_code: "unavailable", message: "Could not read tracked revenue" }, 502);
  const revenue = await revenueResp.json<{ snapshots: Array<{ period: string; revenue_cents: number; billed: boolean; billed_cents?: number; pending_checkout_at?: string | null }> }>();

  // F-27: bill only the DELTA — max(0, cut(revenue) − already-charged) per period — never the full
  // corrected figure on top of what was already collected. F-31: skip a period whose checkout was
  // minted in the last 24h (an in-flight checkout not yet paid), so two checkouts don't both bill it.
  const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const billable = revenue.snapshots
    .map((s) => {
      const owed = Math.round((s.revenue_cents * cut.cutBps) / 10_000);
      const delta = Math.max(0, owed - (s.billed_cents ?? 0));
      // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" (space, UTC) — normalize to an ISO instant.
      const pendingMs = s.pending_checkout_at ? Date.parse(`${s.pending_checkout_at.replace(" ", "T")}Z`) : NaN;
      const isPending = Number.isFinite(pendingMs) && now - pendingMs < PENDING_WINDOW_MS;
      return { period: s.period, delta, isPending };
    })
    .filter((s) => s.delta > 0 && !s.isPending);

  if (billable.length === 0) {
    return c.json({ error_code: "nothing_to_bill", message: "No unbilled tracked revenue for this business" }, 404);
  }

  const surchargeCents = billable.reduce((sum, s) => sum + s.delta, 0);
  if (surchargeCents <= 0) {
    return c.json({ error_code: "nothing_to_bill", message: "Computed surcharge is zero" }, 404);
  }
  const periods = billable.map((s) => s.period);
  const charges = billable.map((s) => s.delta);

  // F-31: reserve these periods so a concurrent/retry checkout skips them. Best-effort — a failure
  // here doesn't block the checkout (the delta guard still prevents true double-charge on payment).
  const markPending = async () => {
    try {
      await c.env.SPACES_WORKER!.fetch(new Request(`http://spaces-worker/spaces/${body.business_space_id}/revenue-tracking/mark-pending`, {
        method: "POST", headers: { "content-type": "application/json", ...internalHeaders }, body: JSON.stringify({ periods }),
      }));
    } catch { /* best-effort */ }
  };

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !cut.lsVariantId) {
    await markPending();
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/revenue-cut-surcharge/${body.business_space_id}`,
      surcharge_cents: surchargeCents,
      periods,
      dev: true,
    });
  }

  const { LemonSqueezyProvider } = await import("@naelao/billing-core");
  const provider = new LemonSqueezyProvider({
    LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY,
    LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID,
  });
  const { url } = await provider.createCheckout({
    spaceId: body.business_space_id,
    variantOrPriceId: cut.lsVariantId,
    customPriceCents: surchargeCents,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: {
      kind: "revenue_cut_surcharge",
      periods: periods.join(","),
      // F-27: the exact delta charged per period (parallel to `periods`), so mark-billed can add
      // it to billed_cents and a refund can reverse exactly it.
      period_charges: charges.join(","),
      product_space_id: catalog.product_space_id,
    },
  });
  await markPending();
  return c.json({ checkout_url: url, surcharge_cents: surchargeCents, periods });
});

// ── POST /webhooks/lemon-squeezy ─────────────────────────────────────────────
// Primary billing provider (spec Appendix H). Unauthenticated — LS calls this directly.
// On payment/subscription events, wakes the Space Assistant agent via NaelaoAgentDO.
app.post("/webhooks/lemon-squeezy", async (c) => {
  if (!c.env.AGENTS_WORKER) {
    // No agents worker bound (local dev without full stack) — still return 200
    return c.json({ ok: true, skipped: true, reason: "AGENTS_WORKER not bound" });
  }
  return handleLemonSqueezyWebhook(c.req.raw, {
    ...(c.env.LEMON_SQUEEZY_WEBHOOK_SECRET ? { LEMON_SQUEEZY_WEBHOOK_SECRET: c.env.LEMON_SQUEEZY_WEBHOOK_SECRET } : {}),
    ...(c.env.LEMON_SQUEEZY_API_KEY ? { LEMON_SQUEEZY_API_KEY: c.env.LEMON_SQUEEZY_API_KEY } : {}),
    ...(c.env.LEMON_SQUEEZY_STORE_ID ? { LEMON_SQUEEZY_STORE_ID: c.env.LEMON_SQUEEZY_STORE_ID } : {}),
    ...(c.env.LAUNCHPAD_FEE_BPS ? { LAUNCHPAD_FEE_BPS: c.env.LAUNCHPAD_FEE_BPS } : {}),
    AGENTS_WORKER: c.env.AGENTS_WORKER,
    ...(c.env.SPACES_WORKER ? { SPACES_WORKER: c.env.SPACES_WORKER } : {}),
    PLATFORM_DB: c.env.PLATFORM_DB,
    PLATFORM_SECRET: c.env.PLATFORM_SECRET,
    // Platform-plan upserts invalidate the org's quota cache so a paid upgrade unlocks
    // entitlements immediately, not after the KV TTL.
    QUOTA_CACHE: c.env.QUOTA_CACHE,
  });
});

// ── POST /webhooks/whop ────────────────────────────────────────────────────────
// The platform's ONE Whop sub-merchant webhook endpoint (unauthenticated — the Whop-Signature
// HMAC is the auth, same posture as /webhooks/lemon-squeezy above). Events carry the
// sub-merchant company they happened on; dispatch resolves the whop_sub_merchants row and
// forces the space from it, never from payload metadata.
app.post("/webhooks/whop", async (c) => handleWhopWebhook(c.req.raw, c.env));

// ── POST /webhooks/whop-platform-plan ──────────────────────────────────────────
// Naelao's OWN Whop company's webhook (builder Growth/Business platform plans, AUDIT_TODO.md
// AI-7) — a DIFFERENT Whop company/secret than /webhooks/whop above (that one is per-BUSINESS
// sub-merchant events). Unauthenticated route; the Whop-Signature HMAC (verified against
// WHOP_PLATFORM_PLAN_WEBHOOK_SECRET) is the auth, same posture as every other webhook here.
app.post("/webhooks/whop-platform-plan", async (c) => {
  if (!c.env.AGENTS_WORKER) {
    // Matches /webhooks/lemon-squeezy's own precedent — no agents worker bound (local dev
    // without full stack) still returns 200 rather than erroring Whop into a retry storm.
    return c.json({ ok: true, skipped: true, reason: "AGENTS_WORKER not bound" });
  }
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
  // Naelao's own Whop company now sells TWO things: builder platform plans (org-level) and end
  // users' personal plans. Both arrive here, distinguished by checkout metadata.kind, so route on
  // that rather than assuming every event on this endpoint is a platform plan.
  const custom = (event.metadata ?? {}) as Record<string, unknown>;
  if (custom["kind"] === "personal_plan") {
    const handledPersonal = await grantPersonalPlanPurchase(event, {
      PLATFORM_DB: c.env.PLATFORM_DB,
      PLATFORM_SECRET: c.env.PLATFORM_SECRET,
      AGENTS_WORKER: c.env.AGENTS_WORKER,
      ...(c.env.SPACES_WORKER ? { SPACES_WORKER: c.env.SPACES_WORKER } : {}),
    } as Parameters<typeof grantPersonalPlanPurchase>[1]);
    return c.json({ ok: true, handled: handledPersonal });
  }

  const handled = await recordPlatformPlanSubscription(event, {
    PLATFORM_DB: c.env.PLATFORM_DB,
    PLATFORM_SECRET: c.env.PLATFORM_SECRET,
    AGENTS_WORKER: c.env.AGENTS_WORKER,
    ...(c.env.SPACES_WORKER ? { SPACES_WORKER: c.env.SPACES_WORKER } : {}),
    QUOTA_CACHE: c.env.QUOTA_CACHE,
  });
  return c.json({ ok: true, handled });
});

// ── GET /webhooks/whop-wallet/payouts/:id/approve?token= ──────────────────────
// Public, unauthenticated — the single-use token IS the auth (business_invites/password-reset
// precedent). SAFE: renders a confirmation page only (no side effects), so an email scanner
// prefetching this link can never trigger a payout. The page's form POSTs to the same path.
app.get("/webhooks/whop-wallet/payouts/:id/approve", async (c) =>
  renderPayoutApprovalPage(c.env, c.req.param("id"), c.req.query("token") ?? "")
);

// ── POST /webhooks/whop-wallet/payouts/:id/approve ─────────────────────────────
// The only handler that actually executes a withdrawal — only reached via a real form
// submission (the GET page above), never a prefetch. Accepts the token from either the form
// body or the query string (a direct API-style POST, e.g. from a future in-dashboard "approve"
// button, can pass it as a query param instead of a form-encoded body).
app.post("/webhooks/whop-wallet/payouts/:id/approve", async (c) => {
  let token = c.req.query("token") ?? "";
  if (!token) {
    try {
      const form = await c.req.parseBody();
      if (typeof form["token"] === "string") token = form["token"];
    } catch {
      // No parseable body — fall through with an empty token (checkPayoutApproval 400s on it).
    }
  }
  return confirmPayoutApproval(c.env, c.req.param("id"), token);
});

// ── Whop sub-merchant wallet — the business-bank-account rail ────────────────
registerWhopWalletRoutes(app);

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
          // G-D06: Dunning stub — real dunning via CF Workflows in Phase 7
          console.log(
            `[billing/dunning] org=${msg.org_id} invoice=${msg.invoice_id} — queued for dunning workflow`
          );
          // Future: trigger a CF Workflow to send dunning emails + pause spaces on non-payment
          message.ack();
          break;
        }

        case "meter": {
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
  async scheduled(event: ScheduledController, env: BillingEnv, ctx: ExecutionContext) { ctx.waitUntil(reconcileDeveloperPayouts(env, Date.now(), event.cron === "0 0 * * *")); },
  queue: handleQueue as unknown as ExportedHandlerQueueHandler<BillingEnv>,
} satisfies ExportedHandler<BillingEnv>;
