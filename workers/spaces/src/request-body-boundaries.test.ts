import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("Spaces Worker request boundary", () => {
  it("rejects streamed oversized input before route dispatch", async () => {
    const request = new Request("https://spaces.test/unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await worker.fetch(request, {} as never, {} as never);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error_code: "request_body_too_large",
      message: "Request body exceeds the 8 MiB limit",
    });
  });

  it.each([
    ["GET", "/spaces/product-space/me/export?end_user_id=victim"],
    ["DELETE", "/spaces/product-space/me/data?end_user_id=victim"],
  ] as const)("denies unauthenticated personal-data %s requests", async (method, path) => {
    const response = await worker.fetch(new Request(`https://spaces.test${path}`, { method }),
      { PLATFORM_SECRET: "test-secret" } as never, {} as never);
    expect(response.status).toBe(403);
  });
});
