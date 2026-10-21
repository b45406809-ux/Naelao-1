import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

function testEnv(options: { activeSpace?: boolean; suite?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const batchRows: Array<{ values?: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind(...values: unknown[]) { this.values = values; return this; },
        values: [] as unknown[],
        async first() { return sql.includes("FROM eval_suites WHERE") ? options.suite ?? null : options.activeSpace ? { 1: 1 } : null; },
        async run() { return { success: true }; },
      };
    },
    batch(rows: Array<{ values?: unknown[] }>) { batchRows.push(...rows); return Promise.resolve([]); },
  } as unknown as D1Database;
  return { env: { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", EVAL_LLM_KEY: "key", NAELAO_ACCOUNT_ID: "account", NAELAO_GATEWAY_ID: "gateway", PLATFORM_DB: db, AGENTS_WORKER: undefined as Fetcher | undefined }, calls, batchRows };
}

function post(body: string, headers: Record<string, string> = {}) {
  return app.request("/evals", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", ...headers },
    body,
  }, testEnv().env);
}

describe("eval suite ingress bounds", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rejects oversized bodies before database access", async () => {
    const { env, calls } = testEnv({ activeSpace: true });
    const body = JSON.stringify({ name: "big", space_id: "space-a", cases: [], padding: "x".repeat(1024 * 1024) });
    const response = await app.request("/evals", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).length), "x-naelao-tenant-id": "tenant-a" },
      body,
    }, env);
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized case fields and malformed cases", async () => {
    const response = await post(JSON.stringify({ name: "suite", space_id: "space-a", cases: [{ input: "x".repeat(8_001) }] }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error_code: string }).error_code).toBe("bad_request");
  });

  it("returns a client error for malformed run JSON instead of silently running text mode", async () => {
    const { env } = testEnv({ activeSpace: true, suite: { id: "suite-id", space_id: "space-a", tenant_id: "tenant-a", cases_json: "[]" } });
    const response = await app.request("/evals/suite-id/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: "{bad json",
    }, env);
    expect(response.status).toBe(400);
  });

  it("does not create suites for suspended, unknown, or cross-tenant Spaces", async () => {
    const { env, calls } = testEnv({ activeSpace: false });
    const response = await app.request("/evals", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ name: "suite", space_id: "space-b", cases: [{ input: "hello" }] }),
    }, env);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("s.tenant_id = ?");
  });

  it("creates a suite only after active tenant and Space ownership is confirmed", async () => {
    const { env, calls } = testEnv({ activeSpace: true });
    const response = await app.request("/evals", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ name: "  suite  ", space_id: "space-a", cases: [{ input: "hello", tags: ["smoke"] }] }),
    }, env);
    expect(response.status).toBe(201);
    expect((await response.json() as { name: string }).name).toBe("suite");
    expect(calls).toHaveLength(2);
  });

  it("persists the successful agent answer as actual_output", async () => {
    const { env, batchRows } = testEnv({
      activeSpace: true,
      suite: { id: "suite-id", space_id: "space-a", tenant_id: "tenant-a", cases_json: JSON.stringify([{ input: "say hello", expected_output: "hello" }]) },
    });
    env.AGENTS_WORKER = { fetch: async () => Response.json({ status: "completed", runId: "run-id", finalAnswer: "Hello there" }) } as unknown as Fetcher;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: [{ type: "text", text: '{"correctness":8,"semantic_validity":9,"reason":"answered"}' }] })));

    const response = await app.request("/evals/suite-id/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" },
      body: JSON.stringify({ mode: "agent", session_id: "session-a" }),
    }, env);

    expect(response.status).toBe(200);
    const resultRows = batchRows.filter((row) => row.values);
    expect(resultRows[0]?.values?.[7]).toBe("Hello there");
  });
});
