/**
 * business-email (spec §11) — a Naelao-provided business mailbox so the agent never has to
 * shop for a third-party email tool. Tier 2.
 *
 * Provisioning allocates hi@{slug}.naelao-mail.com (a Naelao-managed sending identity) and
 * records a business_services row. Sending routes through the notifications worker, which
 * holds the provider credentials, so usage reflects on the owner's billing. This is NOT a
 * reserved capability — a builder may instead author their own email script — but the
 * Naelao service is the zero-config default.
 *
 * Operations:
 *   email.provision(slug?)             → { address: "hi@{slug}.naelao-mail.com", status }
 *   email.send(to, subject, body)      → delivery receipt (from the business address)
 *   email.status()                     → current business-email service record
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { mintInternalToken } from "@naelao/http";

async function bizService(
  ctx: PrebuiltOpContext,
  method: "POST" | "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  if (!ctx.env.spacesWorker) throw new Error("business-email unavailable: spaces worker binding not configured");
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ctx.env.tenantId,
      "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    },
  };
  if (body) init.body = JSON.stringify({ space_id: ctx.env.spaceId, ...body });
  const path = method === "GET"
    ? `/internal/business-services?space_id=${encodeURIComponent(ctx.env.spaceId)}&kind=business_email`
    : `/internal/business-services`;
  const resp = await ctx.env.spacesWorker.fetch(new Request(`http://spaces-worker${path}`, init));
  if (!resp.ok) throw new Error(`business-email op failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function send(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.notificationsWorker) {
    return { delivered: false, reason: "notifications worker binding not configured" };
  }
  // Resolve the provisioned from-address (falls back to the platform sender if unprovisioned).
  let from: string | undefined;
  try {
    const svc = (await bizService(ctx, "GET")) as { naelao_handle?: string } | null;
    from = svc?.naelao_handle ?? undefined;
  } catch { /* best-effort */ }

  const resp = await ctx.env.notificationsWorker.fetch(
    new Request("http://notifications-worker/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": ctx.env.tenantId },
      body: JSON.stringify({
        channel: "email",
        space_id: ctx.env.spaceId,
        to: a["to"],
        subject: a["subject"],
        body: a["body"],
        ...(from ? { from } : {}),
      }),
    })
  );
  if (!resp.ok) throw new Error(`email.send failed: ${resp.status}`);
  return { delivered: true, from: from ?? "platform" };
}

function toSlug(input: string): string {
  return (input || "team").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}

export const businessEmail: PrebuiltScript = {
  name: "business-email",
  description: "Send transactional and marketing email from a Naelao-provided business address.",
  domain: "comms",
  requires_tier: 2,
  operations: {
    "email.provision": (a, c) =>
      bizService(c, "POST", { kind: "business_email", slug: toSlug(String(a["slug"] ?? a["name"] ?? "team")) }),
    "email.send": (a, c) => send(c, a),
    "email.status": (_a, c) => bizService(c, "GET"),
  },
};
