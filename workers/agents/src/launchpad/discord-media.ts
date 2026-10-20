import type { DownloadedChannelAttachment } from "./whatsapp-media.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function attachments(raw: JsonObject): JsonObject[] {
  return (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 5).map(object).filter((item): item is JsonObject => Boolean(item));
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
      if (total > MAX_FILE_BYTES) {
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
  const references = attachments(raw);
  const fetcher = input.fetcher ?? fetch;
  const results: DownloadedChannelAttachment[] = [];
  let total = 0;
  for (const reference of references) {
    if (reference.ephemeral !== true) throw new Error("discord_non_ephemeral_media_unavailable_from_workers");
    const value = typeof reference.url === "string" ? reference.url : "";
    const declaredSize = Number(reference.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_FILE_BYTES || total + declaredSize > MAX_TOTAL_BYTES) {
      throw new Error("discord_media_rejected");
    }
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.hostname !== "cdn.discordapp.com" || url.username || url.password ||
        !url.pathname.startsWith("/attachments/") || url.pathname.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("discord_media_url_rejected");
    }
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`discord_media_download_failed:${response.status}`);
    const bytes = await readBounded(response);
    if (bytes.byteLength !== declaredSize) throw new Error("discord_media_size_mismatch");
    const filename = safeFilename(typeof reference.filename === "string" ? reference.filename : String(reference.id ?? "attachment"));
    const mimeType = typeof reference.content_type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(reference.content_type)
      ? reference.content_type.toLowerCase() : "application/octet-stream";
    results.push({ filename, mimeType, bytes });
    total += bytes.byteLength;
  }
  return results;
}
