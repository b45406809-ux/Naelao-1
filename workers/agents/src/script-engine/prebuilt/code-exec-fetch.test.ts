import { describe, expect, it } from "vitest";
import { readMarkdownFetchResponse } from "./code-exec.js";

describe("bounded Knowledge worker fetch responses", () => {
  it("accepts the bounded Markdown response contract", async () => {
    await expect(readMarkdownFetchResponse(Response.json({
      url: "https://example.com/guide",
      status: 200,
      content: "# Guide",
      content_type: "text/markdown",
      format: "markdown",
      truncated: false,
    }), "https://fallback.example/" )).resolves.toEqual({
      url: "https://example.com/guide",
      status: 200,
      content: "# Guide",
      content_type: "text/markdown",
      format: "markdown",
    });
  });

  it("rejects oversized service responses and oversized content fields", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    await expect(readMarkdownFetchResponse(new Response(body), "https://example.com/"))
      .rejects.toThrow("response_too_large");
    await expect(readMarkdownFetchResponse(Response.json({
      url: "https://example.com/",
      status: 200,
      content: "漢".repeat(34_000),
    }), "https://example.com/" )).rejects.toThrow("response shape is invalid");
  });

  it("rejects malformed successful payloads", async () => {
    await expect(readMarkdownFetchResponse(Response.json({ url: "https://example.com/", status: "200", content: [] }), "https://example.com/"))
      .rejects.toThrow("response shape is invalid");
  });

  it("bounds error messages returned by the service", async () => {
    await expect(readMarkdownFetchResponse(Response.json({ message: "x".repeat(500) }, { status: 503 }), "https://example.com/"))
      .rejects.toThrow(`fetch-md request failed (503): ${"x".repeat(300)}`);
  });
});
