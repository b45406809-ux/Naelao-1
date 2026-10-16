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

  it("classifies every worker blackboard item in one System One request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, unknown> }> };
      expect(Object.keys(body.questions)).toEqual(["item_0", "item_1"]);
      expect(body.questions.item_0?.criteria).toHaveProperty("ffmpeg");
      const criteria = Object.keys(body.questions.item_0!.criteria);
      return Response.json({ model: "jev-1.13.0", answers: {
        item_0: { type: "choice", choice: "ffmpeg", probabilities: Object.fromEntries(criteria.map(key => [key, key === "ffmpeg" ? 1 : 0])), confidence: 0.96 },
        item_1: { type: "choice", choice: "none", probabilities: Object.fromEntries(criteria.map(key => [key, key === "none" ? 1 : 0])), confidence: 0.91 },
      }, usage: { input_tokens: 50, output_tokens: 8 } });
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.classifyWorkPlan!({
      items: [
        { id: "s1-video", title: "Edit video", description: "Trim and transcode an uploaded video." },
        { id: "s2-report", title: "Write report", description: "Summarize the verified result." },
      ],
      availableTools: ["workspace.read", "artifacts.write"],
      runtimes: [{ capability: "ffmpeg", description: "Video transcoding container." }],
    })).resolves.toMatchObject([
      { itemId: "s1-video", capability: "ffmpeg", confidence: 0.96, provider: "jev" },
      { itemId: "s2-report", confidence: 0.91, provider: "jev" },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies attachment intent in one metadata-only decision and recommends a bounded skill", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { message: string; attachments: Array<{ id: string }> } };
      expect(body.state.message).toBe("Read the attached invoice total");
      expect(body.state.attachments).toEqual([{ id: "opaque-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1200 }]);
      expect(JSON.stringify(body)).not.toContain("PRIVATE_FILE_BYTES");
      const criteria = (JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, unknown> } } }).questions.decision.criteria;
      expect(criteria).toHaveProperty("read_0");
      return Response.json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "read_0", probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === "read_0" ? 1 : 0])), confidence: 0.96 } }, usage: { input_tokens: 30, output_tokens: 3 } });
    });
    const client = new SystemOneDecisionClient({ apiKey: "secret", fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.classifyAttachments!({
      message: "Read the attached invoice total",
      attachments: [{ id: "opaque-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1_200 }],
    })).resolves.toMatchObject({ status: "candidate_tool", action: "read", candidateTool: "attachment.read", candidateAttachmentId: "opaque-1", candidateSkill: "attachment-readers", confidence: 0.96 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not recommend an unavailable operation", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, unknown> } } };
      expect(body.questions.decision.criteria).not.toHaveProperty("copy_0");
      const keys = Object.keys(body.questions.decision.criteria);
      return Response.json({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "not_needed", probabilities: Object.fromEntries(keys.map((key) => [key, key === "not_needed" ? 1 : 0])), confidence: 0.99 } }, usage: { input_tokens: 12, output_tokens: 2 } });
    }) as typeof fetch, maxRetries: 0 });
    await expect(client.classifyAttachments!({
      message: "Save this image without reading it",
      attachments: [{ id: "image-1", filename: "photo.png", mimeType: "image/png", sizeBytes: 200 }],
      availableTools: ["attachment.inspect", "attachment.read", "attachment.ocr"],
    })).resolves.toMatchObject({ status: "not_needed", action: "not_needed", candidateSkill: "attachment-routing" });
  });

  it("binds an OCR recommendation to the image attachment that matched the request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, unknown> } } };
      const criteria = body.questions.decision.criteria;
      expect(criteria).toHaveProperty("ocr_1");
      expect(criteria).not.toHaveProperty("ocr_0");
      return Response.json({ model: "jev-1.13.0", answers: { decision: {
        type: "choice", choice: "ocr_1", probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === "ocr_1" ? 1 : 0])), confidence: 0.9,
      } }, usage: { input_tokens: 20, output_tokens: 3 } });
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.classifyAttachments!({
      message: "Read the text in the attached photograph",
      attachments: [
        { id: "opaque-doc", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 700 },
        { id: "opaque-image", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 900 },
      ],
      availableTools: ["attachment.ocr", "attachment.read"],
    })).resolves.toMatchObject({ action: "ocr", candidateAttachmentId: "opaque-image", candidateTool: "attachment.ocr" });
  });

  it("allows transcription of a supported video's audio track without offering video frames", async () => {
    const client = new SystemOneDecisionClient({ fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, string> } } };
      const criteria = Object.keys(body.questions.decision.criteria);
      expect(criteria).toContain("transcribe_0");
      return Response.json({ model: "jev-test", answers: { decision: { type: "choice", choice: "transcribe_0", probabilities: Object.fromEntries(criteria.map((key) => [key, key === "transcribe_0" ? 1 : 0])), confidence: 1 } }, usage: { input_tokens: 2, output_tokens: 1 } });
    } });
    await expect(client.classifyAttachments!({ message: "What does the speaker say?", attachments: [
      { id: "video-1", filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 400 },
    ], availableTools: ["attachment.transcribe"] })).resolves.toMatchObject({
      action: "transcribe", candidateTool: "attachment.transcribe", candidateAttachmentId: "video-1",
    });
  });

  it("distinguishes visual image understanding from OCR", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, unknown> } } };
      const criteria = body.questions.decision.criteria;
      expect(criteria).toHaveProperty("describe_0");
      expect(criteria).toHaveProperty("ocr_0");
      return Response.json({ model: "jev-1.13.0", answers: { decision: {
        type: "choice", choice: "describe_0", probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === "describe_0" ? 1 : 0])), confidence: 0.9,
      } }, usage: { input_tokens: 18, output_tokens: 3 } });
    }) as typeof fetch, maxRetries: 0 });
    await expect(client.classifyAttachments!({ message: "What vehicle is shown?", attachments: [
      { id: "image-opaque", filename: "photo.png", mimeType: "image/png", sizeBytes: 1200 },
    ], availableTools: ["attachment.describe", "attachment.ocr"] })).resolves.toMatchObject({
      action: "describe", candidateTool: "attachment.describe", candidateAttachmentId: "image-opaque", candidateSkill: "attachment-readers",
    });
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
