import type { VoiceAi } from "../voice/voice-pipeline.js";
import { runModalityTask } from "../media/modality-task.js";
import { readBoundedProviderJson } from "./bounded-provider-json.js";

const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;
const MAX_INBOUND_CHANNEL_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_INBOUND_CHANNEL_MEDIA_FILES = 5;
const MAX_INBOUND_CHANNEL_MEDIA_TOTAL_BYTES = 15 * 1024 * 1024;
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

export interface DownloadedChannelAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
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

function whatsappMessages(raw: JsonObject): JsonObject[] {
  const entry = (raw.entry as JsonObject[] | undefined)?.[0];
  const change = (entry?.changes as JsonObject[] | undefined)?.[0];
  const value = object(change?.value);
  return (value?.messages as JsonObject[] | undefined) ?? [];
}

/** Retrieve image/document/audio/video media referenced by a signed Meta webhook.
 * Provider URLs are resolved from the signed media id, then checked against the
 * provider's download hosts. Redirects are disabled and both per-file and aggregate
 * byte limits are enforced before the bytes reach storage.
 */
export async function downloadWhatsAppAttachments(raw: JsonObject, env: WhatsAppMediaEnv): Promise<DownloadedChannelAttachment[]> {
  if (!env.accessToken) throw new Error("whatsapp_media_unavailable");
  const fetcher = env.fetcher ?? fetch;
  const version = env.graphApiVersion ?? "v26.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("whatsapp_graph_api_version_invalid");
  const files: DownloadedChannelAttachment[] = [];
  let total = 0;
  for (const message of whatsappMessages(raw)) {
    const type = typeof message.type === "string" ? message.type : "";
    if (!["image", "document", "audio", "video", "sticker"].includes(type)) continue;
    const media = object(message[type]);
    const id = typeof media?.id === "string" ? media.id : "";
    if (!id || files.length >= MAX_INBOUND_CHANNEL_MEDIA_FILES) continue;
    const metadataResponse = await fetcher(`https://graph.facebook.com/${version}/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${env.accessToken}`, accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!metadataResponse.ok) throw new Error(`whatsapp_media_metadata_failed:${metadataResponse.status}`);
    const metadata = await readBoundedProviderJson(metadataResponse);
    const mimeType = typeof metadata.mime_type === "string" ? metadata.mime_type.toLowerCase().split(";")[0]!.trim() : "";
    const declaredBytes = Number(metadata.file_size);
    const urlValue = metadata.url;
    if (typeof urlValue !== "string" || !/^([\w.+-]+)\/[\w.+-]+$/.test(mimeType) ||
        !Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_INBOUND_CHANNEL_MEDIA_BYTES ||
        total + declaredBytes > MAX_INBOUND_CHANNEL_MEDIA_TOTAL_BYTES) throw new Error("whatsapp_media_rejected");
    const url = new URL(urlValue);
    const trustedHost = url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbsbx.com") || url.hostname.endsWith(".fbcdn.net");
    if (url.protocol !== "https:" || url.port || url.username || url.password || !trustedHost) throw new Error("whatsapp_media_url_rejected");
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${env.accessToken}` }, redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`whatsapp_media_download_failed:${response.status}`);
    const bytes = new Uint8Array(await readBounded(response, MAX_INBOUND_CHANNEL_MEDIA_BYTES));
    if (bytes.byteLength !== declaredBytes) throw new Error("whatsapp_media_size_mismatch");
    const suppliedName = typeof media?.filename === "string" ? media.filename : `${type}-${id}`;
    const filename = suppliedName.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || `${type}-${id}`;
    files.push({ filename, mimeType, bytes });
    total += bytes.byteLength;
  }
  return files;
}

/** Retrieve Twilio WhatsApp media only from the account/message resource covered by the
 * already-verified signed form webhook. URLs are restricted to Twilio's API host; redirects
 * are disabled and media remains under the common byte caps before storage.
 */
export async function downloadTwilioWhatsAppAttachments(fields: Record<string, string>, env: TwilioWhatsAppMediaEnv): Promise<DownloadedChannelAttachment[]> {
  const count = Number(fields.NumMedia ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 5) throw new Error("twilio_whatsapp_media_rejected");
  if (count === 0) return [];
  if (!env.accountSid || !env.authToken || !/^AC[\da-f]{32}$/i.test(env.accountSid)) throw new Error("twilio_whatsapp_media_unavailable");
  const messageSid = fields.MessageSid ?? "";
  if (!/^SM[\da-f]{32}$/i.test(messageSid)) throw new Error("twilio_whatsapp_media_rejected");
  const fetcher = env.fetcher ?? fetch;
  const results: DownloadedChannelAttachment[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (total >= MAX_INBOUND_CHANNEL_MEDIA_TOTAL_BYTES) throw new Error("twilio_whatsapp_media_too_large");
    const mediaUrl = fields[`MediaUrl${index}`];
    const mimeType = (fields[`MediaContentType${index}`] ?? "application/octet-stream").toLowerCase().split(";")[0]!.trim();
    if (!mediaUrl || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new Error("twilio_whatsapp_media_rejected");
    const url = new URL(mediaUrl);
    const prefix = `/2010-04-01/Accounts/${env.accountSid}/Messages/${messageSid}/Media/`;
    if (url.protocol !== "https:" || url.port || url.hostname !== "api.twilio.com" || url.username || url.password ||
        url.search || !url.pathname.startsWith(prefix) || !/^ME[\da-f]{32}(?:\.json)?$/i.test(url.pathname.slice(prefix.length))) {
      throw new Error("twilio_whatsapp_media_url_rejected");
    }
    const response = await fetcher(url, {
      headers: { authorization: `Basic ${btoa(`${env.accountSid}:${env.authToken}`)}` },
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`twilio_whatsapp_media_download_failed:${response.status}`);
    const length = Number(response.headers.get("content-length"));
    const remainingBytes = MAX_INBOUND_CHANNEL_MEDIA_TOTAL_BYTES - total;
    if (Number.isFinite(length) && length > Math.min(MAX_INBOUND_CHANNEL_MEDIA_BYTES, remainingBytes)) throw new Error("twilio_whatsapp_media_too_large");
    const bytes = new Uint8Array(await readBounded(response, Math.min(MAX_INBOUND_CHANNEL_MEDIA_BYTES, remainingBytes)));
    total += bytes.byteLength;
    const supplied = fields[`MediaFilename${index}`] ?? `whatsapp-${messageSid}-${index + 1}`;
    const filename = supplied.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || `attachment-${index + 1}`;
    results.push({ filename, mimeType, bytes });
  }
  return results;
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
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  if (!metadataResponse.ok) throw new Error(`whatsapp_media_metadata_failed:${metadataResponse.status}`);
  const metadata = await readBoundedProviderJson(metadataResponse);
  const urlValue = metadata.url;
  const mimeType = typeof metadata.mime_type === "string" ? metadata.mime_type.toLowerCase().split(";")[0]!.trim() : "";
  const declaredBytes = Number(metadata.file_size);
  if (typeof urlValue !== "string" || !ALLOWED_MIME_TYPES.has(mimeType) ||
      !Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_VOICE_NOTE_BYTES) {
    throw new Error("whatsapp_media_rejected");
  }
  const mediaUrl = new URL(urlValue);
  const trustedMediaHost = mediaUrl.hostname === "lookaside.fbsbx.com" || mediaUrl.hostname.endsWith(".fbsbx.com") || mediaUrl.hostname.endsWith(".fbcdn.net");
  if (mediaUrl.protocol !== "https:" || mediaUrl.port || mediaUrl.username || mediaUrl.password || !trustedMediaHost) {
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
  if (url.protocol !== "https:" || url.port || url.hostname !== "api.twilio.com" || url.username || url.password ||
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
