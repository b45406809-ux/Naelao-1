import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayReasoner } from "../../workers/agents/src/script-engine/reasoner.js";
import {
  isGoogleAiStudioModel,
  googleAiStudioGatewayUrl,
  googleAiStudioGatewayHeaders,
  canAuthenticateLlm,
  byokProviderForModel,
  BYOK_PROVIDER_KEY_FIELD,
} from "../../workers/agents/src/shared/ai-client.js";
import {
  ALLOWED_MODELS,
  MODEL_CONTEXT_WINDOWS,
  capabilityForModel,
  isValidReasoningLevel,
  DEFAULT_WORKING_MODEL,
} from "../../packages/billing-core/src/models.js";
import {
  MODEL_BENCHMARKS,
  validateModelBenchmarks,
  costRankForModel,
  benchmarkForModel,
} from "../../packages/billing-core/src/model-benchmarks.js";
import { effortLadderForModel, nativeReasoningForEffort } from "../../packages/billing-core/src/effort.js";
import { computeTokenCostMicro } from "../../packages/billing-core/src/index.js";
import type { ObserveSnapshot } from "../../workers/agents/src/script-engine/types.js";

// Google AI Studio (Gemini) is a genuinely different routing/auth path from every other model on
// this account: it never resolves through the account's own /ai/v1/chat/completions REST API
// (that endpoint only accepts third-party models under paid Unified Billing, which this account
// doesn't have — confirmed live against a real probe), it routes through the OLDER
// gateway.ai.cloudflare.com compat endpoint with a real BYOK Google key in a plain
// `Authorization: Bearer` header instead. These tests lock in the routing decision, the honest
// failure when the key is missing, and that the model is fully wired into the shared catalog
// (context window, reasoning capability, cost tier, effort ladder) the same way every other model
// is — not a special case bolted on the side.

const GOOGLE_KEY = "google-ai-studio-key-abc";
const AIG = "aig-token-xyz";
const GEMINI_FLASH = "google-ai-studio/gemini-flash-latest";

describe("byokProviderForModel (step 28 BYOK gate)", () => {
  it("maps a Gemini/Groq model to its canonical provider slug", () => {
    expect(byokProviderForModel("google-ai-studio/gemini-flash-latest")).toBe("google-ai-studio");
    expect(byokProviderForModel("groq/llama-3.3-70b-versatile")).toBe("groq");
  });
  it("returns null for a default @cf/ (Workers AI) model — so NO BYOK lookup happens for the common case", () => {
    expect(byokProviderForModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBeNull();
    expect(byokProviderForModel("claude-opus-4-8")).toBeNull();
  });
  it("has a GatewayOpts key field for each BYOK provider slug", () => {
    expect(BYOK_PROVIDER_KEY_FIELD["google-ai-studio"]).toBe("googleAiStudioApiKey");
    expect(BYOK_PROVIDER_KEY_FIELD["groq"]).toBe("groqApiKey");
  });
});

describe("isGoogleAiStudioModel", () => {
  it("true for a google-ai-studio/ prefixed model", () => {
    expect(isGoogleAiStudioModel("google-ai-studio/gemini-flash-latest")).toBe(true);
    expect(isGoogleAiStudioModel("google-ai-studio/gemini-pro-latest")).toBe(true);
  });
  it("false for every other provider's model string", () => {
    expect(isGoogleAiStudioModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(false);
    expect(isGoogleAiStudioModel("claude-sonnet-4-6")).toBe(false);
    expect(isGoogleAiStudioModel("")).toBe(false);
  });
});

describe("googleAiStudioGatewayUrl / Headers", () => {
  it("targets the compat endpoint on the OLDER gateway.ai.cloudflare.com host, not api.cloudflare.com", () => {
    expect(googleAiStudioGatewayUrl({ accountId: "acct-1", gatewayId: "naelao-gateway" })).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-1/naelao-gateway/compat/chat/completions"
    );
  });

  it("puts the real Google key in the plain Authorization header (BYOK), not a Cloudflare token", () => {
    const h = googleAiStudioGatewayHeaders({ accountId: "a", gatewayId: "g", googleAiStudioApiKey: GOOGLE_KEY });
    expect(h["authorization"]).toBe(`Bearer ${GOOGLE_KEY}`);
    expect(h["cf-aig-no-wholesale"]).toBe("true");
  });

  it("carries cf-aig-authorization when the gateway requires it (this account's does — confirmed live)", () => {
    const h = googleAiStudioGatewayHeaders({ accountId: "a", gatewayId: "g", googleAiStudioApiKey: GOOGLE_KEY, aigToken: AIG });
    expect(h["cf-aig-authorization"]).toBe(`Bearer ${AIG}`);
  });

  it("omits the Authorization header entirely when no Google key is configured (never sends 'Bearer undefined')", () => {
    const h = googleAiStudioGatewayHeaders({ accountId: "a", gatewayId: "g" });
    expect(h["authorization"]).toBeUndefined();
  });
});

describe("canAuthenticateLlm — model-aware for Gemini", () => {
  it("false for a Gemini model even with a Cloudflare token/aigToken and no Google key", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", cfApiToken: "cf-tok", aigToken: AIG }, "", GEMINI_FLASH)).toBe(false);
  });
  it("true for a Gemini model once a real googleAiStudioApiKey is set", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", googleAiStudioApiKey: GOOGLE_KEY }, "", GEMINI_FLASH)).toBe(true);
  });
  it("a non-Gemini model is unaffected by the new model param — old behavior preserved", () => {
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", aigToken: AIG }, "", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(true);
    expect(canAuthenticateLlm({ accountId: "a", gatewayId: "g", aigToken: AIG }, "")).toBe(true); // no model arg at all
  });
});

