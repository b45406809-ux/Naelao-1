import type { DownloadedChannelAttachment } from "./whatsapp-media.js";
import { resolveFileContentType } from "@naelao/types";
import { DISCORD_ATTACHMENT_LIMITS } from "./channel-media-capabilities.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function attachments(raw: JsonObject): JsonObject[] {
  return (Array.isArray(raw.attachments) ? raw.attachments : []).map(object).filter((item): item is JsonObject => Boolean(item));
}

export function hasDiscordAttachments(raw: JsonObject): boolean {
  return attachments(raw).length > 0;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("discord_media_body_missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DISCORD_ATTACHMENT_LIMITS.maxFileBytes) {
        await reader.cancel();
        throw new Error("discord_media_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function safeFilename(name: string): string {
  return name.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "discord-attachment";
}

function signedAttachmentExpiry(url: URL, now: number): number {
  const ex = url.searchParams.getAll("ex");
  const issued = url.searchParams.getAll("is");
  const signature = url.searchParams.getAll("hm");
  if (ex.length !== 1 || issued.length !== 1 || signature.length !== 1
    || !/^[0-9a-f]{1,12}$/i.test(ex[0] ?? "")
    || !/^[0-9a-f]{1,12}$/i.test(issued[0] ?? "")
    || !/^[0-9a-f]{16,128}$/i.test(signature[0] ?? "")) {
    throw new Error("discord_media_url_rejected");
  }
  const expiresAtSeconds = Number.parseInt(ex[0]!, 16);
  const issuedAtSeconds = Number.parseInt(issued[0]!, 16);
  const nowSeconds = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(expiresAtSeconds) || !Number.isSafeInteger(issuedAtSeconds)
    || expiresAtSeconds <= nowSeconds || expiresAtSeconds <= issuedAtSeconds
    || issuedAtSeconds > nowSeconds + 300) {
    throw new Error("discord_media_url_expired");
  }
  return expiresAtSeconds * 1_000;
}

/** Discord attachment URLs are signed bearer capabilities. Fetch only the exact signed URL
 * from the authenticated event, while it remains valid; never refresh it from an arbitrary
 * caller URL or pass it into the isolated extension. Ordinary CDN attachments remain
 * unsupported from this Worker because Discord blocks Cloudflare Worker egress to its CDN. */
export async function downloadDiscordAttachments(raw: JsonObject, input: { fetcher?: typeof fetch; now?: number } = {}): Promise<DownloadedChannelAttachment[]> {
  if ((Array.isArray(raw.attachments) ? raw.attachments.length : 0) > DISCORD_ATTACHMENT_LIMITS.maxFiles) throw new Error("discord_media_rejected");
  const references = attachments(raw);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now();
  const channelId = typeof raw.channel_id === "string" ? raw.channel_id : "";
  if (!/^\d{1,20}$/.test(channelId)) throw new Error("discord_media_rejected");
  const prepared = references.map((reference) => {
    if (reference.ephemeral !== true) throw new Error("discord_non_ephemeral_media_unavailable_from_workers");
    const value = typeof reference.url === "string" ? reference.url : "";
    const attachmentId = typeof reference.id === "string" ? reference.id : "";
    const declaredSize = Number(reference.size);
    if (!/^\d{1,20}$/.test(attachmentId) || !Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > DISCORD_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error("discord_media_rejected");
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("discord_media_url_rejected"); }
    if (url.protocol !== "https:" || url.port || url.hostname !== "cdn.discordapp.com" || url.username || url.password ||
        url.hash || url.pathname.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("discord_media_url_rejected");
    }
    const path = url.pathname.split("/");
    if (path.length !== 5 || path[1] !== "attachments" || path[2] !== channelId || path[3] !== attachmentId || !path[4]) {
      throw new Error("discord_media_url_rejected");
    }
    const expiresAt = signedAttachmentExpiry(url, now);
    return { reference, url, declaredSize, expiresAt };
  });
  const declaredTotal = prepared.reduce((sum, item) => sum + item.declaredSize, 0);
  if (declaredTotal > DISCORD_ATTACHMENT_LIMITS.maxTotalBytes) throw new Error("discord_media_rejected");
  const results: DownloadedChannelAttachment[] = [];
  for (const { reference, url, declaredSize, expiresAt } of prepared) {
    if ((input.now ?? Date.now()) >= expiresAt) throw new Error("discord_media_url_expired");
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`discord_media_download_failed:${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > DISCORD_ATTACHMENT_LIMITS.maxFileBytes)) {
      await response.body?.cancel();
      throw new Error(Number(contentLength) > DISCORD_ATTACHMENT_LIMITS.maxFileBytes ? "discord_media_too_large" : "discord_media_rejected");
    }
    const bytes = await readBounded(response);
    if (bytes.byteLength !== declaredSize) throw new Error("discord_media_size_mismatch");
    const filename = safeFilename(typeof reference.filename === "string" ? reference.filename : String(reference.id ?? "attachment"));
    const mimeType = resolveFileContentType(filename, reference.content_type);
    results.push({ filename, mimeType, bytes });
  }
  return results;
}
