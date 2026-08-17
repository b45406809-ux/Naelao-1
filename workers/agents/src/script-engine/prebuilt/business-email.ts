/**
 * business-email (spec §11) — a Naelao-provided business mailbox so the agent never has to
 * shop for a third-party email tool. Tier 2.
 *
 * TWO backends, chosen automatically:
 *   1. AgentMail (preferred when AGENTMAIL_API_KEY is configured on the agents worker): a REAL,
 *      inbound-capable mailbox on a domain AgentMail hosts — no Naelao DNS zone needed. Provision
 *      creates an inbox + inbound webhook; send goes out from that address; replies flow back into
 *      the business's channel inbox. Routed through the agents worker's own /internal/business-email/*
 *      routes, which hold the API key — the agent (this isolate) never sees it.
 *   2. Fallback (AgentMail not configured): the legacy behavior — a placeholder handle recorded in
 *      business_services + outbound-only send through the notifications worker (Resend). Honest:
 *      this address cannot RECEIVE, and provision says so.
 *
 * This is NOT a reserved capability — a builder may instead author their own email script — but the
 * Naelao service is the zero-config default.
 *
 * Operations:
 *   email.provision(slug?)             → { address, inbound, status }
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

/** Call an /internal/business-email/* route on the agents worker itself (holds AGENTMAIL_API_KEY).
 *  Returns null when the self-binding isn't wired (older env), so the caller falls back. */
async function agentMailCall(
  ctx: PrebuiltOpContext,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  if (!ctx.env.agentsWorker) return null;
  const resp = await ctx.env.agentsWorker.fetch(new Request(`http://agents-worker${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": ctx.env.tenantId,
      "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
    },
    body: JSON.stringify({ spaceId: ctx.env.spaceId, tenantId: ctx.env.tenantId, ...body }),
  }));
  return resp.json<Record<string, unknown>>().catch(() => null);
}

async function provision(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  const slug = String(a["slug"] ?? a["name"] ?? "team");
  // Prefer a REAL, inbound-capable AgentMail inbox.
  const am = await agentMailCall(ctx, "/internal/business-email/provision", {
    slug: toSlug(slug),
    ...(a["display_name"] ? { displayName: String(a["display_name"]) } : {}),
  });
  if (am && am["configured"] === true && am["ok"] === true) {
    return {
      address: am["email"],
      inbound: Boolean(am["inbound_wired"]) || Boolean(am["already"]),
      status: "active",
      provider: "agentmail",
    };
  }
  // Fallback: legacy placeholder (send-only). Say plainly it can't receive.
  const rec = (await bizService(ctx, "POST", { kind: "business_email", slug: toSlug(slug) })) as { naelao_handle?: string };
  return {
    address: rec?.naelao_handle,
    inbound: false,
    status: "active",
    provider: "placeholder",
    note: "This address can send but not receive yet (AgentMail is not configured on this deployment).",
  };
}

async function send(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  const to = a["to"];
  // Prefer sending from the real AgentMail inbox (a genuine, reply-able from-address).
  const am = await agentMailCall(ctx, "/internal/business-email/send", {
    to,
    ...(a["subject"] !== undefined ? { subject: a["subject"] } : {}),
    ...(a["body"] !== undefined ? { text: a["body"] } : {}),
    ...(a["html"] !== undefined ? { html: a["html"] } : {}),
  });
  if (am && am["ok"] === true) {
    return { delivered: true, provider: "agentmail", message_id: am["messageId"] ?? null };
  }
  // Fallback: outbound-only via the notifications worker (Resend).
  if (!ctx.env.notificationsWorker) {
    return { delivered: false, reason: "notifications worker binding not configured" };
  }
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
        to,
        subject: a["subject"],
        body: a["body"],
        ...(from ? { from } : {}),
      }),
    })
  );
  if (!resp.ok) throw new Error(`email.send failed: ${resp.status}`);
  return { delivered: true, provider: "resend", from: from ?? "platform" };
}

function toSlug(input: string): string {
  return (input || "team").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}

export const businessEmail: PrebuiltScript = {
  name: "business-email",
  description: "Send transactional and marketing email from a Naelao-provided business address (inbound-capable via AgentMail when configured).",
  domain: "comms",
  requires_tier: 2,
  operations: {
    "email.provision": (a, c) => provision(c, a),
    "email.send": (a, c) => send(c, a),
    "email.status": (_a, c) => bizService(c, "GET"),
  },
};
