import { describe, it, expect, vi } from "vitest";
import { webSearch } from "../../workers/agents/src/script-engine/prebuilt/web-search.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv, LlmCallerGateway } from "../../workers/agents/src/script-engine/types.js";

// §A1.25: grounded_answer is a DIFFERENT mechanism from the existing Tavily-backed search/fetch/
// extract ops — it calls the LLM directly with Anthropic's native web-search tool enabled (via
// CF AI Gateway's transparent proxy) rather than round-tripping through the knowledge worker.
// Its whole point is that this is a REAL, billed LLM call, not a free side-channel — these tests
// prove the usage it reports actually reaches ScriptRunResult.tokens_used (the field
// settleRunBilling reads), not just that the op itself returns a plausible-looking number.

function ctxWith(llmCaller?: LlmCallerGateway) {
  const env = {
    spaceId: "space1",
    agentId: "agent1",
    tenantId: "tenant1",
    scriptsBucket: {} as R2Bucket,
    ...(llmCaller ? { llmCaller } : {}),
  } as ScriptEngineEnv;
  return { env, run: vi.fn() };
}

describe("web-search.grounded_answer — direct op behavior", () => {
  it("reports unavailable (not a silent empty answer) when no llmCaller is configured", async () => {
    const ctx = ctxWith();
    const result = await webSearch.operations["grounded_answer"]!({ query: "what is the refund window?" }, ctx);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("unavailable") });
  });

  it("throws when 'query' is missing (consistent with the other ops' validation)", async () => {
    const callWithNativeWebSearch = vi.fn();
    const ctx = ctxWith({ callWithNativeWebSearch });
    await expect(webSearch.operations["grounded_answer"]!({}, ctx)).rejects.toThrow(/web search query must be 1\.\.1000 characters/);
    expect(callWithNativeWebSearch).not.toHaveBeenCalled();
  });

  it("defaults to a cheap model (claude-haiku) unless the caller specifies one", async () => {
    const callWithNativeWebSearch = vi.fn().mockResolvedValue({ answer: "a", citations: [], tokens_used: 10, input_tokens: 6, output_tokens: 4 });
    const ctx = ctxWith({ callWithNativeWebSearch });
    await webSearch.operations["grounded_answer"]!({ query: "q" }, ctx);
    expect(callWithNativeWebSearch).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001", query: "q" }));
  });

  it("honors an explicit model and max_results", async () => {
    const callWithNativeWebSearch = vi.fn().mockResolvedValue({ answer: "a", citations: [], tokens_used: 10, input_tokens: 6, output_tokens: 4 });
    const ctx = ctxWith({ callWithNativeWebSearch });
    await webSearch.operations["grounded_answer"]!({ query: "q", model: "claude-sonnet-5", max_results: 8 }, ctx);
    expect(callWithNativeWebSearch).toHaveBeenCalledWith({ model: "claude-sonnet-5", query: "q", maxUses: 8 });
  });

  it("returns the answer, citations, and usage breakdown to the caller", async () => {
    const callWithNativeWebSearch = vi.fn().mockResolvedValue({
      answer: "Refunds are accepted within 30 days.",
      citations: [{ title: "Refund Policy", url: "https://example.com/refunds" }],
      tokens_used: 42,
      input_tokens: 30,
      output_tokens: 12,
    });
    const ctx = ctxWith({ callWithNativeWebSearch });
    const result = await webSearch.operations["grounded_answer"]!({ query: "refund window?" }, ctx) as Record<string, unknown>;
    expect(result.answer).toBe("Refunds are accepted within 30 days.");
    expect(result.citations).toEqual([{ title: "Refund Policy", url: "https://example.com/refunds" }]);
    expect(result.usage).toEqual({ tokens_used: 42, input_tokens: 30, output_tokens: 12 });
  });
});

describe("ScriptToolSurface.run — grounded_answer's real LLM usage reaches ScriptRunResult (the billed field)", () => {
  it("folds output.usage into tokens_used/input_tokens/output_tokens, not just the op's own return value", async () => {
    const callWithNativeWebSearch = vi.fn().mockResolvedValue({
      answer: "It's sunny.", citations: [], tokens_used: 55, input_tokens: 40, output_tokens: 15,
    });
    const env = {
      spaceId: "space1", agentId: "agent1", tenantId: "tenant1",
      scriptsBucket: {} as R2Bucket, llmCaller: { callWithNativeWebSearch },
    } as ScriptEngineEnv;
    const tools = new ScriptToolSurface(env, ["web-search"]);
    const result = await tools.run("grounded_answer", { query: "weather?" });
    expect(result.ok).toBe(true);
    expect(result.tokens_used).toBe(55);
    expect(result.input_tokens).toBe(40);
    expect(result.output_tokens).toBe(15);
  });

  it("an ordinary prebuilt op with no LLM usage still reports tokens_used: 0 (no regression)", async () => {
    const env = {
      spaceId: "space1", agentId: "agent1", tenantId: "tenant1", scriptsBucket: {} as R2Bucket,
    } as ScriptEngineEnv;
    const tools = new ScriptToolSurface(env, ["web-search"]);
    const result = await tools.run("fetch_page", { url: "https://example.com" });
    expect(result.tokens_used).toBe(0);
    expect(result.input_tokens).toBeUndefined();
    expect(result.output_tokens).toBeUndefined();
  });
});
