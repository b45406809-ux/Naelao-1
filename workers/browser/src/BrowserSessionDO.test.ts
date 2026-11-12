import { describe, expect, it } from "vitest";
import { BrowserSessionDO } from "./BrowserSessionDO.js";
import type { BrowserSessionRecord } from "./browser-session-state.js";

function harness(initial?: BrowserSessionRecord, projectErasing = false) {
  const values = new Map<string, unknown>();
  const statements: string[] = [];
  if (initial) values.set("browser-session", initial);
  const database = { prepare(sql: string) {
    statements.push(sql);
    return { bind() { return {
      async first<T>() { return (projectErasing && sql.includes("workspace_erasure_tombstones") ? { status: "cleaning" } : null) as T | null; },
      async run() { return { meta: { changes: 1 } }; },
    }; } };
  } };
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) values.delete(item); },
    async deleteAll() { values.clear(); },
    async transaction<T>(callback: (storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }) => Promise<T>) { return callback(storage); },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  return { instance: new BrowserSessionDO({ storage } as never, { ENVIRONMENT: "test", PLATFORM_SECRET: "test", PLATFORM_DB: database } as never), values, statements };
}

const scope = {
  tenantId: "tenant-a", spaceId: "space-a", actorId: "member-a", agentId: "assistant",
  runId: "run-a", sessionId: "session-a", expiresAt: Date.now() + 60_000,
  authorizedOrigins: ["https://example.com"], authorizedActions: [], maxTier: 4 as const,
};

function request(path: string, requestScope: typeof scope) {
  return new Request(`http://browser/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: requestScope }),
  });
}

const projectScope = { ...scope, projectId: "project-a" };

describe("BrowserSessionDO authorization edge cases", () => {
  it("rejects malformed scope before consulting browser or membership providers", async () => {
    const { instance } = harness();
    const response = await instance.fetch(new Request("http://browser/navigate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: { ...scope, expiresAt: -1 } }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "browser_scope_invalid" });
  });

  it("does not let a different actor close an existing browser session", async () => {
    const record: BrowserSessionRecord = { scope, status: "open", engine: "kitesurf", url: "https://example.com", actions: 0, screenshots: [], lastUsedAt: Date.now() };
    const { instance, values } = harness(record);
    const response = await instance.fetch(request("cancel", { ...scope, actorId: "member-b" }));
    expect(response.status).toBe(404);
    expect(values.get("browser-session")).toMatchObject({ status: "open", scope: { actorId: "member-a" } });
  });

  it("erases session observations and action records on close while retaining a non-sensitive tombstone", async () => {
    const record: BrowserSessionRecord = { scope, status: "open", engine: "kitesurf", url: "https://example.com", actions: 1,
      screenshots: [], lastUsedAt: Date.now(), observation: { schema: 1, sessionId: scope.sessionId, revision: "rev-a", engine: "kitesurf",
        url: "https://example.com", title: "private title", text: "private page contents", elements: [], untrusted: true,
        capturedAt: Date.now(), expiresAt: Date.now() + 60_000, features: { interactive: false, pixelAccurate: false, persistentLogin: false } } };
    const { instance, values } = harness(record);
    values.set("action:action-a", { status: "committed", result: record.observation });
    const response = await instance.fetch(request("cancel", scope));
    expect(response.status).toBe(200);
    expect([...values.keys()]).toEqual(["closed"]);
    expect(JSON.stringify([...values.values()])).not.toContain("private page contents");
  });

  it("blocks project browser activity after erasure without recreating its session registry entry", async () => {
    const { instance, statements } = harness(undefined, true);
    const response = await instance.fetch(request("navigate", projectScope));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error_code: "workspace_project_erased" });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("workspace_erasure_tombstones");
  });

  it("allows cleanup cancellation through an erasure tombstone without registering new activity", async () => {
    const record: BrowserSessionRecord = { scope: projectScope, status: "open", engine: "kitesurf", url: "https://example.com", actions: 0, screenshots: [], lastUsedAt: Date.now() };
    const { instance, statements, values } = harness(record, true);
    const response = await instance.fetch(request("cancel", projectScope));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "closed" });
    expect(values.get("closed")).toBe(true);
    expect(statements.some(sql => sql.includes("INSERT INTO workspace_browser_session_registry"))).toBe(false);
  });
});
