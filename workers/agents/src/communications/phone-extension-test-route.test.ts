import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { app } from "../index.js";

const secret = "phone-test-route-secret";
const tenantId = "tenant-a";

function fixture() {
  const dispatch = vi.fn(async (request: Request) => Response.json({ forwarded: await request.json() }));
  const env = {
    PLATFORM_SECRET: secret,
    NAELAO_AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: dispatch }),
    },
  } as never;
  return { dispatch, env };
}

async function testRequest(body: Record<string, unknown>, token?: string, env?: never) {
  return app.request("/internal/phone-extension-test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": token ?? await mintInternalToken(secret, tenantId),
    },
    body: JSON.stringify(body),
  }, env ?? fixture().env);
}

describe("internal phone simulation route", () => {
  it("forwards only normalized call-start and DTMF inputs to the local SpaceDO simulator", async () => {
    const f = fixture();
    const start = await testRequest({ spaceId: "space-a", bindingId: "binding-a", eventType: "call.received" }, undefined, f.env);
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ forwarded: {
      spaceId: "space-a", bindingId: "binding-a", eventType: "call.received", simulation: true,
    } });
    const digits = await testRequest({ spaceId: "space-a", bindingId: "binding-a", eventType: "call.digits", digits: "1" }, undefined, f.env);
    expect(digits.status).toBe(200);
    expect(await digits.json()).toEqual({ forwarded: {
      spaceId: "space-a", bindingId: "binding-a", eventType: "call.digits", digits: "1", simulation: true,
    } });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed digits, extra fields and invalid internal authentication before dispatch", async () => {
    const f = fixture();
    const malformed = await testRequest({ spaceId: "space-a", bindingId: "binding-a", eventType: "call.digits", digits: "1#" }, undefined, f.env);
    expect(malformed.status).toBe(400);
    const extra = await testRequest({ spaceId: "space-a", bindingId: "binding-a", eventType: "call.received", caller: "+15555550100" }, undefined, f.env);
    expect(extra.status).toBe(400);
    const unauthorized = await testRequest({ spaceId: "space-a", bindingId: "binding-a", eventType: "call.received" }, "invalid", f.env);
    expect(unauthorized.status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
