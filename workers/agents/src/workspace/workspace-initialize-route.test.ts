import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { handleWorkspaceInitialize } from "./workspace-initialize-route.js";

describe("workspace initialization adapter", () => {
  it("forwards tenant-scoped initial entries to the coordinator", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/v1/initialize");
      expect(await request.json()).toMatchObject({ branch: "main", entries: [{ path: "index.html", sha256: "a".repeat(64) }] });
      return Response.json({ head: { branch: "main", revision: 1 }, created: true }, { status: 201 });
    });
    const response = await handleWorkspaceInitialize(new Request("http://agents/internal/workspaces/initialize", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken("secret", "tenant") },
      body: JSON.stringify({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" },
        entries: [{ path: "index.html", sha256: "a".repeat(64), size: 4, executable: false, objectKey: "workspace-v1/tenant/space/project/global/content/" + "a".repeat(64) }] }),
    }), { PLATFORM_SECRET: "secret", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ head: { revision: 1 } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an invalid tenant token before coordinator access", async () => {
    const fetch = vi.fn();
    const response = await handleWorkspaceInitialize(new Request("http://agents/internal/workspaces/initialize", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": "invalid" }, body: "{}",
    }), { PLATFORM_SECRET: "secret", WORKSPACE_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch }) } });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
