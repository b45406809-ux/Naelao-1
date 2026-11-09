import { sha256Bytes } from "../script-engine/r2-cas.js";
import { validateWorkspacePath, type WorkspaceScope } from "../workspace/workspace-contract.js";

export const MAX_COORDINATOR_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface ChatUploadManifestSnapshot {
  head: { branch: string; revision: number; updatedAt?: string };
  entries: Array<{ path: string; sha256: string; size: number; contentType?: string }>;
}

export interface ChatUploadPublication {
  status: "published" | "noop" | "conflicted";
  revision: number;
}

/** Publish one authorized session upload to the canonical main branch with an observed hash. */
export async function publishProjectChatUpload(input: {
  scope: WorkspaceScope;
  sessionId: string;
  filename: string;
  contentType?: string;
  actorId: string;
  bytes: Uint8Array | null;
  readSnapshot(path: string): Promise<ChatUploadManifestSnapshot>;
  publish(change: { branch: "main"; actorId: string; path: string; expectedHash: string | null; bytes: Uint8Array | null; contentType: string; idempotencyKey: string }): Promise<ChatUploadPublication>;
}): Promise<{ path: string; hash: string | null; revision: number; deleted: boolean }> {
  const path = `uploads/${input.sessionId}/${input.filename}`;
  if (!validateWorkspacePath(path)) throw new Error("chat_upload_workspace_path_invalid");
  if (input.bytes && input.bytes.byteLength > MAX_COORDINATOR_UPLOAD_BYTES) throw new Error("chat_upload_coordinator_file_limit");
  const snapshot = await input.readSnapshot(path);
  const current = snapshot.entries.find(entry => entry.path === path);
  const expectedHash = current?.sha256 ?? null;
  const hash = input.bytes ? await sha256Bytes(input.bytes) : null;
  const idempotencyKey = await sha256Bytes(new TextEncoder().encode(JSON.stringify({
    action: input.bytes ? "chat-upload-write" : "chat-upload-delete",
    tenantId: input.scope.tenantId, spaceId: input.scope.spaceId, projectId: input.scope.projectId,
    sessionId: input.sessionId, path, expectedHash, hash,
  })));
  const contentType = input.contentType ?? "application/octet-stream";
  const result = await input.publish({ branch: "main", actorId: input.actorId, path, expectedHash, bytes: input.bytes, contentType, idempotencyKey });
  if (result.status === "conflicted") throw new Error("chat_upload_revision_conflict");
  if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error("chat_upload_publication_unconfirmed");
  return { path, hash, revision: result.revision, deleted: input.bytes === null && result.status === "published" };
}
