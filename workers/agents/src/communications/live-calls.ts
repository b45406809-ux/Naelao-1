import { mintInternalToken } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import type { CommunicationScope } from "./core.js";
import { scopeAccess, channelPreferences } from "./core.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AssistantPhoneBinding } from "./phones.js";
import { verifyVoiceSession } from "../voice/session-scope.js";
import { mintOwnerVoiceTicket } from "../voice/voice-ticket.js";

export interface LiveCall {
  id: string;
  binding_id: string;
  tenant_id: string;
  space_id: string;
  project_id: string | null;
  user_id: string;
  caller_role: string;
  session_id: string;
  code_hash: string;
  call_sid: string | null;
  status: string;
  expires_at: number;
  deadline: number | null;
}
export async function liveCodeHash(
  bindingId: string,
  code: string
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${bindingId}:${code}`)
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
/** Only the authenticated human may arm a call; a shared Project identity's original owner
 * is not substituted for the user authorizing this particular call. */
export async function armLiveCall(
  env: AgentsEnv,
  scope: CommunicationScope,
  binding: AssistantPhoneBinding,
  sessionId: unknown
) {
  if (
    sessionId !== undefined &&
    (typeof sessionId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId))
  )
    throw new Error("live_call_session_required");
  if (binding.status !== "active")
    throw new Error("assistant_phone_not_connected");
  const headers = {
    "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-user-id": scope.userId,
    "x-naelao-role": scope.role,
    "x-naelao-internal-token": await mintInternalToken(
      env.PLATFORM_SECRET,
      scope.tenantId
    ),
  };
  if (sessionId === undefined) {
    const previous = await env.PLATFORM_DB.prepare(
      "SELECT session_id FROM assistant_live_calls WHERE binding_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1"
    )
      .bind(binding.id, scope.userId)
      .first<{ session_id: string }>();
    if (previous) sessionId = previous.session_id;
  }
  if (sessionId === undefined) {
    sessionId = crypto.randomUUID();
    const threadId = scope.projectId ? crypto.randomUUID() : undefined;
    if (threadId) {
      const created = await env.SPACES_WORKER.fetch(
        new Request(
          `http://spaces/spaces/${encodeURIComponent(scope.spaceId)}/threads`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              id: threadId,
              project_id: scope.projectId,
              session_id: sessionId,
              title: "Voice conversation",
              thread_tier: "tier_2_task",
              thread_kind: "primary",
            }),
          }
        )
      );
      if (!created.ok) throw new Error("live_call_thread_unavailable");
    }
    const created = await env.SPACES_WORKER.fetch(
      new Request(
        `http://spaces/spaces/${encodeURIComponent(scope.spaceId)}/sessions`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            id: sessionId,
            ...(threadId ? { thread_id: threadId } : {}),
          }),
        }
      )
    );
    if (!created.ok) throw new Error("live_call_session_unavailable");
  }
  const actualSessionId = sessionId as string;
  await verifyVoiceSession(
    env.SPACES_WORKER,
    env.PLATFORM_SECRET,
    scope,
    actualSessionId
  );
  const now = Math.floor(Date.now() / 1000);
  // Uniform 8-digit code, not Math.random. Never retain its plaintext.
  const bytes = new Uint32Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0]! >= 4_200_000_000);
  const code = String(bytes[0]! % 100_000_000).padStart(8, "0");
  const id = crypto.randomUUID();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "UPDATE assistant_live_calls SET status='revoked' WHERE binding_id=? AND status='armed'"
    ).bind(binding.id),
    env.PLATFORM_DB.prepare(
      "INSERT INTO assistant_live_calls(id,binding_id,tenant_id,space_id,project_id,user_id,caller_role,session_id,code_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'armed',?,?)"
    ).bind(
      id,
      binding.id,
      scope.tenantId,
      scope.spaceId,
      scope.projectId ?? null,
      scope.userId,
      scope.role,
      actualSessionId,
      await liveCodeHash(binding.id, code),
      now + 180,
      now
    ),
  ]);
  return {
    live_call_id: id,
    code,
    expires_at: now + 180,
    session_id: actualSessionId,
    phone_number: binding.phone_number,
  };
}
/** Atomic claim makes Twilio callback retries/reconnects reuse this call, never reauthorize another. */
export async function claimLiveCall(
  env: AgentsEnv,
  binding: AssistantPhoneBinding,
  callSid: string,
  code: string,
  maxSeconds: number
): Promise<LiveCall | null> {
  if (
    !/^CA[a-fA-F0-9]{32}$/.test(callSid) ||
    !/^\d{8}$/.test(code) ||
    !Number.isSafeInteger(maxSeconds) ||
    maxSeconds < 30 ||
    maxSeconds > 900
  )
    return null;
  const now = Math.floor(Date.now() / 1000);
  const hash = await liveCodeHash(binding.id, code);
  const existing = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_live_calls WHERE binding_id=? AND code_hash=? AND call_sid=? AND status='connected' AND deadline>?"
  )
    .bind(binding.id, hash, callSid, now)
    .first<LiveCall>();
  if (existing) return existing;
  const attempt = await env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_live_call_attempts(call_sid,binding_id,attempts,created_at) VALUES(?,?,1,?) ON CONFLICT(call_sid) DO UPDATE SET attempts=attempts+1 WHERE binding_id=excluded.binding_id AND attempts<5"
  )
    .bind(callSid, binding.id, now)
    .run();
  if (attempt.meta.changes !== 1) return null;
  // An identical retry may retrieve the same connected claim, but cannot move its deadline.
  await env.PLATFORM_DB.prepare(
    "UPDATE assistant_live_calls SET status='connected',call_sid=?,deadline=? WHERE binding_id=? AND code_hash=? AND status='armed' AND expires_at>?"
  )
    .bind(callSid, now + maxSeconds, binding.id, hash, now)
    .run();
  return env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_live_calls WHERE binding_id=? AND code_hash=? AND call_sid=? AND status='connected' AND deadline>?"
  )
    .bind(binding.id, hash, callSid, now)
    .first<LiveCall>();
}
export async function liveCallAllowed(
  env: AgentsEnv,
  call: LiveCall
): Promise<boolean> {
  const scope: CommunicationScope = {
    tenantId: call.tenant_id,
    spaceId: call.space_id,
    userId: call.user_id,
    role: call.caller_role,
    ...(call.project_id ? { projectId: call.project_id } : {}),
  };
  return (
    (await scopeAccess(env, scope, true)) &&
    (await channelPreferences(env, scope)).enabled.phone &&
    !(await isSpaceNetworkEgressDenied(env.PLATFORM_DB, call.space_id))
  );
}
export async function liveCallTicket(env: AgentsEnv, call: LiveCall) {
  if (!call.call_sid || !call.deadline || !(await liveCallAllowed(env, call)))
    throw new Error("live_call_access_revoked");
  const agentName =
    "phone-" +
    (await liveCodeHash(
      call.binding_id,
      JSON.stringify([call.tenant_id, call.user_id, call.session_id])
    ));
  return mintOwnerVoiceTicket(
    {
      tenantId: call.tenant_id,
      spaceId: call.space_id,
      sessionId: call.session_id,
      userId: call.user_id,
      role: "owner",
      callerRole: call.caller_role,
      agentName,
      expiresAt: call.deadline,
      nonce: call.id,
      ...(call.project_id ? { projectId: call.project_id } : {}),
      phoneBindingId: call.binding_id,
      callSid: call.call_sid,
    },
    env.PLATFORM_SECRET
  );
}
