import type { AgentsEnv } from "../index.js";
import {
  parseCloudflareEmail,
  hashEmailAddress,
  MAX_INBOUND_EMAIL_BYTES,
} from "../channels/cloudflare-email.js";
import {
  channelPreferences,
  scopeAccess,
  storeBody,
  type CommunicationIdentity,
  type CommunicationScope,
} from "./core.js";
import { dispatchCommunicationCommand } from "./routes.js";
/** Returns false without consuming the stream when the address belongs to the legacy reply path. */
export async function receiveAssistantEmail(
  message: ForwardableEmailMessage,
  env: AgentsEnv
): Promise<boolean> {
  const recipient = message.to.trim().toLowerCase(),
    at = recipient.lastIndexOf("@"),
    local = recipient.slice(0, at),
    base = local.split("+")[0] + recipient.slice(at);
  if (at < 1) return false;
  let identity = await env.PLATFORM_DB.prepare(
    "SELECT * FROM assistant_communication_identities WHERE address_hash=? AND status='active' AND email_status IN ('configured','ready')"
  )
    .bind(await hashEmailAddress(base))
    .first<CommunicationIdentity>();
  if (!identity) {
    identity = await env.PLATFORM_DB.prepare(
      "SELECT i.* FROM assistant_communication_aliases a JOIN assistant_communication_identities i ON i.id=a.identity_id WHERE a.address_hash=? AND i.status='active'"
    )
      .bind(await hashEmailAddress(base))
      .first<CommunicationIdentity>();
  }
  if (!identity) {
    const legacy = await env.PLATFORM_DB.prepare(
      "SELECT tenant_id,space_id,project_id FROM project_agent_email_addresses WHERE address_hash=? AND status='active' UNION ALL SELECT tenant_id,space_id,NULL AS project_id FROM agent_email_addresses WHERE address_hash=? AND status='active' LIMIT 1"
    )
      .bind(await hashEmailAddress(base), await hashEmailAddress(base))
      .first<{
        tenant_id: string;
        space_id: string;
        project_id: string | null;
      }>();
    if (legacy) {
      const owner = await env.PLATFORM_DB.prepare(
        "SELECT created_by FROM spaces WHERE id=? AND tenant_id=? AND status='active'"
      )
        .bind(legacy.space_id, legacy.tenant_id)
        .first<{ created_by: string | null }>();
      if (owner?.created_by) {
        try {
          const { ensureIdentity } = await import("./core.js");
          identity = await ensureIdentity(env, {
            tenantId: legacy.tenant_id,
            spaceId: legacy.space_id,
            userId: owner.created_by,
            role: "owner",
            ...(legacy.project_id ? { projectId: legacy.project_id } : {}),
          });
          await env.PLATFORM_DB.prepare(
            "INSERT OR IGNORE INTO assistant_communication_aliases(address_hash,identity_id) VALUES(?,?)"
          )
            .bind(await hashEmailAddress(base), identity.id)
            .run();
        } catch {
          /* Unknown ownership cannot grant a mailbox. */
        }
      }
    }
  }
  if (!identity) return false;
  const scope: CommunicationScope = {
    tenantId: identity.tenant_id,
    spaceId: identity.space_id,
    userId: identity.owner_user_id,
    role: "product_end_user",
    ...(identity.project_id ? { projectId: identity.project_id } : {}),
  };
  if (
    !(await scopeAccess(env, scope)) ||
    !(await channelPreferences(env, scope)).enabled.email
  ) {
    message.setReject("Assistant email is disabled or unavailable");
    return true;
  }
  if (message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
    message.setReject("Message exceeds the inbox size limit");
    return true;
  }
  const parsed = await parseCloudflareEmail(message.raw);
  if (!(await scopeAccess(env, scope))) {
    message.setReject("Assistant workspace is unavailable");
    return true;
  }
  await env.PLATFORM_DB.prepare(
    "UPDATE assistant_communication_identities SET email_status='ready' WHERE id=? AND status='active'"
  )
    .bind(identity.id)
    .run();
  const externalId = parsed.messageId;
  if (
    await env.PLATFORM_DB.prepare(
      "SELECT id FROM assistant_communication_messages WHERE identity_id=? AND provider_message_id=?"
    )
      .bind(identity.id, externalId)
      .first()
  )
    return true;
  const count = await env.PLATFORM_DB.prepare(
    "SELECT COUNT(*) AS n FROM assistant_communication_messages WHERE identity_id=? AND created_at>=date('now') AND direction='inbound'"
  )
    .bind(identity.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 1000) {
    message.setReject("Assistant inbox daily limit reached");
    return true;
  }
  const admitted = await env.PLATFORM_DB.prepare(
    "INSERT INTO assistant_mail_ingress_usage(tenant_id,space_id,day,bytes,messages) VALUES(?,?,date('now'),?,1) ON CONFLICT(tenant_id,space_id,day) DO UPDATE SET bytes=assistant_mail_ingress_usage.bytes+excluded.bytes,messages=assistant_mail_ingress_usage.messages+1 WHERE assistant_mail_ingress_usage.bytes+excluded.bytes<=20971520 AND assistant_mail_ingress_usage.messages<1000 RETURNING bytes"
  )
    .bind(identity.tenant_id, identity.space_id, message.rawSize)
    .first();
  if (!admitted) {
    message.setReject("Space inbox daily storage allowance reached");
    return true;
  }
  const id = "in-" + (await hashEmailAddress(identity.id + ":" + externalId));
  // A dedicated tagged address correlates verification to the pending browser task. Never
  // store an expired verification email as ordinary inbox text containing a reusable code.
  const verification = local.includes("+v-");
  if (verification) {
    const { receiveVerification } = await import("./verification.js");
    const handled = await receiveVerification(
      env,
      identity,
      recipient,
      parsed,
      id
    );
    if (!handled) {
      const registered = await env.PLATFORM_DB.prepare(
        "SELECT connection_id FROM assistant_website_mail_aliases WHERE identity_id=? AND address_hash=?"
      )
        .bind(identity.id, await hashEmailAddress(recipient))
        .first();
      if (!registered) {
        message.setReject("Unknown verification account");
        return true;
      }
    }
  }
  const token = /\[naelao:([a-f0-9]{64})\]/i.exec(parsed.subject)?.[1];
  const subject = verification
    ? "[Website verification]"
    : parsed.subject.replace(/\[naelao:[a-f0-9]{64}\]/gi, "[owner command]");
  const attachments = [] as Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  if (!verification)
    for (const [index, file] of parsed.attachments.entries()) {
      const attachmentId = `${id}-a${index}`;
      await storeBody(env, identity, attachmentId, {
        data: btoa(
          Array.from(file.bytes, (byte) => String.fromCharCode(byte)).join("")
        ),
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.byteLength,
      });
      attachments.push({
        id: attachmentId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.byteLength,
      });
    }
  const privateOwner = verification
    ? await env.PLATFORM_DB.prepare(
        "SELECT actor_id FROM assistant_verification_waits WHERE identity_id=? AND address_hash=? ORDER BY created_at DESC LIMIT 1"
      )
        .bind(identity.id, await hashEmailAddress(recipient))
        .first<{ actor_id: string }>()
    : null;
  const key = await storeBody(env, identity, id, {
    text: verification
      ? "[Verification message delivered privately to its pending browser workflow]"
      : parsed.text.replace(/\[naelao:[a-f0-9]{64}\]/gi, "[owner command]"),
    attachments,
    ...(verification
      ? {
          private_text: parsed.text,
          private_subject: parsed.subject,
          private_actor_id: privateOwner?.actor_id ?? null,
        }
      : {}),
    untrusted: true,
    sender_authenticated: false,
  });
  const replyThread = /\+thread-([A-Za-z0-9._:-]{1,160})$/.exec(local)?.[1];
  const references = (message.headers.get("in-reply-to") ?? "").slice(0, 998);
  const prior = replyThread
    ? await env.PLATFORM_DB.prepare(
        "SELECT COALESCE(thread_id,id) AS thread FROM assistant_communication_messages WHERE identity_id=? AND id=?"
      )
        .bind(identity.id, replyThread)
        .first<{ thread: string }>()
    : references
      ? await env.PLATFORM_DB.prepare(
          "SELECT COALESCE(thread_id,id) AS thread FROM assistant_communication_messages WHERE identity_id=? AND provider_message_id=?"
        )
          .bind(identity.id, references)
          .first<{ thread: string }>()
      : null;
  const inserted = await env.PLATFORM_DB.prepare(
    "INSERT OR IGNORE INTO assistant_communication_messages(id,identity_id,provider_message_id,direction,sender,recipient,subject,thread_id,status,body_key) VALUES(?,?,?,'inbound',?,?,?,?,'received',?)"
  )
    .bind(
      id,
      identity.id,
      externalId,
      parsed.from.toLowerCase(),
      recipient,
      subject,
      prior?.thread ?? id,
      key
    )
    .run();
  if (!inserted.meta.changes || verification) return true;
  const controller = await env.PLATFORM_DB.prepare(
    "SELECT user_id FROM assistant_communication_controllers WHERE identity_id=? AND channel='email' AND address=? AND status='active'"
  )
    .bind(identity.id, parsed.from.toLowerCase())
    .first<{ user_id: string }>();
  if (controller) {
    const commandId = crypto.randomUUID();
    await env.PLATFORM_DB.prepare(
      "INSERT OR IGNORE INTO assistant_communication_commands(id,identity_id,message_id,controller_user_id) VALUES(?,?,?,?)"
    )
      .bind(commandId, identity.id, id, controller.user_id)
      .run();
    const policy = JSON.parse(identity.autonomy_json) as { mode: string };
    if (token && policy.mode === "standing") {
      const consumed = await env.PLATFORM_DB.prepare(
        "DELETE FROM assistant_command_tokens WHERE token_hash=? AND identity_id=? AND user_id=? AND expires_at>? RETURNING user_id"
      )
        .bind(
          await hashEmailAddress(token),
          identity.id,
          controller.user_id,
          new Date().toISOString()
        )
        .first();
      const controllerScope = { ...scope, userId: controller.user_id };
      if (consumed && (await scopeAccess(env, controllerScope, true)))
        await dispatchCommunicationCommand(
          env,
          controllerScope,
          identity,
          commandId
        );
    }
  }
  return true;
}