describe("GatewayReasoner — routes a Gemini model to the compat endpoint", () => {
  const SNAPSHOT: ObserveSnapshot = { type: "compute", timestamp: Date.now(), fingerprint: "fp1" };
  const input = { goal: "g", level: "L2" as const, snapshot: SNAPSHOT, candidates: [], availableOperations: ["Bash"] };
  afterEach(() => vi.restoreAllMocks());

  it("gives up honestly, naming the missing secret, when no Google key is configured — never fires a doomed request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: { accountId: "acct", gatewayId: "gw", aigToken: AIG }, // no googleAiStudioApiKey
      ctx: { spaceId: "s1" },
      model: GEMINI_FLASH,
    });
    const decision = await reasoner.decide(input);
    expect(decision.action).toBe("give_up");
    expect((decision as { reason: string }).reason).toContain("GOOGLE_AI_STUDIO_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hits the compat endpoint with the real key header once configured", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: "Bash", arguments: JSON.stringify({ command: "echo done", doing: "Answering" }) } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }), { status: 200 });
    }));
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: { accountId: "acct-1", gatewayId: "naelao-gateway", aigToken: AIG, googleAiStudioApiKey: GOOGLE_KEY },
      ctx: { spaceId: "s1" },
      model: GEMINI_FLASH,
    });
    const decision = await reasoner.decide(input);
    expect(decision).toMatchObject({ action: "run", name: "Bash", params: { commands: "echo done" } });
    expect(capturedUrl).toBe("https://gateway.ai.cloudflare.com/v1/acct-1/naelao-gateway/compat/chat/completions");
    expect(capturedHeaders["authorization"]).toBe(`Bearer ${GOOGLE_KEY}`);
    expect(capturedHeaders["cf-aig-authorization"]).toBe(`Bearer ${AIG}`);
    expect(capturedHeaders["cf-aig-no-wholesale"]).toBe("true");
  });

  it("a non-Gemini model on the SAME reasoner instance still uses the ordinary REST API endpoint (no cross-contamination)", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: "answer", text: "ok" }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }));
    const reasoner = new GatewayReasoner({
      apiKey: "",
      gateway: { accountId: "acct-1", gatewayId: "naelao-gateway", aigToken: AIG, googleAiStudioApiKey: GOOGLE_KEY },
      ctx: { spaceId: "s1" },
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    await reasoner.decide(input);
    expect(capturedUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions");
  });
});

