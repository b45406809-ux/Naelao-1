import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

describe("thread list query bounds", () => {
  it("passes a positive capped limit and offset to D1 for both request extremes", async () => {
    const bindings: unknown[][] = [];
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-platform-secret",
      LLM_GATEWAY_URL: "https://llm.invalid",
      PLATFORM_DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => ({
            all: async () => {
              bindings.push(values);
              return { results: [] };
            },
          }),
        }),
      },
    };
    const request = (query: string) =>
      worker.fetch(
        new Request(`https://threads.invalid/v1/threads?${query}`, {
          headers: { "x-naelao-tenant-id": "tenant-a" },
        }),
        env as never
      );

    expect((await request("limit=-1&offset=-500")).status).toBe(200);
    expect(bindings[0]).toEqual(["tenant-a", 1, 0]);
    expect((await request("limit=999999&offset=999999999")).status).toBe(200);
    expect(bindings[1]).toEqual(["tenant-a", 100, 100_000]);
  });

  it("paginates sessions in thread detail and returns a bounded next offset", async () => {
    let sessionQueryValues: unknown[] = [];
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-platform-secret",
      LLM_GATEWAY_URL: "https://llm.invalid",
      PLATFORM_DB: {
        prepare: (sql: string) => ({
          bind: (...values: unknown[]) => ({
            first: async () => sql.includes("FROM threads") ? { id: "thread-a", tenant_id: "tenant-a", session_count: 90 } : null,
            all: async () => {
              sessionQueryValues = values;
              return { results: [
                { id: "s1" }, { id: "s2" }, { id: "s3" },
              ] };
            },
          }),
        }),
      },
    };
    const response = await worker.fetch!(new Request("https://threads.invalid/v1/threads/thread-a?limit=2&offset=4", {
      headers: { "x-naelao-tenant-id": "tenant-a" },
    }), env as never);
    expect(sessionQueryValues).toEqual(["thread-a", "tenant-a", 3, 4]);
    expect(await response.json()).toMatchObject({ data: { sessions: [{ id: "s1" }, { id: "s2" }], sessions_pagination: { limit: 2, offset: 4, next_offset: 6 } } });
  });

  it("rejects oversized thread creation JSON before querying D1", async () => {
    const prepare = vi.fn();
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: "test", LLM_GATEWAY_URL: "https://llm.invalid", PLATFORM_DB: { prepare } };
    const response = await worker.fetch!(new Request("https://threads.invalid/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ space_id: "space", end_user_id: "user", title: "x".repeat(66_000) }),
    }), env as never);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error_code: "request_body_too_large" });
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("thread session attachment integrity", () => {
  function attachmentEnv(existing: Map<string, { thread_id: string; tenant_id: string }> = new Map()) {
    const updatedCounts: number[] = [];
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: "test-platform-secret",
      LLM_GATEWAY_URL: "https://llm.invalid",
      PLATFORM_DB: {
        prepare: (sql: string) => ({
          bind: (...values: unknown[]) => ({
            first: async () => {
              if (sql.includes("SELECT id, space_id, end_user_id FROM threads")) return { id: values[0], space_id: "space-a", end_user_id: "user-a" };
              if (sql.includes("SELECT thread_id FROM thread_sessions")) {
                const row = existing.get(String(values[0]));
                return row && row.tenant_id === values[1] ? { thread_id: row.thread_id } : null;
              }
              if (sql.includes("SELECT COUNT(*) AS count")) return { count: [...existing.values()].filter((row) => row.thread_id === values[0] && row.tenant_id === values[1]).length };
              return null;
            },
            run: async () => {
              if (sql.includes("INSERT INTO thread_sessions")) {
                const sessionId = String(values[0]);
                if (existing.has(sessionId)) return { meta: { changes: 0 } };
                existing.set(sessionId, { thread_id: String(values[1]), tenant_id: String(values[3]) });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE threads SET session_count")) updatedCounts.push(Number(values[0]));
              return { meta: { changes: 1 } };
            },
          }),
        }),
      },
    };
    return { env, updatedCounts };
  }

  function attach(sessionId: string, endUserId = "user-a") {
    return new Request("https://threads.invalid/v1/threads/thread-a/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ session_id: sessionId, end_user_id: endUserId }),
    });
  }

  it("does not increment session_count again when an attachment is retried", async () => {
    const { env, updatedCounts } = attachmentEnv();
    const first = await worker.fetch!(attach("session-a"), env as never);
    const retry = await worker.fetch!(attach("session-a"), env as never);
    expect(first.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotent: true });
    expect(updatedCounts).toEqual([1, 1]);
  });

  it("does not move an already attached session into another thread", async () => {
    const { env, updatedCounts } = attachmentEnv(new Map([["session-a", { thread_id: "thread-other", tenant_id: "tenant-a" }]]));
    const response = await worker.fetch!(attach("session-a"), env as never);
    expect(response.status).toBe(409);
    expect(updatedCounts).toEqual([]);
  });

  it("rejects attaching a session owned by a different end user", async () => {
    const { env, updatedCounts } = attachmentEnv();
    const response = await worker.fetch!(attach("session-a", "user-b"), env as never);
    expect(response.status).toBe(403);
    expect(updatedCounts).toEqual([]);
  });
});
