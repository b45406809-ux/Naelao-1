/**
 * business-wallet — the autonomous business-bank-account rail (Whop sub-merchant wallets). Tier
 * 2, reserved: these operations are exactly the "wallet_balance"/"wallet_withdraw"/"payout"
 * capabilities `reserved-capabilities.ts` blocks user-authored scripts from replicating — only
 * this Naelao-authored prebuilt may call them, exactly like `commerce` is the only path to
 * money-in.
 *
 * This is the money-side counterpart to the `wallet` prebuilt (which is a DIFFERENT thing — a
 * Naelao-held stored-value balance for paying Naelao's OWN metered platform costs; see that
 * file's header). This wallet IS the business's own revenue: money in from Whop's own
 * storefront/checkout and connected 3rd-party platforms, expenses out for the business's own
 * operating costs, owner payouts on request. Every business gets one auto-provisioned the moment
 * it's created — no builder/end-user action, no API keys to configure.
 *
 * Scope: a business's wallet is SPACE-scoped (the whole business's bank account), not
 * project-scoped like the Naelao-cost wallet — a business has exactly one, backing its
 * `kind='business_wallet'` project (see packages/events/src/business-feature-kinds.ts).
 *
 * Operations:
 *   business_wallet.balance()                                    → { status, balance_cents, currency }
 *   business_wallet.history(limit?)                               → recent wallet_transactions
 *   business_wallet.list_destinations()                           → payout destinations on file
 *   business_wallet.add_destination(type, label, details)         → vault a new payout destination
 *   business_wallet.request_payout(destination_id, amount_cents, note?) → request a payout
 *   business_wallet.list_payouts()                                → payout request history
 *
 * The FIRST payout to a new destination always requires the owner to click a one-time emailed
 * approval link (safety invariant — never a silent first payout); subsequent payouts to an
 * already-verified destination execute directly from `request_payout` itself.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken, readBoundedResponseJson, readBoundedResponseText } from "@naelao/http";

async function billingCall(
  ctx: PrebuiltOpContext,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.env.billingWorker) throw new Error("business-wallet unavailable: billing worker binding not configured");
  const resp = await ctx.env.billingWorker.fetch(
    new Request(`http://billing-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": ctx.env.tenantId,
        "x-naelao-user-id": "assistant",
        "x-naelao-role": "admin",
        "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  if (!resp.ok) throw new Error(`business-wallet ${path} failed: ${resp.status} ${(await readBoundedResponseText(resp, 8 * 1024).catch(() => "")).slice(0, 300)}`);
  return readBoundedResponseJson(resp, 2 * 1024 * 1024);
}

export const businessWallet: PrebuiltScript = {
  name: "business-wallet",
  description:
    "Check this business's Whop sub-merchant wallet balance/history, manage payout destinations, " +
    "and request owner payouts. This IS the business's bank account — revenue from sales settles " +
    "here automatically; nothing here requires the owner's personal bank/card details up front.",
  domain: "commerce",
  requires_tier: 2,
  operations: {
    "business_wallet.balance": async (_a, c) =>
      billingCall(c, `/billing/whop-wallet/balance?space_id=${encodeURIComponent(c.env.spaceId)}`),

    "business_wallet.history": async (a, c) => {
      const limit = typeof a["limit"] === "number" ? a["limit"] : 50;
      return billingCall(c, `/billing/whop-wallet/transactions?space_id=${encodeURIComponent(c.env.spaceId)}&limit=${limit}`);
    },

    "business_wallet.list_destinations": async (_a, c) =>
      billingCall(c, `/billing/whop-wallet/destinations?space_id=${encodeURIComponent(c.env.spaceId)}`),

    "business_wallet.add_destination": async (a, c) => {
      if (!a["type"] || !a["label"] || !a["details"]) {
        throw new Error("add_destination requires type, label, and details");
      }
      return billingCall(c, "/billing/whop-wallet/destinations", "POST", {
        space_id: c.env.spaceId,
        type: a["type"],
        label: a["label"],
        details: a["details"],
      });
    },

    "business_wallet.request_payout": async (a, c) => {
      if (!a["destination_id"] || typeof a["amount_cents"] !== "number" || a["amount_cents"] <= 0) {
        throw new Error("request_payout requires destination_id and a positive amount_cents");
      }
      // Reserve enforcement is performed by the authoritative SpaceDO before any provider-side
      // payout: the business always retains 1,000 credits ($10) for autonomous operations.
      return billingCall(c, "/billing/business-wallet/withdraw", "POST", {
        space_id: c.env.spaceId,
        destination_id: a["destination_id"],
        amount_cents: a["amount_cents"],
        note: a["note"] ?? null,
        requested_by: "assistant",
      });
    },

    "business_wallet.list_payouts": async (_a, c) =>
      billingCall(c, `/billing/whop-wallet/payouts?space_id=${encodeURIComponent(c.env.spaceId)}`),
  },
};
