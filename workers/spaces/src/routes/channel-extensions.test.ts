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
  function setup(role: string, handlerValid = true) {
    const forwarded: Request[] = [];
    const usageEvents: Record<string, unknown>[] = [];
    const artifacts = new Map<string, string>();
    const bucket = {
      get: async (key: string) => {
        const value = artifacts.get(key);
        return value === undefined ? null : {
          size: new TextEncoder().encode(value).byteLength,
          text: async () => value,
          arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        };
      },
      head: async (key: string) => (artifacts.has(key) ? { key } : null),
      put: async (key: string, value: string) => {
        artifacts.set(key, value);
      },
    };
    const agents = {
      fetch: vi.fn(async () =>
        handlerValid
          ? Response.json({ valid: true, digest: "a".repeat(64) })
          : Response.json(
              { error_code: "code_run_export_required" },
              { status: 400 }
            )
      ),
    };
    const billing = { fetch: vi.fn(async (request: Request) => {
      usageEvents.push(await request.json() as Record<string, unknown>);
      return Response.json({ recorded: true });
    }) };
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
      SCRIPTS_R2: bucket,
      AGENTS_WORKER: agents,
      BILLING_WORKER: billing,
      SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
    } as never;
    return { env, forwarded, stub, artifacts, agents, usageEvents, billing };
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

  it("stores uploaded handler source separately under the immutable package version", async () => {
    const h = setup("owner");
    const source =
      "export async function run(_args, ctx) { return await ctx.channel.answer({ question: 'help' }); }";
    const response = await post(h.env, "owner", packageManifest(), {
      handlerSources: { "./student-answer.ts": source },
    });
    expect(response.status).toBe(201);
    expect(
      h.artifacts.get(
        "spaces/space-a/extensions/ext_trading_mentor/1.0.0/student-answer.ts"
      )
    ).toBe(source);
    expect(h.agents.fetch).toHaveBeenCalledTimes(1);
    expect(h.usageEvents).toEqual([expect.objectContaining({ event_type: "storage_bytes_written", quantity: new TextEncoder().encode(source).byteLength,
      project_id: "project-a", payer_kind: "unknown", idempotency_key: "extension-artifact:space-a:ext_trading_mentor:1.0.0:./student-answer.ts" })]);
  });

  it("does not meter immutable artifacts again when the same release is reinstalled", async () => {
    const h = setup("owner");
    const source = "export async function run(_args, ctx) { return await ctx.channel.answer({ question: 'help' }); }";
    const first = await post(h.env, "owner", packageManifest(), { handlerSources: { "./student-answer.ts": source } });
    const second = await post(h.env, "owner", packageManifest(), { handlerSources: { "./student-answer.ts": source } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(h.usageEvents).toHaveLength(1);
  });

  it("rejects source paths outside the package channel declarations", async () => {
    const h = setup("owner");
    const response = await post(h.env, "owner", packageManifest(), {
      handlerSources: { "../student-answer.ts": "export function run() {}" },
    });
    expect(response.status).toBe(400);
    expect(h.artifacts.size).toBe(0);
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });

  it("does not allow a package version to be overwritten with different handler code", async () => {
    const h = setup("owner");
    h.artifacts.set(
      "spaces/space-a/extensions/ext_trading_mentor/1.0.0/student-answer.ts",
      "old source"
    );
    const response = await post(h.env, "owner", packageManifest(), {
      handlerSources: { "./student-answer.ts": "new source" },
    });
    expect(response.status).toBe(409);
    expect(
      h.artifacts.get(
        "spaces/space-a/extensions/ext_trading_mentor/1.0.0/student-answer.ts"
      )
    ).toBe("old source");
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });

  it("rejects handler code that fails the dynamic compiler before storing it", async () => {
    const h = setup("owner", false);
    const response = await post(h.env, "owner", packageManifest(), {
      handlerSources: { "./student-answer.ts": "export function other() {}" },
    });
    expect(response.status).toBe(400);
    expect(h.artifacts.size).toBe(0);
    expect(
      h.forwarded.some(
        (request) => new URL(request.url).pathname === "/extensions"
      )
    ).toBe(false);
  });
});
