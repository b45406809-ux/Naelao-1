/**
 * Whop API client for Naelao Whop Businesses template.
 *
 * Covers:
 * - Create company/product
 * - Register affiliate-of-record (Naelao earns commission on each business)
 * - Post content / manage community
 * - Pull revenue metrics
 *
 * All mutations are idempotent-safe: callers must supply an idempotency key
 * so that retries after Worker eviction don't double-execute.
 */

const WHOP_API_BASE = "https://api.whop.com/api/v2";

export interface WhopClientConfig {
  apiKey: string;        // Bearer token — never hardcoded, from Workers Secret
  companyId?: string;    // Set after company creation
}

export interface WhopProduct {
  id: string;
  name: string;
  slug: string;
  visibility: "visible" | "hidden" | "archived";
  created_at: number;
}

export interface WhopRevenue {
  total_revenue: number;
  revenue_last_24h: number;
  subscriber_count: number;
  active_members: number;
}

export interface WhopCommunityPost {
  id: string;
  content: string;
  created_at: number;
  likes: number;
  replies: number;
}

// Exponential backoff retry on transient failures (429 / 5xx). Mutations carry a
// deterministic Idempotency-Key, so a retry can never double-execute (§08 / WG-14).
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function whopRequest<T>(
  config: WhopClientConfig,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(`${WHOP_API_BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (resp.ok) {
      return resp.json<T>();
    }

    const text = await resp.text().catch(() => "");
    lastErr = `HTTP ${resp.status} — ${text.slice(0, 300)}`;

    // Retry only on rate-limit / server errors; other 4xx are terminal.
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`Whop API ${method} ${path} failed: ${lastErr}`);
    }
    await sleep(BACKOFF_MS[attempt] ?? 8000);
  }

  // Unreachable, but satisfies the type checker.
  throw new Error(`Whop API ${method} ${path} failed: ${lastErr}`);
}

// ── Company + Product ─────────────────────────────────────────────────────────

export async function createWhopProduct(
  config: WhopClientConfig,
  opts: {
    name: string;
    description: string;
    price_usd: number;
    billing_period: "monthly" | "one_time";
    idempotency_key: string;
    affiliate_percentage?: number; // enable the global affiliate program at creation
  }
): Promise<WhopProduct> {
  // Per Whop create-product API: affiliate commission can be set at creation via
  // global_affiliate_percentage / global_affiliate_status.
  // https://docs.whop.com/api-reference/products/create-product
  return whopRequest<WhopProduct>(
    config,
    "POST",
    "/products",
    {
      name: opts.name,
      description: opts.description,
      price: opts.price_usd,
      billing_period: opts.billing_period,
      visibility: "hidden", // always start hidden; publish only when ready
      ...(opts.affiliate_percentage !== undefined
        ? { global_affiliate_percentage: opts.affiliate_percentage, global_affiliate_status: "enabled" }
        : {}),
    },
    opts.idempotency_key,
  );
}

export async function getWhopProduct(
  config: WhopClientConfig,
  productId: string,
): Promise<WhopProduct> {
  return whopRequest<WhopProduct>(config, "GET", `/products/${productId}`);
}

export async function updateWhopProductVisibility(
  config: WhopClientConfig,
  productId: string,
  visibility: "visible" | "hidden" | "archived",
  idempotencyKey: string,
): Promise<WhopProduct> {
  return whopRequest<WhopProduct>(
    config, "PATCH", `/products/${productId}`,
    { visibility },
    idempotencyKey,
  );
}

// ── Affiliate-of-record registration ─────────────────────────────────────────

export interface WhopAffiliateRegistration {
  id: string;
  affiliate_company_id: string;
  product_id: string;
  commission_percentage: number;
  status: "active" | "pending" | "rejected";
}

// Whop affiliate-of-record is two steps per the docs: create an affiliate record,
// then add an override that defines the commission. Fields per:
// https://docs.whop.com/developer/guides/affiliates
// https://docs.whop.com/api-reference/affiliates/create-affiliate
export async function registerAffiliate(
  config: WhopClientConfig,
  opts: {
    product_id: string;
    affiliate_company_id: string;  // Naelao's Whop company ID
    commission_percentage: number; // e.g. 20 for 20%
    idempotency_key: string;
  }
): Promise<WhopAffiliateRegistration> {
  // 1. Create the affiliate record for Naelao's company on this product.
  const affiliate = await whopRequest<WhopAffiliateRegistration>(
    config,
    "POST",
    "/affiliates",
    {
      product_id: opts.product_id,
      affiliate_company_id: opts.affiliate_company_id,
    },
    opts.idempotency_key,
  );

  // 2. Add the commission override (rev-share % on all payments).
  await whopRequest<unknown>(
    config,
    "POST",
    `/affiliates/${affiliate.id}/overrides`,
    {
      override_type: "rev_share",
      commission_type: "percentage",
      commission_value: opts.commission_percentage,
      applies_to_payments: "all_payments",
      product_id: opts.product_id,
    },
    `${opts.idempotency_key}:override`,
  );

  return affiliate;
}

// ── Community posts ───────────────────────────────────────────────────────────

export async function postCommunityUpdate(
  config: WhopClientConfig,
  opts: {
    product_id: string;
    content: string;
    idempotency_key: string;
  }
): Promise<WhopCommunityPost> {
  return whopRequest<WhopCommunityPost>(
    config,
    "POST",
    `/products/${opts.product_id}/posts`,
    { content: opts.content },
    opts.idempotency_key,
  );
}

export async function getCommunityActivity(
  config: WhopClientConfig,
  productId: string,
  limit = 20,
): Promise<{ posts: WhopCommunityPost[]; total: number }> {
  return whopRequest<{ posts: WhopCommunityPost[]; total: number }>(
    config,
    "GET",
    `/products/${productId}/posts?limit=${limit}`,
  );
}

// ── Revenue metrics ───────────────────────────────────────────────────────────

export async function getRevenueMetrics(
  config: WhopClientConfig,
  productId: string,
): Promise<WhopRevenue> {
  return whopRequest<WhopRevenue>(
    config,
    "GET",
    `/products/${productId}/metrics`,
  );
}

// ── Observation snapshot for the script engine ───────────────────────────────

export interface WhopObserveSnapshot {
  timestamp: number;
  product_id: string;
  revenue: WhopRevenue | null;
  recent_posts: WhopCommunityPost[];
  product_visibility: string;
  fingerprint: string;
}

export async function observeWhopBusiness(
  config: WhopClientConfig,
  productId: string,
): Promise<WhopObserveSnapshot> {
  const [revenue, activity, product] = await Promise.allSettled([
    getRevenueMetrics(config, productId),
    getCommunityActivity(config, productId, 5),
    getWhopProduct(config, productId),
  ]);

  const revenueData = revenue.status === "fulfilled" ? revenue.value : null;
  const posts = activity.status === "fulfilled" ? activity.value.posts : [];
  const visibility = product.status === "fulfilled" ? product.value.visibility : "unknown";

  // Deterministic structural fingerprint (not content-dependent)
  const structural = `whop:${productId}:${visibility}:posts=${posts.length}:revenue=${revenueData?.subscriber_count ?? 0}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < structural.length; i++) {
    h ^= structural.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }

  return {
    timestamp: Date.now(),
    product_id: productId,
    revenue: revenueData,
    recent_posts: posts,
    product_visibility: visibility,
    fingerprint: h.toString(16),
  };
}
