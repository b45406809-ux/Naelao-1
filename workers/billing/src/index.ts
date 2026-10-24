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
import { handleLemonSqueezyWebhook, recordPlatformPlanSubscription } from "./lemon-squeezy.js";
import { normalizePlanTier, PLANS, BILLING_CORE_RATE_CARD_VERSION } from "@naelao/billing-core";
import { registerPartnerPortalRoutes } from "./partner-portal.js";
import { reconcileDeveloperPayouts } from "./payout-reconciliation.js";
import { registerMarketplaceLicenseRoutes } from "./marketplace-licenses.js";
export { settleTemplateSubscriptionPayment } from "./settlement.js";

export interface BillingEnv {
  /** Optional native developer payout rail. */
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
   *  to the same dev-placeholder flow when its platform-plan variant is unset. */
  LEMON_SQUEEZY_GROWTH_VARIANT_ID?: string;
  LEMON_SQUEEZY_BUSINESS_VARIANT_ID?: string;
  // Whop is retained only as an optional provider for Naelao platform plans.
  /** Naelao's own Whop company API key (a normal seller key, like any Whop creator has — no
   *  invite needed). Optional — /billing/checkout falls through to Lemon Squeezy, then the dev
   *  placeholder, when unset. */
  WHOP_API_KEY?: string;
  /** Plan ids for Naelao's own Growth/Business platform plans, created once in Naelao's Whop
   *  company dashboard (like LEMON_SQUEEZY_*_VARIANT_ID). */
  WHOP_GROWTH_PLAN_ID?: string;
  WHOP_BUSINESS_PLAN_ID?: string;
  /** Naelao's own company's webhook signing secret. */
  WHOP_PLATFORM_PLAN_WEBHOOK_SECRET?: string;
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

  // Without LS credentials or a provisioned plan variant (local/dev) return a deterministic
  // placeholder so the flow is testable end-to-end — the exact convention used by Naelao platform-plan checkout.
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
    payer_kind?: "consumer_credits" | "plan_quota" | "platform" | "unknown";
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
// Naelao's OWN Whop company's webhook (builder Growth/Business platform plans, AUDIT_TODO.md
// AI-7). Unauthenticated route; the Whop-Signature HMAC (verified against
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
  const handled = await recordPlatformPlanSubscription(event, {
    PLATFORM_DB: c.env.PLATFORM_DB,
    PLATFORM_SECRET: c.env.PLATFORM_SECRET,
    QUOTA_CACHE: c.env.QUOTA_CACHE,
  });
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
