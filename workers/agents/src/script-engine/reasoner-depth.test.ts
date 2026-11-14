import { describe, expect, it, vi } from "vitest";
import { GatewayReasoner, modelForDelegationDepth, preferredLanguageContext } from "./reasoner.js";
import { runScriptLoop } from "./loop.js";

describe("delegation-depth model tiering", () => {
  it("physically clamps depth 3 to the free edge model", () => {
    expect(modelForDelegationDepth(3, "anthropic/claude-opus-4-1")).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(modelForDelegationDepth(2)).toBe("groq/llama-3.3-70b-versatile");
  });
});

describe("saved language preference context", () => {
  it("defers to an explicit current-turn language request and preserves code-switching", () => {
    const context = preferredLanguageContext("fr-CA");
    expect(context?.preferred_language).toBe("fr-CA");
    expect(context?.preferred_language_rule).toContain("An explicit language request in the current message wins");
    expect(context?.preferred_language_rule).toContain("Preserve mixed-language and code-switched input");
  });

  it("omits a preference when unset", () => {
    expect(preferredLanguageContext()).toBeUndefined();
  });
});

describe("tenant suspension in durable agent loops", () => {
  it("stops before observing or searching when the tenant was suspended after admission", async () => {
    const tools = { find: vi.fn() };
    const reasoner = { decide: vi.fn() };
    const result = await runScriptLoop({} as never, tools as never, reasoner as never, [], {
      goal: "continue the task",
      shouldStopForTenant: async () => true,
    });

    expect(result.result?.error).toBe("tenant_suspended");
    expect(tools.find).not.toHaveBeenCalled();
    expect(reasoner.decide).not.toHaveBeenCalled();
  });

  it("rechecks after planning and blocks the tool if suspension lands during model reasoning", async () => {
    let checks = 0;
    const tools = {
      find: vi.fn(async () => []),
      availableOperations: () => [],
      disclosureGroups: () => [],
      activeCatalog: async () => [],
      resolveOperationAlias: (name: string, params: Record<string, unknown>) => ({ name, params }),
      run: vi.fn(),
    };
    const reasoner = { decide: vi.fn(async () => ({ action: "run", name: "conversation.search", params: { query: "older messages" } })) };
    const result = await runScriptLoop({} as never, tools as never, reasoner as never, [], {
      goal: "find an earlier decision",
      shouldStopForTenant: async () => ++checks >= 5,
    });

    expect(result.result?.error).toBe("tenant_suspended");
    expect(reasoner.decide).toHaveBeenCalledOnce();
    expect(tools.run).not.toHaveBeenCalled();
  });
});

describe("fresh Space coordination context", () => {
  it("refreshes member-filtered facts before each reasoner decision", async () => {
    let revision = 0;
    const readFacts = vi.fn(async () => JSON.stringify({ revision: ++revision, advisory_only: true, untrusted: true }));
    const tools = {
      find: vi.fn(async () => []),
      availableOperations: () => [],
      disclosureGroups: () => [],
      activeCatalog: async () => [],
      resolveOperationAlias: (name: string, params: Record<string, unknown>) => ({ name, params }),
      run: vi.fn(async () => ({ ok: true, output: "found one approved service", tier: 1, duration_ms: 1, tokens_used: 0 })),
    };
    const decisions = [
      { action: "run", name: "coordination.search", params: { capability_key: "official.website" } },
      { action: "answer", text: "The Space has an approved official website." },
    ];
    const reasoner = { decide: vi.fn(async (input: { spaceCoordinationContext?: string }) => {
      expect(input.spaceCoordinationContext).toContain(`"revision":${reasoner.decide.mock.calls.length}`);
      return decisions[reasoner.decide.mock.calls.length - 1]!;
    }) };
    const result = await runScriptLoop({ spaceCoordinationContext: readFacts } as never, tools as never, reasoner as never, [], {
      goal: "Check whether an official service already exists",
      maxSteps: 3,
    });
    expect(result.result?.ok).toBe(true);
    expect(readFacts).toHaveBeenCalledTimes(2);
    expect(reasoner.decide).toHaveBeenCalledTimes(2);
    expect(tools.run).toHaveBeenCalledOnce();
  });
});

