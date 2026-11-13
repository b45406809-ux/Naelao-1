import type { DownloadedChannelAttachment } from "../launchpad/whatsapp-media.js";
import { inferWorkspaceContentType } from "@naelao/types";
import { CHANNEL_ATTACHMENT_RETENTION_DAYS } from "../launchpad/channel-media-capabilities.js";

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
  /** Optional channel-installation fence; omitted for non-extension task attachments. */
  extensionScope?: { projectId: string | null; installationId: string; providerConnectionId: string | null };
  files: readonly DownloadedChannelAttachment[];
  /** Per-ingress override for separately bounded first-party workspace uploads. */
  limits?: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
  /** Stable index for per-file ingestion so retries produce the same opaque id/key. */
  indexOffset?: number;
  now?: number;
}): Promise<StoredChannelAttachment[]> {
  const maxFiles = input.limits?.maxFiles ?? MAX_FILES;
  const maxFileBytes = input.limits?.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = input.limits?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (input.files.length > maxFiles) throw new Error("channel_attachment_count_limit");
  const total = input.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (input.files.some((file) => file.bytes.byteLength <= 0 || file.bytes.byteLength > maxFileBytes) || total > maxTotalBytes) {
    throw new Error("channel_attachment_size_limit");
  }
  const scope = `${input.tenantId}\0${input.spaceId}\0${input.taskId}`;
  const extensionScope = input.extensionScope
    ? `${input.extensionScope.projectId ?? ""}\0${input.extensionScope.installationId}\0${input.extensionScope.providerConnectionId ?? ""}`
    : "";
  // Preserve legacy retry IDs/object paths for attachment callers that do not opt into a
  // channel-installation fence; only the new extension-scoped lane changes its derivation.
  const idScope = input.extensionScope ? `${scope}\0${extensionScope}` : scope;
  const scopeHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idScope)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(input.platformSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const taskSegment = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "task";
  const now = input.now ?? Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CHANNEL_ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const stored: StoredChannelAttachment[] = [];

  for (let index = 0; index < input.files.length; index++) {
    const file = input.files[index]!;
    const recordIndex = (input.indexOffset ?? 0) + index;
    const safeFilename = file.filename.replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment";
    const mimeType = file.mimeType === "application/octet-stream" ? inferWorkspaceContentType(safeFilename) : file.mimeType;
    const idDigest = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey,
      new TextEncoder().encode(`${input.channel}\0${idScope}\0${recordIndex}`)));
    const id = `ca_${[...idDigest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const existing = await input.db.prepare(
      "SELECT id FROM channel_attachments WHERE id=? AND tenant_id=? AND space_id=? AND task_id=? AND expires_at>? LIMIT 1",
    ).bind(id, input.tenantId, input.spaceId, input.taskId, createdAt).first<{ id: string }>();
    if (!existing) {
      const key = `spaces/${input.spaceId}/channel-inbound/${taskSegment}/${scopeHash}/${recordIndex}-${safeFilename}`;
      await input.bucket.put(key, file.bytes, { httpMetadata: { contentType: mimeType } });
      await input.db.prepare(
        `INSERT OR IGNORE INTO channel_attachments
         (id, tenant_id, space_id, task_id, channel, object_key, filename, mime_type, size_bytes, created_at, expires_at,
          project_id, installation_id, provider_connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, input.tenantId, input.spaceId, input.taskId, input.channel, key, safeFilename, mimeType, file.bytes.byteLength, createdAt, expiresAt,
        input.extensionScope?.projectId ?? null, input.extensionScope?.installationId ?? null, input.extensionScope?.providerConnectionId ?? null).run();
    }
    stored.push({ id, filename: safeFilename, mimeType, sizeBytes: file.bytes.byteLength });
  }
  return stored;
}
