import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mintInternalToken } from "@naelao/http";
import { registerAssistantVoiceRoutes } from "./assistant-voice.js";
import type { Env } from "../index.js";
describe("assistant voice gateway", () => {
  const app = new Hono<{ Bindings: Env }>(); registerAssistantVoiceRoutes(app);
  function env(projectRole = "owner") {
    const calls: string[] = [];
    return { calls, bindings: {
      PLATFORM_SECRET: "voice-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "s" }) }) }) },
      SPACE_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => {
        calls.push(r.url);
        return Response.json(r.url.includes("assistant-access") ? { effective_role: projectRole } : { revision: 1 });
      } }) },
    } as unknown as Env };
  }
  async function request(role: string, method = "GET", query = "", token = true) {
    return new Request(`http://spaces/spaces/s/assistant-voice${query}`, { method,
      headers: { "x-naelao-tenant-id": "t", "x-naelao-user-id": "u", "x-naelao-role": role,
        ...(token ? { "x-naelao-internal-token": await mintInternalToken("voice-secret", "t") } : {}) },
      ...(method === "PATCH" ? { body: JSON.stringify({ revision: 0, preferences: { enabled: true } }) } : {}) });
  }
  it("rejects unsigned callers and ordinary members before settings mutation", async () => {
    const { bindings, calls } = env();
    expect((await app.fetch(await request("owner", "GET", "", false), bindings)).status).toBe(403);
    expect((await app.fetch(await request("member", "PATCH"), bindings)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("allows Space admins and Project owners, denying Project viewers", async () => {
    const allowed = env();
    expect((await app.fetch(await request("owner", "PATCH"), allowed.bindings)).status).toBe(200);
    expect((await app.fetch(await request("member", "PATCH", "?project_id=p"), allowed.bindings)).status).toBe(200);
    const denied = env("viewer");
    expect((await app.fetch(await request("member", "PATCH", "?project_id=p"), denied.bindings)).status).toBe(403);
    expect(denied.calls.every(p => p.includes("assistant-access"))).toBe(true);
  });
});
