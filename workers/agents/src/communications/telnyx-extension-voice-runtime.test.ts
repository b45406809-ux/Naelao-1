import { describe, expect, it, vi } from "vitest";
import type { AgentsEnv } from "../index.js";
import { fixture, scope } from "../../../../tests/fixtures/assistant-communications.js";
import { ensureIdentity } from "./core.js";
import {
  activateTelnyxExtensionStreamSession, claimTelnyxExtensionStreamTicket,
  createTelnyxExtensionStreamSession, grantTelnyxExtensionStreamConsent,
} from "./telnyx-extension-stream-session.js";
import { createTelnyxExtensionMediaRuntime, dispatchTelnyxExtensionStreamEvent,
  extensionAudioMaxCost, TelnyxExtensionVoiceUsageJournal } from "./telnyx-extension-voice-runtime.js";
import { sweepTelnyxExtensionAudioUsage } from "./telnyx-extension-audio-reconciliation.js";

async function activeSession() {
  const f = fixture();
  const identity = await ensureIdentity(f.env, scope);
  await f.db.prepare(`INSERT INTO assistant_phone_bindings(id,identity_id,purpose,payer,provider,provider_account_sid,
      provider_number_sid,phone_number,policy_json,status)
    VALUES('voice-line',?,'extension','byo','telnyx','acct','12345','+14155550100','{"allowTelnyxExtensionVoice":true}','active')`)
    .bind(identity.id).run();
  await f.db.prepare(`INSERT INTO assistant_phone_extension_handlers(binding_id,installation_id,handler_sha256,status)
    VALUES('voice-line','install-voice',?,'active')`).bind("a".repeat(64)).run();
  const now = Math.floor(Date.now() / 1000);
  const callControlId = "voice-call-control";
  await f.db.prepare(`INSERT INTO assistant_telnyx_extension_calls(call_control_id,binding_id,caller,state,turn_count,
      started_at,expires_at,created_at,updated_at,extension_installation_id,handler_sha256,settings_revision,settings_pinned)
    VALUES(?,'voice-line','+14155550199','processing',0,?,?,?,?,?, ?,4,1)`)
    .bind(callControlId, now, now + 120, now, now, "install-voice", "a".repeat(64)).run();
  const pin = { tenantId: scope.tenantId, spaceId: scope.spaceId, projectId: null, bindingId: "voice-line", callControlId,
    installationId: "install-voice", handlerSha256: "a".repeat(64), settingsRevision: 4, expiresAt: now + 120 };
  const created = await createTelnyxExtensionStreamSession(f.env.PLATFORM_DB, pin, now);
  const ticket = await grantTelnyxExtensionStreamConsent(f.env.PLATFORM_DB, pin, created.sessionId, now);
  const claimed = await claimTelnyxExtensionStreamTicket(f.env.PLATFORM_DB, pin.bindingId, ticket, now);
  if (!claimed || !await activateTelnyxExtensionStreamSession(f.env.PLATFORM_DB, claimed, now)) throw new Error("test_stream_activation_failed");
  return { f, session: claimed, now };
}

function pcmFrame(amplitude: number): ArrayBuffer {
  const output = new ArrayBuffer(640);
  const view = new DataView(output);
  for (let offset = 0; offset < output.byteLength; offset += 2) view.setInt16(offset, amplitude, true);
  return output;
}

