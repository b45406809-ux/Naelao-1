import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
export async function verifyHeartbeatSession(
  worker: Fetcher,
  secret: string,
  tenantId: string,
  spaceId: string,
  sessionId: string,
  projectId?: string,
  serviceIdentity?: { id: string; authorizationRevision: string }
): Promise<{ serviceIdentity?: { id: string; authorizationRevision: string } }> {
  let session: { id: string; metadata?: string | Record<string, unknown> };
  try {
    const response = await worker.fetch(
      new Request(
        `http://spaces/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { headers: {
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
        } }
      )
    );
    if (!response.ok) throw new Error("heartbeat_session_unavailable");
    session = await readBoundedResponseJson(response, 16384);
  } catch {
    throw new Error("heartbeat_session_unavailable");
  }
  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = typeof session.metadata === "string" ? JSON.parse(session.metadata) as Record<string, unknown> : session.metadata;
  } catch { throw new Error("heartbeat_session_scope_mismatch"); }
  if (
    session.id !== sessionId ||
    metadata?.session_kind !== "heartbeat" ||
    (metadata.project_id ?? null) !== (projectId ?? null) ||
    serviceIdentity && (metadata.service_identity_id !== serviceIdentity.id
      || metadata.authorization_revision !== serviceIdentity.authorizationRevision)
  )
    throw new Error("heartbeat_session_scope_mismatch");
  if (metadata?.service_identity_id !== undefined || metadata?.authorization_revision !== undefined) {
    if (typeof metadata.service_identity_id !== "string" || typeof metadata.authorization_revision !== "string"
      || !metadata.authorization_revision || metadata.authorization_revision.length > 128
      || !/^scheduled_job:[A-Za-z0-9_-]{1,128}$/.test(metadata.service_identity_id))
      throw new Error("heartbeat_session_service_identity_invalid");
    const actual = { id: metadata.service_identity_id, authorizationRevision: metadata.authorization_revision };
    if (serviceIdentity && (actual.id !== serviceIdentity.id || actual.authorizationRevision !== serviceIdentity.authorizationRevision))
      throw new Error("heartbeat_session_service_identity_mismatch");
    return { serviceIdentity: actual };
  }
  return {};
}
