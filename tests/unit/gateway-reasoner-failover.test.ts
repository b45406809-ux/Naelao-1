import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import { normalizeUniversalResponse, buildUniversalBody } from "../../workers/agents/src/shared/ai-client.js";
import type { ObserveSnapshot } from "../../workers/agents/src/script-engine/types.js";

// CF AI Gateway Universal Endpoint — model-driven provider routing (spec §15).
// The caller picks a model; inferProvider() maps it to the correct CF AI Gateway provider;
// buildUniversalBody() builds one provider entry; the gateway handles routing + retries.
// No hardcoded provider preference — Anthropic, Workers AI, and OpenAI are all supported.

const SNAPSHOT: ObserveSnapshot = { type: "compute", timestamp: Date.now(), fingerprint: "fp1" };
const DECIDE_INPUT = {
  goal: "test goal",
  level: "L2" as const,
  snapshot: SNAPSHOT,
  candidates: [],
  availableOperations: ["script.run"],
};

function anthropicGatewayResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ action: "answer", text: "anthropic answered" }) }],
    usage: { input_tokens: 120, output_tokens: 30 },
  }), { status: 200 });
}

function workersAiGatewayResponse(): Response {
  return new Response(JSON.stringify({
    result: { response: JSON.stringify({ action: "answer", text: "workers-ai answered" }), usage: { prompt_tokens: 80, completion_tokens: 25 } },
    success: true,
  }), { status: 200 });
}

function openAiGatewayResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ action: "answer", text: "openai answered" }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── inferProvider unit tests ──────────────────────────────────────────────────

// inferProvider is GONE. The AI REST API (2026-05-21 migration) takes one flat OpenAI-shaped
// body and selects the provider from the model string alone, so there is no per-provider request
// translation left to infer anything for.

describe("normalizeUniversalResponse", () => {
  it("extracts text + usage from Anthropic-format response", () => {
    const result = normalizeUniversalResponse({
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result.text).toBe("hello");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("extracts text + usage from Workers AI-format response (prompt_tokens → input_tokens)", () => {
    const result = normalizeUniversalResponse({
      result: { response: "hi there", usage: { prompt_tokens: 8, completion_tokens: 3 } },
      success: true,
    });
    expect(result.text).toBe("hi there");
    expect(result.usage).toEqual({ input_tokens: 8, output_tokens: 3 });
  });

  it("extracts text + usage from OpenAI-format response", () => {
    const result = normalizeUniversalResponse({
      choices: [{ message: { content: "hello openai" } }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });
    expect(result.text).toBe("hello openai");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 6 });
  });

  it("returns empty text and undefined usage for an unknown format", () => {
    const result = normalizeUniversalResponse({ unexpected: "shape" });
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
  });
});

// ── buildUniversalBody unit tests ─────────────────────────────────────────────

describe("buildUniversalBody — AI REST API shape", () => {
  const base = {
    apiKey: "k",
    gatewayOpts: { accountId: "acc", gatewayId: "gw" },
    ctx: { spaceId: "s1" },
  };

  it("emits one flat body, never the old ordered providers array", () => {
    const body = JSON.parse(buildUniversalBody({
      ...base,
      query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hi" }] },
    }));
    expect(body.providers).toBeUndefined();
    expect(body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("passes the model string through untouched — it alone selects the provider", () => {
    for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "anthropic/claude-sonnet-4", "openai/gpt-4.1"]) {
      const body = JSON.parse(buildUniversalBody({
        ...base,
        query: { model, max_tokens: 10, system: "s", messages: [] },
      }));
      expect(body.model).toBe(model);
    }
  });

  it("declares tools in the OpenAI function shape and forces a call", () => {
    const body = JSON.parse(buildUniversalBody({
      ...base,
      query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 10, system: "s", messages: [] },
      tools: [{ name: "answer", description: "Answer", parameters: { type: "object", properties: {} } }],
    }));
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "answer" } });
    expect(body.tool_choice).toBe("required");
  });

  it("fallbacks no longer ride in the body — the endpoint takes ONE model", () => {
    // Cross-provider failover moved to gateway-level configuration. The parameter is still
    // accepted so no call site silently changes meaning, but it must not appear on the wire.
    const body = JSON.parse(buildUniversalBody({
      ...base,
      query: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", max_tokens: 10, system: "s", messages: [] },
      fallbacks: [{ model: "anthropic/claude-sonnet-4", apiKey: "k2" }],
    }));
    expect(body.providers).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("claude-sonnet-4");
  });
});

describe("GatewayReasoner — AI REST API endpoint", () => {
  it("posts to the account's /ai/v1/chat/completions endpoint regardless of model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "real-account", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const calledUrl = String(fetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl).toBe("https://api.cloudflare.com/client/v4/accounts/real-account/ai/v1/chat/completions");
    // The dead gateway.ai.cloudflare.com host returns 401 now — it must never be used again.
    expect(calledUrl).not.toContain("gateway.ai.cloudflare.com");
    fetchSpy.mockRestore();
  });

  it("sends a flat body with the model, not a providers array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const bodyStr = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
    const body = JSON.parse(bodyStr) as { providers?: unknown; model: string };
    expect(body.providers).toBeUndefined();
    expect(typeof body.model).toBe("string");
    fetchSpy.mockRestore();
  });

  it("parses an Anthropic-format response and sets lastUsage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "anthropic answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 120, output_tokens: 30 });
  });

  it("parses a Workers AI-format response when a @cf/ model is used", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(workersAiGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1", model: "@cf/meta/llama-3.1-8b-instruct" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "workers-ai answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 80, output_tokens: 25 });
  });

  it("parses an OpenAI-format response when a gpt- model is used", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(openAiGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1", model: "gpt-4o" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "openai answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 50, output_tokens: 20 });
  });

  // 503 is transient, so the reasoner now waits and retries before giving up (see retryDelayMs) —
  // this asserts BOTH halves: that it really does retry, and that a persistent failure still
  // surfaces the provider's own words rather than looping forever.
  it("retries a persistent 503, then gives up with the gateway's own explanation", async () => {
    // A fresh Response per call: mockResolvedValue would return the SAME instance every time,
    // and a Response body can only be read once — the retry's own .text() read would find it
    // already consumed by the first attempt's read, which real fetch() never does.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("upstream unavailable", { status: 503 })
    );
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    // The gateway's own explanation is included — a bare status code is nearly undebuggable.
    expect(decision).toMatchObject({ action: "give_up" });
    expect((decision as { reason: string }).reason).toContain("503");
    expect((decision as { reason: string }).reason).toContain("upstream unavailable");
    expect(spy).toHaveBeenCalledTimes(3); // the original call plus MAX_TRANSIENT_RETRIES
  }, 20_000);

  it("gives up on a network error to the gateway", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gateway unreachable"));
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner gateway network error: gateway unreachable" });
  });
});
