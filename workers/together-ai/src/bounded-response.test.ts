import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

describe("Together AI response limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps an oversized upstream error before returning a diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("provider detail", {
            status: 502,
            headers: { "content-length": String(8 * 1024 + 1) },
          })
      )
    );
    const response = await worker.fetch(
      new Request("https://together.test/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      {
        ENVIRONMENT: "test",
        TOGETHER_API_KEY: "test-key",
        TOGETHER_API_URL: "https://api.together.test/v1",
      }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("provider detail");
  });

  it("caps oversized successful JSON before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(16 * 1024 * 1024 + 1) },
          })
      )
    );
    const response = await worker.fetch(
      new Request("https://together.test/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      {
        ENVIRONMENT: "test",
        TOGETHER_API_KEY: "test-key",
        TOGETHER_API_URL: "https://api.together.test/v1",
      }
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("response_too_large");
  });
});
