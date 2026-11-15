import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { approvedAssistantVoice, validateVoiceExtensionStreamResponse } from "@naelao/agent-sdk";
import type { AgentsEnv } from "../index.js";
import { createVoiceAudioAdmission, type VoiceUsageJournal, type VoiceUsageRecord } from "../voice/audio-usage-admission.js";
import { createOpenRouterAudio } from "../voice/openrouter-audio.js";
import { OpenRouterLiveTranscriber } from "../voice/openrouter-live-transcriber.js";
import { createVaultProxy } from "../script-engine/vault-proxy.js";
import type { ClaimedExtensionStreamSession } from "./telnyx-extension-stream-session.js";
import { advanceTelnyxExtensionTranscriptSequence, isTelnyxExtensionStreamSessionCurrent } from "./telnyx-extension-stream-session.js";
import { encodePcm16kToTelnyxPcmu, encodeTelnyxPcmuBase64, TELNYX_PCMU_PACKET_BYTES } from "./telnyx-extension-audio.js";

const MAX_TRANSCRIPT_BYTES = 2_000;
const MAX_OUTBOUND_BUFFER_BYTES = 64 * 1024;
const MAX_TTS_PCM_BYTES = 8 * 1024 * 1024;
const MAX_TURN_DEADLINE_MS = 20_000;

export type TelnyxStreamEventType = "call.started" | "call.interrupted" | "transcript.final";
export type ExtensionStreamEventScope = Pick<ClaimedExtensionStreamSession,
  "tenantId" | "spaceId" | "projectId" | "bindingId" | "callControlId" | "callRef" | "installationId" | "handlerSha256" | "settingsRevision">;

export interface TelnyxStreamDispatch {
  (type: TelnyxStreamEventType, sequence?: number, text?: string): Promise<unknown>;
}

/** D1 stores usage receipts only: no transcript, audio, credential or provider response body. */
export class TelnyxExtensionVoiceUsageJournal implements VoiceUsageJournal {
  private readonly usagePrefix: string;
  constructor(private readonly db: D1Database, private readonly sessionId: string, callRef: string) {
    this.usagePrefix = `voice-audio:${callRef}:`;
  }
  private requestId(key: string): string {
    if (!key.startsWith(this.usagePrefix)) throw new Error("telnyx_voice_usage_scope_mismatch");
    const requestId = key.slice(this.usagePrefix.length);
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) throw new Error("telnyx_voice_usage_key_invalid");
    return requestId;
  }
  async get<T>(key: string): Promise<T | undefined> {
    const requestId = this.requestId(key);
    const row = await this.db.prepare(`SELECT record_json FROM assistant_telnyx_extension_audio_usage
      WHERE session_id=? AND request_id=?`).bind(this.sessionId, requestId).first<{ record_json: string }>();
    if (!row) return undefined;
    try { return JSON.parse(row.record_json) as T; } catch { throw new Error("telnyx_voice_usage_receipt_invalid"); }
  }
  async put<T>(key: string, value: T): Promise<unknown> {
    const requestId = this.requestId(key);
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > 16_384) throw new Error("telnyx_voice_usage_receipt_too_large");
    const now = Date.now();
    return this.db.prepare(`INSERT INTO assistant_telnyx_extension_audio_usage(session_id,request_id,record_json,updated_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM assistant_telnyx_extension_stream_sessions WHERE session_id=?)
      ON CONFLICT(session_id,request_id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at`)
      .bind(this.sessionId, requestId, json, now, this.sessionId).run();
  }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    if (options.prefix !== this.usagePrefix) throw new Error("telnyx_voice_usage_scope_mismatch");
    const rows = await this.db.prepare(`SELECT request_id,record_json FROM assistant_telnyx_extension_audio_usage
      WHERE session_id=? ORDER BY updated_at,request_id LIMIT 200`).bind(this.sessionId)
      .all<{ request_id: string; record_json: string }>();
    const entries = new Map<string, T>();
    for (const row of rows.results ?? []) {
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(row.request_id)) continue;
      try { entries.set(this.usagePrefix + row.request_id, JSON.parse(row.record_json) as T); } catch { /* preserve the receipt for operator repair */ }
    }
    return entries;
  }
}

