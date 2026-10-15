import type { VoiceAi } from "../voice/voice-pipeline.js";
import { runModalityTask } from "../media/modality-task.js";

const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "audio/aac",
  "audio/amr",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
]);

type JsonObject = Record<string, unknown>;

export interface WhatsAppMediaEnv {
  accessToken?: string;
  graphApiVersion?: string;
  ai?: VoiceAi;
  fetcher?: typeof fetch;
}

export interface TwilioWhatsAppMediaEnv {
  accountSid?: string;
  authToken?: string;
  ai?: VoiceAi;
  fetcher?: typeof fetch;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function voiceNote(raw: JsonObject): { message: JsonObject; id: string } | undefined {
  const entry = (raw.entry as JsonObject[] | undefined)?.[0];
  const change = (entry?.changes as JsonObject[] | undefined)?.[0];
  const value = object(change?.value);
  const message = (value?.messages as JsonObject[] | undefined)?.[0];
  const audio = object(message?.audio);
  if (message?.type !== "audio" || typeof audio?.id !== "string" || !audio.id) return undefined;
  return { message, id: audio.id };
}

export function hasWhatsAppVoiceNote(raw: JsonObject): boolean {
  return voiceNote(raw) !== undefined;
}

async function readBounded(response: Response, maximum: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("whatsapp_media_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("whatsapp_media_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function transcribeBytes(bytes: ArrayBuffer, ai: VoiceAi, mimeType: string): Promise<string> {
  const result = await runModalityTask(ai, {
    task: "transcribe", mimeType, bytes, maxOutputChars: 10_000, timeoutMs: 25_000,
  });
  return result.text;
}

/** Fetch and transcribe one signed Meta WhatsApp audio message without forwarding provider credentials. */
export async function transcribeWhatsAppVoiceNote(raw: JsonObject, env: WhatsAppMediaEnv): Promise<JsonObject> {
  const detected = voiceNote(raw);
  if (!detected) return raw;
  if (!env.accessToken || !env.ai) throw new Error("whatsapp_voice_transcription_unavailable");
  const fetcher = env.fetcher ?? fetch;
  const graphApiVersion = env.graphApiVersion ?? "v26.0";
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) throw new Error("whatsapp_graph_api_version_invalid");
  const metadataResponse = await fetcher(`https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(detected.id)}`, {
    headers: { authorization: `Bearer ${env.accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!metadataResponse.ok) throw new Error(`whatsapp_media_metadata_failed:${metadataResponse.status}`);
  const metadata = await metadataResponse.json() as JsonObject;
  const urlValue = metadata.url;
  const mimeType = typeof metadata.mime_type === "string" ? metadata.mime_type.toLowerCase().split(";")[0]!.trim() : "";
  const declaredBytes = Number(metadata.file_size);
  if (typeof urlValue !== "string" || !ALLOWED_MIME_TYPES.has(mimeType) ||
      !Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_VOICE_NOTE_BYTES) {
    throw new Error("whatsapp_media_rejected");
  }
  const mediaUrl = new URL(urlValue);
  const trustedMediaHost = mediaUrl.hostname === "lookaside.fbsbx.com" || mediaUrl.hostname.endsWith(".fbsbx.com") || mediaUrl.hostname.endsWith(".fbcdn.net");
  if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password || !trustedMediaHost) {
    throw new Error("whatsapp_media_url_rejected");
  }
  const mediaResponse = await fetcher(mediaUrl, {
    headers: { authorization: `Bearer ${env.accessToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!mediaResponse.ok) throw new Error(`whatsapp_media_download_failed:${mediaResponse.status}`);
  const bytes = await readBounded(mediaResponse, MAX_VOICE_NOTE_BYTES);
  if (bytes.byteLength !== declaredBytes || bytes.byteLength > MAX_VOICE_NOTE_BYTES) throw new Error("whatsapp_media_size_mismatch");
  const text = await transcribeBytes(bytes, env.ai, mimeType);
  const message = { ...detected.message, text: { body: text } };
  const entry = (raw.entry as JsonObject[])[0]!;
  const change = (entry.changes as JsonObject[])[0]!;
  const value = object(change.value)!;
  const messages = value.messages as JsonObject[];
  const patchedMessages = messages.map((item, index) => index === 0 ? message : item);
  return {
    ...raw,
    entry: raw.entry && (raw.entry as JsonObject[]).map((item, index) => index === 0 ? {
      ...item,
      changes: item.changes && (item.changes as JsonObject[]).map((entryChange, changeIndex) => changeIndex === 0 ? {
        ...entryChange,
        value: { ...value, messages: patchedMessages },
      } : entryChange),
    } : item),
  };
}

/** Twilio signs the form webhook and serves media from an authenticated, account-scoped URL. */
export async function transcribeTwilioWhatsAppVoice(fields: Record<string, string>, env: TwilioWhatsAppMediaEnv): Promise<Record<string, string>> {
  const mediaUrlValue = fields["MediaUrl0"];
  const mediaType = (fields["MediaContentType0"] ?? "").toLowerCase().split(";")[0]!.trim();
  if (!mediaUrlValue || !mediaType.startsWith("audio/")) return fields;
  if (!env.accountSid || !env.authToken || !env.ai || !/^AC[\da-f]{32}$/i.test(env.accountSid)) {
    throw new Error("whatsapp_voice_transcription_unavailable");
  }
  if (!ALLOWED_MIME_TYPES.has(mediaType)) throw new Error("whatsapp_media_rejected");
  const messageSid = fields["MessageSid"] ?? "";
  const url = new URL(mediaUrlValue);
  const expectedPrefix = `/2010-04-01/Accounts/${env.accountSid}/Messages/${messageSid}/Media/`;
  if (url.protocol !== "https:" || url.hostname !== "api.twilio.com" || url.username || url.password ||
      !/^SM[\da-f]{32}$/i.test(messageSid) || !url.pathname.startsWith(expectedPrefix) ||
      !/^ME[\da-f]{32}(?:\.json)?$/i.test(url.pathname.slice(expectedPrefix.length))) {
    throw new Error("whatsapp_media_url_rejected");
  }
  const fetcher = env.fetcher ?? fetch;
  const response = await fetcher(url, {
    headers: { authorization: `Basic ${btoa(`${env.accountSid}:${env.authToken}`)}` },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`whatsapp_media_download_failed:${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VOICE_NOTE_BYTES) throw new Error("whatsapp_media_too_large");
  const bytes = await readBounded(response, MAX_VOICE_NOTE_BYTES);
  const text = await transcribeBytes(bytes, env.ai, mediaType);
  return { ...fields, Body: text };
}

export const WHATSAPP_VOICE_NOTE_MAX_BYTES = MAX_VOICE_NOTE_BYTES;
