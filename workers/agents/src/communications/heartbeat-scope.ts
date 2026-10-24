import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
export async function verifyHeartbeatSession(
  worker: Fetcher,
  secret: string,
  tenantId: string,
  spaceId: string,
  sessionId: string,
  projectId?: string
): Promise<void> {
  const response = await worker.fetch(
    new Request(
      `http://spaces/spaces/${encodeURIComponent(spaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(secret, tenantId),
        },
      }
    )
  );
  if (!response.ok) throw new Error("heartbeat_session_unavailable");
  const session = await readBoundedResponseJson<{
    id: string;
    metadata?: string | Record<string, unknown>;
  }>(response, 16384);
  const metadata =
    typeof session.metadata === "string"
      ? JSON.parse(session.metadata)
      : session.metadata;
  if (
    session.id !== sessionId ||
    metadata?.session_kind !== "heartbeat" ||
    (metadata.project_id ?? null) !== (projectId ?? null)
  )
    throw new Error("heartbeat_session_scope_mismatch");
}
