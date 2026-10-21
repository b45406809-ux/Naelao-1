import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

function env(documentText = "") {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "secret",
    LLM_GATEWAY_URL: "https://llm.example",
    PLATFORM_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
      })),
    } as unknown as D1Database,
    PLATFORM_DOCS_INDEX: { query: vi.fn(async () => ({ matches: documentText ? [{ metadata: { text: documentText } }] : [] })) } as unknown as VectorizeIndex,
  };
}

function request(body: BodyInit, contentType = "application/json"): Request {
  return new Request("https://assistant/v1/assistant/chat", {
    method: "POST",
    headers: { "content-type": contentType, "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
    body,
  });
}

function oversizedJsonResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"content":[{"type":"text","text":"'));
      controller.enqueue(new Uint8Array(256 * 1024 + 1).fill(0x61));
      controller.enqueue(new TextEncoder().encode('"}]}'));
      controller.close();
    },
  }));
}

describe("platform assistant request and provider boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects streamed requests above the local body ceiling before database or provider work", async () => {
    const bindings = env();
    const response = await worker.fetch!(request(JSON.stringify({ message: "x".repeat(65 * 1024) })), bindings, {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "request_body_too_large" });
    expect(bindings.PLATFORM_DB.prepare).not.toHaveBeenCalled();
  });

  it("rejects a message above its byte ceiling", async () => {
    const bindings = env();
    const response = await worker.fetch!(request(JSON.stringify({ message: "x".repeat(16 * 1024 + 1) })), bindings, {} as ExecutionContext);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "message_too_large" });
    expect(bindings.PLATFORM_DB.prepare).not.toHaveBeenCalled();
  });

  it("caps the LLM response body and returns the existing fallback instead of buffering it all", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ embedding: [0.1, 0.2] }] }))
      .mockResolvedValueOnce(oversizedJsonResponse()));
    const bindings = env();
    const response = await worker.fetch!(request(JSON.stringify({ message: "hello" })), bindings, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: "I encountered an error. Please try again." });
  });

  it("caps retrieved document context before sending the prompt to the model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ embedding: [0.1] }] }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const bindings = env("d".repeat(100_000));
    await worker.fetch!(request(JSON.stringify({ message: "hello" })), bindings, {} as ExecutionContext);
    const chatBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as { system: string };
    expect(chatBody.system.length).toBeLessThan(33_000);
  });
});
