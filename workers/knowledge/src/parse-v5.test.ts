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
});
