import { Hono, type Context } from "hono";
import { verifyInternalToken } from "@naelao/http";
import { handleInbound } from "./inbound.js";
import { parseFields, performSend } from "./send.js";
import { SCOPES, authenticate, generateApiKey, isScope, keyPrefix, sha256Hex, type AuthContext, type Scope } from "./keys.js";
import { checkWebhookUrl, resolveDestination } from "./ssrf.js";
import { dispatchDue } from "./dispatch.js";
import { WEBHOOK_EVENT_TYPES, encryptSecret, generateWebhookSecret, isWebhookEventType, webhookAad, webhookKeyUsable } from "./webhooks.js";

export interface Env {
  PLATFORM_DB: D1Database;
  NEMAIL_R2?: R2Bucket;
  EMAIL?: SendEmail;
  PLATFORM_SECRET?: string;
  ENVIRONMENT?: string;
  NAELAO_EMAIL_ENABLED?: string;
  NAELAO_EMAIL_DOMAINS?: string;
  /** Optional address that receives DSN/ARF reports for tenants (tenant resolved from the original Message-ID). */
  NAELAO_EMAIL_BOUNCE_ADDRESS?: string;
  /** Worker secret (>= 32 chars). Derives the AES-256-GCM key that encrypts webhook signing secrets at rest. */
  NEMAIL_WEBHOOK_KEY?: string;
  /** Test injection for the DoH lookup of webhook destinations (MS-48); production uses the global fetch. */
  DOH_FETCH?: typeof fetch;
}
type AppContext = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

export const MAX_INBOXES_PER_TENANT = 10;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const notFound = { error_code: "not_found", message: "Not found." };
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const emailEnabled = (env: Env) => env.NAELAO_EMAIL_ENABLED === "true";
export function configuredDomains(env: Env) {
  return (env.NAELAO_EMAIL_DOMAINS ?? "").split(",").map(d => d.trim().toLowerCase()).filter(d => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
}

interface InboxRow { id: string; address: string; domain: string; local_part: string; display_name: string; status: string; sending_paused: number; created_at: string }
const inboxJson = (r: InboxRow) => ({ id: r.id, address: r.address, domain: r.domain, display_name: r.display_name, status: r.status, sending_paused: r.sending_paused === 1, created_at: r.created_at });
const INBOX_COLS = "id,address,domain,local_part,display_name,status,sending_paused,created_at";

const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// Flag off: every route (including internal and unknown paths) answers the not-found shape.
app.use("*", async (c, next) => {
  if (!emailEnabled(c.env)) return c.json(notFound, 404);
  return next();
});
app.notFound(c => c.json(notFound, 404));
app.onError((_err, c) => c.json({ error_code: "internal_error", message: "Internal error." }, 500));

app.get("/health", c => c.json({ ok: true, service: "naelao-email" }));

// Platform control plane: creates a tenant and its first API key (HMAC-protected, never key-authenticated).
app.post("/internal/v1/tenants", async c => {
  const platformTenant = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !platformTenant || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), platformTenant, c.env.PLATFORM_SECRET))) {
    return c.json({ error_code: "forbidden", message: "Forbidden." }, 403);
  }
  const body = await c.req.json<{ org_id?: unknown; name?: unknown; scopes?: unknown }>().catch(() => null);
  const scopes = body?.scopes === undefined ? [...SCOPES] : body.scopes;
  if (!body || (body.org_id !== undefined && (typeof body.org_id !== "string" || !body.org_id || body.org_id.length > 200)) ||
    (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 120)) ||
    !Array.isArray(scopes) || scopes.length < 1 || !scopes.every(isScope)) {
    return c.json({ error_code: "invalid_request", message: "Invalid tenant request." }, 400);
  }
  if (await c.env.PLATFORM_DB.prepare("SELECT id FROM nemail_tenants WHERE id=?").bind(platformTenant).first()) {
    return c.json({ error_code: "tenant_exists", message: "Tenant already exists." }, 409);
  }
  const key = generateApiKey();
  const keyId = `nek_${crypto.randomUUID()}`;
  try {
    await c.env.PLATFORM_DB.batch([
      c.env.PLATFORM_DB.prepare("INSERT INTO nemail_tenants(id,org_id,name) VALUES(?,?,?)").bind(platformTenant, (body.org_id as string | undefined) ?? null, (body.name as string | undefined) ?? ""),
      c.env.PLATFORM_DB.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json,name) VALUES(?,?,?,?,?,?)")
        .bind(keyId, platformTenant, await sha256Hex(key), keyPrefix(key), JSON.stringify(scopes), "initial"),
    ]);
  } catch {
    return c.json({ error_code: "tenant_exists", message: "Tenant already exists." }, 409);
  }
  return c.json({ data: { tenant_id: platformTenant, api_key: key, key_id: keyId, key_prefix: keyPrefix(key), scopes } }, 201, { "cache-control": "no-store" });
});

