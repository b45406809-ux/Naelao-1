import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { CommunicationScope } from "../communications/core.js";
/** Voice must not attach a Project tool scope to another Project's conversation. */
export async function verifyVoiceSession(
  worker: Fetcher,
  secret: string,
  scope: CommunicationScope,
  sessionId: string
): Promise<void> {
  const headers = {
    "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-user-id": scope.userId,
    "x-naelao-role": scope.role,
    "x-naelao-internal-token": await mintInternalToken(secret, scope.tenantId),
  };
  const base = `http://spaces/spaces/${encodeURIComponent(scope.spaceId)}`;
  const response = await worker.fetch(
    new Request(base + "/sessions/" + encodeURIComponent(sessionId), {
      headers,
    })
  );
  if (!response.ok) throw new Error("voice_session_unavailable");
  const session = await readBoundedResponseJson<{
    id?: string;
    thread_id?: string | null;
    project_id?: string | null;
    status?: string;
    space_id?: string;
    tenant_id?: string;
  }>(response, 16384);
  if (
    session.id !== sessionId ||
    (session.status !== undefined && session.status !== "active") ||
    (session.space_id !== undefined && session.space_id !== scope.spaceId) ||
    (session.tenant_id !== undefined && session.tenant_id !== scope.tenantId)
  )
    throw new Error("voice_session_mismatch");
  let project = session.project_id ?? null;
  if (session.thread_id) {
    const response = await worker.fetch(
      new Request(base + "/threads/" + encodeURIComponent(session.thread_id), {
        headers,
      })
    );
    if (!response.ok) throw new Error("voice_session_unavailable");
    const thread = await readBoundedResponseJson<{
      project_id?: string | null;
      session_id?: string | null;
    }>(response, 16384);
    if (thread.session_id && thread.session_id !== sessionId)
      throw new Error("voice_session_mismatch");
    project = thread.project_id ?? null;
  }
  if (project !== (scope.projectId ?? null))
    throw new Error("voice_session_project_mismatch");
}
