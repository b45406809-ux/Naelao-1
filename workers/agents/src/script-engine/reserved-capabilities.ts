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

/**
 * True if a URL/host is an external payment processor (or Naelao's own LS). Used by the
 * mcp-connector to refuse registering a payment endpoint as a connector — money-in is reserved
 * to the prebuilt commerce script. Accepts a full URL or a bare hostname.
 */
export function isReservedPaymentHost(urlOrHost: string): boolean {
  let host = urlOrHost.toLowerCase();
  try {
    host = new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    // Not a full URL — treat the input as a host/substring.
  }
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