// Platform inventory (MS-38 / MR-REC-2): read-only page of inboxes whose tenant id starts with the caller's prefix, for the Agents
// reconciliation sweep. HMAC-protected like the other /internal routes; never key-authenticated, never mutates.
app.post("/internal/v1/inventory/inboxes", async c => {
  const platformTenant = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !platformTenant || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), platformTenant, c.env.PLATFORM_SECRET))) {
    return c.json({ error_code: "forbidden", message: "Forbidden." }, 403);
  }
  const body = await c.req.json<{ tenant_prefix?: unknown; cursor?: unknown; limit?: unknown }>().catch(() => null);
  if (!body || typeof body.tenant_prefix !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.tenant_prefix) ||
    (body.cursor !== undefined && (typeof body.cursor !== "string" || !/^inb_[A-Za-z0-9_-]{1,80}$/.test(body.cursor))) ||
    (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 500))) {
    return c.json({ error_code: "invalid_request", message: "Invalid inventory request." }, 400);
  }
  const limit = (body.limit as number | undefined) ?? 200;
  const rows = await c.env.PLATFORM_DB.prepare("SELECT id,address,status,nemail_tenant_id FROM nemail_inboxes WHERE substr(nemail_tenant_id,1,?)=? AND id>? ORDER BY id LIMIT ?")
    .bind(body.tenant_prefix.length, body.tenant_prefix, (body.cursor as string | undefined) ?? "", limit + 1).all<{ id: string; address: string; status: string; nemail_tenant_id: string }>();
  const page = rows.results.slice(0, limit);
  return c.json({ data: { items: page.map(r => ({ id: r.id, address: r.address, status: r.status === "deleted" ? "deleted" : "active" })), ...(rows.results.length > limit ? { next_cursor: page[page.length - 1]!.id } : {}) } });
});

// Platform usage by period (MS-40): sent-message count for one inbox of a Managed tenant over [start_ms, end_ms), for the Agents
// subscription settlement. HMAC-protected, tenant id in x-naelao-tenant-id. Only `naelao-` (Managed) tenants are answered: a direct
// tenant, an AgentPort tenant or an unknown one gets the same 404, so nothing here can be used to bill or probe them.
app.post("/internal/v1/usage/period", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))) {
    return c.json({ error_code: "forbidden", message: "Forbidden." }, 403);
  }
  const body = await c.req.json<{ inbox_id?: unknown; start_ms?: unknown; end_ms?: unknown }>().catch(() => null);
  if (!body || typeof body.inbox_id !== "string" || !/^inb_[A-Za-z0-9_-]{1,80}$/.test(body.inbox_id)
    || !Number.isSafeInteger(body.start_ms) || !Number.isSafeInteger(body.end_ms) || (body.start_ms as number) < 0 || (body.end_ms as number) <= (body.start_ms as number)
    || (body.end_ms as number) - (body.start_ms as number) > 100 * 86_400_000) {
    return c.json({ error_code: "invalid_request", message: "Invalid usage request." }, 400);
  }
  if (!tenantId.startsWith("naelao-")) return c.json({ error_code: "not_found", message: "Not found." }, 404);
  const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const inbox = await c.env.PLATFORM_DB.prepare("SELECT id FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=?").bind(body.inbox_id, tenantId).first<{ id: string }>();
  if (!inbox) return c.json({ error_code: "not_found", message: "Not found." }, 404);
  const sent = await c.env.PLATFORM_DB.prepare(`SELECT COALESCE(sum(u.quantity),0) AS n FROM nemail_usage u JOIN nemail_messages m ON m.id=u.message_id
    WHERE u.nemail_tenant_id=? AND u.meter='email.message.sent' AND m.inbox_id=? AND u.created_at>=? AND u.created_at<?`)
    .bind(tenantId, body.inbox_id, sqlTime(body.start_ms as number), sqlTime(body.end_ms as number)).first<{ n: number }>();
  return c.json({ data: { inbox_id: body.inbox_id, meter: "email.message.sent", start_ms: body.start_ms, end_ms: body.end_ms, sent_count: sent?.n ?? 0 } });
});

// Platform inbox sending pause (MS-41): the Agents subscription engine pauses a Managed inbox when its subscription is suspended and lifts
// that pause on recovery. HMAC-protected, `naelao-` tenants only (others get the same 404). The pause is tagged `subscription_suspended`;
// pausing never overwrites another pause, and resuming only lifts a pause carrying that tag, so operator and abuse pauses stay in force.
app.post("/internal/v1/inboxes/sending", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))) {
    return c.json({ error_code: "forbidden", message: "Forbidden." }, 403);
  }
  const body = await c.req.json<{ inbox_id?: unknown; paused?: unknown; reason?: unknown }>().catch(() => null);
  // MS-47: the owner's own suspend/resume uses a second tag, so it never lifts (or is lifted by) a billing suspension.
  const reason = body?.reason === undefined ? "subscription_suspended" : body.reason;
  if (!body || typeof body.inbox_id !== "string" || !/^inb_[A-Za-z0-9_-]{1,80}$/.test(body.inbox_id) || typeof body.paused !== "boolean"
    || (reason !== "subscription_suspended" && reason !== "owner_suspended")) {
    return c.json({ error_code: "invalid_request", message: "Invalid sending request." }, 400);
  }
  if (!tenantId.startsWith("naelao-")) return c.json({ error_code: "not_found", message: "Not found." }, 404);
  const db = c.env.PLATFORM_DB;
  if (body.paused) {
    await db.prepare("UPDATE nemail_inboxes SET sending_paused=1, sending_pause_reason=? WHERE id=? AND nemail_tenant_id=? AND status != 'deleted' AND sending_paused=0")
      .bind(reason, body.inbox_id, tenantId).run();
  } else {
    await db.prepare("UPDATE nemail_inboxes SET sending_paused=0, sending_pause_reason=NULL WHERE id=? AND nemail_tenant_id=? AND status != 'deleted' AND sending_pause_reason=?")
      .bind(body.inbox_id, tenantId, reason).run();
  }
  const row = await db.prepare("SELECT sending_paused,sending_pause_reason FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'")
    .bind(body.inbox_id, tenantId).first<{ sending_paused: number; sending_pause_reason: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "Not found." }, 404);
  return c.json({ data: { inbox_id: body.inbox_id, sending_paused: row.sending_paused === 1, pause_reason: row.sending_pause_reason } });
});

