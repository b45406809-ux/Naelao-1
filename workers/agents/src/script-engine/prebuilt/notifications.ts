/**
 * notifications (spec §12.4) — multi-channel notification dispatch. Tier 2.
 * Operations: notify.email, notify.slack, notify.discord, notify.whatsapp, notify.telegram,
 * notify.apns, notify.fcm, notify.web_push.
 *
 * This is the script the Space Assistant uses to reach the owner (e.g. "Order #1234
 * fulfilled") and that HITL uses for approval requests — and the one the channel heartbeat
 * (NaelaoAgentDO) uses to actually deliver a reply to a customer-facing bot thread. Routed
 * through the notifications worker service binding when configured.
 */

import { mintInternalToken } from "@naelao/http";
import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

/**
 * The owner's own email, resolved server-side, for a notify.email that named no recipient.
 *
 * Both assistant profiles instruct the agent to email the owner when something genuinely needs
 * them — and nothing ever tells it what the owner's address is. Observed live on an unattended
 * wake-up: the assistant correctly decided the owner had to be told setup was unfinished, called
 * notify.email with a real subject and body and no `to`, and the notifications worker rejected it
 * with a 400. The one path the assistant has for reaching a human failed by construction, on the
 * exact class of message that path exists for.
 *
 * Resolving it here rather than handing the address to the model is also the better shape: the
 * owner's email never enters a reasoning payload, a run trace, or a params log — the model asks
 * for "the owner" and the platform knows who that is. An explicit `to` (a customer, a supplier)
 * still wins, so nothing about the existing behaviour changes.
 */
async function resolveOwnerEmail(ctx: PrebuiltOpContext): Promise<string | undefined> {
  if (!ctx.env.spacesWorker || !ctx.env.spaceId) return undefined;
  try {
    const token = await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId);
    const resp = await ctx.env.spacesWorker.fetch(
      new Request(`http://spaces-worker/internal/spaces/${ctx.env.spaceId}/owner-contact`, {
        headers: { "x-naelao-tenant-id": ctx.env.tenantId, "x-naelao-internal-token": token },
      })
    );
    if (!resp.ok) return undefined;
    const body = await resp.json<{ found?: boolean; email?: string }>();
    return body?.found && body.email ? body.email : undefined;
  } catch {
    return undefined;
  }
}

async function dispatch(
  ctx: PrebuiltOpContext,
  channel: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (["email","slack","discord","whatsapp","telegram"].includes(channel) && ctx.env.assistantChannelAllowed && !await ctx.env.assistantChannelAllowed(channel as import("@naelao/agent-sdk").AssistantChannel)) return {delivered:false,channel,reason:"assistant_channel_disabled"};
  if (!ctx.env.notificationsWorker) {
    return { delivered: false, reason: "notifications worker binding not configured", channel };
  }
  const resp = await ctx.env.notificationsWorker.fetch(
    new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": ctx.env.tenantId },
      body: JSON.stringify({ channel, space_id: ctx.env.spaceId, ...payload }),
    })
  );
  const result: Record<string, unknown> = await resp.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  if (!resp.ok) return { ...result, delivered: false, channel, status: resp.status };
  return { ...result, delivered: result.delivered !== false, channel };
}

export const notifications: PrebuiltScript = {
  name: "notifications",
  description: "Send notifications to the owner/customer over email, Slack, Discord, WhatsApp, Telegram, APNs, FCM, and enrolled browser push devices.",
  domain: "comms",
  requires_tier: 2,
  operations: {
    "notify.email": async (a, c) => {
      const to = typeof a["to"] === "string" && a["to"].trim() ? (a["to"] as string) : await resolveOwnerEmail(c);
      if (!to) {
        // Honest degradation rather than a bare 400: name the real reason so the agent can say
        // something useful instead of retrying a call that cannot succeed.
        return {
          delivered: false,
          channel: "email",
          reason: "no recipient: none was given and this space has no owner email on record",
        };
      }
      return dispatch(c, "email", { to, subject: a["subject"], body: a["body"], installation_id: a["installation_id"], provider_connection_id: a["provider_connection_id"] });
    },
    "notify.slack": (a, c) => dispatch(c, "slack", { channel: a["channel"], message: a["message"], thread_ts: a["thread_ts"], installation_id: a["installation_id"], provider_connection_id: a["provider_connection_id"] }),
    "notify.discord": (a, c) => dispatch(c, "discord", { channel: a["channel"], message: a["message"], installation_id: a["installation_id"], provider_connection_id: a["provider_connection_id"] }),
    "notify.whatsapp": (a, c) => dispatch(c, "whatsapp", { to: a["to"], message: a["message"], installation_id: a["installation_id"], provider_connection_id: a["provider_connection_id"] }),
    // `to` is Telegram's chat id, not a username — a reply has to go back to the conversation
    // it came from, which in a group is not the sender (see telegramAdapter.normalizeInbound).
    "notify.telegram": (a, c) => dispatch(c, "telegram", { to: a["to"], message: a["message"], message_thread_id: a["message_thread_id"], installation_id: a["installation_id"], provider_connection_id: a["provider_connection_id"] }),
    "notify.apns": (a, c) => dispatch(c, "apns", { device_token: a["device_token"], payload: a["payload"] }),
    "notify.fcm": (a, c) => dispatch(c, "fcm", { token: a["token"], payload: a["payload"] }),
    "notify.web_push": (a, c) => dispatch(c, "web_push", {
      user_id: a["user_id"] ?? c.env.humanInvokerId,
      subject: a["title"] ?? a["subject"],
      message: a["message"] ?? a["body"],
    }),
  },
};
