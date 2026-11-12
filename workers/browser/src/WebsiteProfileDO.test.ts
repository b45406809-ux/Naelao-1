import { describe, expect, it } from "vitest";
import { WebsiteProfileDO } from "./WebsiteProfileDO.js";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";

const scope: BrowserRuntimeScope = {
  tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "member-a", agentId: "assistant-a",
  runId: "run-a", sessionId: "session-a", expiresAt: Date.now() + 60_000,
  authorizedOrigins: ["https://example.com"], authorizedActions: ["click"], connectionId: "connection-a", maxTier: 5,
};

function harness() {
  const values = new Map<string, unknown>();
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) values.delete(item); },
    async deleteAll() { values.clear(); },
    async setAlarm() {},
  };
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { args = next; return statement; },
      async run() { statements.push({ sql, args }); return { meta: { changes: 1 } }; },
    };
    return statement;
  } };
  const instance = new WebsiteProfileDO({ storage, blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback() } as never,
    { PLATFORM_SECRET: "test-secret", PLATFORM_DB: db } as never);
  return { instance, values, statements };
}

describe("WebsiteProfileDO project erasure inventory", () => {
  it("registers the exact connected project profile before persisting encrypted state", async () => {
    const { instance, values, statements } = harness();
    const response = await instance.fetch(new Request("http://profile/save", { method: "POST", body: JSON.stringify({
      scope, state: { cookies: [], localStorage: {} },
    }) }));
    expect(response.status).toBe(200);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("workspace_browser_profile_registry");
    expect(statements[0]!.args).toContain("tenant-a");
    expect(statements[0]!.args).toContain("project-a");
    expect(statements[0]!.args).toContain("connection-a");
    expect(values.has("sealed")).toBe(true);
  });

  it("registers project profiles on read and leaves non-project profiles out of project inventory", async () => {
    const { instance, statements } = harness();
    const loaded = await instance.fetch(new Request("http://profile/load", { method: "POST", body: JSON.stringify({ scope }) }));
    expect(loaded.status).toBe(200);
    expect(statements).toHaveLength(1);

    const { instance: spaceProfile, statements: spaceStatements } = harness();
    await spaceProfile.fetch(new Request("http://profile/load", { method: "POST", body: JSON.stringify({
      scope: { ...scope, projectId: undefined },
    }) }));
    expect(spaceStatements).toHaveLength(0);
  });
});
