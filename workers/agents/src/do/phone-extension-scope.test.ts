import { describe, it, expect, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
const secret = "phone-extension-secret";
function setup(project: string | null) {
  const runChannel = vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
    channel_replies: [
      JSON.stringify({ actions: [{ type: "say", text: "Hello" }] }),
    ],
    channel_session_update: { simulation: "must not persist" },
  }));
  const storage = createDOStorage();
  const agent = new NaelaoAgentDO(
    { storage, id: { toString: () => "agent" } } as never,
    {
      PLATFORM_SECRET: secret,
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              installation_id: "install",
              handler_sha256: "a".repeat(64),
              status: "active",
              project_id: project,
              owner_user_id: "owner",
              provider: "twilio",
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
  return { agent, runChannel, internals, storage };
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
async function invokeSimulation(agent: NaelaoAgentDO, input = "Can you help with order 42?", valid = true) {
  return agent.fetch(
    new Request("http://agent/phone-extension", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": valid ? await mintInternalToken(secret, "tenant") : "bad",
      },
      body: JSON.stringify({ spaceId: "space", bindingId: "binding", simulation: true, input }),
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
    }
  );
  it("rejects unsigned dispatch and an unavailable installed handler", async () => {
    const f = setup(null);
    expect((await invoke(f.agent, false)).status).toBe(403);
    f.internals.loadActiveChannelHandler = vi.fn(async () => null);
    expect((await invoke(f.agent)).status).toBe(409);
    expect(f.runChannel).not.toHaveBeenCalled();
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
});
