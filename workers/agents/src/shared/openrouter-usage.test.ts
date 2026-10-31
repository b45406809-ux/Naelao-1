import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterGenerationUsage, readOpenRouterGenerationJson, retryDelayMs, verifyOpenRouterGenerationUsage } from "./openrouter-usage.js";

const now = Date.parse("2026-10-31T12:00:00.000Z");
const expected = { generationId: "gen-dec-123abc", model: "cloudflare/clef-flash", reservedAt: now - 2_000, maxTokens: 2_000, maxCredits: 500 };
const usage = { data: { id: expected.generationId, model: expected.model, tokens_prompt: 100, tokens_completion: 20, total_cost: 0.0012, created_at: new Date(now).toISOString() } };

describe("OpenRouter generation usage reconciliation", () => {
  it("accepts matching authenticated usage within reservation time and budget", () => {
    expect(verifyOpenRouterGenerationUsage(usage, expected, now)).toEqual({ generationId: expected.generationId, model: expected.model, inputTokens: 100, outputTokens: 20, costUsd: 0.0012, createdAt: now });
  });
  it.each([
    ["another generation", { ...usage, data: { ...usage.data, id: "gen-dec-other" } }],
    ["another model", { ...usage, data: { ...usage.data, model: "perplexity/pplx-decider-v1.2" } }],
    ["stale record", { ...usage, data: { ...usage.data, created_at: new Date(now - 120_000).toISOString() } }],
    ["future record", { ...usage, data: { ...usage.data, created_at: new Date(now + 120_000).toISOString() } }],
    ["over token bound", { ...usage, data: { ...usage.data, tokens_prompt: 2_000 } }],
    ["over cost bound", { ...usage, data: { ...usage.data, total_cost: 0.051 } }],
    ["missing cost", { ...usage, data: { ...usage.data, total_cost: undefined } }],
    ["negative usage", { ...usage, data: { ...usage.data, tokens_completion: -1 } }],
  ])("keeps %s usage unverifiable", (_name, value) => {
    expect(verifyOpenRouterGenerationUsage(value, expected, now)).toBeNull();
  });
  it("uses a bounded exponential retry and honors numeric or date Retry-After", () => {
    expect(retryDelayMs(null, 3, now)).toBe(120_000);
    expect(retryDelayMs("17", 1, now)).toBe(17_000);
    expect(retryDelayMs(new Date(now + 90_000).toUTCString(), 1, now)).toBe(90_000);
    expect(retryDelayMs("999999", 1, now)).toBe(60 * 60_000);
  });
  it("reads bounded JSON and rejects oversized or malformed provider metadata", async () => {
    await expect(readOpenRouterGenerationJson(Response.json(usage))).resolves.toEqual(usage);
    await expect(readOpenRouterGenerationJson(new Response("{"))).rejects.toThrow("openrouter_generation_response_invalid");
    await expect(readOpenRouterGenerationJson(new Response("x", { headers: { "content-length": "70000" } }))).rejects.toThrow("openrouter_generation_response_too_large");
  });
  it("queries only the authenticated OpenRouter generation endpoint and classifies retryable results", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://openrouter.ai/api/v1/generation");
      expect(url.searchParams.get("id")).toBe(expected.generationId);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-key");
      return Response.json(usage);
    });
    await expect(fetchOpenRouterGenerationUsage(fetcher as typeof fetch, "provider-key", expected, now)).resolves.toMatchObject({ state: "verified", usage: { generationId: expected.generationId, costUsd: 0.0012 } });
    const limited = await fetchOpenRouterGenerationUsage((async () => new Response("private error body", { status: 429, headers: { "retry-after": "42" } })) as typeof fetch, "provider-key", expected, now);
    expect(limited).toEqual({ state: "retry", reason: "generation_lookup_http_429", retryAfter: "42" });
    const unauthorized = await fetchOpenRouterGenerationUsage((async () => new Response("private error body", { status: 401 })) as typeof fetch, "provider-key", expected, now);
    expect(unauthorized).toEqual({ state: "review", reason: "generation_lookup_authorization_failed" });
    const mismatch = await fetchOpenRouterGenerationUsage((async () => Response.json({ ...usage, data: { ...usage.data, id: "gen-dec-other" } })) as typeof fetch, "provider-key", expected, now);
    expect(mismatch).toEqual({ state: "review", reason: "generation_receipt_unverifiable" });
  });
});
