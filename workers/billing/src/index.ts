import {
  badRequest,
  errorResponse,
  internalError,
  notFound,
  requestId,
} from "@naelao/http";
// G-D05: Billing worker — Stripe webhooks, checkout, portal, subscription sync, quota enforcement
import { Hono } from "hono";
import { checkQuota, incrementUsage, invalidateQuotaCache } from "./quota.js";
import {
  createBillingPortalSession,
  createCheckoutSession,
  createCustomer,
  verifyStripeWebhook,
} from "./stripe.js";

export interface BillingEnv {
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_GROWTH_PRICE_ID: string;
  STRIPE_BUSINESS_PRICE_ID: string;
  PLATFORM_DB: D1Database;
  QUOTA_CACHE: KVNamespace;
  BILLING_EVENTS: Queue;
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
// Internal route — called by other workers via service binding
app.post("/billing/usage", async (c) => {
  const body = await c.req.json<{
    org_id: string;
    space_id?: string;
    event_type: string;
    quantity?: number;
  }>();

  if (!body.org_id || !body.event_type) {
    throw badRequest("org_id and event_type are required");
  }

  const quantity = body.quantity ?? 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert into D1 for authoritative accounting
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO usage_events (id, org_id, space_id, event_type, quantity, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.org_id,
      body.space_id ?? null,
      body.event_type,
      quantity,
      now
    )
    .run();

  // Increment KV quota counter for api_call events (for fast quota checks)
  if (body.event_type === "api_call") {
    await incrementUsage(c.env.QUOTA_CACHE, body.org_id, "api_calls", quantity);
  } else if (body.event_type === "kb_doc") {
    await incrementUsage(c.env.QUOTA_CACHE, body.org_id, "kb_docs", quantity);
  }

  // Enqueue to BILLING_EVENTS for async Stripe metering
  await c.env.BILLING_EVENTS.send({
    type: "meter",
    org_id: body.org_id,
    space_id: body.space_id,
    event_type: body.event_type,
    quantity,
    event_id: id,
    recorded_at: now,
  });

  return c.json({ recorded: true, id }, 201);
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
