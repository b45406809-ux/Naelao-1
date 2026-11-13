import { describe, it, expect, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
const secret = "phone-extension-secret";
function setup(project: string | null, provider = "twilio") {
  const runChannel = vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
    channel_replies: [
      JSON.stringify({ actions: [{ type: "say", text: "Hello" }] }),
    ],
    channel_session_update: { simulation: "must not persist" },
  }));
  const runtimeWork = vi.fn(async (request: Request) => {
    const body = await request.clone().json() as { action?: string };
    return Response.json(body.action === "acquire" ? { acquired: true } : { released: true });
  });
  const storage = createDOStorage();
  const agent = new NaelaoAgentDO(
    { storage, id: { toString: () => "agent" } } as never,
    {
      PLATFORM_SECRET: secret,
      SPACES_WORKER: { fetch: runtimeWork },
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              installation_id: "install",
              handler_sha256: "a".repeat(64),
              status: "active",
              project_id: project,
              owner_user_id: "owner",
              provider,
              policy_json: JSON.stringify({ allowSpeechInput: true }),
            }),
          }),
        }),
      },
    } as never
  );
  const internals = agent as unknown as {
    tenantSpaceSuspended: unknown;
    loadActiveChannelHandler: ReturnType<typeof vi.fn>;
    buildScriptEngineEnv: unknown;
  };
  internals.tenantSpaceSuspended = async () => false;
  internals.loadActiveChannelHandler = vi.fn(async () => ({
    name: "voice",
    code: "export async function run() {}",
    maxConcurrency: 1,
    knowledgeCollections: [],
    settings: { schemaVersion: 2 as const, revision: 7, values: { greeting: "Welcome" } },
    limits: {},
  }));
  internals.buildScriptEngineEnv = async () => ({ codeRunner: { runChannel } });
  return { agent, runChannel, internals, storage, runtimeWork };
}
async function invoke(agent: NaelaoAgentDO, valid = true) {
  return agent.fetch(
    new Request("http://agent/phone-extension", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": valid
          ? await mintInternalToken(secret, "tenant")
          : "bad",
      },
      body: JSON.stringify({
        spaceId: "space",
        bindingId: "binding",
        event: {
          id: "CA" + "a".repeat(32),
          type: "call.received",
          payload: { caller: "+15555550100" },
        },
      }),
    })
  );
}
async function invokeSimulation(agent: NaelaoAgentDO, input = "Can you help with order 42?", valid = true,
  eventType: "call.received" | "call.digits" | "call.speech" = "call.speech", digits?: string) {
  const body = { spaceId: "space", bindingId: "binding", simulation: true, eventType,
    ...(eventType === "call.speech" && input ? { input } : {}), ...(eventType === "call.digits" && digits ? { digits } : {}) };
  return agent.fetch(
    new Request("http://agent/phone-extension", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": valid ? await mintInternalToken(secret, "tenant") : "bad",
      },
      body: JSON.stringify(body),
    })
  );
}
describe("phone extension scope dispatch", () => {
  it.each([null, "project"])(
    "dispatches scope %s through the existing restricted executor without owner authority",
    async (project) => {
      const f = setup(project);
      expect((await invoke(f.agent)).status).toBe(200);
      expect(f.internals.loadActiveChannelHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: "space",
          tenantId: "tenant",
          channel: "phone",
          ...(project ? { projectId: project } : {}),
        })
      );
      const input = f.runChannel.mock.calls[0]?.[0] as unknown as Record<
        string,
        unknown
      >;
      expect(input).not.toHaveProperty("userId");
      expect(input).not.toHaveProperty("callerRole");
      expect(input).toMatchObject({
        tenantId: "tenant",
        spaceId: "space",
        installationId: "install",
        channel: { provider: "phone", settings: { schemaVersion: 2, revision: 7, values: { greeting: "Welcome" } } },
      });
      expect(f.runtimeWork.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
        "/internal/extensions/runtime-work", "/internal/extensions/runtime-work",
      ]);
      expect(await f.runtimeWork.mock.calls[0]?.[0].clone().json()).toMatchObject({ action: "acquire", instanceId: "install", workKind: "phone_call" });
      expect(await f.runtimeWork.mock.calls[1]?.[0].clone().json()).toMatchObject({ action: "release", instanceId: "install", workKind: "phone_call" });
    }
  );

  it("returns the durable phone event receipt before requesting another runtime lease", async () => {
    const f = setup("project");
    expect((await invoke(f.agent)).status).toBe(200);
    expect(f.runtimeWork).toHaveBeenCalledTimes(2);
    f.runtimeWork.mockClear();

    const replay = await invoke(f.agent);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ response: { actions: [{ type: "say", text: "Hello" }] } });
    expect(f.runChannel).toHaveBeenCalledOnce();
    expect(f.runtimeWork).not.toHaveBeenCalled();
  });
  it("rejects unsigned dispatch and an unavailable installed handler", async () => {
    const f = setup(null);
    expect((await invoke(f.agent, false)).status).toBe(403);
    f.internals.loadActiveChannelHandler = vi.fn(async () => null);
    expect((await invoke(f.agent)).status).toBe(409);
    expect(f.runChannel).not.toHaveBeenCalled();
  });

  it("does not execute a phone handler when its installation is paused", async () => {
    const f = setup(null);
    f.runtimeWork.mockImplementationOnce(async () => Response.json({ error_code: "extension_installation_inactive" }, { status: 409 }));
    const response = await invoke(f.agent);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error_code: "phone_extension_paused" });
    expect(f.runChannel).not.toHaveBeenCalled();
    expect(f.storage.sql.exec("SELECT status FROM phone_extension_events").toArray()).toEqual([]);
  });

  it("simulates synthetic speech in the bounded isolate without call receipts or saved sessions", async () => {
    const f = setup(null);
    const response = await invokeSimulation(f.agent);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ simulation: true, response: { actions: [{ type: "say", text: "Hello" }] } });
    const call = f.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ installationId: "install", channel: {
      provider: "phone",
      event: { type: "message.received", payload: { voice_event: "call.speech", speech: "Can you help with order 42?", caller: "simulation" } },
      settings: { schemaVersion: 2, revision: 7, values: { greeting: "Welcome" } },
    } });
    expect((call.channel as Record<string, unknown>).session).toBeUndefined();
    expect(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_extension_events'").toArray()).toEqual([]);
    expect(f.storage.sql.exec("SELECT COUNT(*) AS count FROM channel_extension_sessions").toArray()).toEqual([{ count: 0 }]);
    expect(f.storage.sql.exec("SELECT COUNT(*) AS count FROM channel_extension_named_sessions").toArray()).toEqual([{ count: 0 }]);

    f.internals.loadActiveChannelHandler = vi.fn(async () => null);
    expect((await invokeSimulation(f.agent)).status).toBe(409);
    expect(f.runChannel).toHaveBeenCalledTimes(1);
    expect((await invokeSimulation(f.agent, "", false)).status).toBe(403);
    expect((await invokeSimulation(f.agent, "x".repeat(2_001))).status).toBe(400);

    f.internals.loadActiveChannelHandler = vi.fn(async () => ({
      name: "voice", code: "export async function run() {}", maxConcurrency: 1, knowledgeCollections: [],
      limits: {},
    }));
    f.runChannel.mockImplementationOnce(async () => ({
      ok: true, channel_replies: [JSON.stringify({ actions: [{ type: "say", text: "x".repeat(9_000) }] })],
      channel_session_update: { simulation: "still not saved" },
    }));
    expect((await invokeSimulation(f.agent)).status).toBe(409);
    expect(f.runChannel).toHaveBeenCalledTimes(2);
  });

  it("simulates call start and validated DTMF events through the same isolated handler", async () => {
    const start = setup(null);
    expect((await invokeSimulation(start.agent, "", true, "call.received")).status).toBe(200);
    const startCall = start.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(startCall).toMatchObject({ channel: { event: { payload: { voice_event: "call.received", caller: "simulation" } } } });

    const digit = setup(null);
    expect((await invokeSimulation(digit.agent, "", true, "call.digits", "1")).status).toBe(200);
    const digitCall = digit.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(digitCall).toMatchObject({ channel: { event: { payload: { voice_event: "call.digits", digits: "1", caller: "simulation" } } } });
    expect(digit.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_extension_events'").toArray()).toEqual([]);

    expect((await invokeSimulation(setup(null).agent, "", true, "call.digits")).status).toBe(400);
    const telnyx = setup(null, "telnyx");
    expect((await invokeSimulation(telnyx.agent, "speech", true, "call.speech")).status).toBe(400);
    telnyx.runChannel.mockImplementationOnce(async () => ({
      ok: true,
      channel_replies: [JSON.stringify({ schema_version: 1, actions: [{ type: "gather", input: "speech", text: "Speak now" }] })],
    }));
    expect((await invokeSimulation(telnyx.agent, "", true, "call.received")).status).toBe(409);
  });
});
