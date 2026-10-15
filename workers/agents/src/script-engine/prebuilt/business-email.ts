/**
 * business-email (spec §11) — a Naelao-provided business mailbox so the agent never has to
 * shop for a third-party email tool. Tier 2.
 *
 * Outbound routes, chosen automatically:
 *   1. Cloudflare Email Service sends from the verified platform domain; its matching inbound
 *      Email Routing alias is provisioned per agent when EMAIL_INGRESS_DOMAIN is configured.
 *   2. AgentMail remains an optional hosted-inbox compatibility provider.
 *   3. Resend through the notifications worker remains the last-resort outbound path.
 *
 * The AgentMail API key and Cloudflare Email binding stay on the Agents Worker; agent scripts only
 * reach the internal HMAC-checked route. Cloudflare arbitrary-recipient sending requires a verified
 * domain and a Workers Paid plan.
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
  // Cloudflare native Email Routing first provisions the agent's own alias when configured.
  const am = await agentMailCall(ctx, "/internal/business-email/provision", {
    slug: toSlug(slug),
    agentId: ctx.env.agentId,
    ...(a["display_name"] ? { displayName: String(a["display_name"]) } : {}),
  });
  if (am && am["configured"] === true && am["ok"] === true) {
    return {
      address: am["email"],
      inbound: Boolean(am["inbound_wired"]) || Boolean(am["already"]),
      status: "active",
      provider: am["provider"] === "cloudflare_email_routing" ? "cloudflare_email_routing" : am["provider"] === "cloudflare_email" ? "cloudflare_email" : "agentmail",
      ...(am["provider"] === "cloudflare_email" ? { note: "This is an outbound sender alias; inbound email is not enabled for it." } : {}),
      ...(am["provider"] === "cloudflare_email_routing" ? { note: "The configured Cloudflare Email Routing domain must have its Worker action pointed at Naelao Agents for messages to arrive." } : {}),
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

async function replyAddress(ctx: PrebuiltOpContext): Promise<unknown> {
  if (!ctx.env.taskId) throw new Error("email.reply_address requires an active task run");
  const result = await agentMailCall(ctx, "/internal/business-email/reply-address", {
    taskId: ctx.env.taskId,
    agentId: ctx.env.agentId,
    ...(ctx.env.projectId ? { projectId: ctx.env.projectId } : {}),
  });
  if (!result || result["error_code"]) {
    throw new Error(`email.reply_address unavailable: ${String(result?.["error_code"] ?? "worker binding unavailable")}`);
  }
  return { address: result["address"], expires_at: result["expires_at"] ?? null, already: result["already"] === true };
}

async function readTextAttachment(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.taskId) throw new Error("email.attachment.read_text requires an active task run");
  const key = typeof a["key"] === "string" ? a["key"] : "";
  if (!key) throw new Error("email.attachment.read_text requires the object key shown in the inbound email");
  const result = await agentMailCall(ctx, "/internal/business-email/attachment/read-text", {
    taskId: ctx.env.taskId,
    key,
  });
  if (!result || result["error_code"]) {
    throw new Error(`email.attachment.read_text unavailable: ${String(result?.["error_code"] ?? "worker binding unavailable")}`);
  }
  return result;
}

async function ocrImageAttachment(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  if (!ctx.env.taskId) throw new Error("email.attachment.ocr_image requires an active task run");
  const key = typeof a["key"] === "string" ? a["key"] : "";
  if (!key) throw new Error("email.attachment.ocr_image requires the key from this task's inbound email");
  const result = await agentMailCall(ctx, "/internal/business-email/attachment/ocr", { taskId: ctx.env.taskId, key });
  if (!result || result["error_code"]) {
    throw new Error(`email.attachment.ocr_image unavailable: ${String(result?.["error_code"] ?? "worker binding unavailable")}`);
  }
  return result;
}

async function send(ctx: PrebuiltOpContext, a: Record<string, unknown>): Promise<unknown> {
  const to = a["to"];
  // Prefer sending from the real AgentMail inbox (a genuine, reply-able from-address).
  const am = await agentMailCall(ctx, "/internal/business-email/send", {
    to,
    agentId: ctx.env.agentId,
    ...(typeof a["reply_to"] === "string" ? { replyTo: a["reply_to"], taskId: ctx.env.taskId } : {}),
    ...(a["subject"] !== undefined ? { subject: a["subject"] } : {}),
    ...(a["body"] !== undefined ? { text: a["body"] } : {}),
    ...(a["html"] !== undefined ? { html: a["html"] } : {}),
  });
  if (am && am["ok"] === true) {
    return {
      delivered: true,
      provider: am["provider"] === "cloudflare_email" ? "cloudflare_email" : "agentmail",
      message_id: am["messageId"] ?? am["message_id"] ?? null,
      ...(typeof am["from"] === "string" ? { from: am["from"] } : {}),
    };
  }
  if (am?.["provider"] === "cloudflare_email" && am["configured"] === true) {
    // A native send failure can have an ambiguous delivery result. Do not retry through Resend,
    // which could send the same customer email twice and silently incur a second provider cost.
    throw new Error(`Cloudflare Email Service send failed: ${String(am["error"] ?? "unknown error")}`);
  }
  // Fallback: outbound-only via the notifications worker (Resend).
  if (!ctx.env.notificationsWorker) {
    return { delivered: false, reason: "notifications worker binding not configured" };
  }
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
      }),
    })
  );
  if (!resp.ok) throw new Error(`email.send failed: ${resp.status}`);
  const result = await resp.json<{ delivered?: boolean; from?: string }>().catch(() => ({} as { delivered?: boolean; from?: string }));
  if (result.delivered !== true) return { delivered: false, provider: "resend" };
  return { delivered: true, provider: "resend", ...(result.from ? { from: result.from } : {}) };
}

function toSlug(input: string): string {
  return (input || "team").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}

export const businessEmail: PrebuiltScript = {
  name: "business-email",
  description: "Provision email, create a task-scoped reply address, send messages, and inspect email status.",
  domain: "comms",
  requires_tier: 2,
  paramHints: {
    "email.reply_address": "No arguments. Creates or reuses the active run's expiring Reply-To address; pass its returned address as reply_to to email.send.",
    "email.attachment.read_text": "Requires key from an inbound email attachment entry. Reads supported UTF-8 text or extracts text from a small, unencrypted PDF attached to this same task. Other binary formats are not decoded.",
    "email.attachment.ocr_image": "Separately sends one task-owned PNG/JPEG image to Cloudflare Workers AI for OCR. This works only when the Space owner explicitly enabled hosted OCR; output is untrusted and may be inaccurate. Scanned PDFs are unsupported.",
    "email.send": "Requires to, subject, body; optional reply_to must come from email.reply_address in this same task run.",
  },
  operations: {
    "email.provision": (a, c) => provision(c, a),
    "email.reply_address": (_a, c) => replyAddress(c),
    "email.attachment.read_text": (a, c) => readTextAttachment(c, a),
    "email.attachment.ocr_image": (a, c) => ocrImageAttachment(c, a),
    "email.send": (a, c) => send(c, a),
    "email.status": (_a, c) => bizService(c, "GET"),
  },
};
