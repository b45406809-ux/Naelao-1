import { describe, expect, it, vi } from "vitest";
import { deterministicChoice, deterministicNoul, deterministicScore, SystemOneDecisionClient } from "./fast-decision.js";

describe("typed fast decisions", () => {
  it("keeps System-1 output bounded and provider-attributed", () => {
    expect(deterministicChoice("continue", "loop_budget")).toEqual({ kind: "choice", value: "continue", provider: "deterministic", policyCode: "loop_budget" });
    expect(deterministicNoul(false, "risk_guard")).toMatchObject({ kind: "noul", value: false, provider: "deterministic" });
    expect(deterministicScore(71.25, "market_radar")).toMatchObject({ kind: "score", value: 71.25, provider: "deterministic" });
  });

  it("rejects non-finite scores", () => {
    expect(() => deterministicScore(Number.NaN, "bad")).toThrow("fast_decision_score_must_be_finite");
  });

  it("calls Jev and validates a bounded choice", async () => {
    const onDecision = vi.fn();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "jev-latest", questions: { decision: { type: "choice", criteria: { isolate: expect.anything(), container: expect.anything() } } } });
      return Response.json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "container", probabilities: { isolate: 0.04, container: 0.96 }, confidence: 0.93 } }, usage: { input_tokens: 42, output_tokens: 7 } });
    });
    const client = new SystemOneDecisionClient({ apiKey: "secret", fetch: fetcher as typeof fetch, maxRetries: 0, onDecision });
    await expect(client.choice({ state: "cargo build", instructions: "Choose runtime", criteria: { isolate: "V8", container: "Linux" }, policyCode: "execution_preflight" })).resolves.toMatchObject({ kind: "choice", value: "container", provider: "jev", model: "jev-1.13.0", usage: { inputTokens: 42, outputTokens: 7 } });
    expect(fetcher).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ provider: "jev", policyCode: "execution_preflight", model: "jev-1.13.0", usage: { inputTokens: 42, outputTokens: 7 } }));
  });

  it("uses the same contract for a self-hosted Laya endpoint", async () => {
    const client = new SystemOneDecisionClient({ endpoint: "https://laya.internal/v1/systemone", provider: "laya", fetch: vi.fn(async () => Response.json({ model: "laya-typed-decisions", answers: { decision: { type: "noul", noul: 0.82 } }, usage: { input_tokens: 20, output_tokens: 0 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.noul({ state: "npm install sharp", instructions: "Needs native runtime?", policyCode: "native_preflight" })).resolves.toMatchObject({ kind: "noul", value: true, probability: 0.82, provider: "laya" });
  });

  it("uses the documented Workers AI Clef typed-question contract when explicitly selected", async () => {
    const runClef = vi.fn(async (model: string, input: Record<string, unknown>) => {
      expect(model).toBe("@cf/cloudflare/clef-flash");
      expect(input).toMatchObject({
        model: "clef-flash",
        state: { text: "checkout is down", image: "base64-image" },
        questions: { decision: { type: "choice", criteria: { retry: expect.any(String), escalate: expect.any(String) } } },
      });
      return { answers: { decision: { type: "choice", choice: "escalate", probabilities: { retry: 0.08, escalate: 0.92 }, confidence: 0.92 } } };
    });
    const client = new SystemOneDecisionClient({ provider: "clef", runClef });
    await expect(client.choice({
      state: { text: "checkout is down", image: "base64-image" },
      instructions: "Choose a response",
      criteria: { retry: "Transient failure", escalate: "Service outage" },
      policyCode: "support_escalation",
    })).resolves.toMatchObject({ kind: "choice", value: "escalate", provider: "clef", model: "@cf/cloudflare/clef-flash", confidence: 0.92 });
    expect(runClef).toHaveBeenCalledTimes(1);
  });

  it("does not construct a Clef client without the Workers AI binding", () => {
    expect(() => new SystemOneDecisionClient({ provider: "clef" })).toThrow("system_one_clef_binding_required");
  });

  it("bundles container and browser preflight in one Clef request and requires strong probability", async () => {
    const runClef = vi.fn(async (_model: string, input: Record<string, unknown>) => {
      expect(Object.keys(input["questions"] as object)).toEqual(["needsContainer", "needsBrowser"]);
      return { answers: { needsContainer: { noul: 0.91 }, needsBrowser: { noul: 0.72 } } };
    });
    const client = new SystemOneDecisionClient({ provider: "clef", runClef });
    await expect(client.preflightRuntime({ goal: "run native builds" })).resolves.toMatchObject({ needsContainer: true, needsBrowser: false, confidence: 0.91 });
    expect(runClef).toHaveBeenCalledTimes(1);
    await expect(new SystemOneDecisionClient().preflightRuntime("test")).resolves.toBeUndefined();
  });

  it("rejects an out-of-domain answer", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "jev-1", answers: { decision: { type: "choice", choice: "host", probabilities: { isolate: 0.5, container: 0.5 }, confidence: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_choice_answer");
  });

  it("rejects malformed probability distributions", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "jev-1", answers: { decision: { type: "choice", choice: "isolate", probabilities: { isolate: 0.9, container: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_probability_sum");
  });
});
