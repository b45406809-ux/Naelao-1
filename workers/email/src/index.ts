import { Hono, type Context } from "hono";
import { verifyInternalToken } from "@naelao/http";
import { handleInbound } from "./inbound.js";
import { SCOPES, authenticate, generateApiKey, isScope, keyPrefix, sha256Hex, type AuthContext, type Scope } from "./keys.js";

export interface Env {
  PLATFORM_DB: D1Database;
  NEMAIL_R2?: R2Bucket;
  EMAIL?: SendEmail;
  PLATFORM_SECRET?: string;
  ENVIRONMENT?: string;
  NAELAO_EMAIL_ENABLED?: string;
  NAELAO_EMAIL_DOMAINS?: string;
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
async function idempotent(c: AppContext, operation: string, bodyForHash: string, run: () => Promise<{ status: number; body: unknown }>) {
  const key = c.req.header("idempotency-key");
  const send = (status: number, body: unknown, replayed = false) => c.json(body as object, status as 200, replayed ? { "idempotent-replayed": "true" } : {});
  if (key === undefined) { const r = await run(); return send(r.status, r.body); }
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
  let result: { status: number; body: unknown };
  try { result = await run(); } catch (e) {
    await db.prepare("DELETE FROM nemail_idempotency WHERE nemail_tenant_id=? AND idem_key=? AND operation=?").bind(tenantId, key, operation).run();
    throw e;
  }
  await db.prepare("UPDATE nemail_idempotency SET status='completed', response_status=?, response_json=? WHERE nemail_tenant_id=? AND idem_key=? AND operation=?")
    .bind(result.status, JSON.stringify(result.body), tenantId, key, operation).run();
  return send(result.status, result.body);
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

export default {
  fetch: app.fetch,
  email: (message: ForwardableEmailMessage, env: Env) => handleInbound(message, env, emailEnabled(env)),
};
