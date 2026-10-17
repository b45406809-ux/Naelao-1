import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import spacesWorker from "../index.js";

const secret = "channel-extension-test-secret";
function packageManifest(overrides: Record<string, unknown> = {}) {
  const channel = {
    schemaVersion: "1.0",
    kind: "channel",
    id: "student_whatsapp",
    version: "1.0.0",
    permissions: [],
    capabilityRequirements: [],
    lifecycle: {},
    provider: "whatsapp",
    connectionId: "student_channel",
    handlerScript: "./student-answer.ts",
    context: "channel_only",
    inboundEvents: ["message.received"],
    outboundEvents: ["message.reply"],
    knowledgeCollections: ["course_material"],
  };
  const bundle = {
    schemaVersion: "1.0",
    kind: "extension_bundle",
    id: "ext_trading_mentor",
    version: "1.0.0",
    primitives: [channel],
    connections: [
      {
        id: "student_channel",
        provider: "whatsapp",
        purpose: "Receive student questions",
        required: true,
      },
    ],
    knowledge: [
      {
        id: "course_material",
        purpose: "Answer from mentor-approved material",
        access: "owner_published_external",
      },
    ],
  };
  return {
    id: "ext_trading_mentor",
    type: "extension",
    declaredPermissions: [],
    capabilityRequirements: ["channel.invoke"],
    gadgets: [],
    daemons: [],
    commands: [],
    bundle,
    ...overrides,
  };
}

describe("project channel-only extension install route", () => {
  function setup(role: string) {
    const forwarded: Request[] = [];
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        forwarded.push(request);
        if (
          new URL(request.url).pathname ===
          "/projects/project-a/automation-access"
        )
          return role === "owner"
            ? Response.json({ project_id: "project-a", can_manage: true })
            : Response.json({ error_code: "forbidden" }, { status: 403 });
        return Response.json(
          {
            installed: true,
            installationId: "instance-a",
            manifest: packageManifest(),
          },
          { status: 201 }
        );
      }),
    };
    const env = {
      PLATFORM_SECRET: secret,
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    } as never;
    return { env, forwarded, stub };
  }

  async function post(
    env: unknown,
    role: string,
    manifest: unknown,
    extra: Record<string, unknown> = {}
  ) {
    const token = await mintInternalToken(secret, "tenant-a");
    return spacesWorker.fetch(
      new Request(
        "https://spaces.test/spaces/space-a/projects/project-a/channel-extensions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-internal-token": token,
            "x-naelao-tenant-id": "tenant-a",
            "x-naelao-user-id": "owner-a",
            "x-naelao-role": role,
          },
          body: JSON.stringify({
            manifest,
            installedBy: "attacker-id",
            scope: "PROJECT_BOUND",
            ...extra,
          }),
        }
      ),
      env as never
    );
  }

  it("installs only channel primitives with server-derived identity and the channel-only grant", async () => {
    const h = setup("owner");
    const response = await post(h.env, "owner", packageManifest());
    expect(response.status).toBe(201);
    const install = h.forwarded.find(
      (request) => new URL(request.url).pathname === "/extensions"
    );
    if (!install) throw new Error("extension_install_was_not_forwarded");
    expect(await install.json()).toMatchObject({
      installedBy: "owner-a",
      scope: "PROJECT_BOUND",
      projectId: "project-a",
      gatekeeperCapabilities: ["channel.invoke"],
      manifest: { bundle: { id: "ext_trading_mentor" } },
    });
  });

  it("rejects packages that mix in unsupported UI or member-level primitives", async () => {
    const h = setup("owner");
    const response = await post(
      h.env,
      "owner",
      packageManifest({
        bundle: {
          ...packageManifest().bundle,
          primitives: [
            ...packageManifest().bundle.primitives,
            {
              schemaVersion: "1.0",
              kind: "canvas",
              id: "mentor_console",
              version: "1.0.0",
              permissions: [],
              capabilityRequirements: [],
              lifecycle: {},
              layout: "CanvasMount",
              component: "./console.tsx",
              dynamicPage: false,
            },
          ],
        },
      })
    );
    expect(response.status).toBe(400);
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });

  it("rejects undeclared or unsupported provider setup requirements", async () => {
    const h = setup("owner");
    const source = packageManifest();
    const badConnections = {
      ...source,
      bundle: {
        ...source.bundle,
        connections: [
          ...source.bundle.connections,
          {
            id: "other_service",
            provider: "custom_oauth",
            purpose: "External service",
            required: true,
          },
        ],
      },
    };
    const response = await post(h.env, "owner", badConnections);
    expect(response.status).toBe(400);
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });

  it("requires an owner/admin and rejects forged install identity", async () => {
    const h = setup("member");
    const response = await post(h.env, "member", packageManifest());
    expect(response.status).toBe(403);
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });
});
