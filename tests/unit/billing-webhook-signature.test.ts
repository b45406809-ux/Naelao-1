import { describe, expect, it } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("Lemon Squeezy webhook ingress", () => {
  it("rejects an invalid signature before processing an event", async () => {
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/webhooks/lemon-squeezy", {
        method: "POST",
        headers: { "X-Signature": "not-a-real-signature" },
        body: JSON.stringify({ meta: { event_name: "order_created" }, data: {} }),
      }),
      {
        ENVIRONMENT: "test",
        LEMON_SQUEEZY_WEBHOOK_SECRET: "whsec_real",
      } as never,
      execCtx,
    );
    expect(res.status).toBe(401);
  });
});
