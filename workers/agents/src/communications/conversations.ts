import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import { ensureIdentity, type CommunicationScope } from "./core.js";
import { coordinationHash } from "./approval-decisions.js";
import { verifyVoiceSession } from "../voice/session-scope.js";
/** A default conversation belongs to a verified user and assistant scope, never a phone number. */
export async function assistantConversation(
  env: AgentsEnv,
  scope: CommunicationScope,
  requested?: string
): Promise<string> {
  const identity = await ensureIdentity(env, scope);
  const row = await env.PLATFORM_DB.prepare(
    "SELECT session_id FROM assistant_channel_conversations WHERE identity_id=? AND user_id=?"
  )
    .bind(identity.id, scope.userId)
    .first<{ session_id: string }>();
  let id = requested ?? row?.session_id;
  if (!id) {
    // Upgrade existing private telephone conversations without discarding their history.
    const prior = await env.PLATFORM_DB.prepare(
      "SELECT session_id FROM assistant_live_calls WHERE tenant_id=? AND space_id=? AND project_id IS ? AND user_id=? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(
        scope.tenantId,
        scope.spaceId,
        scope.projectId ?? null,
        scope.userId
      )
      .first<{ session_id: string }>();
    id = prior?.session_id;
  }
  if (!id) {
    const key = await coordinationHash(
      JSON.stringify([
        scope.tenantId,
        scope.spaceId,
        scope.projectId ?? null,
        scope.userId,
      ])
    );
    id = "assistant-" + key;
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": scope.tenantId,
      "x-naelao-user-id": scope.userId,
      "x-naelao-role": scope.role,
      "x-naelao-internal-token": await mintInternalToken(
        env.PLATFORM_SECRET,
        scope.tenantId
      ),
    };
    const thread = scope.projectId ? "assistant-thread-" + key : undefined;
    if (thread) {
      const r = await env.SPACES_WORKER.fetch(
        new Request(`http://spaces/spaces/${scope.spaceId}/threads`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: thread,
            project_id: scope.projectId,
            session_id: id,
            title: "Assistant conversation",
            thread_kind: "primary",
            thread_tier: "tier_2_task",
          }),
        })
      );
      if (!r.ok) throw new Error("assistant_conversation_unavailable");
    }
    const created = await env.SPACES_WORKER.fetch(
      new Request(`http://spaces/spaces/${scope.spaceId}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, ...(thread ? { thread_id: thread } : {}) }),
      })
    );
    if (
      !created.ok ||
      (await readBoundedResponseJson<{ id?: string }>(created, 4096)).id !== id
    )
      throw new Error("assistant_conversation_unavailable");
  }
  await verifyVoiceSession(env.SPACES_WORKER, env.PLATFORM_SECRET, scope, id);
  await env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_channel_conversations(identity_id,user_id,session_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(identity_id,user_id) DO UPDATE SET session_id=excluded.session_id,updated_at=excluded.updated_at"
  )
    .bind(identity.id, scope.userId, id, Date.now())
    .run();
  return id;
}
