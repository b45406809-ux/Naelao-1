import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlmGatewayError,
  calculateTokenBudget,
  callLlm,
  moderateInput,
  moderateOutput,
  resolveAnthropicEndpoint,
  streamLlm,
} from "./gateway.js";
import type { LlmRequest } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const request: LlmRequest = {
  model: "claude-test",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
};

describe("LLM gateway stress boundaries", () => {
  it("encodes gateway path components and rejects incomplete gateway configuration", () => {
    const endpoint = resolveAnthropicEndpoint({
      accountId: "account/segment",
      gatewayId: "gateway?override=true",
    });
    expect(endpoint.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account%2Fsegment/gateway%3Foverride%3Dtrue/anthropic/v1/messages"
    );
    expect(() =>
      resolveAnthropicEndpoint({ accountId: "real-account", gatewayId: "" })
    ).toThrowError(LlmGatewayError);
  });

  it("rejects malformed request limits before making a provider request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      callLlm("key", { ...request, max_tokens: 0 })
    ).rejects.toMatchObject({ code: "invalid_llm_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the gateway stored key without sending an empty provider key", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
        expect(new Headers(init?.headers).get("cf-aig-authorization")).toBe(
          "Bearer gateway-token"
        );
        return Response.json({
          id: "resp-1",
          model: "claude-test",
          role: "assistant",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
    );
    vi.stubGlobal("fetch", fetch);
    const result = await callLlm("", request, undefined, {
      accountId: "account-1",
      gatewayId: "gateway-1",
      aigToken: "gateway-token",
    });
    expect(result.id).toBe("resp-1");
  });

  it("opens a failing gateway circuit without blocking a separate gateway", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("gateway-a"))
        return new Response("down", { status: 503 });
      return Response.json({
        id: "gateway-b-ok",
        model: "claude-test",
        role: "assistant",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const gatewayA = {
      accountId: "account-a",
      gatewayId: "gateway-a",
      aigToken: "token-a",
    };
    const firstFailure = expect(
      callLlm("", request, undefined, gatewayA)
    ).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await firstFailure;
    const secondFailure = expect(
      callLlm("", request, undefined, gatewayA)
    ).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await secondFailure;

    const callsBeforeOpenRejection = fetch.mock.calls.length;
    await expect(
      callLlm("", request, undefined, gatewayA)
    ).rejects.toMatchObject({ code: "circuit_open" });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeOpenRejection);

    const gatewayB = {
      accountId: "account-b",
      gatewayId: "gateway-b",
      aigToken: "token-b",
    };
    await expect(
      callLlm("", request, undefined, gatewayB)
    ).resolves.toMatchObject({ id: "gateway-b-ok" });
  });

  it("parses streamed text and extended-thinking usage across SSE chunks", async () => {
    const events = [
      {
        event: "message_start",
        data: {
          message: {
            id: "resp-stream",
            model: "claude-test",
            usage: { input_tokens: 4 },
          },
        },
      },
      {
        event: "content_block_start",
        data: { index: 0, content_block: { type: "thinking" } },
      },
      {
        event: "content_block_delta",
        data: {
          index: 0,
          delta: { type: "thinking_delta", thinking: "Reasoning123456" },
        },
      },
      { event: "content_block_stop", data: { index: 0 } },
      {
        event: "content_block_start",
        data: { index: 1, content_block: { type: "text" } },
      },
      {
        event: "content_block_delta",
        data: { index: 1, delta: { type: "text_delta", text: "answer" } },
      },
      { event: "content_block_stop", data: { index: 1 } },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        },
      },
    ];
    const frames = events.map(
      ({ event, data }) =>
        `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          const bytes = encoder.encode(frame);
          controller.enqueue(bytes.slice(0, 7));
          controller.enqueue(bytes.slice(7));
        }
        controller.close();
      },
    });
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(stream)
    );
    vi.stubGlobal("fetch", fetch);
    const chunks: string[] = [];
    const result = await streamLlm("key", request, (chunk) =>
      chunks.push(chunk)
    );
    expect(chunks).toEqual(["answer"]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).stream).toBe(
      true
    );
    expect(result.id).toBe("resp-stream");
    expect(result.content).toEqual([{ type: "text", text: "answer" }]);
    expect(result.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 2,
      thinking_tokens: 4,
    });
  });

  it("surfaces provider SSE errors instead of returning an empty success", async () => {
    const body =
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"busy"}}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body))
    );
    await expect(streamLlm("key", request, () => {})).rejects.toMatchObject({
      status: 529,
      code: "overloaded_error",
    });
  });

  it("contains malformed budget input and limits moderation work", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const budget = calculateTokenBudget(
      "system",
      [{ role: "assistant", content: [{ type: "tool_use", input: circular }] }],
      "knowledge",
      -1
    );
    expect(budget.maxContextTokens).toBe(0);
    expect(budget.remainingForResponse).toBe(0);
    expect(moderateInput("x".repeat(1_000_001)).blocked).toBe(true);
    expect(moderateOutput("x".repeat(1_000_001), "system").flagged).toBe(true);
  });
});
