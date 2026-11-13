import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../index.js";

const secret = "channel-extension-uninstall-test-secret";

function setup(options: { pauseStatus?: number; removedStatus?: number; projectManage?: boolean } = {}) {
  const spaceRequests: Request[] = [];
  const agentRequests: Request[] = [];
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      spaceRequests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/projects/project-a/automation-access") {
        return options.projectManage === false
          ? Response.json({ error_code: "forbidden" }, { status: 403 })
          : Response.json({ project_id: "project-a", can_manage: true });
      }
      if (url.pathname === "/project-extension-lifecycle") {
        return options.pauseStatus === 404
          ? Response.json({ error_code: "extension_installation_not_found" }, { status: 404 })
          : Response.json({ drained: true, active_work_count: 0 });
      }
      if (url.pathname === "/workflow-installation") return Response.json({ instance: {
        project_id: "project-a", status: options.pauseStatus === 404 ? "removed" : "disabled",
      } });
      return Response.json({ removed: true }, { status: options.removedStatus ?? 200 });
    }),
  };
  const agents = {
    fetch: vi.fn(async (request: Request) => {
      agentRequests.push(request);
      return Response.json({ unboundChannels: 1, deletedConversations: 2, providerRevocations: [] });
    }),
  };
  const env = {
    PLATFORM_SECRET: secret,
    SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    AGENTS_WORKER: agents,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
  } as never;
  return { env, spaceRequests, agentRequests, stub, agents };
}

async function uninstall(env: unknown) {
  return spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/projects/project-a/channel-extensions/instance-a", {
    method: "DELETE",
    headers: {
      "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner",
    },
  }), env as never);
}

describe("project channel extension uninstall", () => {
  it("drains first, revokes installation state, passes the actor, then removes the install", async () => {
    const h = setup();
    const response = await uninstall(h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: true });
    expect(h.spaceRequests.map(request => new URL(request.url).pathname)).toEqual([
      "/projects/project-a/automation-access", "/project-extension-lifecycle", "/extension-installation",
    ]);
    const cleanup = h.agentRequests[0];
    expect(cleanup && new URL(cleanup.url).pathname).toBe("/internal/channel-extensions/session-state");
    await expect(cleanup?.json()).resolves.toMatchObject({
      spaceId: "space-a", projectId: "project-a", installationId: "instance-a", requestedBy: "owner-a", action: "uninstall",
    });
  });

  it("reconciles an ambiguous retry from the exact persisted removed installation", async () => {
    const h = setup({ pauseStatus: 404 });
    const response = await uninstall(h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, already_removed: true });
    expect(h.spaceRequests.map(request => new URL(request.url).pathname)).toEqual([
      "/projects/project-a/automation-access", "/project-extension-lifecycle", "/workflow-installation",
    ]);
    expect(h.agentRequests).toHaveLength(0);
  });

  it("does not touch Agents or the installation for a caller without project management access", async () => {
    const h = setup({ projectManage: false });
    expect((await uninstall(h.env)).status).toBe(403);
    expect(h.spaceRequests.map(request => new URL(request.url).pathname)).toEqual(["/projects/project-a/automation-access"]);
    expect(h.agentRequests).toHaveLength(0);
  });
});
