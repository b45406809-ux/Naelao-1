import type { DownloadedChannelAttachment } from "../launchpad/whatsapp-media.js";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

interface AttachmentDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

interface AttachmentBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface StoredChannelAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Store provider bytes under private keys and derive retry-stable opaque handles. */
export async function storeChannelAttachments(input: {
  db: AttachmentDb;
  bucket: AttachmentBucket;
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  taskId: string;
  channel: string;
  files: readonly DownloadedChannelAttachment[];
  now?: number;
}): Promise<StoredChannelAttachment[]> {
  if (input.files.length > MAX_FILES) throw new Error("channel_attachment_count_limit");
  const total = input.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (input.files.some((file) => file.bytes.byteLength <= 0 || file.bytes.byteLength > MAX_FILE_BYTES) || total > MAX_TOTAL_BYTES) {
    throw new Error("channel_attachment_size_limit");
  }
  const scope = `${input.tenantId}\0${input.spaceId}\0${input.taskId}`;
  const scopeHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(input.platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const taskSegment = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "task";
  const now = input.now ?? Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  const stored: StoredChannelAttachment[] = [];

  for (let index = 0; index < input.files.length; index++) {
    const file = input.files[index]!;
    const safeFilename = file.filename.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment";
    const idDigest = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey,
      new TextEncoder().encode(`${input.channel}\0${scope}\0${index}`)));
    const id = `ca_${[...idDigest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const existing = await input.db.prepare(
      "SELECT id FROM channel_attachments WHERE id=? AND tenant_id=? AND space_id=? AND task_id=? AND expires_at>? LIMIT 1",
    ).bind(id, input.tenantId, input.spaceId, input.taskId, createdAt).first<{ id: string }>();
    if (!existing) {
      const key = `spaces/${input.spaceId}/channel-inbound/${taskSegment}/${scopeHash}/${index}-${safeFilename}`;
      await input.bucket.put(key, file.bytes, { httpMetadata: { contentType: file.mimeType } });
      await input.db.prepare(
        `INSERT OR IGNORE INTO channel_attachments
         (id, tenant_id, space_id, task_id, channel, object_key, filename, mime_type, size_bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, input.tenantId, input.spaceId, input.taskId, input.channel, key, safeFilename, file.mimeType, file.bytes.byteLength, createdAt, expiresAt).run();
    }
    stored.push({ id, filename: safeFilename, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength });
  }
  return stored;
}
