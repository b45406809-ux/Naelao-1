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

  it("deletes assistant history only through a transaction scoped to the owning user and tenant", async () => {
    const bindings = env();
    const prepared: Array<{ sql: string; args: unknown[] }> = [];
    const statements: D1PreparedStatement[] = [];
    bindings.PLATFORM_DB = {
      prepare(sql: string) {
        const item = { sql, args: [] as unknown[] };
        prepared.push(item);
        const statement = {
          bind(...args: unknown[]) { item.args = args; return statement; },
        } as unknown as D1PreparedStatement;
        statements.push(statement);
        return statement;
      },
      batch: vi.fn(async () => [{ meta: { changes: 0 } }, { meta: { changes: 0 } }]),
    } as unknown as D1Database;

    const response = await worker.fetch!(new Request("https://assistant/v1/assistant/sessions/other-users-session", {
      method: "DELETE",
      headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a" },
    }), bindings, {} as ExecutionContext);

    expect(response.status).toBe(404);
    expect(statements).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("SELECT id FROM assistant_sessions WHERE id = ? AND tenant_id = ? AND user_id = ?");
    expect(prepared[1]?.sql).toContain("WHERE id = ? AND tenant_id = ? AND user_id = ?");
    expect(prepared.map((item) => item.args)).toEqual([
      ["other-users-session", "tenant-a", "user-a"],
      ["other-users-session", "tenant-a", "user-a"],
    ]);
  });

  it("pages session history newest-first with a stable row cursor and a bounded page size", async () => {
    const bindings = env();
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const session = { id: "session-1", tenant_id: "tenant", user_id: "user", title: "test", created_at: "2026-01-01" };
    const rows = [
      { id: "message-3", role: "assistant", content: "three", created_at: "same-time" },
      { id: "message-2", role: "user", content: "two", created_at: "same-time" },
      { id: "message-1", role: "assistant", content: "one", created_at: "same-time" },
    ];
    bindings.PLATFORM_DB = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { args = next; return statement; },
          async first() {
            seen.push({ sql, args });
            return sql.includes("SELECT rowid") ? { rowid: 2 } : session;
          },
          async all() {
            seen.push({ sql, args });
            const cursorIndex = args[1] === "message-2" ? 2 : rows.length;
            const candidates = args[1] === "message-2" ? rows.slice(cursorIndex) : rows;
            return { results: candidates.slice(0, Number(args.at(-1))) };
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;

    const first = await worker.fetch!(new Request("https://assistant/v1/assistant/sessions/session-1?limit=2", {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
    }), bindings, {} as ExecutionContext);
    expect(await first.json()).toMatchObject({ data: {
      messages: [{ id: "message-2" }, { id: "message-3" }],
      has_more: true,
      next_cursor: "message-2",
    } });
    expect(seen[1]?.args).toEqual(["session-1", 3]);

    const older = await worker.fetch!(new Request("https://assistant/v1/assistant/sessions/session-1?limit=2&before_id=message-2", {
      headers: { "x-naelao-tenant-id": "tenant", "x-naelao-user-id": "user" },
    }), bindings, {} as ExecutionContext);
    expect(await older.json()).toMatchObject({ data: { messages: [{ id: "message-1" }], has_more: false } });
  });
});
