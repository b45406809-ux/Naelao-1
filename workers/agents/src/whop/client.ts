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

  const resp = await fetch(`${WHOP_API_BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Whop API ${method} ${path} failed: HTTP ${resp.status} — ${text.slice(0, 300)}`);
  }

  return resp.json<T>();
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
  }
): Promise<WhopProduct> {
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

export async function registerAffiliate(
  config: WhopClientConfig,
  opts: {
    product_id: string;
    affiliate_company_id: string;  // Naelao's Whop company ID
    commission_percentage: number; // e.g. 20 for 20%
    idempotency_key: string;
  }
): Promise<WhopAffiliateRegistration> {
  return whopRequest<WhopAffiliateRegistration>(
    config,
    "POST",
    `/products/${opts.product_id}/affiliates`,
    {
      affiliate_company_id: opts.affiliate_company_id,
      commission_percentage: opts.commission_percentage,
    },
    opts.idempotency_key,
  );
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
