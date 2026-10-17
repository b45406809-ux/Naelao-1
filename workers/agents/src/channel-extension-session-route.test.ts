import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { app } from "./index.js";

const secret = "channel-session-route-test-secret";

function setup(projectId = "project-a") {
  const forwarded: Request[] = [];
  const spaces = {
    fetch: vi.fn(async () =>
      Response.json({
        instance: {
          tenant_id: "tenant-a",
          space_id: "space-a",
          project_id: projectId,
          status: "active",
        },
      })
    ),
  };
  const agentStub = {
    fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({
        activeConversations: 2,
        storedBytes: 128,
        nextExpiryAt: 1_900_000_000_000,
      });
    }),
  };
  const update = vi.fn(async () => ({ meta: { changes: 1 } }));
  const env = {
    PLATFORM_SECRET: secret,
    SPACES_WORKER: spaces,
    NAELAO_AGENT_DO: {
      idFromName: (name: string) => name,
      get: () => agentStub,
    },
    PLATFORM_DB: {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: update })) })),
    },
  } as never;
  return { env, spaces, forwarded, agentStub, update };
}

async function post(
  env: unknown,
  action: "summary" | "clear" | "uninstall",
  tokenTenant = "tenant-a"
) {
  const token = await mintInternalToken(secret, tokenTenant);
  return app.request(
    "/internal/channel-extensions/session-state",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tokenTenant,
        "x-naelao-internal-token": token,
      },
      body: JSON.stringify({
        spaceId: "space-a",
        projectId: "project-a",
        installationId: "instance-a",
        action,
      }),
    },
    env as never
  );
}

describe("channel extension session-state controls", () => {
  it("checks the active installation project before reading retention metadata", async () => {
    const h = setup();
    const response = await post(h.env, "summary");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activeConversations: 2,
      storedBytes: 128,
    });
    const request = h.forwarded[0];
    if (!request) throw new Error("agent_do_request_missing");
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("project_id")).toBe(
      "project-a"
    );
    expect(new URL(request.url).searchParams.get("installation_id")).toBe(
      "instance-a"
    );
  });

  it("rejects an installation from another project without reaching its state store", async () => {
    const h = setup("project-b");
    const response = await post(h.env, "clear");
    expect(response.status).toBe(403);
    expect(h.agentStub.fetch).not.toHaveBeenCalled();
  });

  it("uses DELETE for an authorized clear request", async () => {
    const h = setup();
    const response = await post(h.env, "clear");
    expect(response.status).toBe(200);
    expect(h.forwarded[0]?.method).toBe("DELETE");
  });

  it("unbinds channels and clears saved state before an installation is removed", async () => {
    const h = setup();
    const response = await post(h.env, "uninstall");
    expect(response.status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.forwarded[0]?.method).toBe("DELETE");
  });
});