function requireScope(scope: Scope) {
  return async (c: AppContext, next: () => Promise<void>) => {
    const auth = await authenticate(c.env.PLATFORM_DB, c.req.header("authorization"));
    if (!auth) return c.json({ error_code: "unauthorized", message: "Missing or invalid API key." }, 401, { "www-authenticate": "Bearer" });
    if (!auth.scopes.includes(scope)) return c.json({ error_code: "insufficient_scope", message: `API key lacks the ${scope} scope.` }, 403);
    c.set("auth", auth);
    return next();
  };
}

/** Idempotency-Key replay: same key+operation+body replays the stored response; a different body is refused. */
type IdemResult = { status: number; body: unknown; cache?: boolean; headers?: Record<string, string> };
async function idempotent(c: AppContext, operation: string, bodyForHash: string, run: () => Promise<IdemResult>, opts: { required?: boolean; keepClaimOnError?: boolean } = {}) {
  const key = c.req.header("idempotency-key");
  const send = (status: number, body: unknown, replayed = false, extra: Record<string, string> = {}) => c.json(body as object, status as 200, { ...extra, ...(replayed ? { "idempotent-replayed": "true" } : {}) });
  if (key === undefined && opts.required) return c.json({ error_code: "idempotency_key_required", message: "The Idempotency-Key header is required." }, 400);
  if (key === undefined) { const r = await run(); return send(r.status, r.body, false, r.headers); }
  if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) return c.json({ error_code: "invalid_idempotency_key", message: "Invalid Idempotency-Key." }, 400);
  const db = c.env.PLATFORM_DB, tenantId = c.get("auth").tenantId;
  const hash = await sha256Hex(`${operation}\n${bodyForHash}`);
  await db.prepare("DELETE FROM nemail_idempotency WHERE nemail_tenant_id=? AND idem_key=? AND operation=? AND julianday(expires_at) <= julianday('now')").bind(tenantId, key, operation).run();
  const claim = await db.prepare("INSERT OR IGNORE INTO nemail_idempotency(nemail_tenant_id,idem_key,operation,request_hash,status,expires_at) VALUES(?,?,?,?, 'pending', ?)")
    .bind(tenantId, key, operation, hash, new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()).run();
  if (!((claim.meta?.changes ?? 0) > 0)) {
    const row = await db.prepare("SELECT request_hash,status,response_status,response_json FROM nemail_idempotency WHERE nemail_tenant_id=? AND idem_key=? AND operation=?")
      .bind(tenantId, key, operation).first<{ request_hash: string; status: string; response_status: number | null; response_json: string | null }>();
    if (!row || row.request_hash !== hash) return c.json({ error_code: "idempotency_key_reuse", message: "Idempotency-Key was used with a different request." }, 422);
    if (row.status !== "completed" || row.response_status === null || row.response_json === null) return c.json({ error_code: "idempotency_in_progress", message: "A request with this Idempotency-Key is in progress." }, 409);
    return send(row.response_status, JSON.parse(row.response_json), true);
  }
  let result: IdemResult;
  try { result = await run(); } catch (e) {
    // A send that may have reached the transport keeps its pending claim: the key can never trigger a second send.
    if (!opts.keepClaimOnError) await db.prepare("DELETE FROM nemail_idempotency WHERE nemail_tenant_id=? AND idem_key=? AND operation=?").bind(tenantId, key, operation).run();
    throw e;
  }
  if (result.cache === false) {
    await db.prepare("DELETE FROM nemail_idempotency WHERE nemail_tenant_id=? AND idem_key=? AND operation=?").bind(tenantId, key, operation).run();
    return send(result.status, result.body, false, result.headers);
  }
  await db.prepare("UPDATE nemail_idempotency SET status='completed', response_status=?, response_json=? WHERE nemail_tenant_id=? AND idem_key=? AND operation=?")
    .bind(result.status, JSON.stringify(result.body), tenantId, key, operation).run();
  return send(result.status, result.body, false, result.headers);
}