describe("pre-inference spend admission", () => {
  const input = { goal: "answer", level: "L2", snapshot: {}, candidates: [], availableOperations: [] } as never;
  const deps = (reserveInferenceCost: () => Promise<boolean>) => ({
    apiKey: "", gateway: { accountId: "test", gatewayId: "test" },
    ctx: { spaceId: "space", agentId: "agent", model: "test-model" }, model: "test-model",
    reserveInferenceCost,
  });

  it("does not continue when the host budget rejects the reservation", async () => {
    const reserveInferenceCost = vi.fn(async () => false);
    const decision = await new GatewayReasoner(deps(reserveInferenceCost)).decide(input);
    expect(reserveInferenceCost).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model", maxOutputTokens: 1500 }));
    expect(decision).toMatchObject({ action: "give_up", reason: "inference_budget_cap_reached: no inference was sent" });
  });

  it("fails closed when reservation status cannot be verified", async () => {
    const decision = await new GatewayReasoner(deps(async () => { throw new Error("offline"); })).decide(input);
    expect(decision).toMatchObject({ action: "give_up", reason: "inference_budget_reservation_unavailable: no inference was sent" });
  });
});

describe("host-injected model transport", () => {
  it("uses the host-approved deterministic endpoint without touching global network fetch", async () => {
    const globalFetch = vi.fn(async () => { throw new Error("unexpected_global_network_fetch"); });
    vi.stubGlobal("fetch", globalFetch);
    let sentPayload: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
      choices: [{ message: { role: "assistant", content: JSON.stringify({ action: "answer", text: "synthetic accepted" }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
      });
    });
    try {
      const reasoner = new GatewayReasoner({
        apiKey: "",
        gateway: { accountId: "test", gatewayId: "test", aigToken: "test-only" },
        ctx: { spaceId: "space", agentId: "project-assistant", model: "@cf/test-model" },
        model: "@cf/test-model",
        fetcher: fetcher as typeof globalThis.fetch,
      });
      await expect(reasoner.decide({
        goal: "complete deterministic test task", level: "L2", snapshot: {}, candidates: [], availableOperations: [],
        spaceCoordinationContext: JSON.stringify({ entries: [{ capability_key: "official.website", label: "Company site" }], advisory_only: true, untrusted: true }),
      } as never)).resolves.toEqual({ action: "answer", text: "synthetic accepted" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("/ai/v1/chat/completions");
      const messages = Array.isArray(sentPayload?.messages) ? sentPayload.messages as Array<Record<string, unknown>> : [];
      const message = messages.find((candidate) => candidate.role === "user");
      const decisionPayload = typeof message?.content === "string" ? JSON.parse(message.content) as Record<string, unknown> : {};
      expect(decisionPayload.space_coordination_context).toContain("official.website");
      expect(decisionPayload.space_coordination_context_rule).toContain("host must independently authorize");
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("restricted external channel answers", () => {
  it("sends only the host-selected published excerpts to a text-only local completion", async () => {
    const reserveInferenceCost = vi.fn(async () => true);
    const localCompletion = vi.fn(async (payload: Record<string, unknown>) => {
      expect(payload).not.toHaveProperty("tools");
      expect(JSON.stringify(payload)).toContain("Published mentor notes");
      expect(JSON.stringify(payload)).toContain("External user's question");
      return { content: [{ type: "text", text: "Use the position sizing worksheet." }], usage: { input_tokens: 70, output_tokens: 12 } };
    });
    const reasoner = new GatewayReasoner({
      apiKey: "", gateway: { accountId: "test", gatewayId: "test" },
      ctx: { spaceId: "space", agentId: "agent", model: "local/test-model" }, model: "local/test-model",
      airGappedOnly: true, reserveInferenceCost, localCompletion,
    });
    const response = await reasoner.answerExternal({ question: "Which worksheet should I use?", sources: [
      { title: "Published mentor notes", content: "Use the position sizing worksheet." },
    ] });
    expect(response).toEqual({ text: "Use the position sizing worksheet.", usage: { input_tokens: 70, output_tokens: 12 } });
    expect(reserveInferenceCost).toHaveBeenCalledOnce();
  });

  it("fails before inference without an admitted budget or owner-published sources", async () => {
    const localCompletion = vi.fn(async () => ({ content: [{ type: "text", text: "answer" }] }));
    const reasoner = new GatewayReasoner({
      apiKey: "", gateway: { accountId: "test", gatewayId: "test" },
      ctx: { spaceId: "space", agentId: "agent", model: "local/test-model" }, model: "local/test-model",
      reserveInferenceCost: async () => false, localCompletion,
    });
    await expect(reasoner.answerExternal({ question: "Question", sources: [{ title: "Notes", content: "Ground truth." }] })).rejects.toThrow("external_answer_spend_capped");
    expect(localCompletion).not.toHaveBeenCalled();
    const admittedReasoner = new GatewayReasoner({
      apiKey: "", gateway: { accountId: "test", gatewayId: "test" },
      ctx: { spaceId: "space", agentId: "agent", model: "local/test-model" }, model: "local/test-model",
      reserveInferenceCost: async () => true, localCompletion,
    });
    await expect(admittedReasoner.answerExternal({ question: "Question", sources: [] })).rejects.toThrow("external_answer_input_invalid");
  });
});

describe("dynamic OpenRouter modality admission", () => {
  const imageTurn = {
    goal: "Describe this screenshot", level: "L2", snapshot: {}, candidates: [], availableOperations: [],
    priorSteps: [{ name: "browser.see", ok: true, params: {}, output: { image_base64: "aGVsbG8=", mime_type: "image/png" } }],
  } as never;
  const evidence = (inputModalities: string[], observedAt = new Date().toISOString()) => ({
    id: "vendor/model", model: "openrouter/vendor/model", name: "Model", contextLength: 262_144,
    promptPriceUsdPerToken: 0.000001, completionPriceUsdPerToken: 0.000002,
    inputModalities, outputModalities: ["text"], supportedParameters: ["tools"], catalogObservedAt: observedAt,
  });
  const deps = (openRouterCapabilityEvidence: ReturnType<typeof evidence>, reserveInferenceCost: () => Promise<boolean>, model = "openrouter/vendor/model") => ({
    apiKey: "", gateway: { accountId: "test", gatewayId: "test", openRouterApiKey: "key" },
    ctx: { spaceId: "space", agentId: "agent", model },
    model, openRouterCapabilityEvidence, reserveInferenceCost,
  });

  it("denies image requests when the catalog does not declare image input before reserving cost", async () => {
    const reserve = vi.fn(async () => true);
    const decision = await new GatewayReasoner(deps(evidence(["text"]), reserve)).decide(imageTurn);
    expect(decision).toMatchObject({ action: "give_up", reason: expect.stringContaining("does not declare image input") });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails closed when capability evidence is stale or belongs to another model", async () => {
    const reserve = vi.fn(async () => true);
    const stale = evidence(["text", "image"], new Date(Date.now() - 16 * 60_000).toISOString());
    const staleDecision = await new GatewayReasoner(deps(stale, reserve)).decide({ ...imageTurn, priorSteps: [] } as never);
    expect(staleDecision).toMatchObject({ action: "give_up", reason: expect.stringContaining("no inference was sent") });
    const wrongModel = { ...evidence(["text", "image"]), model: "openrouter/other/model" };
    const mismatchDecision = await new GatewayReasoner(deps(wrongModel, reserve, "openrouter/vendor/model")).decide({ ...imageTurn, priorSteps: [] } as never);
    expect(mismatchDecision).toMatchObject({ action: "give_up", reason: expect.stringContaining("no inference was sent") });
    expect(reserve).not.toHaveBeenCalled();
  });
});
