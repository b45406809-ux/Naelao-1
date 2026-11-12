import type { Env } from "../env.js";
import type { DunningEventIdentity } from "@naelao/types";

export interface PlatformDunningEvent extends DunningEventIdentity { orgId: string }
export interface ProductUserDunningEvent extends DunningEventIdentity { productId: string; endUserId: string }

async function stableNotificationId(event: DunningEventIdentity, scope: string, accountId: string, userId: string): Promise<string> {
  const identity = JSON.stringify([scope, accountId, event.provider, event.subscriptionId, event.providerEventId, event.providerUpdatedAt, userId]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `dunning-${hex}`;
}

/** Rechecks the exact current subscription before notifying the payer; old failures cannot email
 * an organization after payment recovery or a replacement subscription. */
export async function notifyCurrentPlatformPaymentFailure(
  env: Pick<Env, "PLATFORM_DB" | "NOTIFICATIONS_QUEUE">,
  event: PlatformDunningEvent,
) {
  const subscriptionColumn = event.provider === "whop" ? "whop_subscription_id" : "ls_subscription_id";
  const subscription = await env.PLATFORM_DB.prepare(
    `SELECT status,provider_event_at FROM subscriptions WHERE org_id=? AND billing_provider=? AND ${subscriptionColumn}=?`
  ).bind(event.orgId, event.provider, event.subscriptionId).first<{ status: string; provider_event_at: string | null }>();
  if (!subscription || subscription.status !== "past_due") return { skipped: "payment_recovered_or_subscription_replaced", notified: 0 };
  if (event.providerUpdatedAt && subscription.provider_event_at && Date.parse(subscription.provider_event_at) > Date.parse(event.providerUpdatedAt)) {
    return { skipped: "stale_provider_event", notified: 0 };
  }

  const recipients = await env.PLATFORM_DB.prepare(
    `SELECT DISTINCT u.id,u.email FROM orgs o
     JOIN users u ON u.status='active'
     LEFT JOIN org_members m ON m.org_id=o.id AND m.user_id=u.id
     WHERE o.id=? AND o.status='active' AND (u.id=o.owner_id OR
       (m.joined_at IS NOT NULL AND m.role IN ('owner','admin')))
     ORDER BY u.id LIMIT 20`
  ).bind(event.orgId).all<{ id: string; email: string }>();

  let notified = 0;
  for (const recipient of recipients.results ?? []) {
    if (!recipient.id || !recipient.email) continue;
    const notificationId = await stableNotificationId(event, "platform_subscription", event.orgId, recipient.id);
    await env.NOTIFICATIONS_QUEUE.send({
      type: "email",
      tenantId: event.orgId,
      userId: recipient.id,
      email: recipient.email,
      notificationId,
      subject: "Action needed: payment for your Naelao plan failed",
      html: "A payment for your organization's Naelao plan was not completed. Sign in to review your subscription and update its payment method. Your current plan status is shown in Billing settings.",
    });
    notified++;
  }
  return { notified };
}

/** Sends a failure notice only to the current, verified Product account email while its exact
 * provider subscription remains past_due. Product users are not platform users, so this uses the
 * owning active organization solely as the Notifications worker's tenant authorization scope. */
export async function notifyCurrentProductPaymentFailure(
  env: Pick<Env, "PLATFORM_DB" | "NOTIFICATIONS_QUEUE">,
  event: ProductUserDunningEvent,
) {
  const account = await env.PLATFORM_DB.prepare(
    `SELECT p.tenant_id,u.email,u.email_verified_at,s.status,s.provider_event_at
     FROM product_user_subscriptions s
     JOIN products p ON p.id=s.product_id AND p.status='active'
     JOIN product_end_users u ON u.product_space_id=p.id AND u.end_user_id=s.end_user_id
     JOIN orgs o ON o.id=p.tenant_id AND o.status='active'
     WHERE s.product_id=? AND s.end_user_id=? AND s.provider=? AND s.provider_subscription_id=?
       AND u.deleted_at IS NULL AND u.suspended_at IS NULL`
  ).bind(event.productId, event.endUserId, event.provider, event.subscriptionId)
    .first<{ tenant_id: string; email: string | null; email_verified_at: string | null; status: string; provider_event_at: string | null }>();
  if (!account || account.status !== "past_due") return { skipped: "payment_recovered_or_subscription_replaced", notified: 0 };
  if (event.providerUpdatedAt && account.provider_event_at && Date.parse(account.provider_event_at) > Date.parse(event.providerUpdatedAt)) {
    return { skipped: "stale_provider_event", notified: 0 };
  }
  if (!account.email || !account.email_verified_at) return { skipped: "no_verified_account_email", notified: 0 };

  const notificationId = await stableNotificationId(event, "product_user_subscription", event.productId, event.endUserId);
  await env.NOTIFICATIONS_QUEUE.send({
    type: "email",
    tenantId: account.tenant_id,
    email: account.email,
    notificationId,
    subject: "Action needed: payment for your subscription failed",
    html: "A payment for your subscription was not completed. Sign in to your account to review your plan and payment method.",
  });
  return { notified: 1 };
}

export async function notifyCurrentPaymentFailure(
  env: Pick<Env, "PLATFORM_DB" | "NOTIFICATIONS_QUEUE">,
  event: (PlatformDunningEvent & { scope: "platform_subscription" }) | (ProductUserDunningEvent & { scope: "product_user_subscription" }),
) {
  return event.scope === "platform_subscription"
    ? notifyCurrentPlatformPaymentFailure(env, event)
    : notifyCurrentProductPaymentFailure(env, event);
}
