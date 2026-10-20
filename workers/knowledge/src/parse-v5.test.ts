import { describe, expect, it, vi } from "vitest";
import { createParseV5Request } from "./parse-v5.js";

describe("createParseV5Request", () => {
  it("uploads bytes to parse-v5.0 and preserves table Markdown", async () => {
    const markdown = "| Col A | Col B |\n| --- | --- |\n| one | two |";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ markdown }), { status: 200 }));
    await expect(createParseV5Request(new TextEncoder().encode("pdf"), "application/pdf", { COHERE_API_KEY: "secret" }, fetcher))
      .resolves.toBe(markdown);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("content-type");
    expect((init.body as FormData).get("model")).toBe("parse-v5.0");
    expect((init.body as FormData).get("output_format")).toBe("markdown");
  });

  it("rejects a provider response that exceeds the extraction result budget", async () => {
    const response = new Response("{}");
    response.headers.set("content-length", String(16 * 1024 * 1024 + 1));
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", { COHERE_API_KEY: "secret" }, fetcher))
      .rejects.toThrow("Cohere Parse returned an invalid or oversized response");
  });

  it("bounds upload bytes and extracted Markdown before returning it", async () => {
    const fetcher = vi.fn();
    await expect(createParseV5Request(new Uint8Array(10 * 1024 * 1024 + 1), "application/pdf", { COHERE_API_KEY: "secret" }, fetcher))
      .rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();

    const oversized = new Response(JSON.stringify({ markdown: "x".repeat(1_048_577) }));
    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", { COHERE_API_KEY: "secret" }, vi.fn().mockResolvedValue(oversized)))
      .rejects.toMatchObject({ status: 413 });
  });

  it("sends a request timeout and sanitizes network, malformed-shape, and provider failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("secret network detail"));
    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", { COHERE_API_KEY: "secret" }, fetcher))
      .rejects.toMatchObject({ status: 502, message: "Cohere Parse request failed or timed out" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });

    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", { COHERE_API_KEY: "secret" }, vi.fn().mockResolvedValue(new Response("null"))))
      .rejects.toMatchObject({ status: 502 });
    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", { COHERE_API_KEY: "secret" }, vi.fn().mockResolvedValue(new Response("{}", { status: 503 }))))
      .rejects.toMatchObject({ status: 502 });
  });

  it("requires a configured key and a nonempty document", async () => {
    const fetcher = vi.fn();
    await expect(createParseV5Request(new Uint8Array([1]), "application/pdf", {}, fetcher))
      .rejects.toMatchObject({ status: 503 });
    await expect(createParseV5Request(new Uint8Array(), "application/pdf", { COHERE_API_KEY: "secret" }, fetcher))
      .rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
