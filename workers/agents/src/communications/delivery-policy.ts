import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import type { AgentsEnv } from "../index.js";
import {
  scopeAccess,
  channelPreferences,
  type CommunicationScope,
  type CommunicationIdentity,
} from "./core.js";
import { storeBody, readBody } from "./core.js";
import { coordinationHash } from "./approval-decisions.js";
export const DELIVERY_CHANNELS = [
  "voice",
  "web_push",
  "whatsapp",
  "telegram",
  "email",
  "phone",
] as const;
export interface DeliveryPolicy {
  channels: Array<(typeof DELIVERY_CHANNELS)[number]>;
  timezone: string;
  quietStart: number;
  quietEnd: number;
  allowUrgentDuringQuiet: boolean;
  allowPhone: boolean;
  dailyLimit: number;
}
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  channels: ["voice", "web_push", "whatsapp", "telegram", "email"],
  timezone: "UTC",
  quietStart: 1320,
  quietEnd: 480,
  allowUrgentDuringQuiet: false,
  allowPhone: false,
  dailyLimit: 20,
};
export function validateDeliveryPolicy(value: unknown): DeliveryPolicy {
  const p = value as DeliveryPolicy;
  if (
    !p ||
    typeof p !== "object" ||
    Object.keys(p).some(
      (k) =>
        ![
          "channels",
          "timezone",
          "quietStart",
          "quietEnd",
          "allowUrgentDuringQuiet",
          "allowPhone",
          "dailyLimit",
        ].includes(k)
    ) ||
    !Array.isArray(p.channels) ||
    p.channels.length > 6 ||
    new Set(p.channels).size !== p.channels.length ||
    p.channels.some((c) => !DELIVERY_CHANNELS.includes(c)) ||
    typeof p.timezone !== "string" ||
    p.timezone.length > 80 ||
    ![p.quietStart, p.quietEnd].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n < 1440
    ) ||
    typeof p.allowUrgentDuringQuiet !== "boolean" ||
    typeof p.allowPhone !== "boolean" ||
    !Number.isSafeInteger(p.dailyLimit) ||
    p.dailyLimit < 1 ||
    p.dailyLimit > 100
  )
    throw new Error("invalid_delivery_policy");
  try {
    new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
  } catch {
    throw new Error("invalid_delivery_timezone");
  }
  return { ...p, channels: [...p.channels] };
}
export function isQuiet(policy: DeliveryPolicy, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: policy.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const minutes =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  return policy.quietStart === policy.quietEnd
    ? false
    : policy.quietStart < policy.quietEnd
      ? minutes >= policy.quietStart && minutes < policy.quietEnd
      : minutes >= policy.quietStart || minutes < policy.quietEnd;
}
export async function readDeliveryPolicy(
  env: AgentsEnv,
  identityId: string,
  userId: string
) {
  const row = await env.PLATFORM_DB.prepare(
    "SELECT policy_json FROM assistant_delivery_preferences WHERE identity_id=? AND user_id=?"
  )
    .bind(identityId, userId)
    .first<{ policy_json: string }>();
  return row
    ? validateDeliveryPolicy(JSON.parse(row.policy_json))
    : DEFAULT_DELIVERY_POLICY;
}
export async function deliverAssistantEvent(
  env: AgentsEnv,
  scope: CommunicationScope,
  identity: CommunicationIdentity,
  input: { event_id: unknown; message: unknown; urgency?: unknown }
) {
  if (
    identity.tenant_id !== scope.tenantId ||
    identity.space_id !== scope.spaceId ||
    (identity.project_id ?? null) !== (scope.projectId ?? null) ||
    (!scope.projectId && identity.owner_user_id !== scope.userId) ||
    (input.urgency !== undefined &&
      input.urgency !== "normal" &&
      input.urgency !== "urgent") ||
    typeof input.event_id !== "string" ||
    !/^[-a-zA-Z0-9._:]{1,160}$/.test(input.event_id) ||
    typeof input.message !== "string" ||
    !input.message.trim() ||
    input.message.length > 4000 ||
    !(await scopeAccess(env, scope, false))
  )
    throw new Error("invalid_assistant_notification");
  const policy = await readDeliveryPolicy(env, identity.id, scope.userId),
    now = Date.now();
  const hash = await coordinationHash(
    JSON.stringify([input.message, input.urgency ?? "normal"])
  );
  const old = await env.PLATFORM_DB.prepare(
    "SELECT payload_hash,status,channel FROM assistant_delivery_receipts WHERE identity_id=? AND user_id=? AND event_id=?"
  )
    .bind(identity.id, scope.userId, input.event_id)
    .first<{ payload_hash: string; status: string; channel: string | null }>();
  if (old && old.payload_hash !== hash)
    throw new Error("notification_event_conflict");
  if (old && old.status !== "deferred")
    return { status: old.status, channel: old.channel, deduplicated: true };
  const activeVoice = policy.channels.includes("voice")
    ? await env.PLATFORM_DB.prepare(
        "SELECT agent_name FROM assistant_active_voice_endpoints WHERE tenant_id=? AND space_id=? AND project_key=? AND user_id=? AND expires_at>?"
      )
        .bind(
          scope.tenantId,
          scope.spaceId,
          scope.projectId ?? "",
          scope.userId,
          now
        )
        .first<{ agent_name: string }>()
    : null;
  const quiet =
    !activeVoice &&
    isQuiet(policy) &&
    !(input.urgency === "urgent" && policy.allowUrgentDuringQuiet);
  const inserted = await env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_delivery_receipts(identity_id,user_id,event_id,payload_hash,status,created_at,attempted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(identity_id,user_id,event_id) DO NOTHING"
  )
    .bind(
      identity.id,
      scope.userId,
      input.event_id,
      hash,
      quiet ? "deferred" : "sending",
      now,
      quiet ? null : now
    )
    .run();
  if (!old && inserted.meta.changes !== 1)
    return { status: "sending", deduplicated: true };
  if (!old) {
    const messageKey = await storeBody(
      env,
      identity,
      "delivery-" +
        (await coordinationHash(
          JSON.stringify([scope.userId, input.event_id])
        )),
      { message: input.message, urgency: input.urgency ?? "normal" }
    );
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_delivery_receipts SET message_key=? WHERE identity_id=? AND user_id=? AND event_id=?"
    )
      .bind(messageKey, identity.id, scope.userId, input.event_id)
      .run();
  }
  if (quiet) return { status: "deferred", reason: "quiet_hours" };
  // One event claimant. Uncertain sends are held; the model cannot retry them on another channel.
  const claim = old
    ? await env.PLATFORM_DB.prepare(
        "UPDATE assistant_delivery_receipts SET status='sending',attempted_at=? WHERE identity_id=? AND user_id=? AND event_id=? AND status='deferred'"
      )
        .bind(now, identity.id, scope.userId, input.event_id)
        .run()
    : null;
  if (old && claim?.meta.changes !== 1)
    return { status: "sending", deduplicated: true };
  const quota = await env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) n FROM assistant_delivery_receipts WHERE identity_id=? AND user_id=? AND COALESCE(attempted_at,created_at)>=? AND status IN ('sending','delivered','held')"
  )
    .bind(identity.id, scope.userId, now - 86400000)
    .first<{ n: number }>();
  if ((quota?.n ?? 0) > policy.dailyLimit) {
    await finish("held", null);
    return { status: "held", reason: "notification_daily_limit" };
  }
  const enabled = (await channelPreferences(env, scope)).enabled;
  const headers = {
    "content-type": "application/json",
    "x-naelao-tenant-id": scope.tenantId,
    "x-naelao-internal-token": await mintInternalToken(
      env.PLATFORM_SECRET,
      scope.tenantId
    ),
  };
  let contacts: Array<{
    user_id: string;
    channel: string;
    contact_id: string;
  }> = [];
  if (policy.channels.some((c) => c === "whatsapp" || c === "telegram")) {
    const response = await env.SPACES_WORKER.fetch(
      new Request(
        `http://spaces/internal/spaces/${scope.spaceId}/executive/contacts`,
        { headers }
      )
    );
    if (response.ok)
      contacts =
        (
          await readBoundedResponseJson<{ data?: typeof contacts }>(
            response,
            16384
          )
        ).data ?? [];
  }
  for (const channel of policy.channels) {
    let to: string | undefined;
    if (channel === "voice") {
      const live = await env.PLATFORM_DB.prepare(
        "SELECT agent_name FROM assistant_active_voice_endpoints WHERE tenant_id=? AND space_id=? AND project_key=? AND user_id=? AND expires_at>?"
      )
        .bind(
          scope.tenantId,
          scope.spaceId,
          scope.projectId ?? "",
          scope.userId,
          now
        )
        .first<{ agent_name: string }>();
      if (!live) continue;
      try {
        const result = await env.OWNER_VOICE_AGENT.get(
          env.OWNER_VOICE_AGENT.idFromName(live.agent_name)
        ).fetch(
          new Request("http://voice/internal/voice-notification", {
            method: "POST",
            headers,
            body: JSON.stringify({
              tenantId: scope.tenantId,
              spaceId: scope.spaceId,
              userId: scope.userId,
              projectId: scope.projectId ?? null,
              eventId: input.event_id,
              message: input.message,
            }),
          })
        );
        if (result.ok) {
          await finish("delivered", channel);
          return { status: "delivered", channel };
        }
        if (result.status === 404) continue;
      } catch {}
      await finish("held", channel);
      return { status: "held", channel };
    }
    if (channel !== "web_push" && !enabled[channel]) continue;
    if (channel === "whatsapp" || channel === "telegram")
      to = contacts.find(
        (c) => c.user_id === scope.userId && c.channel === channel
      )?.contact_id;
    if (channel === "email" || channel === "phone")
      to = (
        await env.PLATFORM_DB.prepare(
          "SELECT address FROM assistant_communication_controllers WHERE identity_id=? AND user_id=? AND channel=? AND status='active'"
        )
          .bind(identity.id, scope.userId, channel)
          .first<{ address: string }>()
      )?.address;
    if (channel !== "web_push" && !to) continue;
    if (channel === "phone") {
      if (
        !policy.allowPhone ||
        !(await (
          await import("./routes.js")
        ).manageIdentity(env, scope, identity))
      )
        continue;
      try {
        const { handlePhoneAction } = await import("./phones.js");
        const draft = (await handlePhoneAction(
          env,
          scope,
          identity,
          "phone-draft",
          { kind: "call", to, text: input.message },
          true,
          false
        )) as { id: string };
        await handlePhoneAction(
          env,
          scope,
          identity,
          "phone-approve",
          { id: draft.id },
          true,
          false
        );
        await handlePhoneAction(
          env,
          scope,
          identity,
          "phone-send",
          { id: draft.id },
          true,
          false
        );
        await finish("delivered", channel);
        return { status: "delivered", channel };
      } catch {
        await finish("held", channel);
        return { status: "held", channel };
      }
    }
    if (!env.NOTIFICATIONS_WORKER) continue;
    try {
      const response = await env.NOTIFICATIONS_WORKER.fetch(
        new Request("http://notifications/internal/notify", {
          method: "POST",
          headers,
          body: JSON.stringify({
            channel,
            space_id: scope.spaceId,
            user_id: scope.userId,
            ...(to ? { to } : {}),
            subject: "Assistant update",
            body: input.message,
          }),
        })
      );
      const result = await readBoundedResponseJson<{ delivered?: boolean }>(
        response,
        8192
      );
      if (result.delivered) {
        await finish("delivered", channel);
        return { status: "delivered", channel };
      }
      if (channel === "web_push" && response.status === 404) continue;
    } catch {}
    await finish("held", channel);
    return { status: "held", channel };
  }
  await finish("held", null);
  return { status: "held", reason: "no_verified_available_channel" };
  async function finish(status: string, channel: string | null) {
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_delivery_receipts SET status=?,channel=? WHERE identity_id=? AND user_id=? AND event_id=?"
    )
      .bind(status, channel, identity.id, scope.userId, input.event_id)
      .run();
  }
}

