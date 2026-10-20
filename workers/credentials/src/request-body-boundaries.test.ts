import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("Credentials Worker request boundary", () => {
  it("rejects a streamed body over 1 MiB before routing", async () => {
    const request = new Request("https://credentials.test/unknown", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
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
});
