// G-D03: Stripe API client — raw fetch(), no npm package, Workers-compatible

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Encode an object as application/x-www-form-urlencoded (Stripe's required format).
 * Handles nested objects via dot-notation (e.g. metadata[key]=value).
 */
export function encodeForm(
  params: Record<string, string | number | boolean | undefined>,
  prefix = ""
): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined) continue;
    const encodedKey = prefix
      ? `${encodeURIComponent(prefix)}[${encodeURIComponent(key)}]`
      : encodeURIComponent(key);
    parts.push(`${encodedKey}=${encodeURIComponent(String(val))}`);
  }
  return parts.join("&");
}

/**
 * Generic Stripe API call using fetch().
 * Authenticates via HTTP Basic Auth (secretKey as username, empty password).
 */
export async function stripeCall<T>(
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = `${STRIPE_API_BASE}${path}`;
  const credentials = btoa(`${secretKey}:`);

  const headers: HeadersInit = {
    Authorization: `Basic ${credentials}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  let body: string | undefined;
  let fullUrl = url;

  if (method === "GET" && params && Object.keys(params).length > 0) {
    const qs = encodeForm(params);
    fullUrl = `${url}?${qs}`;
  } else if (method !== "GET" && params) {
    body = encodeForm(params);
  }

  const response = await fetch(fullUrl, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  const json = (await response.json()) as {
    error?: { message: string; code?: string };
  } & T;

  if (!response.ok) {
    const errMsg =
      json.error?.message ?? `Stripe API error: ${response.status}`;
    throw new Error(errMsg);
  }

  return json;
}

/**
 * Verify a Stripe webhook signature.
 * Stripe sends: Stripe-Signature: t=<unix_ts>,v1=<hmac_hex>
 * We compute HMAC-SHA256 over "<timestamp>.<payload>" and compare with constant-time equality.
 */
export async function verifyStripeWebhook(
  payload: string,
  signature: string,
  webhookSecret: string
): Promise<boolean> {
  // Parse t= and v1= fields from signature header
  let timestamp = "";
  let v1 = "";
  for (const part of signature.split(",")) {
    if (part.startsWith("t=")) timestamp = part.slice(2);
    if (part.startsWith("v1=")) v1 = part.slice(3);
  }
  if (!timestamp || !v1) return false;

  // Reject timestamps older than 5 minutes (replay attack protection)
  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (Math.abs(now - ts) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  // Decode expected signature from hex
  const expectedBytes = hexToBytes(v1);

  // Verify using constant-time comparison
  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedBytes,
    enc.encode(signedPayload)
  );
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ── Customer operations ───────────────────────────────────────────────────────

export async function createCustomer(
  secretKey: string,
  email: string,
  orgId: string
): Promise<{ id: string }> {
  return stripeCall<{ id: string }>(secretKey, "POST", "/customers", {
    email,
    "metadata[org_id]": orgId,
  });
}

export interface CheckoutSessionParams {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export async function createCheckoutSession(
  secretKey: string,
  params: CheckoutSessionParams
): Promise<{ id: string; url: string }> {
  const flatParams: Record<string, string | number | boolean | undefined> = {
    customer: params.customerId,
    "line_items[0][price]": params.priceId,
    "line_items[0][quantity]": 1,
    mode: "subscription",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  };
  // Flatten metadata object into Stripe's bracket notation
  for (const [k, v] of Object.entries(params.metadata)) {
    flatParams[`metadata[${k}]`] = v;
  }
  return stripeCall<{ id: string; url: string }>(
    secretKey,
    "POST",
    "/checkout/sessions",
    flatParams
  );
}

export async function createBillingPortalSession(
  secretKey: string,
  customerId: string,
  returnUrl: string
): Promise<{ url: string }> {
  return stripeCall<{ url: string }>(
    secretKey,
    "POST",
    "/billing_portal/sessions",
    {
      customer: customerId,
      return_url: returnUrl,
    }
  );
}
