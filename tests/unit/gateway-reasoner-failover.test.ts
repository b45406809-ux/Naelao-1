import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import { normalizeUniversalResponse, buildUniversalBody } from "../../workers/agents/src/shared/ai-client.js";
import type { ObserveSnapshot } from "../../workers/agents/src/script-engine/types.js";

// CF AI Gateway Universal Endpoint — cross-provider failover (spec §15 gap).
// The Universal Endpoint accepts a `providers` array in the request body; CF AI Gateway itself
// tries them in order and returns the first success in the provider's native response format. This
// is entirely different from the previous application-level AI-binding fallback that bypassed the
// gateway entirely. When CF_API_TOKEN is absent the gateway wires Anthropic-only (unchanged).

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
  // Workers AI native format returned by the Universal Endpoint when that provider fires.
  return new Response(JSON.stringify({
    result: { response: JSON.stringify({ action: "answer", text: "workers-ai answered" }), usage: { prompt_tokens: 80, completion_tokens: 25 } },
    success: true,
  }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── normalizeUniversalResponse unit tests ─────────────────────────────────────

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

  it("returns empty text and undefined usage for an unknown format", () => {
    const result = normalizeUniversalResponse({ unexpected: "shape" });
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
  });
});

// ── buildUniversalBody unit tests ─────────────────────────────────────────────

describe("buildUniversalBody", () => {
  const baseOpts = {
    apiKey: "sk-ant-test",
    gatewayOpts: { accountId: "acc-1", gatewayId: "gw-1" },
    ctx: { spaceId: "space-1" },
    query: { model: "claude-haiku-4-5-20251001", max_tokens: 1500, system: "sys", messages: [{ role: "user", content: "hi" }] },
  };

  it("includes only Anthropic provider when cfApiToken is absent", () => {
    const body = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: undefined }));
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].provider).toBe("anthropic");
  });

  it("adds Workers AI as second provider when cfApiToken is present", () => {
    const body = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: "cf-token-123" }));
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0].provider).toBe("anthropic");
    expect(body.providers[1].provider).toBe("workers-ai");
    expect(body.providers[1].headers["Authorization"]).toBe("Bearer cf-token-123");
  });

  it("Workers AI query includes system message first", () => {
    const body = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: "tok" }));
    const workersMsgs = body.providers[1].query.messages as Array<{ role: string; content: string }>;
    expect(workersMsgs[0]).toEqual({ role: "system", content: "sys" });
    expect(workersMsgs[1]).toEqual({ role: "user", content: "hi" });
  });
});

// ── GatewayReasoner integration tests ────────────────────────────────────────

describe("GatewayReasoner — Universal Endpoint (cfApiToken present)", () => {
  it("uses the Universal Endpoint URL (not the provider-specific /anthropic URL)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "real-account", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const calledUrl = String((fetchSpy.mock.calls[0]![0] as string));
    // Universal Endpoint has NO provider path suffix — just gateway.ai.cloudflare.com/v1/acc/gw
    expect(calledUrl).toMatch(/\/v1\/real-account\/gw$/);
    expect(calledUrl).not.toContain("/anthropic/");
    fetchSpy.mockRestore();
  });

  it("sends a providers array body with Anthropic first and Workers AI second", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const bodyStr = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
    const body = JSON.parse(bodyStr) as { providers: Array<{ provider: string }> };
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]!.provider).toBe("anthropic");
    expect(body.providers[1]!.provider).toBe("workers-ai");
    fetchSpy.mockRestore();
  });

  it("parses an Anthropic-format response and sets lastUsage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "anthropic answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 120, output_tokens: 30 });
  });

  it("parses a Workers AI-format response (CF AI Gateway routed to the fallback provider)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(workersAiGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "answer", text: "workers-ai answered" });
    expect(reasoner.lastUsage).toEqual({ input_tokens: 80, output_tokens: 25 });
  });

  it("gives up when the Universal Endpoint itself returns a non-2xx (both providers failed in gateway)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner gateway error 503" });
  });

  it("gives up on a network error to the Universal Endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gateway unreachable"));
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw", cfApiToken: "cf-tok" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner gateway network error: gateway unreachable" });
  });
});

describe("GatewayReasoner — provider-specific Anthropic path (no cfApiToken)", () => {
  it("uses the Anthropic-specific gateway URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "real-account", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const calledUrl = String(fetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl).toContain("/anthropic/v1/messages");
    fetchSpy.mockRestore();
  });

  it("gives up with a provider-error message on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "real-account", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner LLM error 429" });
  });

  it("falls through to direct Anthropic URL when accountId is placeholder", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "placeholder", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const calledUrl = String(fetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl).toBe("https://api.anthropic.com/v1/messages");
    fetchSpy.mockRestore();
  });
});
