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

  it("rejects an out-of-domain answer", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "jev-1", answers: { decision: { type: "choice", choice: "host", probabilities: { isolate: 0.5, container: 0.5 }, confidence: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_choice_answer");
  });

  it("rejects malformed probability distributions", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "jev-1", answers: { decision: { type: "choice", choice: "isolate", probabilities: { isolate: 0.9, container: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_probability_sum");
  });
});
