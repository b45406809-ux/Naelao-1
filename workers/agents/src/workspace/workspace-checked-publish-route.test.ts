import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceCheckedPublish } from "./workspace-checked-publish-route.js";

describe("checked workspace compatibility publisher", () => {
  it("pins the current revision, stages expected-hash changes, checkpoints, and closes", async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/v1/head") { expect(url.searchParams.get("branch")).toBe("workers/agent-1"); return Response.json({ head: { revision: 8 } }); }
      if (url.pathname === "/v1/open") return Response.json({ session: { id: `ws_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`, fence: 0 }, head: { revision: 8 } });
      if (url.pathname === "/v1/checkpoint") return Response.json({ publication: { status: "published", revision: 9 } });
      return Response.json({ ok: true });
    });
    const response = await handleWorkspaceCheckedPublish(new Request("http://agents/internal/workspaces/checked-publish", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" },
        branch: "workers/agent-1", actorId: "user-1", path: "workflows/demo.ts", expectedHash: null, contentBase64: "c291cmNl", idempotencyKey: "request-1" }),
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "true", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publication: { revision: 9, status: "published" } });
    expect(calls.map((call) => call.path)).toEqual(["/v1/head", "/v1/open", "/v1/stage", "/v1/checkpoint", "/v1/close"]);
    expect(calls[1]?.body).toMatchObject({ branch: "workers/agent-1" });
    expect(calls[2]?.body).toMatchObject({ changes: [{ path: "workflows/demo.ts", expectedHash: null }] });
    expect(calls[3]?.body).toMatchObject({ baseRevision: 8, idempotencyKey: "request-1", fence: 0 });
  });

  it("rejects unauthorized and invalid-scope requests before coordinator access", async () => {
    const fetch = vi.fn();
    const response = await handleWorkspaceCheckedPublish(new Request("http://agents/internal/workspaces/checked-publish", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": "bad" }, body: "{}",
    }), { PLATFORM_SECRET: "secret", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps checked publication behind the global workspace kill switch", async () => {
    const fetch = vi.fn();
    const response = await handleWorkspaceCheckedPublish(new Request("http://agents/internal/workspaces/checked-publish", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" },
        branch: "main", actorId: "user-1", path: "index.txt", expectedHash: null, contentBase64: "eA==", idempotencyKey: "publish-disabled" }),
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "false", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error_code: "workspace_global_kill_switch_active" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
