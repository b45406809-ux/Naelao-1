// AVOS plan, step 2 — prompt caching extended from the system prompt (already real, G-C05) to
// tool schemas: only the LAST tool in a request gets the cache_control breakpoint, and an
// already-marked last tool is never double-marked. Exercised through callLlm's REAL wire body
// (not a reimplementation of buildRequestBody, which isn't exported) — the actual contract that
// matters is what gets sent over the wire.

import { describe, it, expect, vi, afterEach } from "vitest";
import { callLlm } from "../../packages/llm-gateway/src/gateway.js";
import type { LlmFunctionTool, LlmRequest } from "../../packages/llm-gateway/src/types.js";

function makeTool(name: string, cache_control?: { type: "ephemeral" }): LlmFunctionTool {
  return { name, description: "d", input_schema: { type: "object" }, ...(cache_control ? { cache_control } : {}) };
}

function fakeAnthropicResponse(): Response {
  return new Response(
    JSON.stringify({ id: "x", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200 }
  );
}

afterEach(() => vi.restoreAllMocks());

describe("callLlm — tool prompt caching wire body", () => {
  it("marks only the LAST tool with cache_control", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return fakeAnthropicResponse();
    }));
    const request: LlmRequest = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [makeTool("a"), makeTool("b"), makeTool("c")],
    };
    await callLlm("test-key", request);
    const tools = capturedBody?.tools as LlmFunctionTool[];
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toBeUndefined();
    expect(tools[2]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("never double-marks a tool that already carries cache_control", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return fakeAnthropicResponse();
    }));
    const request: LlmRequest = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [makeTool("a", { type: "ephemeral" })],
    };
    await callLlm("test-key", request);
    const tools = capturedBody?.tools as LlmFunctionTool[];
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
  });

  it("no tools -> no tools field at all (unaffected)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return fakeAnthropicResponse();
    }));
    const request: LlmRequest = { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
    await callLlm("test-key", request);
    expect(capturedBody?.tools).toBeUndefined();
  });

  it("system prompt caching (pre-existing behavior) still applies alongside tool caching", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return fakeAnthropicResponse();
    }));
    const request: LlmRequest = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      system: "You are a helpful assistant.",
      tools: [makeTool("a")],
    };
    await callLlm("test-key", request);
    const system = capturedBody?.system as Array<{ cache_control?: unknown }>;
    const tools = capturedBody?.tools as LlmFunctionTool[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(tools[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
