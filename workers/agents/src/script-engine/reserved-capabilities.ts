/**
 * Reserved capabilities — the "Naelao always gets its cut" guarantee.
 *
 * The script-first engine lets builders (and their agents) author ANY script for delivery,
 * marketing, storefront UI, email, automation, etc. There is exactly ONE class of capability
 * they may NOT self-author: **money-in**. All income — product checkouts, subscription
 * charges, payouts/wallets — must flow through Naelao's own Lemon Squeezy store via the
 * prebuilt `commerce` script, which bakes in the platform fee. If a builder could tell their
 * agent "write a script that charges my customers with my own Stripe key," Naelao would be
 * cut out of the revenue. So those capabilities are RESERVED: only Naelao-authored prebuilt
 * scripts provide them, and user-/agent-authored library scripts that attempt them are
 * rejected at script.create / script.update (authoring time) — fail-closed.
 *
 * This is enforced structurally, not by policy text: a stored script can only call prebuilt
 * operations that exist, and the reserved ops live only in the prebuilt catalogue. The guard
 * below additionally blocks user code that tries to reach an external payment processor
 * directly (bypassing the prebuilt op), and blocks declaring a reserved capability/domain.
 *
 * CF/Lemon Squeezy note: even Naelao's own processor (api.lemonsqueezy.com) is off-limits to
 * user scripts — only the prebuilt commerce op holds the LS credentials (Workers Secret), so
 * the fee + store association can never be stripped.
 *
 * HONEST SCOPE NOTE (appendix A1.9): the checks in this file — a substring host denylist plus
 * self-declared tags/domain — are DEFENSE IN DEPTH, not the primary control. A script author can
 * trivially dodge the substring match (string concatenation, base64/hex-encoding a host, a
 * connector to an as-yet-unlisted processor) and the tags/domain check only catches an agent
 * that HONESTLY states what it's building. The actual guarantee that money-in can't be routed
 * around Naelao is credential possession, not code inspection: only the `commerce` prebuilt
 * (`workers/agents/src/script-engine/prebuilt/commerce.ts`) ever holds the Lemon Squeezy store
 * API key (a Workers Secret on the billing worker, gated by `requireInternalHmac` — see F20 /
 * appendix A1.16.25), and no execution tier this engine grants a script exposes that secret to
 * script code. A script that fully evades this file's checks still cannot charge a customer
 * without Naelao's credentials — it can at most fail loudly against a real processor with no
 * key, which is a worse outcome for the builder than just using `commerce.checkout`. This file
 * exists to catch the honest/careless case early with a clear error, not to be an airtight
 * sandbox. It is also intentionally NOT trying to stop Model A (the connector/automation-layer
 * platforms — Gumroad, etc.): those are read-mostly, the CONNECTED PLATFORM processes the
 * payment on the builder's own account, and Naelao is paid for the labor, not a cut of that
 * sale — by design, not a gap in this guard (see `connectors/catalogue.ts`'s "MODEL A" note).
 *
 * Whop is a SPECIAL CASE, not Model A: it's now ALSO the reserved business-wallet payment rail
 * (every business's auto-provisioned sub-merchant wallet, `business-wallet.ts`), so
 * `api.whop.com` IS in the denylist below — a user-authored script may still read Whop data via
 * the read-only `connector-whop` MCP shim (list_memberships/list_payments/etc., unaffected by
 * this host check, which only fires against code/URLs a user script embeds directly), but it may
 * never construct its own fetch() to Whop's sub-merchant/withdrawal endpoints to move money
 * outside the reserved `business-wallet`/`payout` prebuilt ops.
 */

/** Capabilities only the Naelao prebuilt catalogue may provide. Money-in + payouts. */
export const RESERVED_CAPABILITIES: ReadonlySet<string> = new Set([
  "collect_payment",
  "create_checkout",
  "charge_customer",
  "subscription_charge",
  "issue_invoice",
  "payout",
  "wallet_withdraw",
  "wallet_balance",
  "connect_payment_account",
]);

/**
 * Hosts that mean "an external payment processor is being contacted directly." Includes
 * api.lemonsqueezy.com because only the prebuilt commerce op (which carries Naelao's store
 * credentials + fee) may talk to Lemon Squeezy — never a user script with its own key.
 */
const EXTERNAL_PAYMENT_HOSTS: readonly string[] = [
  "api.stripe.com",
  "stripe.com",
  "js.stripe.com",
  "checkout.stripe.com",
  "api.paypal.com",
  "paypal.com",
  "paypalobjects.com",
  "squareup.com",
  "connect.squareup.com",
  "api.paddle.com",
  "paddle.com",
  "checkout.paddle.com",
  "braintreegateway.com",
  "api.braintreegateway.com",
  "razorpay.com",
  "api.razorpay.com",
  "api.checkout.com",
  "gr4vy.com",
  "commerce.coinbase.com",
  "api.coinbase.com",
  // Naelao's own processor — reserved to the prebuilt commerce op:
  "api.lemonsqueezy.com",
  "lemonsqueezy.com",
  // Reserved to the business-wallet/payout prebuilt scripts (see module header) — a business's
  // sub-merchant wallet money movement, not the read-only connector-whop MCP shim.
  "api.whop.com",
];

/** SDK / package identifiers that pull in an external payment processor. */
const PAYMENT_SDK_PATTERNS: readonly RegExp[] = [
  /\bstripe\b/i,
  /@paypal\b/i,
  /\bpaypal-rest-sdk\b/i,
  /\bsquare\b\s*(sdk|client|payments)/i,
  /@paddle\b/i,
  /\bbraintree\b/i,
  /\brazorpay\b/i,
  /@lemonsqueezy\b/i,
  /\blemonsqueezy\b.*\b(api|client|checkout|key)\b/i,
];