app.post("/v1/inboxes", requireScope("inboxes:write"), async c => {
  const raw = await c.req.text();
  let body: { local_part?: unknown; domain?: unknown; display_name?: unknown } | null = null;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    (body.local_part !== undefined && (typeof body.local_part !== "string" || !LOCAL_PART_RE.test(body.local_part))) ||
    (body.domain !== undefined && typeof body.domain !== "string") ||
    (body.display_name !== undefined && (typeof body.display_name !== "string" || body.display_name.length > 120))) {
    return c.json({ error_code: "invalid_request", message: "Invalid inbox request." }, 400);
  }
  const domains = configuredDomains(c.env);
  if (domains.length === 0) return c.json({ error_code: "offering_unavailable", message: "Naelao Email has no managed domain configured." }, 503);
  const domain = typeof body.domain === "string" ? body.domain.toLowerCase() : domains[0]!;
  if (!domains.includes(domain)) return c.json({ error_code: "domain_not_available", message: "That domain is not a Naelao Email managed domain." }, 400);
  const tenantId = c.get("auth").tenantId;
  return idempotent(c, "inboxes.create", raw, async () => {
    const localPart = (body!.local_part as string | undefined) ?? `ib-${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("")}`;
    const address = `${localPart}@${domain}`;
    const id = `inb_${crypto.randomUUID()}`;
    // Limit enforced inside the INSERT so concurrent creates cannot exceed it.
    let changes = 0;
    try {
      const res = await c.env.PLATFORM_DB.prepare(
        `INSERT INTO nemail_inboxes(id,nemail_tenant_id,domain,local_part,address,display_name)
         SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM nemail_inboxes WHERE nemail_tenant_id=? AND status != 'deleted') < ?`
      ).bind(id, tenantId, domain, localPart, address, (body!.display_name as string | undefined) ?? "", tenantId, MAX_INBOXES_PER_TENANT).run();
      changes = res.meta?.changes ?? 0;
    } catch {
      return { status: 409, body: { error_code: "address_unavailable", message: "That address is not available." } };
    }
    if (changes === 0) return { status: 403, body: { error_code: "inbox_limit_reached", message: `Plan limit of ${MAX_INBOXES_PER_TENANT} inboxes reached.` } };
    await c.env.PLATFORM_DB.prepare("INSERT INTO nemail_addresses(id,nemail_tenant_id,inbox_id,address,is_primary) VALUES(?,?,?,?,1)").bind(`adr_${crypto.randomUUID()}`, tenantId, id, address).run();
    const row = await c.env.PLATFORM_DB.prepare(`SELECT ${INBOX_COLS} FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=?`).bind(id, tenantId).first<InboxRow>();
    return { status: 201, body: { data: inboxJson(row!) } };
  });
});

app.get("/v1/inboxes", requireScope("inboxes:read"), async c => {
  const rows = await c.env.PLATFORM_DB.prepare(`SELECT ${INBOX_COLS} FROM nemail_inboxes WHERE nemail_tenant_id=? AND status != 'deleted' ORDER BY created_at, id LIMIT 100`)
    .bind(c.get("auth").tenantId).all<InboxRow>();
  return c.json({ data: rows.results.map(inboxJson) });
});

app.get("/v1/inboxes/:id", requireScope("inboxes:read"), async c => {
  const row = await c.env.PLATFORM_DB.prepare(`SELECT ${INBOX_COLS} FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'`)
    .bind(c.req.param("id"), c.get("auth").tenantId).first<InboxRow>();
  return row ? c.json({ data: inboxJson(row) }) : c.json(notFound, 404);
});

app.delete("/v1/inboxes/:id", requireScope("inboxes:write"), async c => {
  const id = c.req.param("id"), tenantId = c.get("auth").tenantId;
  return idempotent(c, `inboxes.delete:${id}`, "", async () => {
    const now = new Date().toISOString();
    const res = await c.env.PLATFORM_DB.prepare("UPDATE nemail_inboxes SET status='deleted', deleted_at=? WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'").bind(now, id, tenantId).run();
    if (!((res.meta?.changes ?? 0) > 0)) return { status: 404, body: notFound };
    await c.env.PLATFORM_DB.prepare("UPDATE nemail_addresses SET deleted_at=? WHERE inbox_id=? AND nemail_tenant_id=? AND deleted_at IS NULL").bind(now, id, tenantId).run();
    return { status: 200, body: { data: { id, deleted: true } } };
  });
});

// ---- Webhooks (MS-34). The signing secret is returned once and never stored in plaintext or the replay table. ----
interface WebhookRow { id: string; url: string; event_types_json: string; status: string; created_at: string; inbox_id: string | null }
const webhookJson = (r: WebhookRow) => ({ id: r.id, inbox_id: r.inbox_id, url: r.url, event_types: JSON.parse(r.event_types_json) as string[], status: r.status, created_at: r.created_at });

