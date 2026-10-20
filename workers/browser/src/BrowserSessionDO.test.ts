import { describe, expect, it } from "vitest";
import { BrowserSessionDO } from "./BrowserSessionDO.js";
import type { BrowserSessionRecord } from "./browser-session-state.js";

function harness(initial?: BrowserSessionRecord) {
  const values = new Map<string, unknown>();
  if (initial) values.set("browser-session", initial);
  const storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) values.delete(item); },
    async transaction<T>(callback: (storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }) => Promise<T>) { return callback(storage); },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  return { instance: new BrowserSessionDO({ storage } as never, { ENVIRONMENT: "test", PLATFORM_SECRET: "test" } as never), values };
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
});
