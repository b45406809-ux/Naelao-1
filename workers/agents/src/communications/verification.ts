import type { AgentsEnv } from "../index.js";
import type { ParsedCloudflareEmail } from "../channels/cloudflare-email.js";
import { hashEmailAddress } from "../channels/cloudflare-email.js";
import {
  channelPreferences,
  sealCommunication,
  type CommunicationIdentity,
} from "./core.js";
export async function receiveVerification(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  recipient: string,
  mail: ParsedCloudflareEmail,
  messageId: string
): Promise<boolean> {
  const wait = await env.PLATFORM_DB.prepare(
    "SELECT id,kind,sender_hosts_json,origins_json,status FROM assistant_verification_waits WHERE transport='email' AND address_hash=? AND identity_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(
      await hashEmailAddress(recipient),
      identity.id,
      new Date().toISOString()
    )
    .first<{
      id: string;
      kind: string;
      sender_hosts_json: string;
      origins_json: string;
      status: string;
    }>();
  if (!wait) return false;
  if (wait.status !== "waiting") return true;
  const senderHost = mail.from.toLowerCase().split("@").at(-1) ?? "";
  if (!(JSON.parse(wait.sender_hosts_json) as string[]).includes(senderHost))
    return false;
  let secret: string | undefined;
  if (wait.kind === "code") {
    const codes = [...new Set(mail.text.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [])];
    if (codes.length === 1) secret = codes[0];
  } else {
    const origins = JSON.parse(wait.origins_json) as string[];
    const links = [
      ...new Set(
        [
          ...(mail.text.match(/https:\/\/[^\s<>"']+/g) ?? []),
          ...(mail.links ?? []),
        ].filter((link) => {
          try {
            const url = new URL(link);
            return (
              !url.username && !url.password && origins.includes(url.origin)
            );
          } catch {
            return false;
          }
        })
      ),
    ];
    if (links.length === 1) secret = links[0];
  }
  if (!secret) {
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_verification_waits SET status='ambiguous',message_id=? WHERE id=? AND status='waiting'"
    )
      .bind(messageId, wait.id)
      .run();
    return true;
  }
  const envelope = await sealCommunication(env, identity, wait.id, { secret });
  await env.PLATFORM_DB.prepare(
    "UPDATE assistant_verification_waits SET status='received',secret_json=?,message_id=? WHERE id=? AND identity_id=? AND status='waiting'"
  )
    .bind(JSON.stringify(envelope), messageId, wait.id, identity.id)
    .run();
  return true;
}

/** A single number cannot route replies by alias, so one pending website at a time owns it. */
export async function receiveSmsVerification(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  bindingId: string,
  sender: string,
  text: string,
  messageId: string
): Promise<{ actorId: string } | null> {
  const wait = await env.PLATFORM_DB.prepare(
    "SELECT id,kind,actor_id,status,sender_hosts_json FROM assistant_verification_waits WHERE identity_id=? AND phone_binding_id=? AND transport='sms' AND status IN ('waiting','received') AND expires_at>? LIMIT 1"
  )
    .bind(identity.id, bindingId, new Date().toISOString())
    .first<{
      id: string;
      kind: string;
      actor_id: string;
      status: string;
      sender_hosts_json: string;
    }>();
  if (
    !wait ||
    !(JSON.parse(wait.sender_hosts_json) as string[]).includes(
      sender.toLowerCase()
    )
  )
    return null;
  if (wait.status === "received") return { actorId: wait.actor_id };
  const codes = [...new Set(text.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [])];
  const envelope =
    codes.length === 1
      ? await sealCommunication(env, identity, wait.id, { secret: codes[0] })
      : null;
  await env.PLATFORM_DB.prepare(
    "UPDATE assistant_verification_waits SET status=?,secret_json=?,message_id=? WHERE id=? AND status='waiting'"
  )
    .bind(
      envelope ? "received" : "ambiguous",
      envelope ? JSON.stringify(envelope) : null,
      messageId,
      wait.id
    )
    .run();
  return { actorId: wait.actor_id };
}

export async function consumeVerification(
  env: AgentsEnv,
  scope: import("@naelao/agent-sdk").BrowserRuntimeScope,
  id: string,
  actionId: string,
  kind: "code" | "link"
): Promise<string> {
  if (!scope.connectionId || !actionId)
    throw new Error("verification_scope_required");
  const wait = await env.PLATFORM_DB.prepare(
    "SELECT w.*,i.owner_user_id,i.email_address,i.autonomy_json,i.scope_key,i.email_provider,i.email_status,i.status AS identity_status FROM assistant_verification_waits w JOIN assistant_communication_identities i ON i.id=w.identity_id WHERE w.id=? AND w.tenant_id=? AND w.space_id=? AND w.actor_id=? AND w.run_id=? AND w.connection_id=? AND COALESCE(w.project_id,'')=? AND i.status='active' AND w.expires_at>?"
  )
    .bind(
      id,
      scope.tenantId,
      scope.spaceId,
      scope.actorId,
      scope.runId,
      scope.connectionId,
      scope.projectId ?? "",
      new Date().toISOString()
    )
    .first<{
      id: string;
      identity_id: string;
      tenant_id: string;
      space_id: string;
      project_id: string | null;
      secret_json: string | null;
      status: string;
      kind: string;
      transport: string;
      phone_binding_id: string | null;
    }>();
  if (
    !wait ||
    wait.status !== "received" ||
    !wait.secret_json ||
    wait.kind !== kind
  )
    throw new Error("verification_not_ready_or_consumed");
  const preferences = await channelPreferences(env, {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    userId: scope.actorId,
    role: "product_end_user",
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  });
  if (!preferences.enabled[wait.transport === "sms" ? "phone" : "email"])
    throw new Error("verification_channel_disabled");
  if (wait.transport === "sms") {
    const phone = await env.PLATFORM_DB.prepare(
      "SELECT status,policy_json FROM assistant_phone_bindings WHERE id=? AND identity_id=?"
    )
      .bind(wait.phone_binding_id, wait.identity_id)
      .first<{ status: string; policy_json: string }>();
    if (
      !phone ||
      phone.status !== "active" ||
      JSON.parse(phone.policy_json).allowWebsiteVerification !== true
    )
      throw new Error("phone_verification_no_longer_authorized");
  }
  const { openCommunication } = await import("./core.js");
  const identity = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_communication_identities WHERE id=? AND status='active'"
  )
    .bind(wait.identity_id)
    .first<CommunicationIdentity>();
  if (!identity) throw new Error("verification_identity_unavailable");
  const value = await openCommunication(
    env,
    identity,
    wait.id,
    JSON.parse(wait.secret_json)
  );
  const claimed = await env.PLATFORM_DB.prepare(
    "UPDATE assistant_verification_waits SET status='consumed',secret_json=NULL,consumed_action_id=? WHERE id=? AND status='received'"
  )
    .bind(actionId, wait.id)
    .run();
  if (!claimed.meta.changes) throw new Error("verification_already_consumed");
  return String(value.secret);
}
