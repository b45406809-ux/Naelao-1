import {
  badRequest,
  errorResponse,
  internalError,
  notFound,
  requestId,
  mintInternalToken,
  requireInternalHmac,
} from "@naelao/http";
// G-D05: Billing worker — Stripe webhooks, Lemon Squeezy webhooks, checkout, subscription sync
import { Hono } from "hono";
import { checkQuota, recordUsageEvent, invalidateQuotaCache } from "./quota.js";
import {
  createBillingPortalSession,
  createCheckoutSession,
  createCustomer,
  verifyStripeWebhook,
} from "./stripe.js";
import { handleLemonSqueezyWebhook } from "./lemon-squeezy.js";
import { createLsProductVariant, lsProductsConfig } from "./ls-products.js";

export interface BillingEnv {
  ENVIRONMENT: string;
  /** Shared inter-worker HMAC secret (mintInternalToken/requireInternalHmac, @naelao/http) —
   *  needed to call spaces worker's internal routes directly (bypassing naelao-router). */
  PLATFORM_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_GROWTH_PRICE_ID: string;
  STRIPE_BUSINESS_PRICE_ID: string;
  PLATFORM_DB: D1Database;
  QUOTA_CACHE: KVNamespace;
  BILLING_EVENTS: Queue;
  // Lemon Squeezy (primary billing provider — spec Appendix H / CLAUDE.md #9)
  LEMON_SQUEEZY_WEBHOOK_SECRET?: string;
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
  /** Platform fee on customer product sales, basis points. Default 500 (5%). */
  LAUNCHPAD_FEE_BPS?: string;
  // Service binding to agents worker — billing events wake the Space Assistant agent
  AGENTS_WORKER?: Fetcher;
  // Service binding to spaces worker — seat purchases activate the member in SpaceDO
  SPACES_WORKER?: Fetcher;
}

// ── Stripe event type stubs ───────────────────────────────────────────────────
interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  items: {
    data: Array<{
      price: {
        id: string;
        metadata: Record<string, string>;
        nickname?: string | null;
      };
    }>;
  };
  metadata: Record<string, string>;
}

interface StripeInvoice {
  id: string;
  customer: string;
  subscription?: string | null;
  amount_due: number;
  currency: string;
  status: string;
  period_start: number;
  period_end: number;
  paid: boolean;
  metadata: Record<string, string>;
}

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: StripeSubscription | StripeInvoice | Record<string, unknown>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a Stripe price ID to a Naelao plan tier. */
function priceToPlan(
  priceId: string,
  growthPriceId: string,
  businessPriceId: string
): string {
  if (priceId === growthPriceId) return "growth";
  if (priceId === businessPriceId) return "business";
  // Fall back to price metadata if we know it
  return "growth"; // safe default — actual tier resolved from metadata below
}

/** Unix epoch seconds → ISO 8601 string */
function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/** Get orgId for a Stripe customer from D1. */
async function orgForCustomer(
  db: D1Database,
  customerId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT org_id FROM subscriptions WHERE stripe_customer_id = ? LIMIT 1"
    )
    .bind(customerId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

// G-A11: Validate required secrets at startup
function validateEnv(env: BillingEnv): void {
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_GROWTH_PRICE_ID",
    "STRIPE_BUSINESS_PRICE_ID",
  ] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required secret: ${key}`);
  }
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
    `SELECT plan_tier, status, stripe_customer_id, stripe_subscription_id,
            current_period_start, current_period_end, cancel_at_period_end, trial_ends_at
     FROM subscriptions WHERE org_id = ?`
  )
    .bind(orgId)
    .first<{
      plan_tier: string;
      status: string;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
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
    cancel_url: string;
  }>();

  if (!body.plan || !body.success_url || !body.cancel_url) {
    throw badRequest("plan, success_url, and cancel_url are required");
  }
  if (body.plan !== "growth" && body.plan !== "business") {
    throw badRequest("plan must be 'growth' or 'business'");
  }

  const priceId =
    body.plan === "growth"
      ? c.env.STRIPE_GROWTH_PRICE_ID
      : c.env.STRIPE_BUSINESS_PRICE_ID;

  if (!priceId) {
    throw internalError(
      `STRIPE_${body.plan.toUpperCase()}_PRICE_ID is not configured`
    );
  }

  // Get or create stripe_customer_id
  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{ stripe_customer_id: string | null }>();

  let customerId = sub?.stripe_customer_id ?? null;

  if (!customerId) {
    // Look up the org owner email to pass to Stripe
    const org = await c.env.PLATFORM_DB.prepare(
      "SELECT u.email FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = ? LIMIT 1"
    )
      .bind(userId)
      .first<{ email: string }>();
    const email = org?.email ?? `org-${orgId}@placeholder.naelao.com`;

    const customer = await createCustomer(
      c.env.STRIPE_SECRET_KEY,
      email,
      orgId
    );
    customerId = customer.id;

    // Upsert subscription row with the new customer ID
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO subscriptions (id, org_id, plan_tier, status, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, 'free', 'active', ?, datetime('now'), datetime('now'))
       ON CONFLICT(org_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         updated_at = datetime('now')`
    )
      .bind(crypto.randomUUID(), orgId, customerId)
      .run();
  }

  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId,
    priceId,
    successUrl: body.success_url,
    cancelUrl: body.cancel_url,
    metadata: { org_id: orgId, plan: body.plan },
  });

  return c.json({ checkout_url: session.url });
});

