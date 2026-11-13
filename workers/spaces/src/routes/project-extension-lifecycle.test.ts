import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../index.js";

const secret = "project-extension-lifecycle-secret";

function setup(canManage: boolean, canRead = canManage) {
  const forwarded: Request[] = [];
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      if (new URL(request.url).pathname === "/projects/project-a/automation-access") {
        const allowed = new URL(request.url).searchParams.get("access") === "read" ? canRead : canManage;
        return allowed
          ? Response.json({ project_id: "project-a", can_manage: true })
          : Response.json({ error_code: "forbidden" }, { status: 403 });
      }
      if (new URL(request.url).pathname === "/container-installations") {
        return Response.json({
          installations: [{ instance: { status: "disabled" } }],
        });
      }
      if (new URL(request.url).pathname === "/extension-settings") {
        if (request.method === "PATCH" && request.headers.get("x-naelao-project-manage") !== "1") return Response.json({ error_code: "forbidden" }, { status: 403 });
        return Response.json({ revision: 0, settings: {}, can_configure: request.headers.get("x-naelao-project-manage") === "1" });
      }
      return Response.json({ instance_id: "instance-a", status: "disabled" });
    }),
  };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ name: "Space A", spacetype_id: "general", config_json: null }) }) }) },
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

async function projectSettings(env: unknown, role: string, method: "GET" | "PATCH" = "GET") {
  return spacesWorker.fetch(new Request(
    "https://spaces.test/spaces/space-a/projects/project-a/extension-installations/installation:tenant:extension:project/settings",
    { method, headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"),
      "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": `${role}-a`, "x-naelao-role": role },
      ...(method === "PATCH" ? { body: JSON.stringify({ settings: { greeting: "Hello" }, revision: 0 }) } : {}) }), env as never);
}

async function projectSettingsAudit(env: unknown, role: string) {
  return spacesWorker.fetch(new Request(
    "https://spaces.test/spaces/space-a/projects/project-a/extension-installations/installation-a/settings-audit",
    { headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": `${role}-a`, "x-naelao-role": role } }), env as never);
}

async function spaceSettingsAudit(env: unknown, role: string) {
  return spacesWorker.fetch(new Request(
    "https://spaces.test/spaces/space-a/extension-installations/instance-a/settings-audit",
    { headers: { "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a"), "x-naelao-tenant-id": "tenant-a",
      "x-naelao-user-id": `${role}-a`, "x-naelao-role": role } }), env as never);
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

  it("allows readable project members to review exact installation settings but only managers to change them", async () => {
    const readOnly = setup(false, true);
    const read = await projectSettings(readOnly.env, "editor");
    expect(await read.json()).toMatchObject({ revision: 0, can_configure: false });
    expect(readOnly.forwarded.map(request => new URL(request.url).pathname)).toEqual([
      "/projects/project-a/automation-access", "/projects/project-a/automation-access", "/extension-settings",
    ]);
    expect(readOnly.forwarded.at(-1)?.headers.get("x-naelao-project-read")).toBe("1");
    expect(readOnly.forwarded.at(-1)?.headers.get("x-naelao-project-manage")).toBeNull();

    const deniedWrite = setup(false, true);
    expect((await projectSettings(deniedWrite.env, "editor", "PATCH")).status).toBe(403);
    expect(deniedWrite.forwarded.map(request => new URL(request.url).pathname)).toEqual([
      "/projects/project-a/automation-access", "/projects/project-a/automation-access", "/extension-settings",
    ]);

    const manager = setup(true);
    const write = await projectSettings(manager.env, "editor", "PATCH");
    expect(write.status).toBe(200);
    const forwarded = manager.forwarded.at(-1);
    expect(forwarded && new URL(forwarded.url).pathname).toBe("/extension-settings");
    expect(forwarded?.headers.get("x-naelao-project-manage")).toBe("1");
    await expect(forwarded?.json()).resolves.toMatchObject({ settings: { greeting: "Hello" }, revision: 0 });
  });

  it("limits project settings history to readable project managers", async () => {
    const viewer = setup(false, false);
    expect((await projectSettingsAudit(viewer.env, "viewer")).status).toBe(403);
    expect(viewer.forwarded.map(request => new URL(request.url).pathname)).toEqual(["/projects/project-a/automation-access"]);

    const manager = setup(true);
    expect((await projectSettingsAudit(manager.env, "editor")).status).toBe(200);
    expect(manager.forwarded.map(request => new URL(request.url).pathname)).toEqual([
      "/projects/project-a/automation-access", "/projects/project-a/automation-access", "/extension-settings-audit",
    ]);
    expect(manager.forwarded.at(-1)?.headers.get("x-naelao-project-manage")).toBe("1");
    expect(manager.forwarded.at(-1)?.headers.get("x-naelao-project-read")).toBe("1");
  });

  it("limits Space-shared settings history to owner and admin roles", async () => {
    const member = setup(false);
    expect((await spaceSettingsAudit(member.env, "member")).status).toBe(403);
    expect(member.forwarded).toHaveLength(0);

    const admin = setup(true);
    expect((await spaceSettingsAudit(admin.env, "admin")).status).toBe(200);
    expect(admin.forwarded.map(request => new URL(request.url).pathname)).toEqual(["/extension-settings-audit"]);
    expect(admin.forwarded[0]?.headers.get("x-naelao-role")).toBe("admin");
  });
});
