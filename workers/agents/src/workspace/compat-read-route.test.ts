import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceCompatRead } from "./workspace-compat-route.js";

describe("internal workspace compatibility reader", () => {
  it("returns the coordinator manifest for authenticated clients when unified mode is enabled", async () => {
    const read = vi.fn(async (request: Request) => {
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
    expect(read).toHaveBeenCalledOnce();
  });

  it("never contacts the coordinator while unified mode is disabled", async () => {
    const response = await handleWorkspaceCompatRead(new Request("http://agents/internal/workspaces/compat-read", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") }, body: "{}",
    }), { PLATFORM_SECRET: "secret", UNIFIED_WORKSPACE_ENABLED: "false" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canonical: false });
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
