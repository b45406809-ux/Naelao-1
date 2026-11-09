import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceCompatRead } from "./workspace-compat-route.js";

describe("internal workspace compatibility reader", () => {
  it("returns the coordinator manifest for authenticated clients when unified mode is enabled", async () => {
    const read = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/v1/read-policy") return Response.json({ mode: "coordinator" });
      expect(new URL(request.url).pathname).toBe("/v1/read");
      expect(new URL(request.url).searchParams.get("branch")).toBe("main");
      expect(new URL(request.url).searchParams.get("path")).toBe("reports/summary.txt");
      return Response.json({ head: { branch: "main", revision: 7 }, entries: [{ path: "reports/summary.txt", sha256: "a".repeat(64), size: 8, executable: false, objectKey: "workspace-v1/content/a" }] });
    });
    const response = await handleWorkspaceCompatRead(new Request("http://agents/internal/workspaces/compat-read", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" }, path: "reports/summary.txt" }),
    }), {
      PLATFORM_SECRET: "secret",
      UNIFIED_WORKSPACE_ENABLED: "true",
      WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch: read }) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canonical: true, head: { revision: 7 }, entries: [{ objectKey: "workspace-v1/content/a" }] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a cut-over project reaches the disabled global flag", async () => {
    const fetch = vi.fn(async () => Response.json({ mode: "coordinator" }));
    const response = await handleWorkspaceCompatRead(new Request("http://agents/internal/workspaces/compat-read", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" } }),
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "false", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ error_code: "workspace_global_kill_switch_active" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("allows revision-bearing shadow reads for verification without switching normal readers", async () => {
    const fetch = vi.fn(async (request: Request) => new URL(request.url).pathname === "/v1/read-policy"
      ? Response.json({ mode: "shadow" })
      : Response.json({ head: { branch: "main", revision: 2 }, entries: [] }));
    const response = await handleWorkspaceCompatRead(new Request("http://agents/internal/workspaces/compat-read", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" }, verificationOnly: true }),
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "false", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ canonical: true, head: { revision: 2 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects forged tenant calls before dispatching a coordinator read", async () => {
    const fetch = vi.fn();
    const response = await handleWorkspaceCompatRead(new Request("http://agents/internal/workspaces/compat-read", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": "invalid" }, body: "{}",
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "true", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