// ── POST /billing/portal ──────────────────────────────────────────────────────
app.post("/billing/portal", async (c) => {
  const orgId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!orgId)
    return c.json(
      { error_code: "unauthorized", message: "Missing tenant" },
      401
    );

  const body = await c.req
    .json<{ return_url: string }>()
    .catch(() => ({ return_url: "" }));

  const sub = await c.env.PLATFORM_DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE org_id = ?"
  )
    .bind(orgId)
    .first<{ stripe_customer_id: string | null }>();

  const customerId = sub?.stripe_customer_id;
  if (!customerId) {
    throw notFound("Stripe customer");
  }

  const returnUrl =
    body.return_url || "https://app.naelao.com/dashboard/billing";

  const portal = await createBillingPortalSession(
    c.env.STRIPE_SECRET_KEY,
    customerId,
    returnUrl
  );

  return c.json({ portal_url: portal.url });
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
  }

  // Enqueue to BILLING_EVENTS for async Stripe metering
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

  // Without LS credentials (local/dev) return a deterministic placeholder so the flow is
  // testable end-to-end; production carries real store creds in Workers Secrets.
  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !product.ls_variant_id) {
    return c.json({
      checkout_url: `https://checkout.${"naelao.com"}/dev/${product.id}`,
      product: { id: product.id, name: product.name, price_cents: product.price_cents, currency: product.currency },
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
    spaceId: body.space_id,
    variantOrPriceId: product.ls_variant_id,
    ...(body.customer_email ? { customerEmail: body.customer_email } : {}),
    metadata: { product_id: product.id, fee_bps: String(feeBps) },
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

  if (!c.env.LEMON_SQUEEZY_API_KEY || !c.env.LEMON_SQUEEZY_STORE_ID || !cfg.lsVariantId) {
    return c.json({
      checkout_url: `https://checkout.naelao.com/dev/seat/${body.space_id}`,
      seat_price_cents: cfg.seatPriceCents, currency: cfg.currency, fee_bps: feeBps, dev: true,
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
    metadata: { kind: "seat", fee_bps: String(feeBps), ...(body.user_id ? { user_id: body.user_id } : {}) },
  });
  return c.json({ checkout_url: url, seat_price_cents: cfg.seatPriceCents, currency: cfg.currency, fee_bps: feeBps });
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
  });
});