export function extensionAudioMaxCost(env: Pick<AgentsEnv, "TELNYX_EXTENSION_AUDIO_MAX_COST_USD">): number | null {
  const value = env.TELNYX_EXTENSION_AUDIO_MAX_COST_USD;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

async function extensionEventId(bindingId: string, callControlId: string, type: TelnyxStreamEventType, sequence?: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`${bindingId}:${callControlId}:voice:${type}:${sequence ?? "start"}`)));
  return `telnyx-call-${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Run an exact pinned package handler through the existing host dispatcher. Transcript text is
 * delivered only as the current call event; the durable event receipt stores its response, not it. */
export async function dispatchTelnyxExtensionStreamEvent(env: AgentsEnv, session: ExtensionStreamEventScope,
  type: TelnyxStreamEventType, sequence?: number, text?: string, signal?: AbortSignal): Promise<unknown> {
  if (!env.AGENTS_WORKER) throw new Error("telnyx_extension_dispatch_unavailable");
  if (type === "transcript.final" && (typeof text !== "string" || !text.trim()
    || new TextEncoder().encode(text).byteLength > MAX_TRANSCRIPT_BYTES || text.includes("\0")))
    throw new Error("telnyx_extension_transcript_invalid");
  if ((type === "transcript.final" || type === "call.interrupted") && (!Number.isSafeInteger(sequence) || (sequence ?? -1) < 0 || (sequence ?? 1_000_001) > 1_000_000))
    throw new Error("telnyx_extension_sequence_invalid");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), MAX_TURN_DEADLINE_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
  const response = await env.AGENTS_WORKER.fetch(new Request("http://agents/internal/phone-extension-dispatch", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": session.tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, session.tenantId) }, signal: controller.signal,
    body: JSON.stringify({ spaceId: session.spaceId, bindingId: session.bindingId,
      expectedInstallationId: session.installationId, expectedHandlerSha256: session.handlerSha256,
      settingsRevision: session.settingsRevision,
      event: { schema_version: 1, id: await extensionEventId(session.bindingId, session.callControlId, type, sequence), type,
        payload: { call_ref: session.callRef, ...(sequence === undefined ? {} : { sequence }), ...(text === undefined ? {} : { text }) } },
    }),
  }));
  const result = await readBoundedResponseJson<{ response?: unknown; error_code?: string }>(response, 16_384);
  if (!response.ok || !Object.prototype.hasOwnProperty.call(result, "response")) throw new Error(result.error_code ?? "telnyx_extension_dispatch_rejected");
  return result.response;
  } finally { clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
}

export interface TelnyxExtensionMediaRuntimeOptions {
  env: AgentsEnv;
  session: ClaimedExtensionStreamSession;
  streamId: string;
  bufferedAmount(): number;
  send(value: Record<string, unknown>): void;
  stillAllowed(): Promise<boolean>;
  endCall(reason: "runtime_error" | "timeout" | "completed"): Promise<void>;
  now?: () => number;
}

/** Bounded, extension-only STT/TTS loop. It has no OwnerVoice ticket, agent, turn store or bridge. */
export function createTelnyxExtensionMediaRuntime(options: TelnyxExtensionMediaRuntimeOptions) {
  const profile = approvedAssistantVoice(options.session.voiceProfileId, "economy");
  const maxCostUsd = extensionAudioMaxCost(options.env);
  if (!profile || profile.sampleRate !== 16_000 || !maxCostUsd || !options.env.BILLING_WORKER || !options.env.CREDENTIALS_WORKER)
    throw new Error("telnyx_extension_audio_runtime_unavailable");
  const vault = createVaultProxy({ credentialsWorker: options.env.CREDENTIALS_WORKER, platformSecret: options.env.PLATFORM_SECRET,
    tenantId: options.session.tenantId, spaceId: options.session.spaceId,
    agentId: options.session.installationId, ...(options.session.projectId ? { projectId: options.session.projectId } : {}),
    runId: `telnyx-${options.session.callRef}`, purpose: "assistant-audio" });
  const journal = new TelnyxExtensionVoiceUsageJournal(options.env.PLATFORM_DB, options.session.sessionId, options.session.callRef);
  const audio = createOpenRouterAudio({ vault, credentialName: "llm_byok_active::openrouter", authorize: async input => {
    if (options.env.TELNYX_EXTENSION_STREAMING_ACCEPTED !== "true" || options.env.TELNYX_EXTENSION_STREAMING_ENABLED !== "true"
      || !await options.stillAllowed()) throw new Error("telnyx_extension_voice_authority_revoked");
    return admission.authorize(input);
  } });
  const admission = createVoiceAudioAdmission({ tenantId: options.session.tenantId, spaceId: options.session.spaceId,
    callId: options.session.callRef, secret: options.env.PLATFORM_SECRET, billingWorker: options.env.BILLING_WORKER,
    maxCostUsd, journal, stillAllowed: options.stillAllowed,
    resolveGeneration: (id, fallbackTokens) => audio.resolveGeneration(id, fallbackTokens) });

  let ended = false;
  let cleanupStarted = false;
  let nextSequence = 0;
  const speechSequences: number[] = [];
  let pendingTurns = 0;
  let turnTail: Promise<void> = Promise.resolve();
  const sessionAbort = new AbortController();
  let activePlayback: { reader?: ReadableStreamDefaultReader<Uint8Array>; controller: AbortController; cancelled: boolean } | null = null;
  const now = options.now ?? Date.now;
  const send = (value: Record<string, unknown>) => {
    if (ended) return;
    if (options.bufferedAmount() > MAX_OUTBOUND_BUFFER_BYTES) throw new Error("telnyx_extension_audio_backpressure");
    options.send(value);
  };
  const interrupt = () => {
    const active = activePlayback;
    if (!active) return;
    active.cancelled = true;
    active.controller.abort();
    void active.reader?.cancel().catch(() => {});
    send({ event: "clear", stream_id: options.streamId });
  };
  const stopRuntime = () => {
    if (ended) return;
    ended = true;
    sessionAbort.abort();
    transcriber.close();
    if (activePlayback) {
      activePlayback.cancelled = true;
      activePlayback.controller.abort();
      void activePlayback.reader?.cancel().catch(() => {});
      activePlayback = null;
    }
  };
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const speak = async (text: string, requestKey: string, actionIndex: number) => {
    if (!text.trim() || new TextEncoder().encode(text).byteLength > MAX_TRANSCRIPT_BYTES) throw new Error("telnyx_extension_speech_text_invalid");
    if (!await options.stillAllowed()) throw new Error("telnyx_extension_voice_authority_revoked");
    const controller = new AbortController();
    const playback = { controller, cancelled: false } as { reader?: ReadableStreamDefaultReader<Uint8Array>; controller: AbortController; cancelled: boolean };
    activePlayback = playback;
    const deadline = setTimeout(() => controller.abort(), MAX_TURN_DEADLINE_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const result = await audio.speak({ model: profile.speechModel, voice: profile.speechVoice, speed: 1, rate: 16_000,
        channels: 1, priceUsdPerMillionCharacters: profile.priceUsdPerMillionCharacters,
        requestId: `tts-${options.session.callRef}-${requestKey}-${actionIndex}`, text, signal: controller.signal });
      reader = result.stream.getReader(); playback.reader = reader;
      let buffered = new Uint8Array(0), outputPcmu = new Uint8Array(0), total = 0;
      while (true) {
        if (ended || playback.cancelled) return;
        if (!await options.stillAllowed()) throw new Error("telnyx_extension_voice_authority_revoked");
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TTS_PCM_BYTES) throw new Error("telnyx_extension_tts_size_limit");
        const joined = new Uint8Array(buffered.byteLength + value.byteLength);
        joined.set(buffered); joined.set(value, buffered.byteLength);
        const frameLength = Math.floor(joined.byteLength / (TELNYX_PCMU_PACKET_BYTES * 4)) * TELNYX_PCMU_PACKET_BYTES * 4;
        if (!frameLength) { buffered = joined; continue; }
        const complete = joined.subarray(0, frameLength);
        buffered = joined.slice(frameLength);
        const pcmu = encodePcm16kToTelnyxPcmu(complete);
        const combined = new Uint8Array(outputPcmu.byteLength + pcmu.byteLength);
        combined.set(outputPcmu); combined.set(pcmu, outputPcmu.byteLength); outputPcmu = combined;
        while (outputPcmu.byteLength >= TELNYX_PCMU_PACKET_BYTES) {
          const packet = outputPcmu.slice(0, TELNYX_PCMU_PACKET_BYTES);
          outputPcmu = outputPcmu.slice(TELNYX_PCMU_PACKET_BYTES);
          send({ event: "media", stream_id: options.streamId, media: { payload: encodeTelnyxPcmuBase64(packet) } });
          await sleep(20);
          if (playback.cancelled || ended) return;
        }
      }
      if (buffered.byteLength % 2) throw new Error("telnyx_extension_tts_pcm_invalid");
      if (buffered.byteLength) {
        const padded = new Uint8Array(TELNYX_PCMU_PACKET_BYTES * 4);
        padded.set(buffered.subarray(0, padded.byteLength - (buffered.byteLength % 2)));
        const pcmu = encodePcm16kToTelnyxPcmu(padded);
        const combined = new Uint8Array(outputPcmu.byteLength + pcmu.byteLength);
        combined.set(outputPcmu); combined.set(pcmu, outputPcmu.byteLength); outputPcmu = combined;
      }
      if (outputPcmu.byteLength) {
        const packet = new Uint8Array(TELNYX_PCMU_PACKET_BYTES).fill(0xff);
        packet.set(outputPcmu.subarray(0, TELNYX_PCMU_PACKET_BYTES));
        send({ event: "media", stream_id: options.streamId, media: { payload: encodeTelnyxPcmuBase64(packet) } });
      }
    } finally {
      clearTimeout(deadline);
      if (activePlayback === playback) activePlayback = null;
      if (reader && !playback.cancelled) reader.releaseLock();
    }
  };

  const applyResponse = async (raw: unknown, sequence: number, requestKey: string) => {
    const response = validateVoiceExtensionStreamResponse(raw);
    if (!response) throw new Error("telnyx_extension_voice_response_invalid");
    for (const [index, action] of response.actions.entries()) {
      if (ended) return;
      if (action.type === "speak") await speak(action.text, requestKey, index);
      else if (action.type === "listen" && action.input === "speech") continue;
      else if (action.type === "end") { stopRuntime(); await options.endCall("completed"); return; }
      else throw new Error("telnyx_extension_voice_action_unavailable");
    }
  };

  const dispatchTurn = async (type: TelnyxStreamEventType, sequence: number, text?: string) => {
    if (ended || !await options.stillAllowed()) throw new Error("telnyx_extension_voice_authority_revoked");
    const response = await dispatchTelnyxExtensionStreamEvent(options.env, options.session, type, sequence, text, sessionAbort.signal);
    if (type === "transcript.final") {
      const advanced = await advanceTelnyxExtensionTranscriptSequence(options.env.PLATFORM_DB, options.session, sequence);
      if (!advanced) throw new Error("telnyx_extension_transcript_sequence_rejected");
      await applyResponse(response, sequence, `turn-${sequence}`);
    } else if (type === "call.started") await applyResponse(response, sequence, "start");
    else if (!validateVoiceExtensionStreamResponse(response)) throw new Error("telnyx_extension_voice_interrupt_rejected");
  };

  const transcriber = new OpenRouterLiveTranscriber({
    provider: { transcribe: ({ requestId, data, format, signal }) => audio.transcribe({ model: profile.transcriptionModel,
      requestId, data, format, priceUsdPerSecond: profile.transcriptionUsdPerSecond, ...(signal ? { signal } : {}) }) },
    requestId: () => `${options.session.callRef}-stt-${crypto.randomUUID()}`, now,
  }).createSession({
    onSpeechStart: () => {
      const sequence = nextSequence++;
      speechSequences.push(sequence);
      interrupt();
      pendingTurns++;
      if (pendingTurns > 2) { fail("telnyx_extension_voice_backpressure"); return; }
      turnTail = turnTail.then(() => dispatchTurn("call.interrupted", sequence)).finally(() => { pendingTurns--; });
      void turnTail.catch(error => fail(error instanceof Error ? error.message : "telnyx_extension_voice_interrupted"));
    },
    onUtterance: text => {
      const sequence = speechSequences.shift() ?? nextSequence++;
      pendingTurns++;
      if (pendingTurns > 2) { fail("telnyx_extension_voice_backpressure"); return; }
      turnTail = turnTail.then(async () => {
        if (now() > options.session.expiresAt * 1000) throw new Error("telnyx_extension_voice_deadline");
        if (!await isTelnyxExtensionStreamSessionCurrent(options.env.PLATFORM_DB, options.session)) throw new Error("telnyx_extension_voice_authority_revoked");
        const bounded = text.trim().slice(0, MAX_TRANSCRIPT_BYTES);
        if (!bounded) return;
        await dispatchTurn("transcript.final", sequence, bounded);
      }).finally(() => { pendingTurns--; });
      void turnTail.catch(error => fail(error instanceof Error ? error.message : "telnyx_extension_voice_turn_failed"));
    },
    onFatalError: error => fail(error instanceof Error ? error.message : "telnyx_extension_transcription_failed"),
  });

  let failOnce = false;
  function fail(reason: string) {
    if (ended || failOnce) return;
    failOnce = true;
    stopRuntime();
    void options.endCall(reason === "telnyx_extension_voice_deadline" ? "timeout" : "runtime_error");
  }
  return {
    async start(): Promise<void> {
      if (!await options.stillAllowed()) throw new Error("telnyx_extension_voice_authority_revoked");
      const initial = await dispatchTelnyxExtensionStreamEvent(options.env, options.session, "call.started", undefined, undefined, sessionAbort.signal);
      // Do not wait for a complete greeting before returning to the socket loop. Inbound media
      // must be able to interrupt TTS while it is still being paced to the carrier.
      turnTail = turnTail.then(() => applyResponse(initial, 0, "start"));
      void turnTail.catch(error => fail(error instanceof Error ? error.message : "telnyx_extension_voice_start_failed"));
    },
    feedPcm16k(pcm: ArrayBuffer): void {
      if (ended) return;
      if (pcm.byteLength > 32_000) { fail("telnyx_extension_audio_frame_too_large"); return; }
      transcriber.feed(pcm);
    },
    async close(): Promise<void> {
      if (cleanupStarted) return;
      cleanupStarted = true;
      const active = activePlayback;
      stopRuntime();
      await active?.reader?.cancel().catch(() => {});
      await Promise.race([turnTail.catch(() => {}), sleep(1_000)]);
      await admission.reconcile().catch(() => ({ settled: 0, unresolved: 1 }));
    },
    pendingUsage(): Promise<Map<string, VoiceUsageRecord>> { return journal.list<VoiceUsageRecord>({ prefix: `voice-audio:${options.session.callRef}:` }); },
  };
}
