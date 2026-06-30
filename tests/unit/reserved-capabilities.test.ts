import { describe, it, expect } from "vitest";
import {
  findReservedViolation,
  assertNoReservedViolation,
  RESERVED_CAPABILITIES,
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
});
