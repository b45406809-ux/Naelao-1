import { describe, expect, it } from "vitest";
import { readBoundedProviderJson } from "./bounded-provider-json.js";

describe("provider metadata JSON bounds", () => {
  it("parses a bounded object response", async () => {
    await expect(
      readBoundedProviderJson(Response.json({ ok: true }), 32)
    ).resolves.toEqual({ ok: true });
  });

  it("rejects declared and streamed responses over the byte ceiling", async () => {
    const declared = new Response("{}", {
      headers: { "content-length": "100" },
    });
    await expect(readBoundedProviderJson(declared, 8)).rejects.toThrow(
      "provider_metadata_too_large"
    );
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"x":'));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      })
    );
    await expect(readBoundedProviderJson(streamed, 8)).rejects.toThrow(
      "provider_metadata_too_large"
    );
  });

  it("rejects invalid JSON and non-object responses", async () => {
    await expect(
      readBoundedProviderJson(new Response("not json"), 32)
    ).rejects.toThrow("provider_metadata_invalid_json");
    await expect(
      readBoundedProviderJson(Response.json([1]), 32)
    ).rejects.toThrow("provider_metadata_invalid_json");
  });
});
