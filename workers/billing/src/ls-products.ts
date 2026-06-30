/**
 * Lemon Squeezy product + variant provisioning (auto-create-on-publish).
 *
 * When a builder publishes a product for the first time (status → "published",
 * ls_variant_id IS NULL), we create a matching LS product + default variant in
 * Naelao's store so buyers can immediately checkout without a manual LS step.
 *
 * API: https://docs.lemonsqueezy.com/api/products and /variants (JSON:API format).
 * Pure module (no cloudflare:workers import) — unit-testable.
 */

const LS_API = "https://api.lemonsqueezy.com/v1";

export interface LsProductsConfig {
  apiKey: string;
  storeId: string;
}

export interface LsVariantResult {
  lsProductId: string;
  lsVariantId: string;
}

interface LsApiResponse {
  data: { id: string; type: string };
  errors?: Array<{ status: string; title: string; detail?: string }>;
}

async function lsPost(apiKey: string, path: string, body: unknown): Promise<LsApiResponse> {
  const resp = await fetch(`${LS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json<LsApiResponse>();
  if (!resp.ok || json.errors?.length) {
    const detail = json.errors?.map((e) => e.detail ?? e.title).join("; ") ?? `HTTP ${resp.status}`;
    throw new Error(`LS API ${path} failed: ${detail}`);
  }
  return json;
}

/**
 * Create a Lemon Squeezy product + default variant for a published Naelao product.
 * Returns the LS product id + variant id to store on the launchpad_products row.
 */
export async function createLsProductVariant(
  cfg: LsProductsConfig,
  product: {
    name: string;
    description?: string;
    price_cents: number;
    kind: "one_time" | "subscription";
  }
): Promise<LsVariantResult> {
  // Step 1 — create the product in Naelao's LS store.
  const productResp = await lsPost(cfg.apiKey, "/products", {
    data: {
      type: "products",
      attributes: {
        name: product.name,
        ...(product.description ? { description: product.description } : {}),
      },
      relationships: {
        store: { data: { type: "stores", id: cfg.storeId } },
      },
    },
  });
  const lsProductId = productResp.data.id;

  // Step 2 — create the default variant with correct pricing + billing interval.
  const isSubscription = product.kind === "subscription";
  const variantResp = await lsPost(cfg.apiKey, "/variants", {
    data: {
      type: "variants",
      attributes: {
        name: "Default",
        price: product.price_cents,
        is_subscription: isSubscription,
        ...(isSubscription ? { interval: "month", interval_count: 1 } : {}),
      },
      relationships: {
        product: { data: { type: "products", id: lsProductId } },
      },
    },
  });
  const lsVariantId = variantResp.data.id;

  return { lsProductId, lsVariantId };
}

/** Resolve config from env; null when deploy-time LS secrets are absent (dev path). */
export function lsProductsConfig(env: {
  LEMON_SQUEEZY_API_KEY?: string;
  LEMON_SQUEEZY_STORE_ID?: string;
}): LsProductsConfig | null {
  if (!env.LEMON_SQUEEZY_API_KEY || !env.LEMON_SQUEEZY_STORE_ID) return null;
  return { apiKey: env.LEMON_SQUEEZY_API_KEY, storeId: env.LEMON_SQUEEZY_STORE_ID };
}
