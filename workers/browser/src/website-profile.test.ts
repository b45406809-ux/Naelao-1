import { describe, it, expect } from "vitest";
import { sealProfile, openProfile, profileOwner } from "./website-profile.js";
import { WebsiteProfileDO } from "./WebsiteProfileDO.js";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
const scope: BrowserRuntimeScope = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "owner",
  agentId: "agent",
  projectId: "project",
  runId: "run",
  sessionId: "session",
  connectionId: "connection",
  expiresAt: Date.now() + 600000,
  maxTier: 5,
  authorizedOrigins: ["https://example.com"],
  authorizedActions: ["click"],
};
const state = {
  cookies: [{ name: "session", value: "secret-token", domain: "example.com" }],
  localStorage: {
    "https://example.com": [["auth", "private-token"] as [string, string]],
  },
};
function profile() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
    deleteAll: async () => data.clear(),
    setAlarm: async () => {},
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  };
  const object = new WebsiteProfileDO(
    ctx as never,
    { PLATFORM_SECRET: "test-secret" } as never
  );
  return {
    data,
    object,
    send: (operation: string, s = scope, saved?: typeof state) =>
      object.fetch(
        new Request("http://profile/" + operation, {
          method: "POST",
          body: JSON.stringify({ scope: s, state: saved }),
        })
      ),
  };
}
describe("durable website accounts", () => {
  it("encrypts secrets and binds decryption to the exact user/project connection", async () => {
    const owner = profileOwner(scope),
      sealed = await sealProfile("test-secret", owner, state);
    expect(JSON.stringify(sealed)).not.toContain("secret-token");
    expect(await openProfile("test-secret", owner, sealed)).toEqual(state);
    for (const changed of [
      { actorId: "other" },
      { projectId: "other" },
      { spaceId: "other" },
      { connectionId: "other" },
      { tenantId: "other" },
    ])
      await expect(
        openProfile(
          "test-secret",
          profileOwner({ ...scope, ...changed }),
          sealed
        )
      ).rejects.toThrow();
    await expect(openProfile("different-key", owner, sealed)).rejects.toThrow();
  });
  it("bounds persisted state before encryption", async () => {
    await expect(
      sealProfile("secret", "owner", {
        cookies: ["x".repeat(65000)],
        localStorage: {},
      })
    ).rejects.toThrow("storage_limit");
  });
  it("restores a saved login for a new task only after the previous task releases it", async () => {
    const p = profile();
    expect((await p.send("load")).status).toBe(200);
    await p.send("save", scope, state);
    expect(JSON.stringify([...p.data.values()])).not.toContain("secret-token");
    const next = { ...scope, runId: "next-run", sessionId: "next-session" };
    expect((await p.send("load", next)).status).toBe(409);
    await p.send("release", next);
    expect((await p.send("load", next)).status).toBe(409);
    await p.send("release");
    expect(await (await p.send("load", next)).json()).toEqual({ state });
  });
  it("revocation erases saved credentials and blocks writes from a stale browser", async () => {
    const p = profile();
    await p.send("save", scope, state);
    await p.send("revoke");
    expect(p.data.has("sealed")).toBe(false);
    expect((await p.send("save", scope, state)).status).toBe(403);
  });
  it("expires idle profiles without retaining credentials", async () => {
    const p = profile();
    await p.send("save", scope, state);
    await p.object.alarm();
    expect(p.data.size).toBe(0);
  });
});
