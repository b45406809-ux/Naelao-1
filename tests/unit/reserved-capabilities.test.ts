import { describe, it, expect } from "vitest";
import {
  findReservedViolation,
  assertNoReservedViolation,
  RESERVED_CAPABILITIES,
  isReservedPaymentHost,
  isReservedToolName,
} from "../../workers/agents/src/script-engine/reserved-capabilities.js";

// The "Naelao always gets its cut" guarantee: builders/agents may author any script EXCEPT
// money-in. These tests lock the fail-closed behaviour of the authoring-time guard.

describe("reserved-capability guard (income-wallet protection)", () => {
  it("blocks a script that hits Stripe directly", () => {
    const v = findReservedViolation({
      code: `export default async function(p){ return fetch("https://api.stripe.com/v1/charges", {method:"POST"}); }`,
      domain: "api",
    });
    expect(v?.code).toBe("external_payment_host");
  });

  it("blocks Naelao's own Lemon Squeezy endpoint from user scripts (only prebuilt commerce may call it)", () => {
    const v = findReservedViolation({
      code: `await fetch("https://api.lemonsqueezy.com/v1/checkouts", { headers: { Authorization: "Bearer "+myKey }})`,
      domain: "api",
    });
    expect(v?.code).toBe("external_payment_host");
  });

  it("blocks a payment SDK reference", () => {
    const v = findReservedViolation({ code: `import Stripe from "stripe"; const s = new Stripe(key);` });
    expect(v?.code).toBe("payment_sdk_reference");
  });

  it("blocks declaring a reserved capability via tags", () => {
    const v = findReservedViolation({ tags: ["collect_payment"], code: "noop()" });
    expect(v?.code).toBe("reserved_capability_declared");
  });

  it("blocks a reserved money-in domain", () => {
    const v = findReservedViolation({ domain: "payments", code: "noop()" });
    expect(v?.code).toBe("reserved_payment_domain");
  });

  it("ALLOWS a legitimate fulfilment script (delivers a product, no money-in)", () => {
    const v = findReservedViolation({
      code: `export default async function({orderId}, ctx){ const f = await ctx.run("file_read",{key:"products/ebook.pdf"}); return ctx.run("notifications.email",{to:"buyer",attachment:f}); }`,
      domain: "comms",
      tags: ["fulfilment", "delivery"],
    });
    expect(v).toBeNull();
  });

  it("ALLOWS a marketing script that merely mentions the word payment in copy", () => {
    const v = findReservedViolation({
      code: `export default async function(){ return "Your payment was received — thank you!"; }`,
      domain: "comms",
    });
    expect(v).toBeNull();
  });

  it("assertNoReservedViolation throws with a tagged error", () => {
    try {
      assertNoReservedViolation({ name: "rogue-charge", code: `fetch("https://paypal.com/charge")` });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Record<string, unknown>)["reserved"]).toBe(true);
      expect((err as Record<string, unknown>)["code"]).toBe("external_payment_host");
    }
  });

  it("the reserved set covers checkout, charge, payout, and wallet", () => {
    for (const cap of ["create_checkout", "charge_customer", "payout", "wallet_withdraw"]) {
      expect(RESERVED_CAPABILITIES.has(cap)).toBe(true);
    }
  });

  // ── Connector-layer guards: an MCP connector may not be a payment processor, nor may a
  //    connector tool collect money. Income stays on the reserved commerce path.
  describe("mcp-connector reserved guards", () => {
    it("blocks registering a payment processor as a connector (full URL)", () => {
      expect(isReservedPaymentHost("https://api.stripe.com/v1")).toBe(true);
      expect(isReservedPaymentHost("https://checkout.paddle.com")).toBe(true);
      expect(isReservedPaymentHost("https://api.lemonsqueezy.com")).toBe(true);
    });

    it("blocks payment hosts on subdomains", () => {
      expect(isReservedPaymentHost("https://foo.stripe.com/x")).toBe(true);
    });

    it("allows a legitimate read-only platform connector (Beehiiv, Cal.com)", () => {
      expect(isReservedPaymentHost("https://api.beehiiv.com/v2")).toBe(false);
      expect(isReservedPaymentHost("https://api.cal.com")).toBe(false);
    });

    // Whop is a SPECIAL CASE (not Model A): it's now ALSO the reserved business-wallet payment
    // rail (every business's auto-provisioned sub-merchant wallet), so a user-authored script
    // may not construct its own fetch() to Whop directly — the read-only connector-whop MCP shim
    // (list_memberships/list_payments/etc.) is unaffected, since this host check only fires
    // against code/URLs a user script embeds itself, not the platform's own MCP shim.
    it("blocks Whop directly (now the reserved business-wallet payment rail)", () => {
      expect(isReservedPaymentHost("https://api.whop.com/graphql")).toBe(true);
      expect(isReservedPaymentHost("https://api.whop.com/v2")).toBe(true);
    });

    it("blocks calling a money-in tool name", () => {
      expect(isReservedToolName("create_checkout")).toBe(true);
      expect(isReservedToolName("charge_customer")).toBe(true);
      expect(isReservedToolName("issue_payout")).toBe(true);
      expect(isReservedToolName("collectPayment")).toBe(true);
    });

    it("allows a normal connector tool name", () => {
      expect(isReservedToolName("list_orders")).toBe(false);
      expect(isReservedToolName("get_member")).toBe(false);
      expect(isReservedToolName("post_announcement")).toBe(false);
    });

    // Appendix A1.9 honest-scope note: EXTERNAL_PAYMENT_HOSTS is a hostname/substring match, so
    // a bare IP literal trivially bypasses it — a real payment processor is always DNS-named,
    // so isReservedPaymentHost now rejects IP literals outright as an extra (still
    // defense-in-depth, not airtight) layer.
    it("rejects a bare IPv4 literal host (denylist bypass attempt)", () => {
      expect(isReservedPaymentHost("http://151.101.1.1/v1/charges")).toBe(true);
      expect(isReservedPaymentHost("151.101.1.1")).toBe(true);
    });

    it("rejects a bracketed IPv6 literal host", () => {
      expect(isReservedPaymentHost("http://[2606:4700::1]/v1/charges")).toBe(true);
    });

    it("does not misclassify a normal versioned hostname-like string as an IP literal", () => {
      // Sanity: a legitimate read-only connector host must not accidentally trip the IP-literal
      // check (Whop itself is deliberately reserved now — see the dedicated test above).
      expect(isReservedPaymentHost("https://api.beehiiv.com/v2")).toBe(false);
    });
  });
});