/** Deferred notifications retain encrypted bodies and re-evaluate current permission/policy. */
export async function sweepAssistantDelivery(env: AgentsEnv) {
  // Retain deduplication receipts, but erase encrypted message bodies after 30 days.
  // A timed-out delivery remains held; retention never makes it safe to send again.
  if (env.SCRIPTS_R2) {
    const expired = await env.PLATFORM_DB.prepare(
      "SELECT r.identity_id,r.user_id,r.event_id,r.message_key,i.space_id FROM assistant_delivery_receipts r JOIN assistant_communication_identities i ON i.id=r.identity_id WHERE r.message_key IS NOT NULL AND r.created_at<=? ORDER BY r.created_at LIMIT 100"
    )
      .bind(Date.now() - 30 * 86400000)
      .all<{
        identity_id: string;
        user_id: string;
        event_id: string;
        message_key: string;
        space_id: string;
      }>();
    for (const row of expired.results) {
      const id =
        "delivery-" +
        (await coordinationHash(JSON.stringify([row.user_id, row.event_id])));
      const expected = `spaces/${row.space_id}/communications/${row.identity_id}/${id}.json`;
      if (row.message_key !== expected)
        throw new Error("delivery_retention_scope_mismatch");
      await env.SCRIPTS_R2.delete(expected);
      await env.PLATFORM_DB.prepare(
        "UPDATE assistant_delivery_receipts SET message_key=NULL,status=CASE WHEN status IN ('deferred','sending') THEN 'held' ELSE status END WHERE identity_id=? AND user_id=? AND event_id=? AND message_key=?"
      )
        .bind(row.identity_id, row.user_id, row.event_id, expected)
        .run();
    }
  }
  const rows = await env.PLATFORM_DB.prepare(
    "SELECT r.*,i.tenant_id,i.space_id,i.project_id FROM assistant_delivery_receipts r JOIN assistant_communication_identities i ON i.id=r.identity_id WHERE r.status='deferred' AND r.message_key IS NOT NULL AND r.created_at>? AND i.status='active' ORDER BY COALESCE(r.last_checked_at,r.created_at),r.event_id LIMIT 50"
  )
    .bind(Date.now() - 30 * 86400000)
    .all<{
      identity_id: string;
      user_id: string;
      event_id: string;
      message_key: string;
      tenant_id: string;
      space_id: string;
      project_id: string | null;
    }>();
  for (const row of rows.results) {
    // Rotate through deferred recipients so one timezone cannot starve later ready events.
    await env.PLATFORM_DB.prepare(
      "UPDATE assistant_delivery_receipts SET last_checked_at=? WHERE identity_id=? AND user_id=? AND event_id=? AND status='deferred'"
    )
      .bind(Date.now(), row.identity_id, row.user_id, row.event_id)
      .run();
    try {
      const identity = await env.PLATFORM_DB.prepare(
        "SELECT * FROM assistant_communication_identities WHERE id=?"
      )
        .bind(row.identity_id)
        .first<CommunicationIdentity>();
      if (!identity) continue;
      const scope = {
        tenantId: row.tenant_id,
        spaceId: row.space_id,
        userId: row.user_id,
        role: "product_end_user",
        ...(row.project_id ? { projectId: row.project_id } : {}),
      };
      const body = await readBody(
        env,
        identity,
        "delivery-" +
          (await coordinationHash(JSON.stringify([row.user_id, row.event_id]))),
        row.message_key
      );
      await deliverAssistantEvent(env, scope, identity, {
        event_id: row.event_id,
        message: body.message,
        urgency: body.urgency,
      });
    } catch {
      /* A failed membership/provider check never broadens the destination or retries an uncertain send. */
    }
  }
  await env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_approval_decisions WHERE expires_at<? AND status IN ('issued','applied')"
  )
    .bind(Date.now() - 30 * 86400000)
    .run();
  await env.PLATFORM_DB.prepare(
    "DELETE FROM assistant_active_voice_endpoints WHERE expires_at<=?"
  )
    .bind(Date.now())
    .run();
}
