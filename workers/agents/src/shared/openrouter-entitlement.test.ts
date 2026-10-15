import { describe, expect, it, vi } from "vitest";
import { runOpenRouterEntitlementPreflight } from "./openrouter-entitlement.js";

describe("explicit OpenRouter entitlement preflight", () => {
  it("sends only the fixed one-token check to the exact selected model and key", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer space-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "vendor/model-a", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false,
      });
      expect(init?.redirect).toBe("error");
      return Response.json({ choices: [{ message: { content: "O" } }] });
    });
    await expect(runOpenRouterEntitlementPreflight({ apiKey: "space-key", modelId: "vendor/model-a", fetcher })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 403, 404])("does not treat provider status %s as entitlement", async (status) => {
    await expect(runOpenRouterEntitlementPreflight({ apiKey: "key", modelId: "vendor/model", fetcher: async () => new Response("{}", { status }) })).resolves.toEqual({ ok: false, reason: "provider_rejected" });
  });

  it("rejects malformed and oversized responses and never makes a request for an invalid model", async () => {
    const fetcher = vi.fn(async () => new Response("x".repeat(65 * 1024)));
    await expect(runOpenRouterEntitlementPreflight({ apiKey: "key", modelId: "vendor/model", fetcher })).resolves.toEqual({ ok: false, reason: "invalid_response" });
    await expect(runOpenRouterEntitlementPreflight({ apiKey: "key", modelId: "https://attacker.invalid", fetcher })).resolves.toEqual({ ok: false, reason: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