describe("Gemini models are fully wired into the shared model catalog", () => {
  const GEMINI_IDS = [
    "google-ai-studio/gemini-flash-lite-latest",
    "google-ai-studio/gemini-flash-latest",
    "google-ai-studio/gemini-pro-latest",
  ] as const;

  it("all three are in ALLOWED_MODELS", () => {
    for (const id of GEMINI_IDS) expect(ALLOWED_MODELS).toContain(id);
  });

  it("all three have a real context window", () => {
    for (const id of GEMINI_IDS) expect(MODEL_CONTEXT_WINDOWS[id]).toBe(1_048_576);
  });

  it("Flash and Flash-Lite can fully disable thinking; Pro cannot", () => {
    expect(capabilityForModel("google-ai-studio/gemini-flash-lite-latest").reasoningLevels).toContain("none");
    expect(capabilityForModel("google-ai-studio/gemini-flash-latest").reasoningLevels).toContain("none");
    expect(capabilityForModel("google-ai-studio/gemini-pro-latest").reasoningLevels).not.toContain("none");
    expect(capabilityForModel("google-ai-studio/gemini-pro-latest").reasoningLevels[0]).toBe("low");
  });

  it("all three use the same reasoning_effort wire shape as gpt-oss/glm-5.2 — no new param shape needed", () => {
    for (const id of GEMINI_IDS) expect(capabilityForModel(id).reasoningParam).toBe("reasoning_effort");
  });

  it("isValidReasoningLevel rejects a level the model doesn't offer", () => {
    expect(isValidReasoningLevel("google-ai-studio/gemini-pro-latest", "none")).toBe(false);
    expect(isValidReasoningLevel("google-ai-studio/gemini-pro-latest", "high")).toBe(true);
  });

  it("does not change the platform default working model", () => {
    expect(DEFAULT_WORKING_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("every Gemini id has a MODEL_BENCHMARKS entry with real published pricing, cost-tier ranked cheapest to priciest", () => {
    expect(() => validateModelBenchmarks()).not.toThrow();
    for (const id of GEMINI_IDS) expect(MODEL_BENCHMARKS[id]).toBeDefined();
    expect(costRankForModel("google-ai-studio/gemini-flash-lite-latest")).toBeLessThan(costRankForModel("google-ai-studio/gemini-flash-latest"));
    expect(costRankForModel("google-ai-studio/gemini-flash-latest")).toBeLessThan(costRankForModel("google-ai-studio/gemini-pro-latest"));
    expect(benchmarkForModel("google-ai-studio/gemini-pro-latest")?.costBasis).toBe("measured");
  });

  it("computeTokenCostMicro bills Gemini calls at Google's real published rate, not the generic fallback", () => {
    const flashLite = computeTokenCostMicro(1_000_000, 1_000_000, "google-ai-studio/gemini-flash-lite-latest");
    expect(flashLite).toBe(Math.round((0.30 + 2.50) * 1_000_000));
    const fallback = computeTokenCostMicro(1_000_000, 1_000_000, "google-ai-studio/gemini-9.9-doesnt-exist");
    expect(fallback).not.toBe(flashLite); // an unknown Gemini id still falls to the generic default, not $0
  });

  it("effort ladders go 4-deep for every Gemini model (each has 3+ native reasoning levels)", () => {
    for (const id of GEMINI_IDS) expect(effortLadderForModel(id)).toHaveLength(4);
  });

  it("nativeReasoningForEffort maps Pro's 3-level ladder onto Effort's low/medium/high, saturating at high for ultra", () => {
    expect(nativeReasoningForEffort("google-ai-studio/gemini-pro-latest", "low")).toBe("low");
    expect(nativeReasoningForEffort("google-ai-studio/gemini-pro-latest", "medium")).toBe("medium");
    expect(nativeReasoningForEffort("google-ai-studio/gemini-pro-latest", "high")).toBe("high");
    expect(nativeReasoningForEffort("google-ai-studio/gemini-pro-latest", "ultra")).toBe("high");
  });
});
