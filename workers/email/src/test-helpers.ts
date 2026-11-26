// Test-only fixture: in-memory SQLite with the real migrations, a D1-shaped wrapper, and fake transports.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import app, { type Env } from "./index.js";
import { generateApiKey, keyPrefix, sha256Hex } from "./keys.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const MIGRATIONS = ["0294_naelao_email_core.sql", "0295_naelao_email_inbound.sql", "0296_naelao_email_outbound.sql", "0297_naelao_email_webhooks.sql"];
export const SECRET = "s".repeat(32);
export const WEBHOOK_KEY = "w".repeat(40);
export const ALL_SCOPES = ["inboxes:read", "inboxes:write", "messages:read", "messages:send", "usage:read", "webhooks:write"];

export interface SentMail { from: string; to: string; raw: string }
export interface Fixture {
  db: InstanceType<typeof DatabaseSync>;
  env: Env;
  sent: SentMail[];
  /** "throw": the binding call fails after it was invoked, so the outcome is `unknown`. */
  emailMode: { mode: "ok" | "throw" };
}

export function fixture(over: Partial<Env> = {}): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  for (const m of MIGRATIONS) db.exec(readFileSync(fileURLToPath(new URL(`../../../infra/migrations/${m}`, import.meta.url)), "utf8"));
  const stmt = (sql: string, values: unknown[]) => ({
    sql,
    first: async <T>() => db.prepare(sql).get(...(values as never[])) as T | undefined,
    all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => { const r = db.prepare(sql).run(...(values as never[])); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  type Stmt = ReturnType<typeof stmt>;
  const PLATFORM_DB = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => stmt(sql, values) }),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  } as unknown as D1Database;
  const sent: SentMail[] = [];
  const emailMode: Fixture["emailMode"] = { mode: "ok" };
  const EMAIL = {
    send: async (m: SentMail) => {
      sent.push(m);
      if (emailMode.mode === "throw") throw new Error("upstream timeout");
    },
  } as unknown as SendEmail;
  const r2 = new Map<string, unknown>();
  const NEMAIL_R2 = { put: async (k: string, v: unknown) => { r2.set(k, v); }, get: async (k: string) => r2.get(k) ?? null, delete: async (k: string) => { r2.delete(k); } } as unknown as R2Bucket;
  const env: Env = { PLATFORM_DB, NEMAIL_R2, EMAIL, PLATFORM_SECRET: SECRET, NEMAIL_WEBHOOK_KEY: WEBHOOK_KEY, NAELAO_EMAIL_ENABLED: "true", NAELAO_EMAIL_DOMAINS: "mail.naelao.test", ...over };
  return { db, env, sent, emailMode };
}

export async function seedTenant(f: Fixture, tenantId: string, scopes: string[] = ALL_SCOPES): Promise<string> {
  const key = generateApiKey();
  f.db.prepare("INSERT INTO nemail_tenants(id, created_at) VALUES(?, datetime('now', '-20 days'))").run(tenantId);
  f.db.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json) VALUES(?,?,?,?,?)")
    .run(`k_${tenantId}`, tenantId, await sha256Hex(key), keyPrefix(key), JSON.stringify(scopes));
  return key;
}

export const call = (f: Fixture, method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://email.test${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : null,
  }), f.env as never);

let sendCounter = 0;
export const sendMail = (f: Fixture, key: string, inboxId: string, body: unknown) =>
  call(f, "POST", `/v1/inboxes/${inboxId}/messages/send`, key, body, { "idempotency-key": `send-${++sendCounter}` });

export async function createInbox(f: Fixture, key: string, localPart: string): Promise<string> {
  const res = await call(f, "POST", "/v1/inboxes", key, { local_part: localPart });
  return ((await res.json()) as { data: { id: string } }).data.id;
}

export async function createWebhook(f: Fixture, key: string, url: string, eventTypes: string[]) {
  return call(f, "POST", "/v1/webhooks", key, { url, event_types: eventTypes });
}

/** Records every outbound request made through the injected fetch and answers with the scripted status. */
export interface FakeCall { url: string; body: string; headers: Record<string, string>; signal: AbortSignal | undefined }
export function fakeFetch(respond: (call: FakeCall, index: number) => Response | Promise<Response> = () => new Response("ok", { status: 200 })) {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: FakeCall = { url: String(input), body: String(init?.body ?? ""), headers, signal: init?.signal ?? undefined };
    calls.push(c);
    return respond(c, calls.length - 1);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
