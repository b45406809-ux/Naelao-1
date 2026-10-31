import { describe, expect, it, vi } from "vitest";
import { CLEF_FLASH_MODEL, DECIDER_MODEL, deterministicChoice, deterministicNoul, deterministicScore, resolveDecisionModel, SystemOneDecisionClient } from "./fast-decision.js";

describe("typed fast decisions", () => {
  it("reserves before a billed decision and settles actual usage", async () => {
    const events: string[] = [];
    const billing = { reserve: vi.fn(async () => { events.push("reserve"); return "reservation-1"; }), settle: vi.fn(async () => { events.push("settle"); }) };
    const fetcher = vi.fn(async () => { events.push("fetch"); return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "yes", probabilities: { yes: 1, no: 0 }, confidence: 1 } }, usage: { input_tokens: 42, output_tokens: 2 } }); });
    const client = new SystemOneDecisionClient({ billing, fetch: fetcher as typeof fetch });
    await client.choice({ state: "task", instructions: "choose", criteria: { yes: null, no: null }, policyCode: "test" });
    expect(events).toEqual(["reserve", "fetch", "settle"]);
    expect(billing.settle).toHaveBeenCalledWith("reservation-1", { status: "confirmed", inputTokens: 42, outputTokens: 2 });
    expect(billing.reserve.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps a failed billed request uncertain and does not retry", async () => {
    const billing = { reserve: vi.fn(async () => "reservation-2"), settle: vi.fn(async () => {}) };
    const fetcher = vi.fn(async () => new Response("busy", { status: 503 }));
    const client = new SystemOneDecisionClient({ billing, fetch: fetcher as typeof fetch, maxRetries: 2 });
    await expect(client.choice({ state: "task", instructions: "choose", criteria: { yes: null, no: null }, policyCode: "test" })).rejects.toThrow("system_one_http_503");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledWith("reservation-2", { status: "uncertain" });
  });
  it("keeps System-1 output bounded and provider-attributed", () => {
    expect(deterministicChoice("continue", "loop_budget")).toEqual({ kind: "choice", value: "continue", provider: "deterministic", policyCode: "loop_budget" });
    expect(deterministicNoul(false, "risk_guard")).toMatchObject({ kind: "noul", value: false, provider: "deterministic" });
    expect(deterministicScore(71.25, "market_radar")).toMatchObject({ kind: "score", value: 71.25, provider: "deterministic" });
  });

  it("rejects non-finite scores", () => {
    expect(() => deterministicScore(Number.NaN, "bad")).toThrow("fast_decision_score_must_be_finite");
  });

  it("calls OpenRouter Decisions with Clef Flash by default and validates a bounded choice", async () => {
    const onDecision = vi.fn();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: CLEF_FLASH_MODEL, questions: { decision: { type: "choice", criteria: { isolate: expect.anything(), container: expect.anything() } } } });
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "container", probabilities: { isolate: 0.04, container: 0.96 }, confidence: 0.93 } }, usage: { input_tokens: 42, output_tokens: 0 } });
    });
    const client = new SystemOneDecisionClient({ apiKey: "secret", fetch: fetcher as typeof fetch, maxRetries: 0, onDecision });
    await expect(client.choice({ state: "cargo build", instructions: "Choose runtime", criteria: { isolate: "V8", container: "Linux" }, policyCode: "execution_preflight" })).resolves.toMatchObject({ kind: "choice", value: "container", provider: "openrouter", model: CLEF_FLASH_MODEL, usage: { inputTokens: 42, outputTokens: 0 } });
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/alpha/decisions", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter", policyCode: "execution_preflight", model: CLEF_FLASH_MODEL, usage: { inputTokens: 42, outputTokens: 0 } }));
  });

  it("caps deployment retry overrides to two retries", async () => {
    const cancelBody = vi.fn();
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      attempts++;
      const body = new ReadableStream<Uint8Array>({ cancel: cancelBody });
      return new Response(body, { status: 503 });
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 100 });
    await expect(client.choice({ state: "small", instructions: "Choose", criteria: { yes: null, no: null }, policyCode: "retry_bound" })).rejects.toThrow("system_one_http_503");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cancelBody).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung OpenRouter decision within the total request budget", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 2, timeoutMs: 100 });
    await expect(client.choice({ state: "small", instructions: "Choose", criteria: { yes: null, no: null }, policyCode: "timeout" }))
      .rejects.toThrow("system_one_timeout");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("includes retry backoff in the shared timeout budget", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response("busy", { status: 503 }));
      const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 2, timeoutMs: 250 });
      const result = client.choice({ state: "small", instructions: "Choose", criteria: { yes: null, no: null }, policyCode: "retry_deadline" });
      await vi.advanceTimersByTimeAsync(100);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(150);
      await expect(result).rejects.toThrow("system_one_timeout");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the same deadline while reading a stalled response body", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => streamController?.error(new Error("aborted")), { once: true });
      return new Response(body);
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0, timeoutMs: 100 });
    await expect(client.choice({ state: "small", instructions: "Choose", criteria: { yes: null, no: null }, policyCode: "body_timeout" }))
      .rejects.toThrow("system_one_timeout");
  });

  it("maps legacy and Clef aliases to Clef Flash and permits only full Decider as overflow", () => {
    expect(resolveDecisionModel(undefined, "jev")).toBe(CLEF_FLASH_MODEL);
    expect(resolveDecisionModel("jev-latest")).toBe(CLEF_FLASH_MODEL);
    expect(resolveDecisionModel(undefined, "laya")).toBe(CLEF_FLASH_MODEL);
    expect(resolveDecisionModel(undefined, "clef")).toBe(CLEF_FLASH_MODEL);
    expect(resolveDecisionModel("@cf/cloudflare/clef-flash")).toBe(CLEF_FLASH_MODEL);
    expect(resolveDecisionModel(DECIDER_MODEL)).toBe(DECIDER_MODEL);
    expect(resolveDecisionModel("perplexity/pplx-decider-flash-v1.2")).toBe(CLEF_FLASH_MODEL);
    expect(() => resolveDecisionModel("openai/gpt-6-luna-decisions")).toThrow("system_one_unsupported_openrouter_model");
  });

  it("routes ordinary Clef Flash decisions through the same OpenRouter Decisions API", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: CLEF_FLASH_MODEL, state: { text: "checkout is down", image: "base64-image" } });
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "escalate", probabilities: { retry: 0.08, escalate: 0.92 }, confidence: 0.92 } }, usage: { input_tokens: 30, output_tokens: 0 } });
    });
    const client = new SystemOneDecisionClient({ legacyProvider: "clef", apiKey: "secret", fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.choice({
      state: { text: "checkout is down", image: "base64-image" },
      instructions: "Choose a response",
      criteria: { retry: "Transient failure", escalate: "Service outage" },
      policyCode: "support_escalation",
    })).resolves.toMatchObject({ kind: "choice", value: "escalate", provider: "openrouter", model: CLEF_FLASH_MODEL, confidence: 0.92 });
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/alpha/decisions", expect.anything());
  });

  it("uses full Decider only when the decision payload exceeds Clef Flash budget", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe(DECIDER_MODEL);
      return Response.json({ model: DECIDER_MODEL, answers: { decision: { type: "choice", choice: "keep", probabilities: { keep: 1, discard: 0 }, confidence: 1 } }, usage: { input_tokens: 20_000, output_tokens: 0 } });
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: { history: "x".repeat(40_000) }, instructions: "Select", criteria: { keep: null, discard: null }, policyCode: "long_context" })).resolves.toMatchObject({ model: DECIDER_MODEL });
  });

  it("rejects payloads above full Decider capacity before making a request", async () => {
    const fetcher = vi.fn();
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: { history: "x".repeat(450_000) }, instructions: "Select", criteria: { keep: null, discard: null }, policyCode: "too_large" })).rejects.toThrow("system_one_context_exceeds_decider_limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds streamed Decisions API responses without trusting Content-Length", async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(oversizedBody));
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });

    await expect(client.choice({
      state: "small decision",
      instructions: "Choose a result",
      criteria: { keep: null, discard: null },
      policyCode: "response_size_limit",
    })).rejects.toThrow("system_one_response_too_large");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not expose provider error bodies that could echo prompt data", async () => {
    const fetcher = vi.fn(async () => new Response("rejected prompt: private-customer-secret", { status: 500 }));
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });

    let failure = "";
    try {
      await client.choice({
        state: "small decision",
        instructions: "Choose a result",
        criteria: { keep: null, discard: null },
        policyCode: "error_body_redaction",
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe("system_one_http_500");
    expect(failure).not.toContain("private-customer-secret");
  });

  it("redacts provider error bodies from batched capability decisions too", async () => {
    const client = new SystemOneDecisionClient({
      fetch: vi.fn(async () => new Response("rejected prompt: private-customer-secret", { status: 500 })) as typeof fetch,
      maxRetries: 0,
    });
    await expect(client.classifyWorkerCapabilities({
      task: "inspect a transcript",
      capabilities: [{ capability: "conversation_research", description: "Search bounded conversation history" }],
    })).rejects.toThrow(/^system_one_http_500$/);
  });

  it("bundles container and browser preflight in one Decisions API request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, unknown> };
      expect(body.model).toBe(CLEF_FLASH_MODEL);
      expect(Object.keys(body.questions)).toEqual(["needsContainer", "needsBrowser"]);
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { needsContainer: { type: "noul", noul: 0.91 }, needsBrowser: { type: "noul", noul: 0.72 } }, usage: { input_tokens: 42, output_tokens: 0 } });
    });
    const client = new SystemOneDecisionClient({ legacyProvider: "clef", apiKey: "secret", fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.preflightRuntime({ goal: "run native builds" })).resolves.toMatchObject({ needsContainer: true, needsBrowser: false, confidence: 0.91 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: CLEF_FLASH_MODEL, answers: { needsContainer: { type: "noul", noul: 0.8 }, needsBrowser: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 10, output_tokens: 0 } })) as typeof fetch, maxRetries: 0 }).preflightRuntime("test")).resolves.toMatchObject({ needsContainer: true, needsBrowser: false });
  });

  it("classifies every worker blackboard item in one System One request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, unknown> }> };
      expect(Object.keys(body.questions)).toEqual(["item_0", "item_1"]);
      expect(body.questions.item_0?.criteria).toHaveProperty("ffmpeg");
      const criteria = Object.keys(body.questions.item_0!.criteria);
      return Response.json({ model: CLEF_FLASH_MODEL, answers: {
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
      { itemId: "s1-video", capability: "ffmpeg", confidence: 0.96, provider: "openrouter" },
      { itemId: "s2-report", confidence: 0.91, provider: "openrouter" },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("recommends a bounded task-specific subset of configured worker capabilities", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { task: string }; questions: Record<string, { instructions: string }> };
      expect(body.state.task).toContain("conversation");
      const answers = Object.fromEntries(Object.keys(body.questions).map((key, index) => [key, { type: "noul", noul: index === 0 ? 0.94 : 0.06 }]));
      return Response.json({ model: CLEF_FLASH_MODEL, answers, usage: { input_tokens: 40, output_tokens: 0 } });
    });
    const client = new SystemOneDecisionClient({ fetch: fetcher as typeof fetch, maxRetries: 0 });
    await expect(client.classifyWorkerCapabilities!({
      task: "Find the earlier decision in the conversation.",
      capabilities: [
        { capability: "conversation_research", description: "Search transcript and summarize evidence." },
        { capability: "code_and_runtime", description: "Run shell and build commands." },
      ],
    })).resolves.toMatchObject({ capabilities: ["conversation_research"], provider: "openrouter", model: CLEF_FLASH_MODEL });
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(JSON.stringify(sent)).not.toContain("conversation content");
  });

  it("fails closed on malformed worker capability recommendations", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: CLEF_FLASH_MODEL, answers: { capability_0: { type: "noul", noul: 1.1 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.classifyWorkerCapabilities!({ task: "read history", capabilities: [{ capability: "conversation_research", description: "Search transcript." }] })).rejects.toThrow("system_one_invalid_noul");
  });

  it("classifies attachment intent in one metadata-only decision and recommends a bounded skill", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { message: string; attachments: Array<{ id: string }> } };
      expect(body.state.message).toBe("Read the attached invoice total");
      expect(body.state.attachments).toEqual([{ id: "opaque-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1200 }]);
      expect(JSON.stringify(body)).not.toContain("PRIVATE_FILE_BYTES");
      const criteria = (JSON.parse(String(init?.body)) as { questions: { decision: { criteria: Record<string, unknown> } } }).questions.decision.criteria;
      expect(criteria).toHaveProperty("read_0");
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "read_0", probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === "read_0" ? 1 : 0])), confidence: 0.96 } }, usage: { input_tokens: 30, output_tokens: 3 } });
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
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "not_needed", probabilities: Object.fromEntries(keys.map((key) => [key, key === "not_needed" ? 1 : 0])), confidence: 0.99 } }, usage: { input_tokens: 12, output_tokens: 2 } });
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
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: {
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
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: { type: "choice", choice: "transcribe_0", probabilities: Object.fromEntries(criteria.map((key) => [key, key === "transcribe_0" ? 1 : 0])), confidence: 1 } }, usage: { input_tokens: 2, output_tokens: 1 } });
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
      return Response.json({ model: CLEF_FLASH_MODEL, answers: { decision: {
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
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "perplexity/pplx-decider-v1.2", answers: { decision: { type: "choice", choice: "host", probabilities: { isolate: 0.5, container: 0.5 }, confidence: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_choice_answer");
  });

  it("rejects malformed probability distributions", async () => {
    const client = new SystemOneDecisionClient({ fetch: vi.fn(async () => Response.json({ model: "perplexity/pplx-decider-v1.2", answers: { decision: { type: "choice", choice: "isolate", probabilities: { isolate: 0.9, container: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } })) as typeof fetch, maxRetries: 0 });
    await expect(client.choice({ state: "echo ok", instructions: "Choose", criteria: { isolate: null, container: null }, policyCode: "test" })).rejects.toThrow("system_one_invalid_probability_sum");
  });
});
