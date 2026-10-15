import type { DownloadedChannelAttachment } from "./whatsapp-media.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function files(raw: JsonObject): JsonObject[] {
  return (Array.isArray(raw.files) ? raw.files : []).map(object).filter((file): file is JsonObject => Boolean(file)).slice(0, 5);
}

export function hasSlackFiles(raw: JsonObject): boolean {
  return files(raw).length > 0;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("slack_media_body_missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error("slack_media_too_large");
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
  return name.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "slack-attachment";
}

/** Resolve Slack message file IDs with files:read and fetch only Slack-owned HTTPS URLs. */
export async function downloadSlackAttachments(raw: JsonObject, input: { botToken?: string; fetcher?: typeof fetch }): Promise<DownloadedChannelAttachment[]> {
  if (!input.botToken) throw new Error("slack_media_unavailable");
  const fetcher = input.fetcher ?? fetch;
  const results: DownloadedChannelAttachment[] = [];
  let aggregateBytes = 0;
  for (const reference of files(raw)) {
    const fileId = typeof reference.id === "string" ? reference.id : "";
    if (!fileId) throw new Error("slack_media_rejected");
    const infoResponse = await fetcher(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${input.botToken}`, accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!infoResponse.ok) throw new Error(`slack_file_lookup_failed:${infoResponse.status}`);
    const payload = await infoResponse.json() as JsonObject;
    const file = object(payload.file);
    const size = Number(file?.size);
    const downloadUrl = file?.url_private_download ?? file?.url_private;
    if (!payload.ok || !file || typeof downloadUrl !== "string" || !Number.isSafeInteger(size) || size <= 0 ||
        size > MAX_FILE_BYTES || aggregateBytes + size > MAX_TOTAL_BYTES) throw new Error("slack_media_rejected");
    const url = new URL(downloadUrl);
    if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))) {
      throw new Error("slack_media_url_rejected");
    }
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${input.botToken}` }, redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`slack_media_download_failed:${response.status}`);
    const bytes = await readBounded(response);
    if (bytes.byteLength !== size) throw new Error("slack_media_size_mismatch");
    const filename = safeFilename(typeof file.name === "string" ? file.name : typeof reference.name === "string" ? reference.name : fileId);
    const mimeType = typeof file.mimetype === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.mimetype)
      ? file.mimetype.toLowerCase() : "application/octet-stream";
    results.push({ filename, mimeType, bytes });
    aggregateBytes += bytes.byteLength;
  }
  return results;
}
