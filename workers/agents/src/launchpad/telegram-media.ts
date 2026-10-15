import type { DownloadedChannelAttachment } from "./whatsapp-media.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function mediaEntries(raw: JsonObject): Array<{ item: JsonObject; kind: string }> {
  const message = object(raw.message);
  if (!message) return [];
  const result: Array<{ item: JsonObject; kind: string }> = [];
  const photo = message.photo;
  if (Array.isArray(photo) && photo.length) {
    const largest = photo.at(-1);
    const item = object(largest);
    if (item) result.push({ item, kind: "photo" });
  }
  for (const kind of ["document", "audio", "voice", "video", "animation", "video_note", "sticker"]) {
    const item = object(message[kind]);
    if (item) result.push({ item, kind });
  }
  return result.slice(0, 5);
}

export function hasTelegramMedia(raw: JsonObject): boolean {
  return mediaEntries(raw).length > 0;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("telegram_media_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error("telegram_media_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function safeFilename(value: string): string {
  return value.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "telegram-attachment";
}

/** Download bounded Telegram Bot API files using the platform bot token.
 * The webhook token is never treated as a bot API credential and provider paths
 * are accepted only from getFile's JSON response.
 */
export async function downloadTelegramAttachments(
  raw: JsonObject,
  input: { botToken?: string; fetcher?: typeof fetch },
): Promise<DownloadedChannelAttachment[]> {
  if (!input.botToken) throw new Error("telegram_media_unavailable");
  const fetcher = input.fetcher ?? fetch;
  const files: DownloadedChannelAttachment[] = [];
  for (const { item, kind } of mediaEntries(raw)) {
    const fileId = typeof item.file_id === "string" ? item.file_id : "";
    if (!fileId) continue;
    const infoResponse = await fetcher(`https://api.telegram.org/bot${input.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!infoResponse.ok) throw new Error(`telegram_file_lookup_failed:${infoResponse.status}`);
    const payload = await infoResponse.json() as JsonObject;
    const result = object(payload.result);
    const path = typeof result?.file_path === "string" ? result.file_path : "";
    const declaredBytes = Number(result?.file_size ?? item.file_size ?? -1);
    if (!payload.ok || !path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(declaredBytes) || declaredBytes === 0 || declaredBytes > MAX_FILE_BYTES) {
      throw new Error("telegram_media_rejected");
    }
    const pathUrl = new URL(path, "https://api.telegram.org/file/");
    if (pathUrl.hostname !== "api.telegram.org" || pathUrl.protocol !== "https:" || pathUrl.username || pathUrl.password) {
      throw new Error("telegram_media_url_rejected");
    }
    const response = await fetcher(`https://api.telegram.org/file/bot${input.botToken}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`telegram_media_download_failed:${response.status}`);
    const bytes = await readBounded(response);
    if (declaredBytes > 0 && bytes.byteLength !== declaredBytes) throw new Error("telegram_media_size_mismatch");
    const rawName = typeof item.file_name === "string" ? item.file_name : `${kind}-${String(item.file_unique_id ?? files.length + 1)}`;
    const mimeType = typeof item.mime_type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(item.mime_type)
      ? item.mime_type.toLowerCase() : kind === "photo" ? "image/jpeg" : "application/octet-stream";
    files.push({ filename: safeFilename(rawName), mimeType, bytes });
  }
  return files;
}
