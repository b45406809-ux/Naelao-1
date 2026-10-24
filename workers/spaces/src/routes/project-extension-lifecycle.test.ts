import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../index.js";

const secret = "project-extension-lifecycle-secret";

function setup(canManage: boolean) {
  const forwarded: Request[] = [];
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      if (
        new URL(request.url).pathname ===
        "/projects/project-a/automation-access"
      ) {
        return canManage
          ? Response.json({ project_id: "project-a", can_manage: true })
          : Response.json({ error_code: "forbidden" }, { status: 403 });
      }
      if (new URL(request.url).pathname === "/container-installations") {
        return Response.json({
          installations: [{ instance: { status: "disabled" } }],
        });
      }
      return Response.json({ instance_id: "instance-a", status: "disabled" });
    }),
  };
  const env = {
    PLATFORM_SECRET: secret,
    SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
  } as never;
  return { env, forwarded, stub };
}

async function patchLifecycle(env: unknown, role: string, action = "disable") {
  return spacesWorker.fetch(
    new Request(
      "https://spaces.test/spaces/space-a/projects/project-a/extension-installations/instance-a/lifecycle",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-naelao-internal-token": await mintInternalToken(
            secret,
            "tenant-a"
          ),
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-user-id": `${role}-a`,
          "x-naelao-role": role,
        },
        body: JSON.stringify({ action }),
      }
    ),
    env as never
  );
}

describe("project extension lifecycle route", () => {
  it("authorizes a project manager by project access and forwards the exact scoped operation", async () => {
    const h = setup(true);
    const response = await patchLifecycle(h.env, "editor");
    expect(response.status).toBe(200);
    expect(h.forwarded.map((request) => new URL(request.url).pathname)).toEqual(
      ["/projects/project-a/automation-access", "/project-extension-lifecycle"]
    );
    const operation = h.forwarded[1];
    if (!operation) throw new Error("lifecycle_request_not_forwarded");
    expect(await operation.json()).toMatchObject({
      tenantId: "tenant-a",
      spaceId: "space-a",
      projectId: "project-a",
      instanceId: "instance-a",
      action: "disable",
    });
  });

  it("rejects a project viewer before any lifecycle mutation", async () => {
    const h = setup(false);
    const response = await patchLifecycle(h.env, "viewer");
    expect(response.status).toBe(403);
    expect(h.forwarded.map((request) => new URL(request.url).pathname)).toEqual(
      ["/projects/project-a/automation-access"]
    );
  });

  it("rejects unknown lifecycle actions before resolving the Durable Object", async () => {
    const h = setup(true);
    const response = await patchLifecycle(h.env, "editor", "delete");
    expect(response.status).toBe(400);
    expect(h.forwarded.map((request) => new URL(request.url).pathname)).toEqual(
      ["/projects/project-a/automation-access"]
    );
  });

  it("lets a project manager list paused installations without granting Space-wide visibility", async () => {
    const h = setup(true);
    const response = await spacesWorker.fetch(
      new Request(
        "https://spaces.test/spaces/space-a/container-installations?project_id=project-a&include_disabled=1",
        {
          headers: {
            "x-naelao-internal-token": await mintInternalToken(
              secret,
              "tenant-a"
            ),
            "x-naelao-tenant-id": "tenant-a",
            "x-naelao-user-id": "editor-a",
            "x-naelao-role": "editor",
          },
        }
      ),
      h.env as never
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      installations: [{ instance: { status: "disabled" } }],
    });
    expect(h.forwarded.map((request) => new URL(request.url).pathname)).toEqual(
      ["/projects/project-a/automation-access", "/container-installations"]
    );
  });
});
