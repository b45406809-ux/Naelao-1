import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity } from "./core.js";
import { defaultPhonePolicy, type AssistantPhoneBinding } from "./phones.js";
import { dispatchTelnyxVoiceEvent } from "./telnyx-live-calls.js";

afterEach(() => vi.unstubAllGlobals());

describe("Telnyx live call command contract", () => {
  it("uses the current provider-qualified voice and millisecond gather fields", async () => {
    const f = fixture();
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100",
    }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'assistant','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("binding-1", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='binding-1'").first<AssistantPhoneBinding>();
    expect(binding).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    await f.db.prepare("INSERT INTO assistant_live_calls(id,binding_id,tenant_id,space_id,user_id,caller_role,session_id,code_hash,status,expires_at,created_at) VALUES('live-1','binding-1',?,?,?,'owner','session-1','hash','armed',?,?)")
      .bind(scope.tenantId, scope.spaceId, scope.userId, now + 300, now).run();
    await f.db.prepare("INSERT INTO assistant_telnyx_live_calls(call_control_id,binding_id,live_call_id,state,created_at,updated_at) VALUES('v3:call-control-1','binding-1','live-1','answering',?,?)")
      .bind(now, now).run();

    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const result = await dispatchTelnyxVoiceEvent(
      f.env as AgentsEnv,
      binding!,
      identity,
      { eventId: "answered-1", eventType: "call.answered", payload: { call_control_id: "v3:call-control-1" } },
    );

    expect(result).toMatchObject({ accepted: true, awaiting_code: true });
    expect(carrier).toHaveBeenCalledTimes(1);
    const [url, init] = carrier.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telnyx.com/v2/calls/v3%3Acall-control-1/actions/gather_using_speak");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      voice: "AWS.Polly.Joanna",
      language: "en-US",
      minimum_digits: 8,
      maximum_digits: 8,
      timeout_millis: 15_000,
      inter_digit_timeout_millis: 5_000,
      command_id: expect.stringContaining("code"),
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("timeout_secs");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("inter_digit_timeout_secs");
  });

  it("runs public calls through a durable extension-only DTMF session, never the owner voice bridge", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100",
    }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("public-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('public-extension','ext-1',?,'active')")
      .bind("a".repeat(64)).run();

    const extensionEvents: Array<{ event: { id: string; type: string; payload: Record<string, unknown> } }> = [];
    const extensionBodies: Array<Record<string, unknown>> = [];
    const extension = vi.fn(async (request: Request) => {
      const body = await request.json() as { pinCall?: boolean; settingsRevision?: number | null; expectedInstallationId?: string;
        expectedHandlerSha256?: string; event?: { id: string; type: string; payload: Record<string, unknown> } };
      extensionBodies.push(body);
      if (body.pinCall) return Response.json({ settings_revision: 7 });
      if (body.event) extensionEvents.push(body as { event: { id: string; type: string; payload: Record<string, unknown> } });
      if (body.event?.type === "call.received") return Response.json({ response: { schema_version: 1, actions: [
        { type: "say", text: "Welcome." }, { type: "gather", input: "dtmf", digits: 1, text: "Press one for support." },
      ] } });
      return Response.json({ response: { actions: [{ type: "hangup" }] } });
    });
    f.env.AGENTS_WORKER = { fetch: extension } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='public-extension'").first<AssistantPhoneBinding>();
    expect(binding).not.toBeNull();
    const callControlId = "v3:public-call-control";
    const initiated = await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "public-event-1", eventType: "call.initiated", payload: { call_control_id: callControlId, direction: "incoming", from: { phone_number: "+14155550101" }, to: { phone_number: "+14155550100" } },
    });
    expect(initiated).toMatchObject({ accepted: true, extension_call: true });
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM assistant_telnyx_extension_stream_sessions").first()).toEqual({ n: 0 });
    expect(await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "public-event-1-retry", eventType: "call.initiated", payload: { call_control_id: callControlId, direction: "incoming", from: { phone_number: "+14155550101" }, to: { phone_number: "+14155550100" } },
    })).toMatchObject({ accepted: true, duplicate: true });
    expect(extensionBodies.filter(body => body.pinCall)).toHaveLength(1);
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "public-event-2", eventType: "call.answered", payload: { call_control_id: callControlId },
    });
    const gatherAction = JSON.parse(String(carrier.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(gatherAction).toMatchObject({ payload: "Welcome. Press one for support.", minimum_digits: 1, maximum_digits: 1, voice: "AWS.Polly.Joanna" });
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "public-event-3", eventType: "call.gather.ended", payload: { call_control_id: callControlId, digits: "1" },
    });
    expect(JSON.parse(String(carrier.mock.calls[2]?.[1]?.body))).toMatchObject({ command_id: expect.stringContaining("extension_hangup") });
    expect(extension).toHaveBeenCalledTimes(3); // call-start settings pin plus two DTMF handler turns
    const firstCall = extensionEvents[0]!;
    expect(firstCall.event).toMatchObject({ type: "call.received", payload: { caller: "+14155550101", voice_event: "call.received" } });
    expect(firstCall.event.id).toMatch(/^telnyx-call-[a-f0-9]{32}$/);
    expect(firstCall.event.payload).not.toHaveProperty("call_control_id");
    const secondCall = extensionEvents[1]!;
    expect(secondCall.event).toMatchObject({ type: "call.digits", payload: { digits: "1" } });
    expect(extensionBodies[0]).toMatchObject({ pinCall: true, expectedInstallationId: "ext-1", expectedHandlerSha256: "a".repeat(64) });
    expect(extensionBodies.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ settingsRevision: 7, expectedInstallationId: "ext-1", expectedHandlerSha256: "a".repeat(64) }),
    ]));
    expect(await f.db.prepare("SELECT state,extension_installation_id,handler_sha256,settings_revision,settings_pinned FROM assistant_telnyx_extension_calls WHERE call_control_id=?").bind(callControlId).first())
      .toEqual({ state: "ended", extension_installation_id: "ext-1", handler_sha256: "a".repeat(64), settings_revision: 7, settings_pinned: 1 });
    await f.db.prepare("UPDATE assistant_phone_extension_handlers SET installation_id='ext-2',handler_sha256=? WHERE binding_id='public-extension'")
      .bind("b".repeat(64)).run();
    expect(await f.db.prepare("SELECT extension_installation_id,handler_sha256 FROM assistant_telnyx_extension_calls WHERE call_control_id=?").bind(callControlId).first())
      .toEqual({ extension_installation_id: "ext-1", handler_sha256: "a".repeat(64) });
    await f.db.prepare("UPDATE assistant_telnyx_extension_calls SET updated_at=? WHERE call_control_id=?")
      .bind(Math.floor(Date.now() / 1000) - 8 * 86_400, callControlId).run();
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "public-event-cleanup", eventType: "call.initiated", payload: { call_control_id: "v3:cleanup-control", direction: "incoming", from: { phone_number: "+14155550102" }, to: { phone_number: "+14155550100" } },
    });
    expect(await f.db.prepare("SELECT call_control_id FROM assistant_telnyx_extension_calls WHERE call_control_id=?").bind(callControlId).first()).toBeNull();
    expect(await f.db.prepare("SELECT call_control_id FROM assistant_telnyx_live_calls").first()).toBeNull();
    expect(await f.db.prepare("SELECT id FROM assistant_live_calls").first()).toBeNull();
  });

  it("records caller consent before creating a Telnyx stream ticket and preserves keypad fallback", async () => {
    const f = fixture();
    f.env.TELNYX_EXTENSION_STREAMING_ENABLED = "true";
    f.fetch.mockImplementation((request: Request) => Promise.resolve(request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } })));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100",
    }) })) } as unknown as Fetcher;
    await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')`)
      .bind("consent-extension", identity.id, JSON.stringify({ ...defaultPhonePolicy, allowTelnyxExtensionVoice: true })).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('consent-extension','ext-1',?,'active')")
      .bind("a".repeat(64)).run();
    f.env.AGENTS_WORKER = { fetch: vi.fn(async request => {
      const body = await request.json() as { pinCall?: boolean };
      return body.pinCall ? Response.json({ settings_revision: 7 }) : Response.json({ response: { actions: [
        { type: "say", text: "Welcome." }, { type: "gather", input: "dtmf", digits: 1, text: "Press one." },
      ] } });
    }) } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='consent-extension'").first<AssistantPhoneBinding>();
    const call = async (callControlId: string, digits: string) => {
      await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: `${callControlId}-1`, eventType: "call.initiated",
        payload: { call_control_id: callControlId, direction: "incoming", from: "+14155550101", to: "+14155550100" } });
      await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: `${callControlId}-2`, eventType: "call.answered",
        payload: { call_control_id: callControlId } });
      return dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: `${callControlId}-3`, eventType: "call.gather.ended",
        payload: { call_control_id: callControlId, digits } });
    };

    expect(await call("consent-yes", "1")).toMatchObject({ accepted: true, gathering: true });
    expect(await call("consent-no", "2")).toMatchObject({ accepted: true, gathering: true });
    const sessions = await f.db.prepare(`SELECT call_control_id,consent_state,state,media_ticket_sha256
      FROM assistant_telnyx_extension_stream_sessions ORDER BY call_control_id`).all();
    expect(sessions.results).toEqual([
      expect.objectContaining({ call_control_id: "consent-no", consent_state: "denied", state: "ended", media_ticket_sha256: null }),
      expect.objectContaining({ call_control_id: "consent-yes", consent_state: "granted", state: "ready", media_ticket_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(carrier.mock.calls.some(([url]) => String(url).includes("/actions/streaming_start"))).toBe(false);
    const gathered = carrier.mock.calls.filter(([url]) => String(url).includes("/actions/gather_using_speak"));
    expect(gathered).toHaveLength(4);
    expect(JSON.parse(String(gathered[0]?.[1]?.body))).toMatchObject({ minimum_digits: 1, maximum_digits: 1, valid_digits: "12" });
  });

  it("rejects public extension calls atomically at the per-binding concurrency ceiling", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({
      apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100",
    }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("concurrency-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('concurrency-extension','ext-1',?,'active')")
      .bind("a".repeat(64)).run();
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 5; index++) {
      await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
        started_at,expires_at,created_at,updated_at,extension_installation_id,handler_sha256,settings_revision,settings_pinned)
        VALUES(?,?,'+14155550101','answering',0,?,?,?,?,'ext-1',?,0,1)`)
        .bind(`active-${index}`, "concurrency-extension", now, now + 120, now, now, "a".repeat(64)).run();
    }
    f.env.AGENTS_WORKER = { fetch: vi.fn(async () => Response.json({ settings_revision: 0 })) } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='concurrency-extension'").first<AssistantPhoneBinding>();

    const result = await dispatchTelnyxVoiceEvent(f.env, binding!, identity, {
      eventId: "at-cap", eventType: "call.initiated", payload: {
        call_control_id: "new-call", direction: "incoming", from: "+14155550102", to: "+14155550100",
      },
    });

    expect(result).toMatchObject({ accepted: true, rejected: "extension_concurrency_limit" });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM assistant_telnyx_extension_calls WHERE binding_id='concurrency-extension'").first())
      .toEqual({ count: 5 });
    expect(String(carrier.mock.calls.at(-1)?.[0])).toContain("/actions/hangup");
    expect(JSON.parse(String(carrier.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ command_id: expect.stringContaining("extension_concurrency_limit") });
  });

  it("hangs up extension responses that request unsupported speech collection", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("public-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('public-extension','ext-1',?,'active')").bind("a".repeat(64)).run();
    f.env.AGENTS_WORKER = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as { pinCall?: boolean };
      return body.pinCall ? Response.json({ settings_revision: null })
        : Response.json({ response: { actions: [{ type: "gather", input: "speech", text: "Say what you need." }] } });
    }) } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='public-extension'").first<AssistantPhoneBinding>();
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e1", eventType: "call.initiated", payload: { call_control_id: "call-1", direction: "incoming", from: "+14155550101", to: "+14155550100" } });
    const result = await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e2", eventType: "call.answered", payload: { call_control_id: "call-1" } });
    expect(result).toMatchObject({ accepted: true, ended: true, rejected: "unsupported_extension_voice_response" });
    expect(String(carrier.mock.calls.at(-1)?.[0])).toContain("/actions/hangup");
  });

  it("rejects Twilio-only Say styles on Telnyx and hangs up", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("public-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('public-extension','ext-1',?,'active')").bind("a".repeat(64)).run();
    f.env.AGENTS_WORKER = { fetch: vi.fn(async (request: Request) => {
      const body = await request.json() as { pinCall?: boolean };
      return body.pinCall ? Response.json({ settings_revision: null })
        : Response.json({ response: { actions: [{ type: "say", text: "Hello", style: "woman" }] } });
    }) } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='public-extension'").first<AssistantPhoneBinding>();
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e1", eventType: "call.initiated", payload: { call_control_id: "call-style", direction: "incoming", from: "+14155550101", to: "+14155550100" } });
    const result = await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e2", eventType: "call.answered", payload: { call_control_id: "call-style" } });
    expect(result).toMatchObject({ accepted: true, ended: true, rejected: "unsupported_extension_voice_response" });
    expect(String(carrier.mock.calls.at(-1)?.[0])).toContain("/actions/hangup");
  });

  it("speaks a terminal extension response and ends without another extension dispatch", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async (request: Request) => request.url.includes("assistant-access")
      ? Response.json({ effective_role: "owner" })
      : Response.json({ preferences: { enabled: { phone: true, email: true } } }));
    const identity = await ensureIdentity(f.env, scope);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async () => Response.json({ value: JSON.stringify({ apiKey: "test-api-key-123456", publicKey, verifiedNumberId: "12345", verifiedPhoneNumber: "+14155550100" }) })) } as unknown as Fetcher;
    await f.db.prepare("INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,provider_number_sid,phone_number,policy_json,status) VALUES(?,?,'extension','byo','telnyx','account','12345','+14155550100',?,'active')")
      .bind("public-extension", identity.id, JSON.stringify(defaultPhonePolicy)).run();
    await f.db.prepare("INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status) VALUES('public-extension','ext-1',?,'active')").bind("a".repeat(64)).run();
    const extension = vi.fn(async (request: Request) => {
      const body = await request.json() as { pinCall?: boolean };
      return body.pinCall ? Response.json({ settings_revision: 0 })
        : Response.json({ response: { actions: [{ type: "say", text: "Thank you. Goodbye." }] } });
    });
    f.env.AGENTS_WORKER = { fetch: extension } as unknown as Fetcher;
    const carrier = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: { result: "accepted" } }));
    vi.stubGlobal("fetch", carrier);
    const binding = await f.db.prepare("SELECT * FROM assistant_phone_bindings WHERE id='public-extension'").first<AssistantPhoneBinding>();
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e1", eventType: "call.initiated", payload: { call_control_id: "call-final", direction: "incoming", from: "+14155550101", to: "+14155550100" } });
    const response = await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e2", eventType: "call.answered", payload: { call_control_id: "call-final" } });
    expect(response).toMatchObject({ accepted: true, finishing: true });
    expect(JSON.parse(String(carrier.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ payload: "Thank you. Goodbye.", minimum_digits: 1, timeout_millis: 2_000 });
    expect(await f.db.prepare("SELECT state FROM assistant_telnyx_extension_calls WHERE call_control_id='call-final'").first()).toEqual({ state: "finishing" });
    await dispatchTelnyxVoiceEvent(f.env, binding!, identity, { eventId: "e3", eventType: "call.gather.ended", payload: { call_control_id: "call-final", status: "no_input" } });
    expect(String(carrier.mock.calls.at(-1)?.[0])).toContain("/actions/hangup");
    expect(extension).toHaveBeenCalledTimes(2); // call-start settings pin plus one terminal handler turn
    expect(await f.db.prepare("SELECT state FROM assistant_telnyx_extension_calls WHERE call_control_id='call-final'").first()).toEqual({ state: "ended" });
  });
});