// Not idempotent by design: a replayed response would have to contain the one-time secret, which must not be stored.
app.post("/v1/webhooks", requireScope("webhooks:write"), async c => {
  const body = await c.req.json<{ url?: unknown; event_types?: unknown; inbox_id?: unknown }>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error_code: "invalid_request", message: "Invalid webhook request." }, 400);
  const dest = checkWebhookUrl(body.url);
  if (!dest.ok) return c.json({ error_code: "invalid_webhook_url", message: `Webhook URL refused: ${dest.reason}.` }, 400);
  const resolution = await resolveDestination(new URL(dest.href).hostname, c.env.DOH_FETCH ?? fetch);
  if (resolution === "private") return c.json({ error_code: "invalid_webhook_url", message: "Webhook URL refused: the destination host resolves to a private address." }, 400);
  if (resolution === "unknown") return c.json({ error_code: "destination_unverifiable", message: "The webhook destination could not be verified. Try again." }, 503);
  const types = body.event_types;
  if (!Array.isArray(types) || types.length < 1 || types.length > WEBHOOK_EVENT_TYPES.length || !types.every(isWebhookEventType) || new Set(types).size !== types.length) {
    return c.json({ error_code: "invalid_request", message: `event_types must be a non-empty, duplicate-free subset of: ${WEBHOOK_EVENT_TYPES.join(", ")}.` }, 400);
  }
  if (!webhookKeyUsable(c.env.NEMAIL_WEBHOOK_KEY)) return c.json({ error_code: "offering_unavailable", message: "Webhook signing is not configured." }, 503);
  const tenantId = c.get("auth").tenantId;
  // Optional inbox scope. Another tenant's or a deleted inbox is indistinguishable from an unknown one.
  let inboxId: string | null = null;
  if (body.inbox_id !== undefined && body.inbox_id !== null) {
    if (typeof body.inbox_id !== "string" || !body.inbox_id) return c.json({ error_code: "invalid_request", message: "Invalid inbox_id." }, 400);
    const inbox = await c.env.PLATFORM_DB.prepare("SELECT id FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'").bind(body.inbox_id, tenantId).first();
    if (!inbox) return c.json(notFound, 404);
    inboxId = body.inbox_id;
  }
  const id = `whk_${crypto.randomUUID()}`;
  const secret = generateWebhookSecret();
  const ciphertext = await encryptSecret(c.env.NEMAIL_WEBHOOK_KEY, secret, webhookAad(tenantId, id));
  await c.env.PLATFORM_DB.prepare("INSERT INTO nemail_webhooks(id,nemail_tenant_id,url,event_types_json,secret_ciphertext,inbox_id) VALUES(?,?,?,?,?,?)")
    .bind(id, tenantId, dest.href, JSON.stringify(types), ciphertext, inboxId).run();
  const row = await c.env.PLATFORM_DB.prepare("SELECT id,url,event_types_json,status,created_at,inbox_id FROM nemail_webhooks WHERE id=? AND nemail_tenant_id=?").bind(id, tenantId).first<WebhookRow>();
  return c.json({ data: { ...webhookJson(row!), secret } }, 201, { "cache-control": "no-store" });
});

app.delete("/v1/webhooks/:id", requireScope("webhooks:write"), async c => {
  const id = c.req.param("id"), tenantId = c.get("auth").tenantId;
  return idempotent(c, `webhooks.delete:${id}`, "", async () => {
    const now = new Date().toISOString();
    const res = await c.env.PLATFORM_DB.prepare("UPDATE nemail_webhooks SET status='deleted', deleted_at=? WHERE id=? AND nemail_tenant_id=? AND deleted_at IS NULL").bind(now, id, tenantId).run();
    if (!((res.meta?.changes ?? 0) > 0)) return { status: 404, body: notFound };
    // No further attempts for this webhook, including rows already due.
    await c.env.PLATFORM_DB.prepare("UPDATE nemail_webhook_deliveries SET status='cancelled', claimed_until=NULL, last_error='webhook_deleted', updated_at=? WHERE webhook_id=? AND nemail_tenant_id=? AND status='pending'").bind(now, id, tenantId).run();
    return { status: 200, body: { data: { id, deleted: true } } };
  });
});

