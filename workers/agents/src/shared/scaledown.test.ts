import { describe, expect, it, vi } from "vitest";
import {
  type ScaleDownOptions,
  createScaleDownProcessor,
} from "./scaledown.js";

function setup(payload: unknown, extra: Partial<ScaleDownOptions> = {}) {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(payload)
  );
  const authorize = vi.fn(async () => {});
  const recordUsage = vi.fn(async () => {});
  const processor = createScaleDownProcessor({
    gateway: {
      accountId: "account",
      gatewayId: "gateway",
      openRouterApiKey: "space-key",
    },
    fetch: fetcher as typeof fetch,
    authorize,
    recordUsage,
    ...extra,
  });
  return { processor, fetcher, authorize, recordUsage };
}
const completion = (text: string) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 80, completion_tokens: 0, cost: 0.000004 },
});

describe("ScaleDown task-specific provider contracts", () => {
  it("separates summary instructions/source and uses the Space's no-wholesale gateway route", async () => {
    const { processor, fetcher, authorize, recordUsage } = setup(
      completion("A concise summary.")
    );
    const result = await processor.summarize({
      text: "Long source text.",
      instructions: "Focus on decisions.",
      sourceId: "doc-1",
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      sourceId: "doc-1",
      text: "A concise summary.",
      usage: {
        model: "openrouter/scaledown/summarize",
        inputTokens: 80,
        outputTokens: 0,
      },
    });
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "Long source text.",
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("temperature");
    expect(init.headers).toMatchObject({
      authorization: "Bearer space-key",
      "cf-aig-no-wholesale": "true",
    });
  });

  it("cannot send document bytes when host admission rejects", async () => {
    const { processor, fetcher } = setup(completion("no"), {
      authorize: async () => {
        throw new Error("budget_exhausted");
      },
    });
    await expect(
      processor.summarize({ text: "private source" })
    ).rejects.toThrow("budget_exhausted");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects sources above the byte limit before admission or provider egress", async () => {
    const { processor, fetcher, authorize } = setup(completion("unused"));
    await expect(
      processor.summarize({ text: "x".repeat(2 * 1024 * 1024 + 1) })
    ).rejects.toThrow("document_text_required_or_too_large");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels non-success provider bodies without exposing their content", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("private provider error details")); },
        cancel,
      }),
      { status: 503 },
    ));
    const { processor, recordUsage } = setup({}, { fetch: fetcher as typeof fetch });
    await expect(processor.summarize({ text: "source" })).rejects.toThrow("scaledown_provider_503");
    expect(cancel).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("cancels provider response streams that exceed the JSON byte limit", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
        cancel,
      }),
    ));
    const { processor, recordUsage } = setup({}, { fetch: fetcher as typeof fetch });
    await expect(processor.summarize({ text: "source" })).rejects.toThrow("scaledown_response_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("rejects malformed runtime inputs and non-text summary instructions before provider egress", async () => {
    const { processor, fetcher, authorize } = setup(completion("unused"));
    await expect(processor.summarize(null as never)).rejects.toThrow(
      "document_text_required_or_too_large"
    );
    await expect(
      processor.summarize({ text: "source", instructions: { inject: true } as never })
    ).rejects.toThrow("document_summary_options_invalid");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 provider JSON rather than silently replacing bytes", async () => {
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
    );
    const { processor } = setup({}, { fetch: fetcher as typeof fetch });
    await expect(processor.summarize({ text: "source" })).rejects.toThrow();
  });

  it("uses provider-specific entity declarations and checks spans against the source", async () => {
    const { processor, fetcher } = setup(
      completion(
        JSON.stringify({
          entities: [
            {
              type: "vendor",
              text: "Acme",
              start: 8,
              end: 12,
              confidence: 0.9,
            },
          ],
        })
      )
    );
    const result = await processor.extract({
      text: "Vendor: Acme",
      entities: { vendor: "Name of the vendor" },
    });
    expect(result.entities[0]).toMatchObject({
      text: "Acme",
      offsetEncoding: "utf16",
    });
    const body = JSON.parse(
      (fetcher.mock.calls[0]?.[1] as RequestInit).body as string
    );
    expect(body.provider.options.scaledown.entities).toEqual({
      vendor: "Name of the vendor",
    });
    expect(body).not.toHaveProperty("response_format");
  });

  it("bills known usage before rejecting fabricated extraction spans or truncated summaries", async () => {
    const a = setup(
      completion(
        JSON.stringify({
          entities: [
            {
              type: "vendor",
              text: "Invented",
              start: 0,
              end: 8,
              confidence: 1,
            },
          ],
        })
      )
    );
    await expect(
      a.processor.extract({
        text: "Vendor: Acme",
        entities: { vendor: "vendor" },
      })
    ).rejects.toThrow("source_mismatch");
    expect(a.recordUsage).toHaveBeenCalledOnce();
    const b = setup({
      ...completion("unfinished"),
      choices: [
        { message: { content: "unfinished" }, finish_reason: "length" },
      ],
    });
    await expect(b.processor.summarize({ text: "source" })).rejects.toThrow(
      "output_truncated"
    );
    expect(b.recordUsage).toHaveBeenCalledOnce();
  });

  it("handles Unicode code-point offsets and never accepts an undeclared extraction field", async () => {
    const a = setup(
      completion(
        JSON.stringify({
          entities: [
            { type: "vendor", text: "Acme", start: 2, end: 6, confidence: 1 },
          ],
        })
      )
    );
    expect(
      (
        await a.processor.extract({
          text: "😀 Acme",
          entities: { vendor: "vendor" },
        })
      ).entities[0]?.offsetEncoding
    ).toBe("unicode_code_points");
    const b = setup(
      completion(
        JSON.stringify({
          entities: [
            { type: "secret", text: "Acme", start: 0, end: 4, confidence: 1 },
          ],
        })
      )
    );
    await expect(
      b.processor.extract({ text: "Acme", entities: { vendor: "vendor" } })
    ).rejects.toThrow("entity_invalid");
  });

  it("uses only the native compression credential, preserves the query and rejects changed prompts", async () => {
    const a = setup(
      {
        results: {
          success: true,
          compressed_prompt: "facts",
          original_prompt: "Question?",
        },
        input_tokens: 30,
      },
      { nativeApiKey: "native-key" }
    );
    expect(
      await a.processor.compress({
        text: "Long source facts repeated here.",
        query: "Question?",
      })
    ).toMatchObject({
      text: "facts",
      applied: true,
      usage: { outputTokens: null },
    });
    expect(a.fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.scaledown.xyz/compress/raw/"
    );
    expect(
      (a.fetcher.mock.calls[0]?.[1] as RequestInit).headers
    ).not.toHaveProperty("authorization");
    const b = setup(
      {
        results: {
          success: true,
          compressed_prompt: "facts",
          original_prompt: "Other",
        },
        input_tokens: 30,
      },
      { nativeApiKey: "native-key" }
    );
    await expect(
      b.processor.compress({ text: "Original facts", query: "Question?" })
    ).rejects.toThrow("compression_invalid");
  });

  it("does not mistake an OpenRouter key for native compression credentials", async () => {
    const { processor, fetcher } = setup({});
    await expect(
      processor.compress({ text: "source", query: "question" })
    ).rejects.toThrow("provider_unconfigured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("caches validated derivatives for the same source and policy scope with no second provider charge", async () => {
    const values = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const first = setup(completion("Summary A"), {
      cache,
      cacheScope: "tenant:s:project:p:actor:u:policy:v1",
    });
    await first.processor.summarize({
      text: "source",
      sourceId: "workspace:a#sha256:1",
    });
    const second = setup(completion("Should not be called"), {
      cache,
      cacheScope: "tenant:s:project:p:actor:u:policy:v1",
    });
    const cached = await second.processor.summarize({
      text: "source",
      sourceId: "workspace:a#sha256:1",
    });
    expect(cached).toMatchObject({
      text: "Summary A",
      usage: { inputTokens: 0, outputTokens: 0, cacheHit: true },
    });
    expect(second.fetcher).not.toHaveBeenCalled();
    expect(second.authorize).not.toHaveBeenCalled();
    const otherActor = setup(completion("Summary B"), {
      cache,
      cacheScope: "tenant:s:project:p:actor:other:policy:v1",
    });
    expect(
      (
        await otherActor.processor.summarize({
          text: "source",
          sourceId: "workspace:a#sha256:1",
        })
      ).text
    ).toBe("Summary B");
    expect(cache.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 604800 }
    );
  });

  it("does not trust cached extraction spans that no longer match their source", async () => {
    const values = new Map<string, string>();
    const cache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    };
    const input = { text: "Vendor: Acme", sourceId: "source-1", entities: { vendor: "vendor name" } };
    const first = setup(completion(JSON.stringify({ entities: [
      { type: "vendor", text: "Acme", start: 8, end: 12, confidence: 0.9 },
    ] })), { cache, cacheScope: "tenant:space:project:actor:policy" });
    await first.processor.extract(input);

    const [key, serialized] = [...values.entries()][0]!;
    const corrupted = JSON.parse(serialized) as { entities: Array<{ text: string }> };
    corrupted.entities[0]!.text = "Other";
    values.set(key, JSON.stringify(corrupted));

    const second = setup(completion(JSON.stringify({ entities: [
      { type: "vendor", text: "Acme", start: 8, end: 12, confidence: 0.9 },
    ] })), { cache, cacheScope: "tenant:space:project:actor:policy" });
    const result = await second.processor.extract(input);
    expect(result.entities[0]?.text).toBe("Acme");
    expect(second.fetcher).toHaveBeenCalledOnce();
  });
});
