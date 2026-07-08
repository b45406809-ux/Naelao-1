import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import { normalizeUniversalResponse, buildUniversalBody, inferProvider } from "../../workers/agents/src/shared/ai-client.js";
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

describe("inferProvider", () => {
  it("maps @cf/ models to workers-ai", () => {
    expect(inferProvider("@cf/meta/llama-3.1-8b-instruct")).toBe("workers-ai");
    expect(inferProvider("@cf/baai/bge-base-en-v1.5")).toBe("workers-ai");
  });

  it("maps claude models to anthropic", () => {
    expect(inferProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(inferProvider("claude-sonnet-5")).toBe("anthropic");
  });

  it("maps gpt-/o1-/o3- models to openai", () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("o1-mini")).toBe("openai");
    expect(inferProvider("o3-mini")).toBe("openai");
  });

  it("defaults unknown models to anthropic", () => {
    expect(inferProvider("some-future-model")).toBe("anthropic");
  });
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

describe("buildUniversalBody", () => {
  const baseOpts = {
    apiKey: "sk-ant-test",
    gatewayOpts: { accountId: "acc-1", gatewayId: "gw-1" },
    ctx: { spaceId: "space-1" },
    query: { model: "claude-haiku-4-5-20251001", max_tokens: 1500, system: "sys", messages: [{ role: "user", content: "hi" }] },
  };

  it("builds a single Anthropic provider entry for a claude model", () => {
    const body = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: undefined }));
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].provider).toBe("anthropic");
    expect(body.providers[0].endpoint).toBe("messages");
    expect(body.providers[0].headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("builds a single Workers AI provider entry for a @cf/ model", () => {
    const body = JSON.parse(buildUniversalBody({
      ...baseOpts,
      cfApiToken: "cf-token-123",
      query: { ...baseOpts.query, model: "@cf/meta/llama-3.1-8b-instruct" },
    }));
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].provider).toBe("workers-ai");
    expect(body.providers[0].headers["Authorization"]).toBe("Bearer cf-token-123");
  });

  it("Workers AI query prepends system message to the messages array", () => {
    const body = JSON.parse(buildUniversalBody({
      ...baseOpts,
      cfApiToken: "tok",
      query: { ...baseOpts.query, model: "@cf/meta/llama-3.1-8b-instruct" },
    }));
    const msgs = body.providers[0].query.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("builds a single OpenAI provider entry for a gpt- model", () => {
    const body = JSON.parse(buildUniversalBody({
      ...baseOpts,
      cfApiToken: undefined,
      query: { ...baseOpts.query, model: "gpt-4o" },
    }));
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].provider).toBe("openai");
    expect(body.providers[0].headers["Authorization"]).toBe("Bearer sk-ant-test");
  });

  it("cfApiToken has no effect on provider count for non-workers-ai models", () => {
    const without = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: undefined }));
    const withTok = JSON.parse(buildUniversalBody({ ...baseOpts, cfApiToken: "cf-tok" }));
    expect(without.providers).toHaveLength(1);
    expect(withTok.providers).toHaveLength(1);
    expect(withTok.providers[0].provider).toBe("anthropic");
  });
});

// ── GatewayReasoner integration tests ────────────────────────────────────────

describe("GatewayReasoner — Universal Endpoint (always)", () => {
  it("always uses the Universal Endpoint URL (no /anthropic/ suffix regardless of model)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "real-account", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const calledUrl = String(fetchSpy.mock.calls[0]![0] as string);
    expect(calledUrl).toMatch(/\/v1\/real-account\/gw$/);
    expect(calledUrl).not.toContain("/anthropic/");
    fetchSpy.mockRestore();
  });

  it("sends a single provider entry for a claude model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicGatewayResponse());
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    await reasoner.decide(DECIDE_INPUT);
    const bodyStr = (fetchSpy.mock.calls[0]![1] as RequestInit).body as string;
    const body = JSON.parse(bodyStr) as { providers: Array<{ provider: string }> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe("anthropic");
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

  it("gives up when the gateway returns a non-2xx (all providers failed in gateway)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const reasoner = new GatewayReasoner({
      apiKey: "key",
      gateway: { accountId: "acc", gatewayId: "gw" },
      ctx: { spaceId: "s1" },
    });
    const decision = await reasoner.decide(DECIDE_INPUT);
    expect(decision).toEqual({ action: "give_up", reason: "reasoner gateway error 503" });
  });

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
