import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

describe("Billing Worker request boundary", () => {
  it("rejects a streamed body over 4 MiB before routing", async () => {
    const request = new Request("https://billing.test/unknown", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await worker.fetch(request, {} as never, {} as never);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error_code: "request_body_too_large",
    });
  });

  it.each([
    ["settle", "/billing/business-wallet/settle", { space_id: "space-a", amount_cents: 500, type: "revenue", source: "sale" }],
    ["withdraw", "/billing/business-wallet/withdraw", { space_id: "space-a", amount_cents: 500, requested_by: "assistant" }],
  ])("requires a tenant HMAC before forwarding wallet %s", async (_name, path, body) => {
    let forwarded = 0;
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-secret",
      SPACES_WORKER: { fetch: async () => { forwarded++; return Response.json({ ok: true }); } },
    };
    const makeRequest = async (token?: string) => new Request(`https://billing.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant-a",
        ...(token ? { "x-naelao-internal-token": token } : {}),
      },
      body: JSON.stringify(body),
    });

    const unsigned = await worker.fetch(await makeRequest(), env as never, {} as never);
    expect(unsigned.status).toBe(403);
    expect(forwarded).toBe(0);

    const signed = await worker.fetch(await makeRequest(await mintInternalToken("test-secret", "tenant-a")), env as never, {} as never);
    expect(signed.status).toBe(200);
    expect(forwarded).toBe(1);
  });
});
