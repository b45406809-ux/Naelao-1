/**
 * Whop platform-managed sub-merchant wallets — the business-bank-account rail that REPLACES the
 * Stripe/LS Wallet Connect rail entirely (see git history for the removed
 * wallet-connections.ts/wallet-checkout.ts/wallet-webhooks.ts — that was opt-in, builder-driven,
 * two-provider BYO custody; this is default, autonomous, one-provider platform custody).
 *
 * Model: Naelao holds ONE master Whop Platform account (`WHOP_PLATFORM_API_KEY`). Every business
 * created on Naelao (Launchpad or otherwise) auto-provisions an isolated Whop "company"
 * (sub-merchant) the moment it's created — no builder enrollment flow, no OAuth consent screen,
 * no bank/KYC details Naelao ever sees. Whop is the regulated payment facilitator that actually
 * custodies funds and runs KYC on payout destinations (bank/crypto/Venmo/CashApp, 241+
 * territories) — Naelao's integration surface is provisioning, balance/status reads, and
 * programmatic withdrawal requests only. This is the same custody boundary the removed Stripe
 * Connect rail had (Naelao never holds the money, never has debit capability), just mandatory
 * and automatic instead of opt-in.
 *
 * Fee model: Whop's own all-in cut (~6-7%: 2.7%+$0.30 card processing, +3% platform, +1-2%
 * payout) is deducted by Whop itself before funds reach the sub-merchant balance. Naelao's own
 * additional cut is collected via `transferPlatformFee` (a payment-split transfer out of the
 * sub-merchant's Whop balance into the platform's own Whop wallet), run on a schedule by the
 * billing worker — never per-transaction, to bound API call volume at scale.
 *
 * Endpoint shapes below follow Whop's documented "Platforms" API as of this build
 * (https://docs.whop.com/developer/platforms/enroll-sub-merchants,
 *  https://docs.whop.com/developer/platforms/collect-payments-for-connected-accounts). Whop's
 * public API evolves — verify field/path names against current docs before this handles real
 * production traffic, the same "verify before production" precedent already established by
 * `workers/connector-whop`'s own header comment and the `revenue-tracker` prebuilt elsewhere in
 * this repo for exactly this kind of live-API assumption.
 */

const WHOP_API = "https://api.whop.com";

