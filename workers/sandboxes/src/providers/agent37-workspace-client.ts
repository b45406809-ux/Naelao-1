import { mintInternalToken } from "@naelao/http";
import type { ComputerConfig } from "@naelao/sandboxes-core";
import type { Agent37Provider, Agent37WorkspaceHandoff } from "./agent37.js";
import type { RuntimeRequest } from "@naelao/sandboxes-core";

export interface Agent37WorkspaceClientEnv {
  AGENTS_WORKER?: Fetcher;
  PLATFORM_SECRET: string;
}

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_STAGED_BYTES = 20 * 1024 * 1024;

/** Service-binding client for the Agents checked workspace route. All publication work is
 * delegated to WorkspaceCoordinatorDO; no legacy R2 bridge or per-file CAS is used. */
export function agent37WorkspaceHandoff(env: Agent37WorkspaceClientEnv, computer: ComputerConfig): Agent37WorkspaceHandoff {
  if (!env.AGENTS_WORKER) throw new Error("workspace_coordinator_unavailable");
  if (!computer.scope.tenantId || !computer.scope.ownerId || !computer.scope.spaceId || !computer.scope.projectId) throw new Error("workspace_scope_required");
  const tenantId = computer.scope.tenantId;
  const userId = computer.scope.ownerId;
  const branch = computer.scope.branch ?? "main";
  const request = async (body: Record<string, unknown>): Promise<Response> => env.AGENTS_WORKER!.fetch(new Request("http://agents-worker/internal/sandbox-agent37-workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-user-id": userId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
    },
    body: JSON.stringify({ computerId: computer.id, runtimeId: computer.id, ...body }),
  }));
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) throw new Error(`workspace_coordinator_http_${response.status}`);
    return await response.json() as T;
  };
  return {
    async readCommitted({ allocationGeneration }) {
      const opened = await json<{ session: { id: string; fence: number }; head: { revision: number } }>(await request({ operation: "open", allocationGeneration }));
      const sessionId = opened.session.id;
      const fence = opened.session.fence;
      try {
        const snapshot = await json<{ session: { baseRevision: number; allocationGeneration: number }; entries: Array<{ path: string; sha256: string; size: number; executable: boolean; contentType?: string }> }>(await request({ operation: "snapshot", sessionId, allocationGeneration, fence }));
        if (snapshot.entries.length > MAX_ENTRIES) throw new Error("workspace_entry_limit_exceeded");
        let total = 0;
        const files = [];
        for (const entry of snapshot.entries) {
          if (entry.size > MAX_FILE_BYTES || (total += entry.size) > MAX_SNAPSHOT_BYTES) throw new Error("workspace_snapshot_limit_exceeded");
          const response = await request({ operation: "content", sessionId, allocationGeneration, fence, filePath: entry.path });
          if (!response.ok) throw new Error(`workspace_content_http_${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const contentType = entry.contentType ?? "application/octet-stream";
          if (bytes.byteLength !== entry.size || response.headers.get("x-content-sha256") !== entry.sha256 || response.headers.get("x-executable") !== String(entry.executable) ||
              (response.headers.get("content-type") ?? "application/octet-stream") !== contentType) throw new Error("workspace_content_metadata_mismatch");
          files.push({ path: entry.path, sha256: entry.sha256, executable: entry.executable, contentType, bytes });
        }
        return { tenantId, spaceId: computer.scope.spaceId!, projectId: computer.scope.projectId!, branch,
          sessionId, revision: snapshot.session.baseRevision, fence, allocationGeneration: snapshot.session.allocationGeneration, files };
      } catch (error) {
        // No provider execution has been dispatched yet, so closing this read-only session is safe.
        await request({ operation: "close", sessionId, allocationGeneration, fence }).catch(() => undefined);
        throw error;
      }
    },
    async stage({ sessionId, stageId, revision: _revision, fence, allocationGeneration, changes }) {
      if (changes.length > 100) throw new Error("workspace_change_limit_exceeded");
      let total = 0;
      const wireChanges = changes.map((change) => {
        if (!change.bytes) return { path: change.path, expectedHash: change.expectedHash, contentBase64: null, executable: change.executable, contentType: change.contentType };
        if (change.bytes.byteLength > MAX_FILE_BYTES || (total += change.bytes.byteLength) > MAX_STAGED_BYTES) throw new Error("workspace_stage_limit_exceeded");
        return { path: change.path, expectedHash: change.expectedHash, contentBase64: base64(change.bytes), executable: change.executable, contentType: change.contentType };
      });
      return await json<{ stageId: string }>(await request({ operation: "stage", sessionId, stageId, allocationGeneration, fence, changes: wireChanges }));
    },
    async publish({ sessionId, stageId, revision, fence, allocationGeneration, idempotencyKey }) {
      try {
        const value = await json<{ publication: { id: string; status: "published" | "conflicted" | "noop" } }>(await request({ operation: "publish", sessionId, stageId, baseRevision: revision, fence, allocationGeneration, idempotencyKey }));
        return { publicationId: value.publication.id, status: value.publication.status };
      } catch (error) {
        // A response may be lost after commit. Lookup is read-only; an absent receipt is still
        // ambiguous and must not trigger another execution or publish attempt.
        try {
          const value = await json<{ publication: { id: string; status: "published" | "conflicted" | "noop" } }>(await request({ operation: "receipt", sessionId, fence, allocationGeneration, idempotencyKey }));
          return { publicationId: value.publication.id, status: value.publication.status };
        } catch { throw error; }
      }
    },
    async close({ sessionId, fence, allocationGeneration }) {
      await json<{ status: string }>(await request({ operation: "close", sessionId, fence, allocationGeneration }));
    },
  };
}

/** Runtime entrypoint used by a provider execution dispatcher after it has authorized the
 * computer and resolved its credentials/allocation. Availability remains controlled by the
 * sandbox worker's provider gate. */
export function invokeAgent37WithCheckedWorkspace(provider: Agent37Provider, env: Agent37WorkspaceClientEnv, request: RuntimeRequest) {
  return provider.invokeWithWorkspace(request, agent37WorkspaceHandoff(env, request.computer));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return btoa(binary);
}
