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

/** Cloudflare Workers can fetch Discord ephemeral CDN media, while its official guide
 * documents that non-ephemeral CDN fetches fail from Workers. Only handle ephemeral files here.
 */
export async function downloadDiscordAttachments(raw: JsonObject, input: { fetcher?: typeof fetch } = {}): Promise<DownloadedChannelAttachment[]> {
  if ((Array.isArray(raw.attachments) ? raw.attachments.length : 0) > DISCORD_ATTACHMENT_LIMITS.maxFiles) throw new Error("discord_media_rejected");
  const references = attachments(raw);
  const fetcher = input.fetcher ?? fetch;
  const prepared = references.map((reference) => {
    if (reference.ephemeral !== true) throw new Error("discord_non_ephemeral_media_unavailable_from_workers");
    const value = typeof reference.url === "string" ? reference.url : "";
    const declaredSize = Number(reference.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > DISCORD_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error("discord_media_rejected");
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("discord_media_url_rejected"); }
    if (url.protocol !== "https:" || url.port || url.hostname !== "cdn.discordapp.com" || url.username || url.password ||
        !url.pathname.startsWith("/attachments/") || url.pathname.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("discord_media_url_rejected");
    }
    return { reference, url, declaredSize };
  });
  const declaredTotal = prepared.reduce((sum, item) => sum + item.declaredSize, 0);
  if (declaredTotal > DISCORD_ATTACHMENT_LIMITS.maxTotalBytes) throw new Error("discord_media_rejected");
  const results: DownloadedChannelAttachment[] = [];
  for (const { reference, url, declaredSize } of prepared) {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`discord_media_download_failed:${response.status}`);
    const bytes = await readBounded(response);
    if (bytes.byteLength !== declaredSize) throw new Error("discord_media_size_mismatch");
    const filename = safeFilename(typeof reference.filename === "string" ? reference.filename : String(reference.id ?? "attachment"));
    const mimeType = resolveFileContentType(filename, reference.content_type);
    results.push({ filename, mimeType, bytes });
  }
  return results;
}