// ── POST /webhooks/stripe ─────────────────────────────────────────────────────
// Unauthenticated — Stripe calls this directly
app.post("/webhooks/stripe", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";

  const valid = await verifyStripeWebhook(
    rawBody,
    signature,
    c.env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) {
    return c.json(
      { error_code: "forbidden", message: "Invalid webhook signature" },
      400
    );
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return c.json({ error_code: "bad_request", message: "Invalid JSON" }, 400);
  }

  const db = c.env.PLATFORM_DB;
  const kv = c.env.QUOTA_CACHE;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const stripe_sub = event.data.object as StripeSubscription;
      const orgId = await orgForCustomer(db, stripe_sub.customer);
      if (!orgId) {
        // Org not found — possibly created via checkout before our subscription row; log and ack
        console.warn(
          `[billing] subscription event for unknown customer: ${stripe_sub.customer}`
        );
        return c.json({ received: true });
      }

      // Determine plan tier from price metadata or price ID
      const priceItem = stripe_sub.items.data[0];
      let planTier = "growth"; // safe default
      if (priceItem) {
        const priceMeta = priceItem.price.metadata.plan_tier;
        if (priceMeta) {
          planTier = priceMeta;
        } else {
          // Fall back to matching against our configured price IDs
          planTier = priceToPlan(
            priceItem.price.id,
            c.env.STRIPE_GROWTH_PRICE_ID,
            c.env.STRIPE_BUSINESS_PRICE_ID
          );
        }
      }

      await db
        .prepare(
          `INSERT INTO subscriptions
             (id, org_id, plan_tier, status, stripe_subscription_id,
              current_period_start, current_period_end, cancel_at_period_end,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(org_id) DO UPDATE SET
             plan_tier               = excluded.plan_tier,
             status                  = excluded.status,
             stripe_subscription_id  = excluded.stripe_subscription_id,
             current_period_start    = excluded.current_period_start,
             current_period_end      = excluded.current_period_end,
             cancel_at_period_end    = excluded.cancel_at_period_end,
             updated_at              = datetime('now')`
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          planTier,
          stripe_sub.status,
          stripe_sub.id,
          epochToIso(stripe_sub.current_period_start),
          epochToIso(stripe_sub.current_period_end),
          stripe_sub.cancel_at_period_end ? 1 : 0
        )
        .run();

      // Invalidate quota cache so limits take effect immediately
      await invalidateQuotaCache(kv, orgId);
      break;
    }

    case "customer.subscription.deleted": {
      const stripe_sub = event.data.object as StripeSubscription;
      const orgId = await orgForCustomer(db, stripe_sub.customer);
      if (orgId) {
        await db
          .prepare(
            `UPDATE subscriptions
             SET plan_tier = 'free', status = 'cancelled', updated_at = datetime('now')
             WHERE org_id = ?`
          )
          .bind(orgId)
          .run();
        await invalidateQuotaCache(kv, orgId);
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as StripeInvoice;
      const orgId = await orgForCustomer(db, invoice.customer);
      if (!orgId) break;

      const invoiceId = crypto.randomUUID();
      const now = new Date().toISOString();

      await db
        .prepare(
          `INSERT INTO invoices
             (id, org_id, amount_cents, currency, status, stripe_invoice_id,
              period_start, period_end, paid_at, created_at)
           VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?)
           ON CONFLICT(stripe_invoice_id) DO UPDATE SET
             status  = 'paid',
             paid_at = excluded.paid_at`
        )
        .bind(
          invoiceId,
          orgId,
          invoice.amount_due,
          invoice.currency,
          invoice.id,
          epochToIso(invoice.period_start),
          epochToIso(invoice.period_end),
          now,
          now
        )
        .run();
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as StripeInvoice;
      const orgId = await orgForCustomer(db, invoice.customer);
      if (!orgId) break;

      const invoiceId = crypto.randomUUID();
      const now = new Date().toISOString();

      await db
        .prepare(
          `INSERT INTO invoices
             (id, org_id, amount_cents, currency, status, stripe_invoice_id,
              period_start, period_end, paid_at, created_at)
           VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, NULL, ?)
           ON CONFLICT(stripe_invoice_id) DO UPDATE SET
             status = 'failed'`
        )
        .bind(
          invoiceId,
          orgId,
          invoice.amount_due,
          invoice.currency,
          invoice.id,
          epochToIso(invoice.period_start),
          epochToIso(invoice.period_end),
          now
        )
        .run();

      // Enqueue dunning event for async handling (CF Workflows later)
      await c.env.BILLING_EVENTS.send({
        type: "dunning",
        org_id: orgId,
        invoice_id: invoice.id,
        amount_due: invoice.amount_due,
        currency: invoice.currency,
      });
      break;
    }

    default:
      // Acknowledge unhandled event types without error — Stripe retries on non-2xx
      console.log(`[billing] unhandled stripe event type: ${event.type}`);
  }

  // Always return 200 so Stripe doesn't retry
  return c.json({ received: true });
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
          // G-D07: Stripe Meter API call stub — sends usage to Stripe Billing meters
          // Real implementation will call POST /v1/billing/meter_events once price meters are configured
          console.log(
            `[billing/meter] org=${msg.org_id} event=${msg.event_type} qty=${msg.quantity} id=${msg.event_id} — metering intent logged`
          );
          // Future: stripeCall(env.STRIPE_SECRET_KEY, "POST", "/billing/meter_events", { ... })
          // and then update usage_events.stripe_meter_event_id in D1
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
