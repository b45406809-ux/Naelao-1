import { storeChannelAttachments, type StoredChannelAttachment } from "./channel-attachment-store.js";

interface ChatUploadObject {
  key: string;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface ChatUploadBucket {
  get(key: string): Promise<ChatUploadObject | null>;
}
interface ChatUploadDb {
  prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } };
}

const MAX_FILES = 6;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

function safeName(value: string): string {
  const name = value.split(/[\\/]/).pop()?.replace(/\.\./g, "_").trim() ?? "";
  return name.length > 0 && name.length <= 200 ? name : "";
}

/**
 * Convert only the upload names attached to this authenticated chat turn into task-scoped
 * opaque attachment records. The source key is constructed from the route scope; caller
 * supplied object keys are never accepted. Bytes are copied into the private attachment area
 * so task expiry cannot delete the session's original workspace upload.
 */
export async function indexChatUploads(input: {
  bucket: ChatUploadBucket;
  db: ChatUploadDb;
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  sessionId: string;
  projectId?: string;
  taskId: string;
  names: readonly string[];
}): Promise<StoredChannelAttachment[]> {
  if (input.names.length > MAX_FILES) throw new Error("chat_attachment_count_limit");
  const base = input.projectId
    ? `spaces/${input.spaceId}/projects/${input.projectId}/workspace/`
    : `spaces/${input.spaceId}/workspace/`;
  const files: Array<{ filename: string; key: string; size: number; etag: string; mimeType: string }> = [];
  let total = 0;
  const names = new Set<string>();
  for (const rawName of input.names) {
    const filename = safeName(rawName);
    if (!filename || filename !== rawName || names.has(filename)) throw new Error("chat_attachment_name_invalid");
    names.add(filename);
    const key = `${base}uploads/${input.sessionId}/${filename}`;
    const object = await input.bucket.get(key);
    if (!object) throw new Error("chat_attachment_not_found");
    if (object.size <= 0 || object.size > MAX_FILE_BYTES || total + object.size > MAX_TOTAL_BYTES) {
      throw new Error("chat_attachment_size_limit");
    }
    total += object.size;
    files.push({ filename, key, size: object.size, etag: object.etag, mimeType: object.httpMetadata?.contentType ?? "application/octet-stream" });
  }
  const stored: StoredChannelAttachment[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const object = await input.bucket.get(file.key);
    if (!object || object.size !== file.size || object.etag !== file.etag) throw new Error("chat_attachment_changed_during_index");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error("chat_attachment_size_mismatch");
    const [record] = await storeChannelAttachments({
      db: input.db as never,
      bucket: input.bucket as never,
      platformSecret: input.platformSecret,
      tenantId: input.tenantId,
      spaceId: input.spaceId,
      taskId: input.taskId,
      channel: "web-chat",
      files: [{ filename: file.filename, mimeType: file.mimeType, bytes }],
      indexOffset: index,
      limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
    });
    if (record) stored.push(record);
  }
  return stored;
}
