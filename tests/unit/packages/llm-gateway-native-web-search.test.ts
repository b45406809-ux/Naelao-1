import { describe, it, expect, vi, afterEach } from "vitest";
import { callLlm, streamLlm } from "../../../packages/llm-gateway/src/gateway.js";
import type { LlmNativeWebSearchTool } from "../../../packages/llm-gateway/src/types.js";

// §A1.25: Anthropic's native web-search tool is proxied transparently by CF AI Gateway (Unified
// Billing, no separate provider key). buildRequestBody already passes `tools` through
// unconditionally — this proves a native tool block (no input_schema, unlike Naelao's own custom
// function tools) survives that pass-through, and that streamLlm's SSE parser — which previously
// silently dropped anything but "text"/"tool_use" block types — now captures the native tool's
// "server_tool_use" (the model's own tool call) and "web_search_tool_result" (Anthropic's search
// results) blocks instead of losing them.

const NATIVE_WEB_SEARCH: LlmNativeWebSearchTool = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("callLlm — passes the native web-search tool through unchanged", () => {
  afterEach(() => vi.restoreAllMocks());

  it("includes the native tool block (no input_schema) verbatim in the request body", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    await callLlm("sk-ant-test", {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "what's the weather in Harare?" }],
      tools: [NATIVE_WEB_SEARCH],
      max_tokens: 100,
    });
    expect(capturedBody.tools).toEqual([NATIVE_WEB_SEARCH]);
  });

  it("callLlm's response mapping already passes through server_tool_use/web_search_tool_result blocks unfiltered (no per-block-type logic to break)", async () => {
    const nativeBlocks = [
      { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "weather Harare" } },
      { type: "web_search_tool_result", tool_use_id: "srvtool_1", web_search_results: [{ title: "Weather", url: "https://example.com" }] },
      { type: "text", text: "It's sunny in Harare." },
    ];
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ content: nativeBlocks, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 })
    ));
    const res = await callLlm("sk-ant-test", {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "weather?" }],
      tools: [NATIVE_WEB_SEARCH],
      max_tokens: 100,
    });
    expect(res.content).toEqual(nativeBlocks);
  });
});

describe("streamLlm — captures native web-search tool blocks instead of silently dropping them", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reconstructs a server_tool_use block from streamed input_json_delta chunks", async () => {
    const frames = [
      sseFrame("message_start", { message: { id: "msg_1", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 8, output_tokens: 0 } } }),
      sseFrame("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "srvtool_1", name: "web_search" } }),
      sseFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } }),
      sseFrame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"weather Harare"}' } }),
      sseFrame("content_block_stop", { index: 0 }),
      sseFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseStreamResponse(frames)));
    const onChunk = vi.fn();
    const res = await streamLlm("sk-ant-test", {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "weather?" }],
      tools: [NATIVE_WEB_SEARCH],
      max_tokens: 100,
    }, onChunk);
    expect(res.content).toEqual([
      { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "weather Harare" } },
    ]);
    // input_json_delta must never be forwarded to onChunk — that callback is for visible text.
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("captures a web_search_tool_result block's results (delivered whole in content_block_start, not via delta)", async () => {
    const frames = [
      sseFrame("message_start", { message: { id: "msg_1", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 8, output_tokens: 0 } } }),
      sseFrame("content_block_start", {
        index: 0,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtool_1",
          content: [{ title: "Weather in Harare", url: "https://example.com/weather", page_age: "2026-07-10" }],
        },
      }),
      sseFrame("content_block_stop", { index: 0 }),
      sseFrame("content_block_start", { index: 1, content_block: { type: "text" } }),
      sseFrame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "It's sunny." } }),
      sseFrame("content_block_stop", { index: 1 }),
      sseFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseStreamResponse(frames)));
    const res = await streamLlm("sk-ant-test", {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "weather?" }],
      tools: [NATIVE_WEB_SEARCH],
      max_tokens: 100,
    }, vi.fn());
    expect(res.content).toContainEqual({
      type: "web_search_tool_result",
      tool_use_id: "srvtool_1",
      web_search_results: [{ title: "Weather in Harare", url: "https://example.com/weather", page_age: "2026-07-10" }],
    });
    expect(res.content).toContainEqual({ type: "text", text: "It's sunny." });
  });

  it("still handles ordinary text/tool_use streams unchanged (no regression)", async () => {
    const frames = [
      sseFrame("message_start", { message: { id: "msg_1", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 5, output_tokens: 0 } } }),
      sseFrame("content_block_start", { index: 0, content_block: { type: "text" } }),
      sseFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
      sseFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: " world" } }),
      sseFrame("content_block_stop", { index: 0 }),
      sseFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => sseStreamResponse(frames)));
    const onChunk = vi.fn();
    const res = await streamLlm("sk-ant-test", {
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    }, onChunk);
    expect(res.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(onChunk.mock.calls.map((c) => c[0]).join("")).toBe("Hello world");
  });
});
