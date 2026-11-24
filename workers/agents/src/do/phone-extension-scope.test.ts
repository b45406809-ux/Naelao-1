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
async function invoke(agent: NaelaoAgentDO, valid = true, expectedInstallationId?: string, expectedHandlerSha256?: string,
  settingsRevision?: number | null, eventId = "CA" + "a".repeat(32)) {
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
        ...(expectedInstallationId !== undefined ? { expectedInstallationId } : {}),
        ...(expectedHandlerSha256 !== undefined ? { expectedHandlerSha256 } : {}),
        ...(settingsRevision !== undefined ? { settingsRevision } : {}),
        event: {
          id: eventId,
          type: "call.received",
          payload: { caller: "+15555550100" },
        },
      }),
    })
  );
}
async function invokeSimulation(agent: NaelaoAgentDO, input = "Can you help with order 42?", valid = true,
  eventType: "call.received" | "call.digits" | "call.speech" | "transcript.final" = "call.speech", digits?: string, settingsSource?: "active" | "draft") {
  const body = { spaceId: "space", bindingId: "binding", simulation: true, eventType,
    ...(settingsSource ? { settingsSource } : {}),
    ...(eventType === "call.speech" || eventType === "transcript.final" ? { input } : {}), ...(eventType === "call.digits" && digits ? { digits } : {}) };
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
        channel: { provider: "phone", settings: { schemaVersion: 2, revision: 7, values: { greeting: "Welcome" } },
          event: { payload: { provider: "twilio", speech_input_allowed: true } } },
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

  it("fences a public call to the exact installation and signed handler digest admitted at answer", async () => {
    const f = setup(null);
    expect((await invoke(f.agent, true, "replaced-install", "a".repeat(64))).status).toBe(409);
    expect((await invoke(f.agent, true, "install", "b".repeat(64))).status).toBe(409);
    expect(f.runtimeWork).not.toHaveBeenCalled();
    expect(f.runChannel).not.toHaveBeenCalled();

    const accepted = await invoke(f.agent, true, "install", "a".repeat(64));
    expect(accepted.status).toBe(200);
    expect(f.runChannel).toHaveBeenCalledOnce();
  });

  it("rechecks a customer phone-test session inside the Agent DO before routing an executive-like turn", async () => {
    const f = setup("project", "whatsapp");
    const currentAuthority = vi.fn(async () => null);
    (f.agent as unknown as { currentWhatsAppCustomerTest: typeof currentAuthority }).currentWhatsAppCustomerTest = currentAuthority;
    const text = `ad_${"f".repeat(48)}`;
    const response = await f.agent.fetch(new Request("http://agent/channels/whatsapp/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant") },
      body: JSON.stringify({ raw: { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [
        { id: "wamid-customer-test", from: "+15551234567", type: "text", text: { body: text } },
      ] } }] }] }, projectId: "project", spaceId: "space", tenantId: "tenant", taskId: "wamid-customer-test",
        extensionInstanceId: "install", extensionScriptSha256: "a".repeat(64), customerTestSessionId: "test-session",
        customerTestProviderRouteKey: "b".repeat(64), allowExecutiveRouting: false }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "customer_test_authority_changed" });
    expect(currentAuthority).toHaveBeenCalledWith(expect.objectContaining({ testSessionId: "test-session", tenantId: "tenant",
      spaceId: "space", projectId: "project", senderId: "+15551234567", providerRouteKey: "b".repeat(64),
      installationId: "install", handlerSha256: "a".repeat(64) }));
    expect(f.runChannel).not.toHaveBeenCalled();
    expect(f.runtimeWork).not.toHaveBeenCalled();
  });

  it("pins a Telnyx DTMF call to its published settings revision and fails closed on drift", async () => {
    const f = setup(null, "telnyx");
    const pin = await f.agent.fetch(new Request("http://agent/phone-extension", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant") },
      body: JSON.stringify({ spaceId: "space", bindingId: "binding", pinCall: true,
        expectedInstallationId: "install", expectedHandlerSha256: "a".repeat(64) }),
    }));
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ settings_revision: 7 });
    expect(f.internals.loadActiveChannelHandler).toHaveBeenLastCalledWith(expect.objectContaining({
      instanceId: "install", scriptSha256: "a".repeat(64), channel: "phone", inboundEvent: "call.received",
    }));
    expect(f.runtimeWork).not.toHaveBeenCalled();
    expect(f.runChannel).not.toHaveBeenCalled();

    const accepted = await invoke(f.agent, true, "install", "a".repeat(64), 7, `telnyx-call-${"a".repeat(32)}`);
    expect(accepted.status).toBe(200);
    expect(f.internals.loadActiveChannelHandler).toHaveBeenLastCalledWith(expect.objectContaining({ settingsRevision: 7 }));
    f.internals.loadActiveChannelHandler.mockResolvedValueOnce(null);
    expect((await invoke(f.agent, true, "install", "a".repeat(64), 6, `telnyx-call-${"b".repeat(32)}`)).status).toBe(409);
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
    expect(await response.json()).toEqual({ simulation: true, settings_source: "active", response: { actions: [{ type: "say", text: "Hello" }] } });
    expect(f.internals.loadActiveChannelHandler).toHaveBeenCalledWith(expect.objectContaining({ settingsSource: "active" }));
    const call = f.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ installationId: "install", channel: {
      provider: "phone",
      event: { type: "message.received", payload: { voice_event: "call.speech", speech: "Can you help with order 42?", caller: "simulation",
        provider: "twilio", speech_input_allowed: true } },
      settings: { schemaVersion: 2, revision: 7, values: { greeting: "Welcome" } },
    } });
    expect((call.channel as Record<string, unknown>).session).toBeUndefined();
    expect(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_extension_events'").toArray()).toEqual([]);
    expect(f.storage.sql.exec("SELECT COUNT(*) AS count FROM channel_extension_sessions").toArray()).toEqual([{ count: 0 }]);
    expect(f.storage.sql.exec("SELECT COUNT(*) AS count FROM channel_extension_named_sessions").toArray()).toEqual([{ count: 0 }]);

    const draft = await invokeSimulation(f.agent, "Can you help with order 42?", true, "call.speech", undefined, "draft");
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ simulation: true, settings_source: "draft" });
    expect(f.internals.loadActiveChannelHandler).toHaveBeenCalledWith(expect.objectContaining({ settingsSource: "draft" }));
    expect(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_extension_events'").toArray()).toEqual([]);

    f.internals.loadActiveChannelHandler = vi.fn(async () => null);
    expect((await invokeSimulation(f.agent)).status).toBe(409);
    expect(f.runChannel).toHaveBeenCalledTimes(2);
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
    expect(f.runChannel).toHaveBeenCalledTimes(3);
  });

  it("simulates call start and validated DTMF events through the same isolated handler", async () => {
    const start = setup(null);
    expect((await invokeSimulation(start.agent, "", true, "call.received")).status).toBe(200);
    const startCall = start.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(startCall).toMatchObject({ channel: { event: { payload: { voice_event: "call.received", caller: "simulation", provider: "twilio", speech_input_allowed: true } } } });

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

  it("simulates a Telnyx final transcript with the streaming response schema and no carrier effects", async () => {
    const f = setup(null, "telnyx");
    f.runChannel.mockImplementationOnce(async () => ({
      ok: true, channel_replies: [JSON.stringify({ schema_version: 1, actions: [
        { type: "speak", text: "I can help with that." }, { type: "listen", input: "speech", timeout_ms: 5_000 },
      ] })],
    }));
    const response = await invokeSimulation(f.agent, "Where is my order?", true, "transcript.final");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ simulation: true, settings_source: "active", response: {
      schema_version: 1, actions: [
        { type: "speak", text: "I can help with that." }, { type: "listen", input: "speech", timeout_ms: 5_000 },
      ],
    } });
    const call = f.runChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ channel: { provider: "phone", event: { payload: {
      voice_event: "transcript.final", text: "Where is my order?", provider: "telnyx",
    } } } });
    expect(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='phone_extension_events'").toArray()).toEqual([]);

    f.runChannel.mockImplementationOnce(async () => ({ ok: true, channel_replies: [JSON.stringify({ schema_version: 1,
      actions: [{ type: "transfer", target: "+263771234567" }] })] }));
    expect((await invokeSimulation(f.agent, "Transfer me", true, "transcript.final")).status).toBe(409);
  });

  it("does not persist Telnyx transcript events through a handler's durable session state", async () => {
    const f = setup(null, "telnyx");
    f.internals.loadActiveChannelHandler = vi.fn(async () => ({
      name: "voice", code: "export async function run() {}", maxConcurrency: 1, knowledgeCollections: [],
      settings: { schemaVersion: 2 as const, revision: 7, values: {} }, session: { maxBytes: 2_000, ttlDays: 30 }, limits: {},
    }));
    const privateText = "my private order and address";
    f.runChannel.mockImplementationOnce(async input => {
      const call = input as unknown as { channel: Record<string, unknown> };
      expect(call.channel).not.toHaveProperty("session");
      expect(call.channel).not.toHaveProperty("sessions");
      return { ok: true, channel_replies: [JSON.stringify({ schema_version: 1,
        actions: [{ type: "listen", input: "speech" }] })], channel_session_update: { transcript: privateText } };
    });
    const callRef = `call_${"b".repeat(32)}`;
    const response = await f.agent.fetch(new Request("http://agent/phone-extension", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant") },
      body: JSON.stringify({ spaceId: "space", bindingId: "binding", expectedInstallationId: "install",
        expectedHandlerSha256: "a".repeat(64), settingsRevision: 7,
        event: { schema_version: 1, id: `telnyx-call-${"c".repeat(32)}`, type: "transcript.final",
          payload: { call_ref: callRef, sequence: 0, text: privateText } } }),
    }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(privateText);
    const stored = f.storage.sql.exec("SELECT status,response_json FROM phone_extension_events").toArray();
    expect(stored).toEqual([{ status: "completed", response_json: null }]);
    expect(f.storage.sql.exec("SELECT COUNT(*) AS count FROM channel_extension_sessions").toArray()).toEqual([{ count: 0 }]);
    const retry = await f.agent.fetch(new Request("http://agent/phone-extension", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant",
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant") },
      body: JSON.stringify({ spaceId: "space", bindingId: "binding", expectedInstallationId: "install",
        expectedHandlerSha256: "a".repeat(64), settingsRevision: 7,
        event: { schema_version: 1, id: `telnyx-call-${"c".repeat(32)}`, type: "transcript.final",
          payload: { call_ref: callRef, sequence: 0, text: privateText } } }),
    }));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error_code: "phone_event_outcome_unknown" });
    expect(f.runChannel).toHaveBeenCalledOnce();
  });

  it("replays the non-transcript call-start response without rerunning the handler", async () => {
    const f = setup(null, "telnyx");
    f.runChannel.mockImplementationOnce(async () => ({ ok: true,
      channel_replies: [JSON.stringify({ schema_version: 1, actions: [{ type: "listen", input: "speech" }] })] }));
    const makeRequest = async () => {
      const token = await mintInternalToken(secret, "tenant");
      return new Request("http://agent/phone-extension", { method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": token },
        body: JSON.stringify({ spaceId: "space", bindingId: "binding", expectedInstallationId: "install",
          expectedHandlerSha256: "a".repeat(64), settingsRevision: 7,
          event: { schema_version: 1, id: `telnyx-call-${"d".repeat(32)}`, type: "call.started",
            payload: { call_ref: `call_${"e".repeat(32)}` } } }),
      });
    };
    const first = await f.agent.fetch(await makeRequest());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const second = await f.agent.fetch(await makeRequest());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(f.runChannel).toHaveBeenCalledOnce();
  });
});