describe("Telnyx extension voice runtime", () => {
  it("scopes durable usage receipts to one session and stores no audio or transcript", async () => {
    const { f, session } = await activeSession();
    const journal = new TelnyxExtensionVoiceUsageJournal(f.env.PLATFORM_DB, session.sessionId, session.callRef);
    const record = { requestId: "stt-1", runId: `voice-audio:${session.callRef}:stt-1`, model: "openai/whisper-large-v3-turbo",
      operation: "transcription" as const, estimatedTokens: 128, estimatedCostUsd: 0.00001, state: "held" as const, updatedAt: Date.now() };
    await journal.put(`voice-audio:${session.callRef}:stt-1`, record);
    expect(await journal.get(`voice-audio:${session.callRef}:stt-1`)).toEqual(record);
    expect(await journal.list({ prefix: `voice-audio:${session.callRef}:` })).toEqual(new Map([[`voice-audio:${session.callRef}:stt-1`, record]]));
    await expect(journal.get("voice-audio:other-call:stt-1")).rejects.toThrow("telnyx_voice_usage_scope_mismatch");
    const stored = await f.db.prepare("SELECT record_json FROM assistant_telnyx_extension_audio_usage WHERE session_id=?")
      .bind(session.sessionId).first<{ record_json: string }>();
    expect(stored?.record_json).not.toContain("I need help with an order.");
    expect(stored?.record_json).not.toContain("+14155550199");
  });

  it("runs a consented transcript through bounded STT, the pinned extension and admitted TTS", async () => {
    const { f, session, now: initialNow } = await activeSession();
    f.env.TELNYX_EXTENSION_STREAMING_ENABLED = "true";
    f.env.TELNYX_EXTENSION_STREAMING_ACCEPTED = "true";
    f.env.TELNYX_EXTENSION_AUDIO_MAX_COST_USD = "0.25";
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    f.env.AGENTS_WORKER = { fetch: vi.fn(async request => {
      const body = await request.json() as { event: { type: string; payload: Record<string, unknown> } };
      events.push(body.event);
      const actions = body.event.type === "transcript.final" || body.event.type === "call.started"
        ? [{ type: "speak", text: body.event.type === "call.started" ? "Welcome." : "I can help with that." }]
        : [{ type: "listen", input: "speech" }];
      return Response.json({ response: { schema_version: 1, actions } });
    }) } as unknown as Fetcher;
    const billingRequests: string[] = [];
    f.env.BILLING_WORKER = { fetch: vi.fn(async request => {
      const url = new URL(request.url);
      billingRequests.push(url.pathname);
      return url.pathname.endsWith("/reserve") ? Response.json({ reserved: true }) : Response.json({ settled: true });
    }) } as unknown as Fetcher;
    let generation = 0;
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn(async request => {
      const body = await request.clone().json() as { url?: string };
      const url = body.url ?? "";
      if (url.includes("/audio/transcriptions")) return Response.json({ text: "I need help with an order.", usage: { cost: 0.0001, total_tokens: 20 } });
      if (url.includes("/audio/speech")) return new Response(new Uint8Array(12_800), { status: 200,
        headers: { "x-generation-id": `generation-${++generation}`, "content-type": "audio/pcm" } });
      if (url.includes("/generation?id=")) return Response.json({ data: { total_cost: 0.0001, total_tokens: 20 } });
      return Response.json({ error: "unexpected_test_request" }, { status: 400 });
    }) } as unknown as Fetcher;

    let time = Date.now();
    const sent: Record<string, unknown>[] = [];
    const endCall = vi.fn(async () => {});
    const runtime = createTelnyxExtensionMediaRuntime({ env: f.env as unknown as AgentsEnv, session, streamId: "stream-voice",
      bufferedAmount: () => 0, send: value => sent.push(value), endCall,
      stillAllowed: () => isCurrent(f, session), now: () => time });
    await runtime.start();
    await vi.waitFor(() => expect(sent.some(frame => frame.event === "media")).toBe(true), { timeout: 3_000 });
    for (let i = 0; i < 8; i++) { runtime.feedPcm16k(pcmFrame(4_000)); time += 20; }
    for (let i = 0; i < 36; i++) { runtime.feedPcm16k(pcmFrame(0)); time += 20; }
    await vi.waitFor(() => expect(events.some(event => event.type === "transcript.final")).toBe(true), { timeout: 3_000 });
    await vi.waitFor(() => expect(sent.some(frame => frame.event === "media")).toBe(true), { timeout: 3_000 });
    await runtime.close();

    expect(events.map(event => event.type)).toEqual(["call.started", "call.interrupted", "transcript.final"]);
    expect(events[2]?.payload).toMatchObject({ call_ref: session.callRef, sequence: 0, text: "I need help with an order." });
    expect(events[2]?.payload).not.toHaveProperty("caller");
    expect(sent.some(frame => frame.event === "clear")).toBe(true);
    const usage = await f.db.prepare("SELECT record_json FROM assistant_telnyx_extension_audio_usage WHERE session_id=? ORDER BY request_id")
      .bind(session.sessionId).all<{ record_json: string }>();
    expect(usage.results).toHaveLength(3);
    expect(usage.results?.map(row => (JSON.parse(row.record_json) as { state: string }).state)).toEqual(["settled", "settled", "settled"]);
    expect(billingRequests.filter(path => path.endsWith("/reserve"))).toHaveLength(3);
    expect(billingRequests.filter(path => path.endsWith("/settle"))).toHaveLength(3);
    expect(endCall).not.toHaveBeenCalled();
    expect(initialNow).toBeLessThan(session.expiresAt);
  });

  it("rejects unsupported cost configuration instead of allowing an unbounded stream", () => {
    expect(extensionAudioMaxCost({ TELNYX_EXTENSION_AUDIO_MAX_COST_USD: "0.25" })).toBe(0.25);
    expect(extensionAudioMaxCost({ TELNYX_EXTENSION_AUDIO_MAX_COST_USD: "0" })).toBeNull();
    expect(extensionAudioMaxCost({ TELNYX_EXTENSION_AUDIO_MAX_COST_USD: "1e6" })).toBeNull();
  });

  it("dispatches only opaque call references and bounded versioned extension events", async () => {
    const { f, session } = await activeSession();
    let dispatchedBody: { expectedInstallationId: string; event: { id: string; payload: Record<string, unknown> } } | null = null;
    const fetch = vi.fn(async request => {
      const body = await request.json() as { expectedInstallationId: string; event: { id: string; schema_version: number; type: string; payload: Record<string, unknown> } };
      dispatchedBody = body;
      expect(body.event.schema_version).toBe(1);
      return Response.json({ response: { schema_version: 1, actions: [{ type: "listen", input: "speech" }] } });
    });
    f.env.AGENTS_WORKER = { fetch } as unknown as Fetcher;
    await dispatchTelnyxExtensionStreamEvent(f.env, session, "transcript.final", 0, "Hello");
    const body = dispatchedBody!;
    expect(body).not.toBeNull();
    expect(body.expectedInstallationId).toBe(session.installationId);
    expect(body.event.id).toMatch(/^telnyx-call-[a-f0-9]{32}$/);
    expect(body.event.payload).toEqual({ call_ref: session.callRef, sequence: 0, text: "Hello" });
    await expect(dispatchTelnyxExtensionStreamEvent(f.env, session, "transcript.final", 0, "x".repeat(2_001)))
      .rejects.toThrow("telnyx_extension_transcript_invalid");
  });

  it("reconciles only ended-call audio usage receipts from the scheduled sweep", async () => {
    const { f, session } = await activeSession();
    f.env.BILLING_WORKER = { fetch: vi.fn(async () => Response.json({ settled: true })) } as unknown as Fetcher;
    f.env.CREDENTIALS_WORKER = { fetch: vi.fn() } as unknown as Fetcher;
    const journal = new TelnyxExtensionVoiceUsageJournal(f.env.PLATFORM_DB, session.sessionId, session.callRef);
    await journal.put(`voice-audio:${session.callRef}:tts-retry`, { requestId: "tts-retry",
      runId: `voice-audio:${session.callRef}:tts-retry`, model: "openai/tts-1", operation: "speech",
      estimatedTokens: 256, estimatedCostUsd: 0.001, costUsd: 0.001, actualTokens: 5,
      state: "settle_retry", updatedAt: Date.now() });
    await f.db.prepare("UPDATE assistant_telnyx_extension_calls SET state='ended' WHERE call_control_id=?")
      .bind(session.callControlId).run();
    const result = await sweepTelnyxExtensionAudioUsage(f.env);
    expect(result).toEqual({ examined: 1, settled: 1, unresolved: 0 });
    expect((await journal.get<{ state: string }>(`voice-audio:${session.callRef}:tts-retry`))?.state).toBe("settled");
  });
});

async function isCurrent(f: ReturnType<typeof fixture>, session: Awaited<ReturnType<typeof activeSession>>["session"]) {
  const { isTelnyxExtensionStreamSessionCurrent } = await import("./telnyx-extension-stream-session.js");
  return isTelnyxExtensionStreamSessionCurrent(f.env.PLATFORM_DB, session);
}
