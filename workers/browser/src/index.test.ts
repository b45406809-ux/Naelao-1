import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
import { browserSessionId } from "./browser-session-state.js";
import app from "./index.js";

const scope: BrowserRuntimeScope = {
  tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", actorId: "member-a", agentId: "assistant-a",
  runId: "run-a", sessionId: "session-a", expiresAt: Date.now() + 60_000,
  authorizedOrigins: ["https://example.com"], authorizedActions: [], maxTier: 4,
};

describe("Browser worker project session erasure", () => {
  it("cancels the exact session and deletes only its screenshot prefix", async () => {
    const calls: Request[] = [], deleted: string[][] = [], prefixes: string[] = [];
    const sessionFetch = vi.fn(async (request: Request) => { calls.push(request); return Response.json({ error_code: "browser_session_not_found" }, { status: 404 }); });
    let listed = 0;
    const env = {
      PLATFORM_SECRET: "secret",
      BROWSER_SESSION_DO: { idFromName: (name: string) => name, get: (id: string) => ({ fetch: sessionFetch }) },
      BROWSER_ARTIFACTS: {
        async list({ prefix }: { prefix: string }) {
          prefixes.push(prefix);
          listed++;
          return { objects: listed === 1 ? [{ key: prefix + "revision.png" }] : [], truncated: false };
        },
        async delete(keys: string[]) { deleted.push(keys); },
      },
    };
    const token = await mintInternalToken("secret", scope.tenantId);
    const response = await app.fetch(new Request("https://browser/v1/workspace-erasure/browser-session", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify(scope),
    }), env as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionClosed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://browser-session/cancel");
    expect(await calls[0]!.clone().json()).toMatchObject({ scope });
    expect(sessionFetch).toHaveBeenCalledWith(expect.objectContaining({ url: "http://browser-session/cancel" }));
    expect(deleted).toEqual([[prefixes[0] + "revision.png"]]);
    expect(prefixes).toEqual(Array(2).fill(".perception/tenant-a/space-a/run-a/session-a/"));
    expect(await browserSessionId(scope)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a tenant mismatch before reaching a session or artifact namespace", async () => {
    const fetch = vi.fn();
    const token = await mintInternalToken("secret", scope.tenantId);
    const response = await app.fetch(new Request("https://browser/v1/workspace-erasure/browser-session", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify({ ...scope, tenantId: "tenant-b" }),
    }), { PLATFORM_SECRET: "secret", BROWSER_SESSION_DO: { get: fetch }, BROWSER_ARTIFACTS: {} } as never);
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps profile revocation pending when the current session could not be closed", async () => {
    const connected = { ...scope, connectionId: "connection-a" };
    const cancel = vi.fn(async () => Response.json({ error_code: "browser_artifact_delete_failed" }, { status: 503 }));
    const token = await mintInternalToken("secret", scope.tenantId);
    const response = await app.fetch(new Request("https://browser/v1/website-profile/revoke", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": scope.tenantId, "x-naelao-internal-token": token },
      body: JSON.stringify(connected),
    }), {
      PLATFORM_SECRET: "secret",
      WEBSITE_PROFILE_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ ok: true, activeScope: connected }) }) },
      BROWSER_SESSION_DO: { idFromName: (name: string) => name, get: () => ({ fetch: cancel }) },
    } as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "browser_session_cancel_retry_required" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
