/**
 * notifications (spec §12.4) — multi-channel notification dispatch. Tier 2.
 * Operations: notify.email, notify.slack, notify.discord, notify.whatsapp, notify.telegram,
 * notify.apns, notify.fcm.
 *
 * This is the script the Space Assistant uses to reach the owner (e.g. "Order #1234
 * fulfilled") and that HITL uses for approval requests — and the one the channel heartbeat
 * (NaelaoAgentDO) uses to actually deliver a reply to a customer-facing bot thread. Routed
 * through the notifications worker service binding when configured.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";

async function dispatch(
  ctx: PrebuiltOpContext,
  channel: string,
  payload: Record<string, unknown>
): Promise<unknown> {
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
  if (!resp.ok) throw new Error(`notify.${channel} failed: ${resp.status}`);
  return { delivered: true, channel };
}

export const notifications: PrebuiltScript = {
  name: "notifications",
  description: "Send notifications to the owner/customer over email, Slack, Discord, WhatsApp, Telegram, APNs, FCM.",
  domain: "comms",
  requires_tier: 2,
  operations: {
    "notify.email": (a, c) =>
      dispatch(c, "email", { to: a["to"], subject: a["subject"], body: a["body"] }),
    "notify.slack": (a, c) => dispatch(c, "slack", { channel: a["channel"], message: a["message"] }),
    "notify.discord": (a, c) => dispatch(c, "discord", { channel: a["channel"], message: a["message"] }),
    "notify.whatsapp": (a, c) => dispatch(c, "whatsapp", { to: a["to"], message: a["message"] }),
    // `to` is Telegram's chat id, not a username — a reply has to go back to the conversation
    // it came from, which in a group is not the sender (see telegramAdapter.normalizeInbound).
    "notify.telegram": (a, c) => dispatch(c, "telegram", { to: a["to"], message: a["message"] }),
    "notify.apns": (a, c) => dispatch(c, "apns", { device_token: a["device_token"], payload: a["payload"] }),
    "notify.fcm": (a, c) => dispatch(c, "fcm", { token: a["token"], payload: a["payload"] }),
  },
};
