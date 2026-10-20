import { describe, expect, it } from "vitest";
import { BrowserSessionDO } from "./BrowserSessionDO.js";

describe("BrowserSessionDO request body limit", () => {
  it("rejects an oversized streamed command before parsing or browser access", async () => {
    const instance = new BrowserSessionDO(
      { storage: {} } as never,
      { ENVIRONMENT: "test", PLATFORM_SECRET: "test" } as never
    );
    const response = await instance.fetch(
      new Request("http://browser/navigate", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error_code: "request_body_too_large",
    });
  });
});
