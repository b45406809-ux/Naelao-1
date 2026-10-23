/**
 * wallet (user-directed feature — Launchpad Wallet) — Tier 2.
 *
 * Lets an agent/Space Assistant check and top up a business's own stored-value balance
 * (a project flagged kind='wallet', SpaceDO's wallet_ledger — see SpaceDO.ts's "Launchpad
 * Wallet" section for the ledger implementation).
 *
 * SCOPE, READ THIS BEFORE EXTENDING: the wallet is an INTERNAL, Naelao-held ledger, funded via
 * a fixed-price Lemon Squeezy checkout (same "pick a pre-configured pack" shape as commerce
 * checkouts) and drawn down for NAELAO'S OWN metered platform costs. It is NOT, and is not meant
 * to become, a payment rail that pays a third party (Whop, Shopify, Stripe, PayPal...) on a
 * business's behalf — Lemon Squeezy has no API for funding an arbitrary outbound payment to a
 * vendor, and actually building that (a virtual card / ACH-push / money-transmission capability)
 * is a real regulatory undertaking (money-transmitter licensing, PCI scope) this build does not
 * attempt. The "cut Naelao gets" this feature supports is: a business that uses the Naelao
 * wallet for its own platform spend has no separate payment credential to configure; a business
 * that instead connects its OWN Stripe/Whop/Shopify key (check_bypass detects this) is a signal
 * for the assistant to have an honest conversation about it — never a hard block coded here.
 *
 * Operations:
 *   wallet.balance()                        → { balance_cents, currency }
 *   wallet.fund(topup_id, customer_email?)  → { checkout_url }               (money-in)
 *   wallet.history(limit?)                  → recent ledger entries
 *   wallet.check_bypass()                   → { using_own_payment_method, matched_providers }
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";

// Credential names a business might register for its OWN payment method instead of using the
// Naelao wallet. Deliberately a small, explicit allowlist (not a heuristic/regex over arbitrary
// names) — a false positive here would incorrectly flag an unrelated credential as a "bypass."
const THIRD_PARTY_PAYMENT_CREDENTIAL_NAMES = [
  "stripe_api_key",
  "shopify_api_key",
  "shopify_access_token",
  "paypal_api_key",
];

function requireProjectId(ctx: PrebuiltOpContext, args: Record<string, unknown>): string {
  const projectId = (args["project_id"] as string | undefined) ?? ctx.env.projectId;
  if (!projectId) throw new Error("wallet ops require a project-scoped run (or an explicit project_id)");
  return projectId;
}

async function spacesGet(ctx: PrebuiltOpContext, path: string): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("wallet unavailable: spaces worker binding not configured");
  const resp = await ctx.env.spacesWorker.fetch(
    new Request(`http://spaces-worker${path}`, {
      headers: {
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
    })
  );
  if (!resp.ok) throw new Error(`wallet read ${path} failed: ${resp.status}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

async function billingPost(ctx: PrebuiltOpContext, path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.billingWorker) throw new Error("wallet unavailable: billing worker binding not configured");
  const resp = await ctx.env.billingWorker.fetch(
    new Request(`http://billing-worker${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
      body: JSON.stringify(body),
    })
  );
  if (!resp.ok) throw new Error(`wallet ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

export const wallet: PrebuiltScript = {
  name: "wallet",
  description:
    "Check and top up this business's Naelao wallet balance (a Naelao-held stored-value ledger " +
    "used to pay for Naelao platform costs — not a rail for paying third parties like Whop or " +
    "Shopify). Also detects when a business has connected its own payment credential instead of " +
    "using the wallet.",
  domain: "api",
  requires_tier: 2,
  operations: {
    // async: requireProjectId's validation throw must surface as a rejected promise (matching
    // PrebuiltOp's Promise<unknown> contract), not a synchronous throw from a non-async arrow fn.
    "wallet.balance": async (a, c) =>
      spacesGet(c, `/spaces/${c.env.spaceId}/projects/${requireProjectId(c, a)}/wallet/balance`),

    "wallet.history": async (a, c) => {
      const limit = typeof a["limit"] === "number" ? a["limit"] : 50;
      return spacesGet(c, `/spaces/${c.env.spaceId}/projects/${requireProjectId(c, a)}/wallet/history?limit=${limit}`);
    },

    // Money-in: returns a Naelao-store Lemon Squeezy checkout URL for a pre-configured top-up
    // pack (productConfig.pricingConfig.walletTopups) — never an arbitrary custom amount.
    "wallet.fund": async (a, c) =>
      billingPost(c, "/internal/wallet-topups/checkout", {
        business_space_id: c.env.spaceId,
        project_id: requireProjectId(c, a),
        topup_id: a["topup_id"],
        ...(a["customer_email"] ? { customer_email: a["customer_email"] } : {}),
      }),

    // Detection only — reports what it found. It is deliberately the CALLER's job (the
    // assistant's own judgment / a builder-authored no-code trigger on wallet.bypass_detected)
    // to decide what to say or do about it, never a hardcoded gate here.
    "wallet.check_bypass": async (_a, c) => {
      if (!c.env.credentialsWorker) {
        return { using_own_payment_method: false, matched_providers: [], checked: false };
      }
      const resp = await c.env.credentialsWorker.fetch(
        new Request(`http://credentials-worker/spaces/${c.env.spaceId}/credentials`, {
          headers: {
            "x-naelao-tenant-id": c.env.tenantId,
            "x-naelao-internal-token": await mintInternalToken(c.env.platformSecret ?? "", c.env.tenantId),
          },
        })
      );
      if (!resp.ok) return { using_own_payment_method: false, matched_providers: [], checked: false };
      const { credentials } = await resp.json<{ credentials: Array<{ name: string }> }>();
      const matched = credentials
        .map((cred) => cred.name)
        .filter((name) => THIRD_PARTY_PAYMENT_CREDENTIAL_NAMES.includes(name));
      return { using_own_payment_method: matched.length > 0, matched_providers: matched, checked: true };
    },
  },
};
