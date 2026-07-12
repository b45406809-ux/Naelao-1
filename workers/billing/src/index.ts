import {
  badRequest,
  errorResponse,
  internalError,
  notFound,
  requestId,
  mintInternalToken,
  requireInternalHmac,
} from "@naelao/http";
// G-D05: Billing worker — Lemon Squeezy webhooks, checkout, subscription sync.
// Vendor cutover: Lemon Squeezy is the ONLY billing provider — the builder's own platform-plan
// checkout/portal (previously the last Stripe-backed path) now runs through the same LS store as
// every other money path. stripe.ts is deleted; /webhooks/stripe removed.
import { Hono } from "hono";
import { checkQuota, recordUsageEvent, getUsageSummary } from "./quota.js";
import { handleLemonSqueezyWebhook } from "./lemon-squeezy.js";
import { createLsProductVariant, lsProductsConfig } from "./ls-products.js";
import { registerWalletConnectionRoutes } from "./wallet-connections.js";

export interface BillingEnv {
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
  // ── Wallet Connect (payment_connections — builder-owned payment accounts) ──
  /** Service binding to credentials worker — vaults the builder's own LS API key +
   *  per-connection webhook secret, AES-256-GCM encrypted (never D1 plaintext). */
  CREDENTIALS_WORKER?: Fetcher;
  /** Naelao's ONE Stripe platform integration key (sk_...) — universal-tools doctrine, like
   *  COMPOSIO_API_KEY. Used ONLY to create/read Express connected accounts and their checkouts;
   *  never platform billing custody (item 45 stands). Optional — wallet Stripe routes degrade
   *  honestly (stripe_not_configured) when unset. */
  STRIPE_PLATFORM_SECRET_KEY?: string;
  /** Signing secret (whsec_...) for the platform's Connect webhook endpoint. */
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  /** Public base URL webhooks are reachable at (e.g. https://api.naelao.com) — used to
   *  auto-create the per-connection LS webhook. Optional: the connection still activates
   *  without it, surfaced as webhook_created:false. */
  PUBLIC_WEBHOOK_BASE_URL?: string;
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

  // The buyer email prefills the LS checkout (same lookup the Stripe path used to do).
  const owner = await c.env.PLATFORM_DB.prepare(
    "SELECT u.email FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? LIMIT 1"
  )
    .bind(userId)
    .first<{ email: string }>();

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
// Lemon Squeezy's hosted customer portal (subscription management / cancel / update card).
app.post("/billing/portal", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId)
    return c.json(
      { error_code: "unauthorized", message: "Missing tenant" },
      401
    );

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT ls_customer_id FROM subscriptions WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{ ls_customer_id: string | null }>();

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
    // G-AN09: Caller may supply an idempotency key; if absent, one is computed
    idempotency_key?: string;
  }>();

  if (!body.event_type) {
    throw badRequest("event_type is required");
  }

  const quantity = body.quantity ?? 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // G-AN09: Compute stable event hash for idempotency.
  // Truncate timestamp to the minute so retries within the same minute are deduplicated.
  // Format: sha256(org_id:space_id:user_id:event_type:YYYY-MM-DDTHH:MM)
  let eventHash: string | null = null;
  if (body.idempotency_key) {
    // Caller-supplied key takes precedence
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.idempotency_key));
    eventHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } else {
    const minuteBucket = now.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const hashInput = `${orgId}:${body.space_id ?? ""}:${body.user_id ?? ""}:${body.event_type}:${minuteBucket}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
    eventHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // G-AN09: INSERT OR IGNORE on event_hash — if duplicate, silently skip (idempotent)
  const result = await c.env.PLATFORM_DB.prepare(
    `INSERT OR IGNORE INTO usage_events (id, org_id, space_id, event_type, quantity, recorded_at, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      orgId,
      body.space_id ?? null,
      body.event_type,
      quantity,
      now,
      eventHash
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
  } else if (body.event_type === "llm_tokens") {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "llm_tokens");
  } else if (body.event_type === "infra_credits") {
    await recordUsageEvent(c.env.QUOTA_CACHE, orgId, "infra_credits");
  }

  // Enqueue to BILLING_EVENTS for async usage metering
  await c.env.BILLING_EVENTS.send({
    type: "meter",
    org_id: orgId,
    space_id: body.space_id,
    event_type: body.event_type,
    quantity,
    event_id: id,
    event_hash: eventHash,
    recorded_at: now,
  });

  return c.json({ recorded: true, id }, 201);
});

// ── GET /internal/usage/llm-tokens/check ─────────────────────────────────────
// P0-3: NaelaoAgentDO's pre-run gate for a builder (owner/admin/editor/viewer) chatting with
// their own Space Assistant (never a project-scoped run, never a signed-in product end user —
// those have their own separate wallet/credit gates). Internal-only, HMAC-gated like every
// sibling /internal/* route in this file; the org to check is the verified x-naelao-tenant-id
// header, same posture as /billing/usage above.
app.use("/internal/usage/llm-tokens/check", requireInternalHmac((c) => (c as unknown as { env: BillingEnv }).env.PLATFORM_SECRET));
app.get("/internal/usage/llm-tokens/check", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT plan_tier FROM subscriptions WHERE org_id = ?"
  ).bind(orgId).first<{ plan_tier: string }>();
  const planTier = sub?.plan_tier ?? "free";

  const quota = await checkQuota(c.env.QUOTA_CACHE, c.env.PLATFORM_DB, orgId, "llm_tokens", planTier);
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

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT plan_tier FROM subscriptions WHERE org_id = ?"
  ).bind(orgId).first<{ plan_tier: string }>();
  const planTier = sub?.plan_tier ?? "free";

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

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT plan_tier FROM subscriptions WHERE org_id = ?"
  ).bind(orgId).first<{ plan_tier: string }>();
  const planTier = sub?.plan_tier ?? "free";

  const summary = await getUsageSummary(c.env.PLATFORM_DB, orgId, "llm_tokens", planTier);
  return c.json({ ...summary, plan_tier: planTier });
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
    "SELECT id, name, price_cents, currency, ls_variant_id, status FROM launchpad_products WHERE id = ? AND space_id = ?"
  ).bind(body.product_id, body.space_id).first<{
    id: string; name: string; price_cents: number; currency: string; ls_variant_id: string | null; status: string;
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

// ── Wallet Connect (payment_connections) — builder-owned payment accounts ────
registerWalletConnectionRoutes(app);

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
  fetch: app.fetch,
  queue: handleQueue as unknown as ExportedHandlerQueueHandler<BillingEnv>,
} satisfies ExportedHandler<BillingEnv>;