async function whopRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const resp = await fetch(`${WHOP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!resp.ok) {
    const detail = typeof json === "object" && json !== null ? JSON.stringify(json) : text;
    throw new Error(`Whop ${method} ${path} failed: ${resp.status} ${detail}`.slice(0, 500));
  }
  return json as T;
}

export interface WhopSubMerchant {
  company_id: string;
  status: "pending" | "awaiting_kyc" | "active" | "error";
  /** Set only when Whop requires the owner to complete KYC before this connected account can
   *  receive transfers/payouts — present on a brand-new owner with no prior Whop account, absent
   *  on an owner who already has one (their existing company is enrolled directly, active
   *  immediately). Naelao must surface this link to the owner; it cannot be completed on their
   *  behalf. */
  onboarding_url?: string;
}

/**
 * Auto-provision an isolated Whop company ("connected account" in Whop's current terminology —
 * the Platforms API docs called this "sub-merchant" enrollment in an earlier version; same
 * mechanism, same invite-only access, name updated here to match). No consent screen, no OAuth —
 * the enrollment API creates the company directly under the platform account; it starts empty and
 * is funded entirely by that business's own future sales.
 *
 * IMPORTANT — enrollment creating the company record is NOT the same as being payout-ready: per
 * Whop's docs, a recipient with no existing Whop company must additionally complete an emailed
 * account-onboarding link (KYC verification) before the connected account can receive transfers.
 * The exact response field name for that link is unverified against live Whop docs (docs.whop.com
 * blocks unauthenticated fetches) — this checks a few plausible names defensively and degrades to
 * `status: 'active'` if none are present, matching this codebase's own "verify against real docs
 * before production" precedent (see revenue-tracker.ts's header). Confirm the real field name
 * once Platforms API access is granted, then narrow this to the one that's actually returned.
 */
export async function createSubMerchant(
  masterApiKey: string,
  params: { tenantId: string; businessId: string; ownerEmail: string; businessName: string }
): Promise<WhopSubMerchant> {
  const result = await whopRequest<{
    id?: string;
    status?: string;
    onboarding_url?: string;
    account_link?: string;
    verification_url?: string;
    requires_onboarding?: boolean;
  }>(
    masterApiKey,
    "POST",
    "/v5/platforms/sub_merchants",
    {
      name: params.businessName,
      owner_email: params.ownerEmail,
      metadata: { naelao_tenant_id: params.tenantId, naelao_business_id: params.businessId },
    }
  );
  if (!result.id) throw new Error("Whop sub-merchant creation returned no company id");

  const onboardingUrl = result.onboarding_url ?? result.account_link ?? result.verification_url;
  if (onboardingUrl) {
    return { company_id: result.id, status: "awaiting_kyc", onboarding_url: onboardingUrl };
  }
  if (result.requires_onboarding) {
    // Whop signaled onboarding is required but didn't include a link in this response —
    // surface the state honestly rather than fabricating a URL; a later status poll
    // (getCompanyStatus) may pick up the link once Whop issues it.
    return { company_id: result.id, status: "awaiting_kyc" };
  }
  return { company_id: result.id, status: (result.status as WhopSubMerchant["status"]) ?? "active" };
}

export interface WhopCompanyStatus {
  company_id: string;
  balance_cents: number;
  currency: string;
  status: "pending" | "awaiting_kyc" | "active" | "error";
  /** False while the owner still needs to complete Whop's KYC/onboarding link — the primary
   *  payout-readiness signal (mirrors Stripe Connect's own charges_enabled/payouts_enabled
   *  polling pattern this replaced), independent of whatever `status` string Whop returns. */
  payouts_enabled: boolean;
}

/** Live balance/status read for a sub-merchant company. Derives 'awaiting_kyc' from
 *  `payouts_enabled: false` when Whop's own status doesn't already say 'error' — this is more
 *  reliable than depending on an unverified onboarding-link field name (see createSubMerchant's
 *  header) since `payouts_enabled` is a plain boolean unlikely to have a naming ambiguity. */
export async function getCompanyStatus(masterApiKey: string, companyId: string): Promise<WhopCompanyStatus> {
  const result = await whopRequest<{
    id: string;
    balance?: number;
    balance_cents?: number;
    currency?: string;
    status?: string;
    payouts_enabled?: boolean;
  }>(masterApiKey, "GET", `/v5/platforms/sub_merchants/${encodeURIComponent(companyId)}`);
  const cents =
    typeof result.balance_cents === "number"
      ? result.balance_cents
      : typeof result.balance === "number"
        ? Math.round(result.balance * 100)
        : 0;
  const payoutsEnabled = result.payouts_enabled === true;
  const rawStatus = (result.status as WhopCompanyStatus["status"]) ?? "pending";
  const status: WhopCompanyStatus["status"] =
    rawStatus === "error" ? "error" : payoutsEnabled ? "active" : "awaiting_kyc";
  return {
    company_id: result.id,
    balance_cents: cents,
    currency: (result.currency ?? "usd").toUpperCase(),
    status,
    payouts_enabled: payoutsEnabled,
  };
}

export interface WhopCheckoutParams {
  companyId: string;
  productName: string;
  amountCents: number;
  currency?: string;
  customerEmail?: string;
  successUrl?: string;
  /** Naelao's platform cut, auto-split off this checkout via Whop's payment-splits mechanism
   *  (mirrors Stripe Connect's application_fee_amount) — settles to the platform's own Whop
   *  wallet at charge time, never a manual sweep. */
  platformFeeCents?: number;
  metadata?: Record<string, string>;
}

/** A checkout that settles directly into the business's own Whop sub-merchant balance. */
export async function createSubMerchantCheckout(
  masterApiKey: string,
  params: WhopCheckoutParams
): Promise<{ checkout_url: string }> {
  const result = await whopRequest<{ checkout_url?: string; url?: string }>(
    masterApiKey,
    "POST",
    `/v5/platforms/sub_merchants/${encodeURIComponent(params.companyId)}/checkout_links`,
    {
      product_name: params.productName,
      amount: params.amountCents,
      currency: (params.currency ?? "usd").toLowerCase(),
      ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      ...(params.successUrl ? { success_url: params.successUrl } : {}),
      ...(params.platformFeeCents && params.platformFeeCents > 0
        ? { platform_fee: params.platformFeeCents }
        : {}),
      metadata: params.metadata ?? {},
    }
  );
  const url = result.checkout_url ?? result.url;
  if (!url) throw new Error("Whop checkout link returned no url");
  return { checkout_url: url };
}

export interface WhopWithdrawal {
  withdrawal_id: string;
  status: string;
}

/** Programmatic payout (the autonomous "revenue out" call) — Whop routes funds to a destination
 *  (bank/crypto/Venmo/CashApp) it already verified when the destination was added. */
export async function createWithdrawal(
  masterApiKey: string,
  companyId: string,
  params: { destinationId: string; amountCents: number }
): Promise<WhopWithdrawal> {
  const result = await whopRequest<{ id?: string; status?: string }>(
    masterApiKey,
    "POST",
    `/v5/platforms/sub_merchants/${encodeURIComponent(companyId)}/withdrawals`,
    { destination_id: params.destinationId, amount: params.amountCents }
  );
  if (!result.id) throw new Error("Whop withdrawal returned no id");
  return { withdrawal_id: result.id, status: result.status ?? "pending" };
}

/** Transfer Naelao's own platform cut out of a sub-merchant's balance into the platform's own
 *  Whop wallet — run on a schedule (billing worker cron), not per-transaction. */
export async function transferPlatformFee(
  masterApiKey: string,
  companyId: string,
  amountCents: number
): Promise<{ transfer_id: string }> {
  const result = await whopRequest<{ id?: string }>(
    masterApiKey,
    "POST",
    `/v5/platforms/sub_merchants/${encodeURIComponent(companyId)}/transfers`,
    { amount: amountCents, destination: "platform" }
  );
  if (!result.id) throw new Error("Whop platform-fee transfer returned no id");
  return { transfer_id: result.id };
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whop-Signature header verification (HMAC-SHA256 of the raw body, hex-encoded). */
export async function verifyWhopWebhook(rawBody: string, headers: Headers, webhookSecret: string): Promise<boolean> {
  const header = headers.get("Whop-Signature") ?? headers.get("whop-signature");
  if (!header || !webhookSecret) return false;
  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  return timingSafeEqualHex(expected, header.toLowerCase());
}

export interface WhopWalletEvent {
  type: "revenue_received" | "payout_completed" | "payout_failed" | "unknown";
  companyId: string;
  amountCents: number;
  currency: string;
  /** The webhook envelope's own event id — dedupe key for wallet_transactions.provider_event_id. */
  providerEventId: string | null;
  /** `data.id` — for withdrawal.completed/withdrawal.failed this is Whop's own withdrawal id, the
   *  same value `createWithdrawal` returns as `withdrawal_id` and that gets stored on
   *  `whop_payout_requests.whop_withdrawal_id` at execution time. Lets the webhook handler reconcile
   *  against the request WE initiated instead of blindly appending a second ledger entry for a
   *  payout that's already recorded. Null for revenue events (no withdrawal involved). */
  externalId: string | null;
  raw: Record<string, unknown>;
}

const EVENT_MAP: Record<string, WhopWalletEvent["type"]> = {
  "payment.succeeded": "revenue_received",
  "order.completed": "revenue_received",
  "withdrawal.completed": "payout_completed",
  "withdrawal.failed": "payout_failed",
};

/** Parse a verified Whop webhook body into a normalized wallet event. Unmapped event types
 *  return `type: "unknown"` rather than throwing — the caller skips (200, no retry) rather than
 *  erroring on an event this build doesn't need to react to yet. */
export function parseWhopWalletEvent(rawBody: string): WhopWalletEvent {
  const event = JSON.parse(rawBody) as {
    id?: string;
    type?: string;
    data?: {
      id?: string;
      company_id?: string;
      final_amount?: number;
      amount?: number;
      currency?: string;
    };
  };
  const type = EVENT_MAP[event.type ?? ""] ?? "unknown";
  const data = event.data ?? {};
  const amountCents = Math.round(Number(data.final_amount ?? data.amount ?? 0)) || 0;
  return {
    type,
    companyId: String(data.company_id ?? ""),
    amountCents,
    currency: (data.currency ?? "usd").toUpperCase(),
    providerEventId: event.id ?? null,
    externalId: data.id ?? null,
    raw: event as Record<string, unknown>,
  };
}
