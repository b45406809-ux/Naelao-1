/**
 * Whop OAuth-delegated checkout for the BILLING worker — resolves a business's own vaulted
 * "Connect with Whop" OAuth token (catalogue.ts's WHOP.oauth, credential name
 * `WHOP_OAUTH_TOKENS`, scope='space') and uses it to create a checkout on THAT business's own
 * Whop company via `@naelao/billing-core`'s `whop-oauth-checkout.ts` — never Naelao's own key.
 *
 * Credential resolution mirrors `workers/mcp-hub/src/index.ts`'s `buildAuthHeaders`/
 * `resolveOAuthAccessToken` exactly (same short-lived HMAC credential-token scheme, same
 * proactive-refresh-via-agents-worker pattern) — duplicated here rather than shared, matching
 * this codebase's own established precedent of mcp-hub/credentials each holding their own copy
 * of `generateCredentialToken` rather than introducing a new cross-package dependency for one
 * function.
 *
 * Returns `null` (never throws) when the business has no Whop OAuth connection — callers fall
 * back to Lemon Squeezy / the dev placeholder, exactly like every other optional-provider
 * degradation in this file.
 */

import { mintInternalToken } from "@naelao/http";
import { createWhopOAuthCheckout } from "@naelao/billing-core";
import type { BillingEnv } from "./index.js";

const OAUTH_REFRESH_BUFFER_MS = 5 * 60_000;

interface OAuthCredentialValue {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

async function generateCredentialToken(platformSecret: string, spaceId: string, agentId: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${spaceId}:${agentId}:${timestamp}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},aid=${agentId},v1=${hex}`;
}

/** Resolve the plaintext WHOP_OAUTH_TOKENS credential for a business, refreshing it via the
 *  agents worker's `/internal/connectors/oauth/refresh` when near expiry. Returns null (not an
 *  error) whenever the credential doesn't exist, can't be resolved, or the worker isn't bound —
 *  "no Whop OAuth connection" is an expected, common state, not a failure. */
export async function getBusinessWhopOAuthToken(
  env: BillingEnv,
  spaceId: string,
  tenantId: string
): Promise<string | null> {
  if (!env.CREDENTIALS_WORKER) return null;
  try {
    const credToken = await generateCredentialToken(env.PLATFORM_SECRET, spaceId, "billing-worker");
    const resp = await env.CREDENTIALS_WORKER.fetch(
      new Request(`http://credentials/v1/internal/spaces/${spaceId}/credentials/${encodeURIComponent("WHOP_OAUTH_TOKENS")}/plaintext`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-credential-token": credToken },
      })
    );
    if (!resp.ok) return null;
    const { value } = await resp.json<{ value: string }>();
    let tokens: OAuthCredentialValue;
    try {
      tokens = JSON.parse(value) as OAuthCredentialValue;
    } catch {
      return null;
    }
    if (!tokens.access_token) return null;
    if (!tokens.expires_at || Date.now() < tokens.expires_at - OAUTH_REFRESH_BUFFER_MS) {
      return tokens.access_token;
    }
    if (!env.AGENTS_WORKER) return tokens.access_token; // stale but usable; the real call surfaces 401 if actually expired

    const internalToken = await mintInternalToken(env.PLATFORM_SECRET, tenantId);
    const refreshResp = await env.AGENTS_WORKER.fetch(
      new Request("http://agents-worker/internal/connectors/oauth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": internalToken },
        body: JSON.stringify({ space_id: spaceId, platform: "whop", refresh_token: tokens.refresh_token }),
      })
    );
    if (!refreshResp.ok) return tokens.access_token;
    const refreshed = await refreshResp.json<{ access_token?: string }>();
    return refreshed.access_token ?? tokens.access_token;
  } catch {
    return null;
  }
}

export interface WhopOAuthBillingCheckoutParams {
  spaceId: string;
  tenantId: string;
  title: string;
  priceCents: number;
  currency?: string;
  billingModel: "renewal" | "one_time";
  billingPeriodDays?: number;
  redirectUrl?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

/** Create a Whop OAuth-delegated checkout for a business, or return null (no connection / a
 *  transient failure) so the caller falls back to Lemon Squeezy / the dev placeholder. Mints a
 *  fresh Whop access_pass+plan+checkout_configuration on every call — a documented v1
 *  simplification (see whop-oauth-checkout.ts's header), not a caching gap that silently
 *  duplicates money-in state. */
export async function createBusinessWhopOAuthCheckout(
  env: BillingEnv,
  params: WhopOAuthBillingCheckoutParams
): Promise<{ checkout_url: string } | null> {
  const accessToken = await getBusinessWhopOAuthToken(env, params.spaceId, params.tenantId);
  if (!accessToken) return null;
  try {
    return await createWhopOAuthCheckout(accessToken, {
      title: params.title,
      priceCents: params.priceCents,
      billingModel: params.billingModel,
      ...(params.currency !== undefined ? { currency: params.currency } : {}),
      ...(params.billingPeriodDays !== undefined ? { billingPeriodDays: params.billingPeriodDays } : {}),
      ...(params.redirectUrl !== undefined ? { redirectUrl: params.redirectUrl } : {}),
      ...(params.customerEmail !== undefined ? { customerEmail: params.customerEmail } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });
  } catch (err) {
    console.warn(`[billing/whop-oauth] checkout failed for space=${params.spaceId}: ${(err as Error).message}`);
    return null;
  }
}