export interface ReservedViolation {
  /** Machine code for the gate; surfaced to the agent so it self-corrects. */
  code:
    | "reserved_capability_declared"
    | "external_payment_host"
    | "payment_sdk_reference"
    | "reserved_payment_domain";
  message: string;
}

/**
 * Inspect a user-/agent-authored script being created or updated. Returns a violation if it
 * attempts a reserved (money-in) capability, or null when the script is allowed.
 *
 * Allowed: scripts that deliver products, send email, build storefronts, post marketing,
 * read orders, etc. Blocked: anything that constructs a charge/checkout/payout against an
 * external processor, references a payment SDK, or declares a reserved capability/domain.
 */
export function findReservedViolation(input: {
  code?: string | undefined;
  tags?: readonly string[] | undefined;
  domain?: string | undefined;
}): ReservedViolation | null {
  // 1. Declaring a reserved capability via tags (the agent's own statement of intent).
  for (const tag of input.tags ?? []) {
    if (RESERVED_CAPABILITIES.has(tag)) {
      return {
        code: "reserved_capability_declared",
        message:
          `Capability '${tag}' is reserved to Naelao's prebuilt commerce script. ` +
          `Use script.run("commerce.checkout", …) for any money-in — do not author a payment script. ` +
          `You can still author scripts for fulfilment, email, marketing, and storefront UI.`,
      };
    }
  }

  // 2. A money-in domain on a user script (the prebuilt commerce op is the only "payments" script).
  if (input.domain === "payments" || input.domain === "billing" || input.domain === "wallet") {
    return {
      code: "reserved_payment_domain",
      message:
        `Domain '${input.domain}' is reserved. Income must flow through the prebuilt ` +
        `commerce script so the platform fee and store association are preserved.`,
    };
  }

  const code = input.code ?? "";
  if (!code) return null;
  const lower = code.toLowerCase();

  // 3. Direct contact with an external payment processor (or Naelao's LS) from user code.
  for (const host of EXTERNAL_PAYMENT_HOSTS) {
    if (lower.includes(host)) {
      return {
        code: "external_payment_host",
        message:
          `This script contacts a payment processor (${host}) directly. Collecting money is ` +
          `reserved to Naelao's prebuilt commerce script (script.run("commerce.checkout", …)), ` +
          `which applies the platform fee. External payment endpoints are not permitted in ` +
          `authored scripts.`,
      };
    }
  }

  // 4. Payment SDK references.
  for (const pat of PAYMENT_SDK_PATTERNS) {
    if (pat.test(code)) {
      return {
        code: "payment_sdk_reference",
        message:
          `This script references a payment SDK. Use the prebuilt commerce script for all ` +
          `money-in; authored scripts may not embed external payment SDKs.`,
      };
    }
  }

  return null;
}

/** Bare IPv4, or bare/bracketed IPv6 — a legitimate payment processor is always DNS-named
 *  (api.stripe.com, api.lemonsqueezy.com, …); a connector/endpoint addressed by raw IP is
 *  already the kind of denylist bypass this module exists to catch (see the module-level
 *  defense-in-depth note above `isReservedPaymentHost`). Not exhaustive IP validation — just
 *  enough shape-matching to flag "this looks like an IP literal, not a hostname." */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_LITERAL = /^\[?[0-9a-f:]+\]?$/i;

function isIpLiteralHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (IPV4_LITERAL.test(bare)) return bare.split(".").every((o) => Number(o) <= 255);
  return bare.includes(":") && IPV6_LITERAL.test(host);
}

/**
 * True if a URL/host is an external payment processor (or Naelao's own LS). Used by the
 * mcp-connector to refuse registering a payment endpoint as a connector — money-in is reserved
 * to the prebuilt commerce script. Accepts a full URL or a bare hostname.
 *
 * Also rejects a bare IP-literal host outright (`isIpLiteralHost`) — the denylist below is a
 * substring/hostname match, which a raw IP trivially bypasses (see the defense-in-depth note
 * at the top of this file). A real payment processor is never addressed by IP, so this adds
 * coverage without touching the documented "Model A" carve-out (Whop/Gumroad/etc. are
 * DNS-named connector hosts, never IP literals, so they're unaffected).
 */
export function isReservedPaymentHost(urlOrHost: string): boolean {
  let host = urlOrHost.toLowerCase();
  try {
    host = new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    // Not a full URL — treat the input as a host/substring.
  }
  if (isIpLiteralHost(host)) return true;
  return EXTERNAL_PAYMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
}

/**
 * True if an MCP tool name looks like a money-in capability (charge/checkout/payout/etc.).
 * Used by the mcp-connector to refuse calling a connector tool that would collect money outside
 * Naelao's reserved commerce path. Matches the reserved capability set plus common verbs.
 */
export function isReservedToolName(toolName: string): boolean {
  const n = toolName.toLowerCase().replace(/[^a-z]/g, "_");
  for (const cap of RESERVED_CAPABILITIES) {
    if (n.includes(cap)) return true;
  }
  return /(create|start|new|capture|collect)_?(payment|checkout|charge|invoice|payout|subscription)/.test(n)
    || /\b(charge|payout|refund|withdraw)\b/.test(toolName.toLowerCase());
}

/** Throw a tagged error if the script violates the reserved-capability policy. */
export function assertNoReservedViolation(input: {
  name: string;
  code?: string | undefined;
  tags?: readonly string[] | undefined;
  domain?: string | undefined;
}): void {
  const v = findReservedViolation(input);
  if (v) {
    const err = new Error(`Reserved capability blocked for script '${input.name}': ${v.message}`);
    (err as unknown as Record<string, unknown>)["code"] = v.code;
    (err as unknown as Record<string, unknown>)["reserved"] = true;
    throw err;
  }
}
