import {
  deriveKek,
  encryptAuthenticated,
  decryptAuthenticated,
  getDOName,
  signHmac,
} from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";
import {
  createAgentEmailAddress,
  hashEmailAddress,
  normalizeIngressDomain,
} from "../channels/cloudflare-email.js";
import { isSpaceNetworkEgressDenied } from "@naelao/security";
import type { AgentsEnv } from "../index.js";
import type { AssistantChannelPreferences } from "@naelao/agent-sdk";
export interface CommunicationScope {
  tenantId: string;
  spaceId: string;
  userId: string;
  projectId?: string;
  role: string;
}
export interface CommunicationIdentity {
  id: string;
  tenant_id: string;
  space_id: string;
  project_id: string | null;
  scope_key: string;
  owner_user_id: string;
  email_address: string | null;
  address_hash: string | null;
  email_provider: string;
  email_status: string;
  status: string;
  autonomy_json: string;
}
export async function scopeAccess(
  env: AgentsEnv,
  scope: CommunicationScope,
  write = false
): Promise<boolean> {
  const space = await env.PLATFORM_DB.prepare(
    "SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id AND o.status='active' WHERE s.id=? AND s.tenant_id=? AND s.status='active'"
  )
    .bind(scope.spaceId, scope.tenantId)
    .first();
  if (!space || !scope.userId) return false;
  let role = scope.role;
  if (role === "product_end_user") {
    const direct = await env.PLATFORM_DB.prepare(
      "SELECT role FROM space_members WHERE space_id=? AND end_user_id=? AND suspended_at IS NULL"
    )
      .bind(scope.spaceId, scope.userId)
      .first<{ role: string }>();
    const member =
      direct ??
      (await env.PLATFORM_DB.prepare(
        "SELECT role FROM space_members WHERE space_id=? AND end_user_id=? AND suspended_at IS NULL"
      )
        .bind(scope.spaceId, scope.userId)
        .first<{ role: string }>());
    if (!member) return false;
    role = member.role;
  }
  if (
    ![
      "owner",
      "admin",
      "member",
      "editor",
      "operator",
      "viewer",
      "moderator",
    ].includes(role) ||
    (write && role === "viewer")
  )
    return false;
  if (scope.projectId) {
    const r = await env.SPACES_WORKER.fetch(
      new Request(
        `http://spaces/spaces/${encodeURIComponent(scope.spaceId)}/projects/${encodeURIComponent(scope.projectId)}/assistant-access?user_id=${encodeURIComponent(scope.userId)}`,
        {
          headers: {
            "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-user-id": scope.userId,
            "x-naelao-role": scope.role,
            "x-naelao-internal-token": await mintInternalToken(
              env.PLATFORM_SECRET,
              scope.tenantId
            ),
          },
        }
      )
    );
    const access = r.ok ? await r.json<{ effective_role?: string }>() : {};
    if (!access.effective_role || (write && access.effective_role === "viewer"))
      return false;
  }
  return true;
}
export async function channelPreferences(
  env: AgentsEnv,
  scope: CommunicationScope
): Promise<AssistantChannelPreferences> {
  const q = new URLSearchParams({
    actor_id: scope.userId,
    ...(scope.projectId ? { project_id: scope.projectId } : {}),
  });
  const r = await env.SPACES_WORKER.fetch(
    new Request(
      `http://spaces/internal/spaces/${encodeURIComponent(scope.spaceId)}/assistant-channels?${q}`,
      {
        headers: {
          "x-naelao-tenant-id": scope.tenantId,
          "x-naelao-internal-token": await mintInternalToken(
            env.PLATFORM_SECRET,
            scope.tenantId
          ),
        },
      }
    )
  );
  if (!r.ok) throw new Error("assistant_channel_settings_unavailable");
  return (await r.json<{ preferences: AssistantChannelPreferences }>())
    .preferences;
}
export async function ensureIdentity(
  env: AgentsEnv,
  scope: CommunicationScope
): Promise<CommunicationIdentity> {
  const scopeKey = scope.projectId
    ? `project:${scope.projectId}`
    : `user:${scope.userId}`;
  const id =
    "aci_" +
    (
      await signHmac(
        JSON.stringify([scope.tenantId, scope.spaceId, scopeKey]),
        env.PLATFORM_SECRET
      )
    )
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 40);
  const existing = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_communication_identities WHERE tenant_id=? AND space_id=? AND scope_key=?"
  )
    .bind(scope.tenantId, scope.spaceId, scopeKey)
    .first<CommunicationIdentity>();
  if (!existing && scope.projectId) {
    const response = await env.SPACES_WORKER.fetch(
      new Request(
        `http://spaces/spaces/${encodeURIComponent(scope.spaceId)}/projects/${encodeURIComponent(scope.projectId)}/assistant-access?user_id=${encodeURIComponent(scope.userId)}`,
        {
          headers: {
            "x-naelao-tenant-id": scope.tenantId,
            "x-naelao-user-id": scope.userId,
            "x-naelao-role": scope.role,
            "x-naelao-internal-token": await mintInternalToken(
              env.PLATFORM_SECRET,
              scope.tenantId
            ),
          },
        }
      )
    );
    if (
      !response.ok ||
      (await response.json<{ effective_role: string }>()).effective_role !==
        "owner"
    )
      throw new Error("project_owner_setup_required");
  }
  const domain = normalizeIngressDomain(env.EMAIL_INGRESS_DOMAIN);
  let address = domain
    ? await createAgentEmailAddress({
        domain,
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        agentId: scope.projectId ? "project-assistant" : scope.userId,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        secret: env.PLATFORM_SECRET,
      })
    : null;
  const legacyAliases: Array<{ agent_id: string; address_hash: string }> = [];
  if (!existing && domain) {
    const legacy = scope.projectId
      ? await env.PLATFORM_DB.prepare(
          "SELECT agent_id,address_hash FROM project_agent_email_addresses WHERE tenant_id=? AND space_id=? AND project_id=? AND status='active' ORDER BY created_at LIMIT 100"
        )
          .bind(scope.tenantId, scope.spaceId, scope.projectId)
          .all<{ agent_id: string; address_hash: string }>()
      : await env.PLATFORM_DB.prepare(
          "SELECT a.agent_id,a.address_hash FROM agent_email_addresses a JOIN spaces s ON s.id=a.space_id WHERE a.tenant_id=? AND a.space_id=? AND s.created_by=? AND a.status='active' ORDER BY a.created_at LIMIT 100"
        )
          .bind(scope.tenantId, scope.spaceId, scope.userId)
          .all<{ agent_id: string; address_hash: string }>();
    for (const old of legacy.results) {
      const candidate = await createAgentEmailAddress({
        domain,
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        agentId: old.agent_id,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        secret: env.PLATFORM_SECRET,
      });
      if ((await hashEmailAddress(candidate)) === old.address_hash) {
        if (!legacyAliases.length) address = candidate;
        legacyAliases.push(old);
      }
    }
  }
  await env.PLATFORM_DB.prepare(
    "INSERT OR IGNORE INTO assistant_communication_identities(id,tenant_id,space_id,project_id,scope_key,owner_user_id,email_address,address_hash,email_status) VALUES(?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      scope.tenantId,
      scope.spaceId,
      scope.projectId ?? null,
      scopeKey,
      scope.userId,
      address,
      address ? await hashEmailAddress(address) : null,
      address ? "configured" : "pending"
    )
    .run();
  const row = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_communication_identities WHERE tenant_id=? AND space_id=? AND scope_key=?"
  )
    .bind(scope.tenantId, scope.spaceId, scopeKey)
    .first<CommunicationIdentity>();
  if (row)
    for (const old of legacyAliases)
      await env.PLATFORM_DB.prepare(
        "INSERT OR IGNORE INTO assistant_communication_aliases(address_hash,identity_id) VALUES(?,?)"
      )
        .bind(old.address_hash, row.id)
        .run();
  if (!row || row.status !== "active")
    throw new Error("assistant_identity_disabled");
  if (!row.email_address && address) {
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_communication_identities SET email_address=?,address_hash=?,email_status='configured' WHERE id=? AND email_address IS NULL"
    )
      .bind(address, await hashEmailAddress(address), row.id)
      .run();
    row.email_address = address;
    row.email_status = "configured";
  }
  return row;
}
export async function sealCommunication(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  id: string,
  value: unknown
) {
  return encryptAuthenticated(
    JSON.stringify(value),
    await deriveKek(env.PLATFORM_SECRET, identity.tenant_id),
    `communications:${identity.id}:${id}`
  );
}
export async function openCommunication(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  id: string,
  value: Parameters<typeof decryptAuthenticated>[0]
) {
  return JSON.parse(
    await decryptAuthenticated(
      value,
      await deriveKek(env.PLATFORM_SECRET, identity.tenant_id),
      `communications:${identity.id}:${id}`
    )
  ) as Record<string, unknown>;
}
export async function storeBody(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  id: string,
  value: unknown
): Promise<string> {
  if (!env.SCRIPTS_R2) throw new Error("communication_storage_unavailable");
  const key = `spaces/${identity.space_id}/communications/${identity.id}/${id}.json`;
  await env.SCRIPTS_R2.put(
    key,
    JSON.stringify(await sealCommunication(env, identity, id, value))
  );
  return key;
}
export async function readBody(
  env: AgentsEnv,
  identity: CommunicationIdentity,
  id: string,
  key: string
): Promise<Record<string, unknown>> {
  if (
    key !==
    `spaces/${identity.space_id}/communications/${identity.id}/${id}.json`
  )
    throw new Error("communication_body_scope_mismatch");
  const object = await env.SCRIPTS_R2?.get(key);
  if (!object || object.size > 1024 * 1024)
    throw new Error("communication_body_unavailable");
  return openCommunication(env, identity, id, await object.json());
}
export interface CommunicationAutonomy {
  mode: "approve" | "standing";
  recipients: string[];
  dailySendLimit: number;
}
export function validateAutonomy(value: unknown): CommunicationAutonomy {
  const v = value as CommunicationAutonomy;
  if (
    !v ||
    !["approve", "standing"].includes(v.mode) ||
    !Array.isArray(v.recipients) ||
    v.recipients.length > 100 ||
    v.recipients.some(
      (x) =>
        typeof x !== "string" ||
        x.length > 320 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)
    ) ||
    !Number.isSafeInteger(v.dailySendLimit) ||
    v.dailySendLimit < 1 ||
    v.dailySendLimit > 1000
  )
    throw new Error("invalid_communication_autonomy");
  return {
    mode: v.mode,
    recipients: [...new Set(v.recipients.map((x) => x.toLowerCase()))],
    dailySendLimit: v.dailySendLimit,
  };
}
export async function sendDraft(
  env: AgentsEnv,
  scope: CommunicationScope,
  identity: CommunicationIdentity,
  id: string
): Promise<unknown> {
  const row = await env.PLATFORM_DB.prepare(
    "SELECT id,recipient,subject,status,body_key,provider_result_id FROM assistant_communication_messages WHERE id=? AND identity_id=? AND direction='outbound' AND channel='email'"
  )
    .bind(id, identity.id)
    .first<{
      id: string;
      recipient: string;
      subject: string;
      status: string;
      body_key: string;
      provider_result_id: string | null;
    }>();
  if (!row) throw new Error("draft_not_found");
  if (row.status === "sent")
    return { sent: true, id, provider_message_id: row.provider_result_id };
  const policy = validateAutonomy(JSON.parse(identity.autonomy_json));
  const approved =
    row.status === "approved" ||
    (row.status === "draft" &&
      policy.mode === "standing" &&
      policy.recipients.includes(row.recipient.toLowerCase()));
  if (!approved) throw new Error("communication_approval_required");
  if (!(await channelPreferences(env, scope)).enabled.email)
    throw new Error("assistant_channel_disabled");
  if (!env.EMAIL || !env.EMAIL_SENDING_DOMAIN || !identity.email_address)
    throw new Error("email_sending_not_configured");
  if (await isSpaceNetworkEgressDenied(env.PLATFORM_DB, scope.spaceId))
    throw new Error("communication_egress_denied");
  const body = await readBody(env, identity, id, row.body_key);
  if (!(await scopeAccess(env, scope, true)))
    throw new Error("communication_access_revoked");
  const claim = await env.PLATFORM_DB.prepare(
    "UPDATE assistant_communication_messages SET status='sending' WHERE id=? AND identity_id=? AND status IN ('draft','approved') AND (SELECT COUNT(*) FROM assistant_communication_messages WHERE identity_id=? AND direction='outbound' AND status IN ('sending','sent','indeterminate') AND created_at>=date('now'))<?"
  )
    .bind(id, identity.id, identity.id, policy.dailySendLimit)
    .run();
  if (!claim.meta.changes) throw new Error("send_busy_or_daily_limit");
  try {
    const result = await (
      env.EMAIL as unknown as {
        send(input: {
          from: string;
          to: string;
          subject: string;
          text: string;
          headers: Record<string, string>;
          replyTo?: string;
        }): Promise<{ messageId?: string }>;
      }
    ).send({
      from: identity.email_address,
      to: row.recipient,
      subject: row.subject,
      text: String(body.text ?? ""),
      headers: { "X-Naelao-Message-ID": id },
      replyTo: identity.email_address.replace("@", `+thread-${id}@`),
    });
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_communication_messages SET status='sent',provider_result_id=? WHERE id=? AND identity_id=? AND status='sending'"
    )
      .bind(result?.messageId ?? id, id, identity.id)
      .run();
    return { sent: true, id };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (
      typeof code === "string" &&
      [
        "E_VALIDATION_ERROR",
        "E_FIELD_MISSING",
        "E_TOO_MANY_RECIPIENTS",
        "E_SENDER_NOT_VERIFIED",
        "E_RECIPIENT_NOT_ALLOWED",
        "E_RECIPIENT_SUPPRESSED",
        "E_ACCOUNT_SUSPENDED",
        "E_SENDER_DOMAIN_NOT_AVAILABLE",
        "E_CONTENT_TOO_LARGE",
        "E_RATE_LIMIT_EXCEEDED",
        "E_DAILY_LIMIT_EXCEEDED",
        "E_HEADER_NOT_ALLOWED",
        "E_HEADER_USE_API_FIELD",
      ].includes(code)
    ) {
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_communication_messages SET status='failed',error_code=? WHERE id=? AND identity_id=? AND status='sending'"
      )
        .bind(code, id, identity.id)
        .run();
      throw new Error("email_send_rejected:" + code);
    }
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_communication_messages SET status='indeterminate',error_code='provider_send_uncertain' WHERE id=? AND identity_id=? AND status='sending'"
    )
      .bind(id, identity.id)
      .run();
    throw new Error("send_reconciliation_required");
  }
}
