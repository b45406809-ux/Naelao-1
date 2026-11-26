// AgentPort's only email provider: Naelao Email, reached over the NAELAO_EMAIL service binding (MS-35, MR-EM-7).
// AgentPort holds one Naelao Email API key per AgentPort tenant. It is created through the internal HMAC tenant
// route on first use and kept only as AES-GCM ciphertext (sealSecret). It is never logged, returned or put in an error.
import { mintInternalToken, readBoundedResponseJson } from "@naelao/http";
import { openSealedSecret, sealSecret } from "./core/identity.js";

export interface NaelaoEmailEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  AGENTPORT_JWT_SECRET?: string;
  NAELAO_EMAIL?: Fetcher;
}

export interface NaelaoEmailResult { status: number; body: Record<string, unknown> | null }

const BASE = "https://naelao-email.internal";
const KEY_PURPOSE = "naelao-email-api-key";
export const WEBHOOK_SECRET_PURPOSE = "naelao-email-webhook-secret";
// Least privilege: AgentPort never reads message bodies or usage through this key.
const KEY_SCOPES = ["inboxes:read", "inboxes:write", "messages:send", "webhooks:write"];

export class NaelaoEmailUnavailable extends Error {
  constructor() { super("naelao_email_unavailable"); }
}

export const nemailTenantId = (tenantId: string) => `agentport-${tenantId}`;

export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable, printable Idempotency-Key (<= 128 chars) derived from AgentPort identifiers, so a retry replays and never duplicates. */
export async function nemailIdempotencyKey(...parts: string[]) {
  return `ap-${await sha256Hex(parts.join("\n"))}`;
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await readBoundedResponseJson<unknown>(response, 262_144);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function send(env: NaelaoEmailEnv, request: Request): Promise<NaelaoEmailResult> {
  if (!env.NAELAO_EMAIL) throw new NaelaoEmailUnavailable();
  let response: Response;
  try { response = await env.NAELAO_EMAIL.fetch(request); } catch { throw new NaelaoEmailUnavailable(); }
  return { status: response.status, body: await readBody(response) };
}

/** Opens the tenant's sealed key, creating the Naelao Email tenant and key on first use. Returns null when it cannot be had. */
async function tenantApiKey(env: NaelaoEmailEnv, tenantId: string): Promise<string | null> {
  const secret = env.AGENTPORT_JWT_SECRET;
  if (!secret) return null;
  const read = async () => {
    const row = await env.PLATFORM_DB.prepare("SELECT key_ciphertext,key_iv FROM agentport_naelao_email_tenants WHERE tenant_id=?").bind(tenantId).first<{ key_ciphertext: string; key_iv: string }>();
    if (!row) return null;
    try { return await openSealedSecret(secret, KEY_PURPOSE, tenantId, { ciphertext: row.key_ciphertext, iv: row.key_iv }); } catch { return null; }
  };
  const existing = await read();
  if (existing) return existing;
  const nemailTenant = nemailTenantId(tenantId);
  const created = await send(env, new Request(`${BASE}/internal/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": nemailTenant, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, nemailTenant) },
    body: JSON.stringify({ name: `AgentPort ${tenantId}`.slice(0, 120), scopes: KEY_SCOPES }),
  }));
  const apiKey = (created.body?.data as { api_key?: unknown } | undefined)?.api_key;
  if (created.status !== 201 || typeof apiKey !== "string" || !apiKey.startsWith("nem_")) {
    // 409: another request created the tenant first; its key is (or will shortly be) in our table. Anything else: unavailable.
    return created.status === 409 ? await read() : null;
  }
  const sealed = await sealSecret(secret, KEY_PURPOSE, tenantId, apiKey);
  await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO agentport_naelao_email_tenants(tenant_id,nemail_tenant_id,key_ciphertext,key_iv,created_at) VALUES(?,?,?,?,?)")
    .bind(tenantId, nemailTenant, sealed.ciphertext, sealed.iv, new Date().toISOString()).run();
  return await read();
}

/** Calls the Naelao Email public API as this AgentPort tenant. Returns null when no tenant key can be had. */
export async function naelaoEmailRequest(env: NaelaoEmailEnv, tenantId: string, method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<NaelaoEmailResult | null> {
  const apiKey = await tenantApiKey(env, tenantId);
  if (!apiKey) return null;
  return send(env, new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }));
}

/** Best-effort removal of a mailbox's Naelao Email resources. Safe to repeat: a missing resource is already gone. */
export async function deleteNaelaoEmailMailbox(env: NaelaoEmailEnv, tenantId: string, ids: { inboxId?: string | null; webhookId?: string | null }) {
  if (!env.NAELAO_EMAIL) return;
  try {
    if (ids.webhookId) await naelaoEmailRequest(env, tenantId, "DELETE", `/v1/webhooks/${encodeURIComponent(ids.webhookId)}`);
    if (ids.inboxId) await naelaoEmailRequest(env, tenantId, "DELETE", `/v1/inboxes/${encodeURIComponent(ids.inboxId)}`);
  } catch { /* the local revoke is authoritative; a repeat of revoke retries this */ }
}