// ---- Read API (MS-32). Content is untrusted: html is returned as an inert string, never rendered. ----
const MAX_PAGE = 100;
const untrustedHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
const encodeCursor = (a: string, b: string) => btoa(JSON.stringify([a, b])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(value: string | undefined): [string, string] | null | undefined {
  if (value === undefined) return undefined;
  try {
    const v = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && v[0].length < 64 && v[1].length < 100 ? [v[0], v[1]] : null;
  } catch { return null; }
}
function pageParams(c: AppContext) {
  const raw = c.req.query("limit");
  const limit = raw === undefined ? 50 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  const cursor = decodeCursor(c.req.query("cursor"));
  if (limit < 1 || limit > MAX_PAGE || cursor === null) return null;
  return { limit, cursor };
}
const badPage = (c: AppContext) => c.json({ error_code: "invalid_request", message: "Invalid limit (1-100) or cursor." }, 400);
const parseJson = <T>(s: string | null, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

interface MsgRow { id: string; inbox_id: string; thread_id: string | null; direction: string; message_id_header: string | null; in_reply_to: string | null; references_json: string | null; from_address: string | null; from_name: string | null; to_json: string | null; cc_json: string | null; subject: string | null; size_bytes: number; state: string; error_code: string | null; received_at: string; text_body?: string | null; html_body?: string | null }
const MSG_COLS = "id,inbox_id,thread_id,direction,message_id_header,in_reply_to,references_json,from_address,from_name,to_json,cc_json,subject,size_bytes,state,error_code,received_at";
function messageJson(r: MsgRow, attachments?: unknown[]) {
  const out: Record<string, unknown> = {
    id: r.id, inbox_id: r.inbox_id, thread_id: r.thread_id, direction: r.direction, message_id: r.message_id_header, in_reply_to: r.in_reply_to,
    references: parseJson<string[]>(r.references_json, []), from: r.from_address, from_name: r.from_name, to: parseJson<string[]>(r.to_json, []), cc: parseJson<string[]>(r.cc_json, []),
    subject: r.subject, size_bytes: r.size_bytes, status: r.state, error_code: r.error_code, received_at: r.received_at,
  };
  if (r.text_body !== undefined) out.text = r.text_body ?? "";
  if (r.html_body !== undefined) { out.html = r.html_body ?? ""; out.html_untrusted = true; }
  if (attachments) out.attachments = attachments;
  return out;
}
async function ownedInbox(c: AppContext, id: string) {
  return c.env.PLATFORM_DB.prepare("SELECT id FROM nemail_inboxes WHERE id=? AND nemail_tenant_id=? AND status != 'deleted'").bind(id, c.get("auth").tenantId).first<{ id: string }>();
}

app.get("/v1/inboxes/:id/messages", requireScope("messages:read"), async c => {
  const page = pageParams(c);
  if (!page) return badPage(c);
  const inboxId = c.req.param("id") as string, tenantId = c.get("auth").tenantId;
  if (!(await ownedInbox(c, inboxId))) return c.json(notFound, 404);
  const cur = page.cursor;
  const rows = await c.env.PLATFORM_DB.prepare(
    `SELECT ${MSG_COLS} FROM nemail_messages WHERE nemail_tenant_id=? AND inbox_id=? ${cur ? "AND (received_at < ? OR (received_at = ? AND id < ?))" : ""} ORDER BY received_at DESC, id DESC LIMIT ?`
  ).bind(...[tenantId, inboxId, ...(cur ? [cur[0], cur[0], cur[1]] : []), page.limit + 1]).all<MsgRow>();
  const more = rows.results.length > page.limit;
  const items = rows.results.slice(0, page.limit);
  const last = items[items.length - 1];
  return c.json({ data: items.map(r => messageJson(r)), next_cursor: more && last ? encodeCursor(last.received_at, last.id) : null }, 200, untrustedHeaders);
});

app.get("/v1/messages/:id", requireScope("messages:read"), async c => {
  const tenantId = c.get("auth").tenantId;
  const row = await c.env.PLATFORM_DB.prepare(`SELECT ${MSG_COLS},text_body,html_body FROM nemail_messages WHERE id=? AND nemail_tenant_id=?`).bind(c.req.param("id"), tenantId).first<MsgRow>();
  if (!row) return c.json(notFound, 404);
  const atts = await c.env.PLATFORM_DB.prepare("SELECT id,filename,content_type,size_bytes,sha256 FROM nemail_attachments WHERE message_id=? AND nemail_tenant_id=? ORDER BY created_at, id").bind(row.id, tenantId)
    .all<{ id: string; filename: string; content_type: string; size_bytes: number; sha256: string | null }>();
  return c.json({ data: messageJson(row, atts.results) }, 200, untrustedHeaders);
});

interface ThreadRow { id: string; inbox_id: string; subject: string; last_message_at: string | null; created_at: string }
const threadJson = (r: ThreadRow) => ({ id: r.id, inbox_id: r.inbox_id, subject: r.subject, last_message_at: r.last_message_at, created_at: r.created_at });

app.get("/v1/inboxes/:id/threads", requireScope("messages:read"), async c => {
  const page = pageParams(c);
  if (!page) return badPage(c);
  const inboxId = c.req.param("id") as string, tenantId = c.get("auth").tenantId;
  if (!(await ownedInbox(c, inboxId))) return c.json(notFound, 404);
  const cur = page.cursor;
  const rows = await c.env.PLATFORM_DB.prepare(
    `SELECT id,inbox_id,subject,last_message_at,created_at FROM nemail_threads WHERE nemail_tenant_id=? AND inbox_id=? ${cur ? "AND (COALESCE(last_message_at,'') < ? OR (COALESCE(last_message_at,'') = ? AND id < ?))" : ""} ORDER BY COALESCE(last_message_at,'') DESC, id DESC LIMIT ?`
  ).bind(...[tenantId, inboxId, ...(cur ? [cur[0], cur[0], cur[1]] : []), page.limit + 1]).all<ThreadRow>();
  const more = rows.results.length > page.limit;
  const items = rows.results.slice(0, page.limit);
  const last = items[items.length - 1];
  return c.json({ data: items.map(threadJson), next_cursor: more && last ? encodeCursor(last.last_message_at ?? "", last.id) : null }, 200, untrustedHeaders);
});

app.get("/v1/threads/:id", requireScope("messages:read"), async c => {
  const tenantId = c.get("auth").tenantId;
  const t = await c.env.PLATFORM_DB.prepare("SELECT id,inbox_id,subject,last_message_at,created_at FROM nemail_threads WHERE id=? AND nemail_tenant_id=?").bind(c.req.param("id"), tenantId).first<ThreadRow>();
  if (!t) return c.json(notFound, 404);
  const msgs = await c.env.PLATFORM_DB.prepare(`SELECT ${MSG_COLS},text_body FROM nemail_messages WHERE nemail_tenant_id=? AND thread_id=? ORDER BY received_at, id LIMIT ${MAX_PAGE}`).bind(tenantId, t.id).all<MsgRow>();
  return c.json({ data: { ...threadJson(t), messages: msgs.results.map(r => messageJson(r)) } }, 200, untrustedHeaders);
});

// ---- Outbound (MS-33). Check order is enforced in performSend (see send.ts). ----
const parseBodyJson = (raw: string): unknown => { try { return raw ? JSON.parse(raw) : {}; } catch { return null; } };

app.post("/v1/inboxes/:id/messages/send", requireScope("messages:send"), async c => {
  const inboxId = c.req.param("id") as string, tenantId = c.get("auth").tenantId;
  const raw = await c.req.text();
  return idempotent(c, `messages.send:${inboxId}`, raw, () => performSend(c.env, tenantId, inboxId, parseBodyJson(raw)), { required: true, keepClaimOnError: true });
});

interface DraftRow { id: string; inbox_id: string; in_reply_to_message_id: string | null; to_json: string; cc_json: string; bcc_json: string; subject: string; text_body: string | null; html_body: string | null; status: string; sent_message_id: string | null; created_at: string; updated_at: string }
const DRAFT_COLS = "id,inbox_id,in_reply_to_message_id,to_json,cc_json,bcc_json,subject,text_body,html_body,status,sent_message_id,created_at,updated_at";
const draftJson = (r: DraftRow) => ({
  id: r.id, inbox_id: r.inbox_id, in_reply_to_message_id: r.in_reply_to_message_id, to: parseJson<string[]>(r.to_json, []), cc: parseJson<string[]>(r.cc_json, []), bcc: parseJson<string[]>(r.bcc_json, []),
  subject: r.subject, text: r.text_body, html: r.html_body, status: r.status, sent_message_id: r.sent_message_id, created_at: r.created_at, updated_at: r.updated_at,
});
const invalid = (c: AppContext, message: string) => c.json({ error_code: "invalid_request", message }, 400);

app.post("/v1/inboxes/:id/drafts", requireScope("messages:send"), async c => {
  const inboxId = c.req.param("id") as string, tenantId = c.get("auth").tenantId;
  const raw = await c.req.text();
  const parsed = parseFields(parseBodyJson(raw));
  if (parsed.error) return invalid(c, parsed.error);
  return idempotent(c, `drafts.create:${inboxId}`, raw, async () => {
    if (!(await ownedInbox(c, inboxId))) return { status: 404, body: notFound, cache: false };
    const f = parsed.fields, id = `drf_${crypto.randomUUID()}`;
    await c.env.PLATFORM_DB.prepare("INSERT INTO nemail_drafts(id,nemail_tenant_id,inbox_id,in_reply_to_message_id,to_json,cc_json,bcc_json,subject,text_body,html_body) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(id, tenantId, inboxId, f.in_reply_to_message_id ?? null, JSON.stringify(f.to ?? []), JSON.stringify(f.cc ?? []), JSON.stringify(f.bcc ?? []), f.subject ?? "", f.text ?? null, f.html ?? null).run();
    const row = await c.env.PLATFORM_DB.prepare(`SELECT ${DRAFT_COLS} FROM nemail_drafts WHERE id=? AND nemail_tenant_id=?`).bind(id, tenantId).first<DraftRow>();
    return { status: 201, body: { data: draftJson(row!) } };
  });
});

app.get("/v1/drafts/:id", requireScope("messages:read"), async c => {
  const row = await c.env.PLATFORM_DB.prepare(`SELECT ${DRAFT_COLS} FROM nemail_drafts WHERE id=? AND nemail_tenant_id=? AND status != 'discarded'`).bind(c.req.param("id"), c.get("auth").tenantId).first<DraftRow>();
  return row ? c.json({ data: draftJson(row) }, 200, untrustedHeaders) : c.json(notFound, 404);
});

app.patch("/v1/drafts/:id", requireScope("messages:send"), async c => {
  const id = c.req.param("id") as string, tenantId = c.get("auth").tenantId;
  const parsed = parseFields(parseBodyJson(await c.req.text()));
  if (parsed.error) return invalid(c, parsed.error);
  const row = await c.env.PLATFORM_DB.prepare(`SELECT ${DRAFT_COLS} FROM nemail_drafts WHERE id=? AND nemail_tenant_id=? AND status != 'discarded'`).bind(id, tenantId).first<DraftRow>();
  if (!row) return c.json(notFound, 404);
  if (row.status !== "draft") return c.json({ error_code: "draft_not_editable", message: "A sent draft cannot be edited." }, 409);
  const f = parsed.fields;
  const res = await c.env.PLATFORM_DB.prepare("UPDATE nemail_drafts SET to_json=?,cc_json=?,bcc_json=?,subject=?,text_body=?,html_body=?,in_reply_to_message_id=?,updated_at=datetime('now') WHERE id=? AND nemail_tenant_id=? AND status='draft'")
    .bind(JSON.stringify(f.to ?? parseJson<string[]>(row.to_json, [])), JSON.stringify(f.cc ?? parseJson<string[]>(row.cc_json, [])), JSON.stringify(f.bcc ?? parseJson<string[]>(row.bcc_json, [])),
      f.subject ?? row.subject, "text" in f ? f.text ?? null : row.text_body, "html" in f ? f.html ?? null : row.html_body,
      "in_reply_to_message_id" in f ? f.in_reply_to_message_id ?? null : row.in_reply_to_message_id, id, tenantId).run();
  if (!((res.meta?.changes ?? 0) > 0)) return c.json({ error_code: "draft_not_editable", message: "A sent draft cannot be edited." }, 409);
  const next = await c.env.PLATFORM_DB.prepare(`SELECT ${DRAFT_COLS} FROM nemail_drafts WHERE id=? AND nemail_tenant_id=?`).bind(id, tenantId).first<DraftRow>();
  return c.json({ data: draftJson(next!) });
});

app.post("/v1/drafts/:id/send", requireScope("messages:send"), async c => {
  const id = c.req.param("id") as string, tenantId = c.get("auth").tenantId, db = c.env.PLATFORM_DB;
  return idempotent(c, `drafts.send:${id}`, "", async () => {
    const d = await db.prepare(`SELECT ${DRAFT_COLS} FROM nemail_drafts WHERE id=? AND nemail_tenant_id=? AND status != 'discarded'`).bind(id, tenantId).first<DraftRow>();
    if (!d) return { status: 404, body: notFound, cache: false };
    if (d.status !== "draft") return { status: 409, body: { error_code: "draft_already_sent", message: "This draft was already sent." }, cache: false };
    const input = { to: parseJson<string[]>(d.to_json, []), cc: parseJson<string[]>(d.cc_json, []), bcc: parseJson<string[]>(d.bcc_json, []), subject: d.subject, text: d.text_body, html: d.html_body, in_reply_to_message_id: d.in_reply_to_message_id };
    return performSend(c.env, tenantId, d.inbox_id, input, {
      claim: async () => ((await db.prepare("UPDATE nemail_drafts SET status='sent', updated_at=datetime('now') WHERE id=? AND nemail_tenant_id=? AND status='draft'").bind(id, tenantId).run()).meta?.changes ?? 0) > 0,
      release: async () => { await db.prepare("UPDATE nemail_drafts SET status='draft', updated_at=datetime('now') WHERE id=? AND nemail_tenant_id=? AND status='sent' AND sent_message_id IS NULL").bind(id, tenantId).run(); },
      onSent: async mid => { await db.prepare("UPDATE nemail_drafts SET sent_message_id=? WHERE id=? AND nemail_tenant_id=?").bind(mid, id, tenantId).run(); },
    });
  }, { required: true, keepClaimOnError: true });
});

// ---- Usage (meter email.message.sent) ----
app.get("/v1/usage", requireScope("usage:read"), async c => {
  const now = new Date().toISOString().slice(0, 7);
  const period = c.req.query("period") ?? now;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return c.json({ error_code: "invalid_request", message: "period must be YYYY-MM." }, 400);
  const tenantId = c.get("auth").tenantId, db = c.env.PLATFORM_DB;
  const sent = await db.prepare("SELECT COALESCE(sum(quantity),0) AS n FROM nemail_usage WHERE nemail_tenant_id=? AND meter='email.message.sent' AND period=?").bind(tenantId, period).first<{ n: number }>();
  // Storage = raw MIME bytes plus attachment bytes of messages created in the period (UTC month).
  const raw = await db.prepare("SELECT COALESCE(sum(size_bytes),0) AS n FROM nemail_messages WHERE nemail_tenant_id=? AND substr(received_at,1,7)=?").bind(tenantId, period).first<{ n: number }>();
  const att = await db.prepare("SELECT COALESCE(sum(a.size_bytes),0) AS n FROM nemail_attachments a WHERE a.nemail_tenant_id=? AND substr(a.created_at,1,7)=?").bind(tenantId, period).first<{ n: number }>();
  return c.json({ data: { period, meter: "email.message.sent", sent_count: sent?.n ?? 0, storage_bytes: (raw?.n ?? 0) + (att?.n ?? 0) } });
});

// Operator route (HMAC, tenant id in x-naelao-tenant-id): pause/resume sending and set the per-tenant daily limit override.
app.post("/internal/v1/tenants/sending", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))) {
    return c.json({ error_code: "forbidden", message: "Forbidden." }, 403);
  }
  const body = await c.req.json<{ paused?: unknown; daily_send_limit_override?: unknown }>().catch(() => null);
  const o = body?.daily_send_limit_override;
  if (!body || (body.paused !== undefined && typeof body.paused !== "boolean") || (o !== undefined && o !== null && (!Number.isInteger(o) || (o as number) < 0 || (o as number) > 1_000_000)) ||
    (body.paused === undefined && o === undefined)) return c.json({ error_code: "invalid_request", message: "Invalid sending request." }, 400);
  if (!(await c.env.PLATFORM_DB.prepare("SELECT id FROM nemail_tenants WHERE id=?").bind(tenantId).first())) return c.json(notFound, 404);
  if (body.paused === false) await c.env.PLATFORM_DB.prepare("UPDATE nemail_tenants SET sending_paused=0, sending_paused_reason=NULL, sending_resumed_at=datetime('now') WHERE id=?").bind(tenantId).run();
  if (body.paused === true) await c.env.PLATFORM_DB.prepare("UPDATE nemail_tenants SET sending_paused=1, sending_paused_reason='operator', sending_paused_at=datetime('now') WHERE id=?").bind(tenantId).run();
  if (o !== undefined) await c.env.PLATFORM_DB.prepare("UPDATE nemail_tenants SET daily_send_limit_override=? WHERE id=?").bind(o as number | null, tenantId).run();
  const t = await c.env.PLATFORM_DB.prepare("SELECT sending_paused,sending_paused_reason,daily_send_limit_override FROM nemail_tenants WHERE id=?").bind(tenantId).first<{ sending_paused: number; sending_paused_reason: string | null; daily_send_limit_override: number | null }>();
  return c.json({ data: { tenant_id: tenantId, sending_paused: t!.sending_paused === 1, sending_paused_reason: t!.sending_paused_reason, daily_send_limit_override: t!.daily_send_limit_override } });
});

export default {
  fetch: app.fetch,
  email: (message: ForwardableEmailMessage, env: Env) => handleInbound(message, env, emailEnabled(env)),
  // Every minute. Flag off: no-op. Work per run is bounded (see dispatch.ts).
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    if (!emailEnabled(env)) return;
    ctx.waitUntil(dispatchDue(env).then(() => undefined));
  },
};
