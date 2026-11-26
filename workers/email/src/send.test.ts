import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import app, { type Env } from "./index.js";
import { generateApiKey, sha256Hex, keyPrefix } from "./keys.js";
import { evaluateAutoPause } from "./feedback.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../../../infra/migrations/${n}`, import.meta.url)), "utf8");
const SECRET = "s".repeat(32);
const ALL = ["inboxes:read", "inboxes:write", "messages:read", "messages:send", "usage:read"];

interface Sent { from: string; to: string; raw: string }
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  for (const m of ["0294_naelao_email_core.sql", "0295_naelao_email_inbound.sql", "0296_naelao_email_outbound.sql", "0297_naelao_email_webhooks.sql"]) db.exec(mig(m));
  const stmt = (sql: string, values: unknown[]) => ({
    sql,
    first: async <T>() => db.prepare(sql).get(...(values as never[])) as T | undefined,
    all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => { const r = db.prepare(sql).run(...(values as never[])); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  const PLATFORM_DB = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => stmt(sql, values) }),
    batch: async (stmts: Array<ReturnType<typeof stmt>>) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  } as unknown as D1Database;
  const r2 = new Map<string, unknown>();
  const sent: Sent[] = [];
  const behavior = { mode: "ok" as "ok" | "throw" };
  const EMAIL = { send: async (m: Sent) => { sent.push(m); if (behavior.mode === "throw") throw new Error("upstream timeout"); } } as unknown as SendEmail;
  const NEMAIL_R2 = { put: async (k: string, v: unknown) => { r2.set(k, v); }, get: async (k: string) => r2.get(k) ?? null, delete: async (k: string) => { r2.delete(k); } } as unknown as R2Bucket;
  const env: Env = { PLATFORM_DB, NEMAIL_R2, EMAIL, PLATFORM_SECRET: SECRET, NAELAO_EMAIL_ENABLED: "true", NAELAO_EMAIL_DOMAINS: "mail.naelao.test" };
  return { db, env, sent, behavior, r2 };
}
type F = ReturnType<typeof fixture>;

async function seed(f: F, tenant: string, scopes = ALL, createdDaysAgo = 20) {
  const key = generateApiKey();
  f.db.prepare("INSERT INTO nemail_tenants(id,created_at) VALUES(?, datetime('now', ?))").run(tenant, `-${createdDaysAgo} days`);
  f.db.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json) VALUES(?,?,?,?,?)").run(`k_${tenant}_${scopes.length}`, tenant, await sha256Hex(key), keyPrefix(key), JSON.stringify(scopes));
  const inboxId = `inb_${tenant}`;
  f.db.prepare("INSERT INTO nemail_inboxes(id,nemail_tenant_id,domain,local_part,address,display_name) VALUES(?,?,?,?,?,?)").run(inboxId, tenant, "mail.naelao.test", "bot", `bot-${tenant}@mail.naelao.test`, "Bot");
  return { key, inboxId };
}
let n = 0;
const call = (f: F, method: string, path: string, key: string | undefined, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://email.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : null }), f.env as never);
const send = (f: F, key: string, inboxId: string, body: unknown, idem: string | null = `k${++n}`) =>
  call(f, "POST", `/v1/inboxes/${inboxId}/messages/send`, key, body, idem === null ? {} : { "idempotency-key": idem });
const ok = { to: ["bob@example.com"], subject: "Hi", text: "hello" };
const code = async (r: Response) => (await r.json() as { error_code?: string }).error_code;
const one = <T>(f: F, sql: string, ...v: unknown[]) => f.db.prepare(sql).get(...(v as never[])) as T;
const all = <T>(f: F, sql: string, ...v: unknown[]) => f.db.prepare(sql).all(...(v as never[])) as T[];

function seedDeliveries(f: F, tenant: string, inboxId: string, count: number, statuses: Record<number, string> = {}, createdAt = "datetime('now')") {
  f.db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const mid = `seed_${tenant}_${i}_${Math.random().toString(36).slice(2)}`;
    f.db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,message_id_header) VALUES(?,?,?, 'outbound', ?)").run(mid, tenant, inboxId, `${mid}@mail.naelao.test`);
    f.db.prepare(`INSERT INTO nemail_deliveries(id,nemail_tenant_id,inbox_id,message_id,recipient,status,created_at) VALUES(?,?,?,?,?,?,${createdAt})`).run(`d_${mid}`, tenant, inboxId, mid, `r${i}@example.com`, statuses[i] ?? "sent");
  }
  f.db.exec("COMMIT");
}

describe("Naelao Email outbound (MS-33)", () => {
  it("checks run in MR-EM-4 order with distinct error codes", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const ro = await seed(f, "t2", ["messages:read"]);
    // 1. scope, then 401 for no key
    const r1 = await send(f, ro.key, ro.inboxId, ok);
    expect([r1.status, await code(r1)]).toEqual([403, "insufficient_scope"]);
    expect((await send(f, "nem_" + "x".repeat(43), inboxId, ok)).status).toBe(401);
    // Idempotency-Key is required
    const noKey = await send(f, key, inboxId, ok, null);
    expect([noKey.status, await code(noKey)]).toEqual([400, "idempotency_key_required"]);
    // inbox status: unknown inbox 404, suspended -> inbox_unavailable (before suppression)
    expect((await send(f, key, "inb_nope", ok)).status).toBe(404);
    f.db.prepare("INSERT INTO nemail_suppressions(id,nemail_tenant_id,address,reason) VALUES('s1','t1','bob@example.com','manual')").run();
    f.db.prepare("UPDATE nemail_inboxes SET status='suspended' WHERE id=?").run(inboxId);
    expect(await code(await send(f, key, inboxId, ok))).toBe("inbox_unavailable");
    f.db.prepare("UPDATE nemail_inboxes SET status='active' WHERE id=?").run(inboxId);
    // 2. suppression before recipient count: 51 recipients including a suppressed one -> recipient_suppressed
    const many = Array.from({ length: 50 }, (_, i) => `u${i}@example.com`);
    const sup = await send(f, key, inboxId, { ...ok, to: [...many, "bob@example.com"] });
    expect([sup.status, await code(sup)]).toEqual([422, "recipient_suppressed"]);
    // 3. count (suppression cleared) before rate limit
    f.db.prepare("DELETE FROM nemail_suppressions").run();
    f.db.prepare("UPDATE nemail_tenants SET daily_send_limit_override=0 WHERE id='t1'").run();
    const cnt = await send(f, key, inboxId, { ...ok, to: [...many, "extra@example.com"] });
    expect([cnt.status, await code(cnt)]).toEqual([422, "too_many_recipients"]);
    // 4. rate limit
    const rl = await send(f, key, inboxId, ok);
    expect([rl.status, await code(rl)]).toEqual([429, "rate_limit_exceeded"]);
    // paused (tenant) is part of the status step
    f.db.prepare("UPDATE nemail_tenants SET sending_paused=1, daily_send_limit_override=NULL WHERE id='t1'").run();
    expect(await code(await send(f, key, inboxId, ok))).toBe("sending_paused");
    expect(f.sent).toHaveLength(0);
    // pre-send rejections do not consume the Idempotency-Key
    f.db.prepare("UPDATE nemail_tenants SET sending_paused=0 WHERE id='t1'").run();
    expect((await send(f, key, inboxId, ok, "reuse")).status).toBe(201);
    expect(await code(await send(f, key, inboxId, { to: [] }))).toBe("invalid_request");
  });

  it("sends via the binding, stores the message and delivery, records usage, and threads replies", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const res = await send(f, key, inboxId, { to: ["bob@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "Héllo", text: "hi", html: "<b>hi</b>" });
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: { message_id: string; thread_id: string; status: string; deliveries: Array<{ recipient: string; status: string }> } };
    expect(data.status).toBe("sent");
    expect(f.sent.map(s => s.to).sort()).toEqual(["bob@example.com", "cc@example.com", "hidden@example.com"]);
    const raw = f.sent[0]!.raw;
    expect(raw).toContain("From: \"Bot\" <bot-t1@mail.naelao.test>");
    expect(raw).toContain("To: bob@example.com");
    expect(raw).not.toMatch(/hidden@example\.com/);
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(one<{ direction: string; state: string; size_bytes: number }>(f, "SELECT * FROM nemail_messages WHERE id=?", data.message_id)).toMatchObject({ direction: "outbound", state: "stored" });
    expect(all<{ status: string }>(f, "SELECT status FROM nemail_deliveries").every(d => d.status === "sent")).toBe(true);
    expect(one<{ n: number }>(f, "SELECT count(*) n FROM nemail_usage WHERE message_id=? AND outcome='sent'", data.message_id).n).toBe(1);
    expect(f.r2.size).toBe(1);

    const hdr = one<{ message_id_header: string }>(f, "SELECT message_id_header FROM nemail_messages WHERE id=?", data.message_id).message_id_header;
    const reply = await send(f, key, inboxId, { ...ok, subject: "Re: Hi", in_reply_to_message_id: data.message_id });
    const rd = (await reply.json() as { data: { thread_id: string } }).data;
    expect(rd.thread_id).toBe(data.thread_id);
    const last = f.sent[f.sent.length - 1]!.raw;
    expect(last).toContain(`In-Reply-To: <${hdr}>`);
    expect(last).toContain(`References: <${hdr}>`);
    expect(await code(await send(f, key, inboxId, { ...ok, in_reply_to_message_id: "msg_missing" }))).toBe("message_not_found");
    // readable through the read API
    const msgs = await (await call(f, "GET", `/v1/inboxes/${inboxId}/messages`, key)).json() as { data: Array<{ direction: string }> };
    expect(msgs.data.filter(m => m.direction === "outbound")).toHaveLength(2);
  });

  it("cross-tenant send is not-found", async () => {
    const f = fixture();
    const a = await seed(f, "t1");
    const b = await seed(f, "t2");
    const res = await send(f, b.key, a.inboxId, ok);
    expect(res.status).toBe(404);
    expect(f.sent).toHaveLength(0);
  });

  it("daily limit: 100/day for the first 14 days, 1000/day from day 15, operator override wins", async () => {
    const f = fixture();
    const young = await seed(f, "young", ALL, 5);
    seedDeliveries(f, "young", young.inboxId, 99);
    expect((await send(f, young.key, young.inboxId, ok)).status).toBe(201); // 100th
    const over = await send(f, young.key, young.inboxId, ok);
    expect([over.status, await code(over)]).toEqual([429, "rate_limit_exceeded"]);
    // an operator override raises it
    f.db.prepare("UPDATE nemail_tenants SET daily_send_limit_override=150 WHERE id='young'").run();
    expect((await send(f, young.key, young.inboxId, ok)).status).toBe(201);

    const old = await seed(f, "old", ALL, 15); // day 15: the new-tenant window has ended
    seedDeliveries(f, "old", old.inboxId, 100);
    expect((await send(f, old.key, old.inboxId, ok)).status).toBe(201); // would have been blocked on day 14
    seedDeliveries(f, "old", old.inboxId, 898);
    expect((await send(f, old.key, old.inboxId, ok)).status).toBe(201); // 1000th
    expect(await code(await send(f, old.key, old.inboxId, ok))).toBe("rate_limit_exceeded");
    // messages older than 24h and failed deliveries do not count
    f.db.prepare("UPDATE nemail_deliveries SET created_at=datetime('now','-25 hours') WHERE nemail_tenant_id='old'").run();
    expect((await send(f, old.key, old.inboxId, ok)).status).toBe(201);
  });

  it("idempotent replay sends once; a different body with the same key is 422", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const a = await send(f, key, inboxId, ok, "same");
    const b = await send(f, key, inboxId, ok, "same");
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect(f.sent).toHaveLength(1);
    const c = await send(f, key, inboxId, { ...ok, text: "other" }, "same");
    expect([c.status, await code(c)]).toEqual([422, "idempotency_key_reuse"]);
    expect(f.sent).toHaveLength(1);
    expect(one<{ n: number }>(f, "SELECT count(*) n FROM nemail_usage").n).toBe(1);
  });

  it("transport errors: thrown during invocation is unknown (usage, never retried); before invocation is failed (no usage)", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    f.behavior.mode = "throw";
    const res = await send(f, key, inboxId, ok, "amb");
    expect(res.status).toBe(201);
    expect((await res.json() as { data: { status: string } }).data.status).toBe("unknown");
    expect(one<{ status: string; error_code: string }>(f, "SELECT status,error_code FROM nemail_deliveries")).toMatchObject({ status: "unknown", error_code: "transport_outcome_unknown" });
    expect(one<{ outcome: string }>(f, "SELECT outcome FROM nemail_usage").outcome).toBe("unknown");
    f.behavior.mode = "ok";
    const replay = await send(f, key, inboxId, ok, "amb");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(f.sent).toHaveLength(1); // never retried blindly

    // no binding: nothing was invoked
    const g = fixture();
    const t = await seed(g, "t9");
    delete (g.env as { EMAIL?: unknown }).EMAIL;
    const failed = await send(g, t.key, t.inboxId, ok);
    expect(failed.status).toBe(502);
    expect(one<{ status: string }>(g, "SELECT status FROM nemail_deliveries").status).toBe("failed");
    expect(one<{ n: number }>(g, "SELECT count(*) n FROM nemail_usage").n).toBe(0);
    // failed deliveries do not count towards the daily limit
    expect(one<{ n: number }>(g, "SELECT count(DISTINCT message_id) n FROM nemail_deliveries WHERE status != 'failed'").n).toBe(0);
  });

  it("drafts: create, edit, send once, then immutable", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const created = await call(f, "POST", `/v1/inboxes/${inboxId}/drafts`, key, { to: ["bob@example.com"], subject: "Draft" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { data: { id: string } }).data.id;
    // incomplete draft cannot be sent
    expect(await code(await call(f, "POST", `/v1/drafts/${id}/send`, key, undefined, { "idempotency-key": "d0" }))).toBe("invalid_request");
    const patched = await call(f, "PATCH", `/v1/drafts/${id}`, key, { text: "Body v2", cc: ["c@example.com"] });
    expect(await patched.json()).toMatchObject({ data: { subject: "Draft", text: "Body v2", cc: ["c@example.com"], status: "draft" } });
    expect(await code(await call(f, "POST", `/v1/drafts/${id}/send`, key))).toBe("idempotency_key_required");
    const sentRes = await call(f, "POST", `/v1/drafts/${id}/send`, key, undefined, { "idempotency-key": "d1" });
    expect(sentRes.status).toBe(201);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]!.raw).toContain("Subject: Draft");
    const replay = await call(f, "POST", `/v1/drafts/${id}/send`, key, undefined, { "idempotency-key": "d1" });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(f.sent).toHaveLength(2);
    expect(await code(await call(f, "POST", `/v1/drafts/${id}/send`, key, undefined, { "idempotency-key": "d2" }))).toBe("draft_already_sent");
    expect(await code(await call(f, "PATCH", `/v1/drafts/${id}`, key, { text: "late" }))).toBe("draft_not_editable");
    const got = await call(f, "GET", `/v1/drafts/${id}`, key);
    expect(await got.json()).toMatchObject({ data: { status: "sent" } });
    // other tenants cannot see it
    const other = await seed(f, "t2");
    expect((await call(f, "GET", `/v1/drafts/${id}`, other.key)).status).toBe(404);
    expect((await call(f, "PATCH", `/v1/drafts/${id}`, other.key, { text: "x" })).status).toBe(404);
  });

  it("a draft whose send is rejected (suppressed) stays a draft and is not claimed", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    f.db.prepare("INSERT INTO nemail_suppressions(id,nemail_tenant_id,address,reason) VALUES('s1','t1','bob@example.com','manual')").run();
    const id = (await (await call(f, "POST", `/v1/inboxes/${inboxId}/drafts`, key, { ...ok })).json() as { data: { id: string } }).data.id;
    expect(await code(await call(f, "POST", `/v1/drafts/${id}/send`, key, undefined, { "idempotency-key": "x" }))).toBe("recipient_suppressed");
    expect(one<{ status: string }>(f, "SELECT status FROM nemail_drafts WHERE id=?", id).status).toBe("draft");
  });

  it("GET /v1/usage returns sent count and storage bytes for the period", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    await send(f, key, inboxId, ok); await send(f, key, inboxId, ok);
    f.behavior.mode = "throw"; await send(f, key, inboxId, ok); // unknown also counts
    f.db.prepare("INSERT INTO nemail_messages(id,nemail_tenant_id,inbox_id,direction,size_bytes,received_at) VALUES('in1','t1',?, 'inbound', 1000, datetime('now'))").run(inboxId);
    f.db.prepare("INSERT INTO nemail_attachments(id,nemail_tenant_id,message_id,size_bytes) VALUES('a1','t1','in1',400)").run();
    const period = new Date().toISOString().slice(0, 7);
    const u = await (await call(f, "GET", `/v1/usage?period=${period}`, key)).json() as { data: { period: string; sent_count: number; storage_bytes: number } };
    const outboundBytes = one<{ n: number }>(f, "SELECT sum(size_bytes) n FROM nemail_messages WHERE direction='outbound'").n;
    expect(u.data).toMatchObject({ period, sent_count: 3, storage_bytes: 1400 + outboundBytes });
    const empty = await (await call(f, "GET", "/v1/usage?period=2020-01", key)).json() as { data: { sent_count: number; storage_bytes: number } };
    expect(empty.data).toMatchObject({ sent_count: 0, storage_bytes: 0 });
    expect((await call(f, "GET", "/v1/usage?period=2020-13", key)).status).toBe(400);
    const noScope = await seed(f, "t2", ["messages:send"]);
    expect(await code(await call(f, "GET", "/v1/usage", noScope.key))).toBe("insufficient_scope");
    // another tenant sees only its own numbers
    const t3 = await seed(f, "t3");
    expect((await (await call(f, "GET", `/v1/usage?period=${period}`, t3.key)).json() as { data: { sent_count: number } }).data.sent_count).toBe(0);
  });
});

// ---- bounces, complaints, auto-pause ----
function dsn(originalId: string, recipient: string, status = "5.1.1", action = "failed") {
  return [
    "From: MAILER-DAEMON@example.com", "To: bot-t1@mail.naelao.test", "Subject: Undelivered Mail Returned to Sender", "Message-ID: <dsn1@example.com>", "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="BND"', "",
    "--BND", "Content-Type: text/plain", "", "Delivery failed.", "",
    "--BND", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; example.com", "",
    `Final-Recipient: rfc822; ${recipient}`, `Action: ${action}`, `Status: ${status}`, "",
    "--BND", "Content-Type: message/rfc822", "", `Message-ID: <${originalId}>`, "Subject: Hi", "", "original body", "", "--BND--", "",
  ].join("\r\n");
}
function arf(originalId: string, recipient: string | null, type = "abuse") {
  return [
    "From: fbl@isp.example", "To: bot-t1@mail.naelao.test", "Subject: complaint", "Message-ID: <arf1@isp.example>", "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="ARF"', "",
    "--ARF", "Content-Type: text/plain", "", "This is an abuse report.", "",
    "--ARF", "Content-Type: message/feedback-report", "", "Feedback-Type: " + type, "User-Agent: test/1.0", "Version: 1", ...(recipient ? [`Original-Rcpt-To: <${recipient}>`] : []), "",
    "--ARF", "Content-Type: message/rfc822", "", `Message-ID: <${originalId}>`, "Subject: Hi", "", "orig", "", "--ARF--", "",
  ].join("\r\n");
}
function deliverMail(f: F, raw: string, to: string) {
  const bytes = new TextEncoder().encode(raw);
  const msg = { from: "x@example.com", to, rawSize: bytes.byteLength, raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }), headers: new Headers(), setReject: () => {} } as unknown as ForwardableEmailMessage;
  return (app as unknown as { email: (m: ForwardableEmailMessage, e: Env) => Promise<void> }).email(msg, f.env);
}
async function sentHeaderId(f: F, key: string, inboxId: string, to: string[]) {
  const r = await send(f, key, inboxId, { ...ok, to });
  const d = (await r.json() as { data: { message_id: string } }).data;
  return one<{ message_id_header: string }>(f, "SELECT message_id_header FROM nemail_messages WHERE id=?", d.message_id).message_id_header;
}

describe("Naelao Email bounces, complaints and auto-pause (MS-33)", () => {
  it("a hard-bounce DSN marks the delivery bounced and suppresses the recipient per tenant; soft bounces are ignored", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const hid = await sentHeaderId(f, key, inboxId, ["bob@example.com", "carol@example.com"]);
    await deliverMail(f, dsn(hid, "bob@example.com", "4.2.2", "delayed"), "bot-t1@mail.naelao.test");
    expect(all(f, "SELECT * FROM nemail_suppressions")).toHaveLength(0);
    await deliverMail(f, dsn(hid, "bob@example.com"), "bot-t1@mail.naelao.test");
    await deliverMail(f, dsn(hid, "bob@example.com"), "bot-t1@mail.naelao.test"); // redelivery is idempotent
    expect(all<{ recipient: string; status: string }>(f, "SELECT recipient,status FROM nemail_deliveries ORDER BY recipient")).toEqual([{ recipient: "bob@example.com", status: "bounced" }, { recipient: "carol@example.com", status: "sent" }]);
    expect(all(f, "SELECT * FROM nemail_suppressions")).toMatchObject([{ nemail_tenant_id: "t1", address: "bob@example.com", reason: "hard_bounce" }]);
    expect(await code(await send(f, key, inboxId, ok))).toBe("recipient_suppressed");
    // suppression is per tenant
    const t2 = await seed(f, "t2");
    expect((await send(f, t2.key, t2.inboxId, ok)).status).toBe(201);
  });

  it("an ARF complaint suppresses with reason complaint; not-spam is ignored", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    const hid = await sentHeaderId(f, key, inboxId, ["bob@example.com"]);
    await deliverMail(f, arf(hid, "bob@example.com", "not-spam"), "bot-t1@mail.naelao.test");
    expect(all(f, "SELECT * FROM nemail_suppressions")).toHaveLength(0);
    await deliverMail(f, arf(hid, null), "bot-t1@mail.naelao.test"); // no recipient: every recipient of that message
    expect(all(f, "SELECT address,reason FROM nemail_suppressions")).toEqual([{ address: "bob@example.com", reason: "complaint" }]);
    expect(one<{ status: string }>(f, "SELECT status FROM nemail_deliveries").status).toBe("complained");
  });

  it("forged reports are ignored: unknown Message-ID, recipient not on the message, or another tenant's message", async () => {
    const f = fixture();
    const a = await seed(f, "t1");
    await seed(f, "t2");
    const hid = await sentHeaderId(f, a.key, a.inboxId, ["bob@example.com"]);
    await deliverMail(f, dsn("nope@mail.naelao.test", "bob@example.com"), "bot-t1@mail.naelao.test");
    await deliverMail(f, dsn(hid, "victim@example.com"), "bot-t1@mail.naelao.test");
    await deliverMail(f, dsn(hid, "bob@example.com"), "bot-t2@mail.naelao.test"); // t2's inbox reporting on t1's message
    expect(all(f, "SELECT * FROM nemail_suppressions")).toHaveLength(0);
  });

  it("reports sent to the configured bounce address are applied; others to that address do nothing", async () => {
    const f = fixture();
    f.env.NAELAO_EMAIL_BOUNCE_ADDRESS = "bounces@mail.naelao.test";
    const { key, inboxId } = await seed(f, "t1");
    const hid = await sentHeaderId(f, key, inboxId, ["bob@example.com"]);
    await deliverMail(f, "Subject: hello\r\n\r\nplain", "bounces@mail.naelao.test");
    expect(all(f, "SELECT * FROM nemail_suppressions")).toHaveLength(0);
    await deliverMail(f, dsn(hid, "bob@example.com"), "bounces@mail.naelao.test");
    expect(all(f, "SELECT * FROM nemail_suppressions")).toHaveLength(1);
    expect(all(f, "SELECT * FROM nemail_messages WHERE direction='inbound'")).toHaveLength(0);
  });

  it("auto-pause: bounce >5% or complaint >0.3% over 7 days with a minimum sample of 50", async () => {
    const f = fixture();
    const { inboxId } = await seed(f, "t1");
    // below the minimum sample: even 100% bounces do not pause
    seedDeliveries(f, "t1", inboxId, 49, Object.fromEntries(Array.from({ length: 49 }, (_, i) => [i, "bounced"])));
    expect(await evaluateAutoPause(f.env.PLATFORM_DB, "t1")).toBe(false);
    // 50 sends, 2 bounces = 4%: fine
    seedDeliveries(f, "t1", inboxId, 1, {}, "datetime('now')");
    f.db.prepare("UPDATE nemail_deliveries SET status='sent'").run();
    f.db.prepare("UPDATE nemail_deliveries SET status='bounced' WHERE id IN (SELECT id FROM nemail_deliveries LIMIT 2)").run();
    expect(await evaluateAutoPause(f.env.PLATFORM_DB, "t1")).toBe(false);
    // a third bounce: 3/50 = 6% > 5%: pause
    f.db.prepare("UPDATE nemail_deliveries SET status='bounced' WHERE id IN (SELECT id FROM nemail_deliveries WHERE status='sent' LIMIT 1)").run();
    expect(await evaluateAutoPause(f.env.PLATFORM_DB, "t1")).toBe(true);
    expect(one<{ sending_paused: number; sending_paused_reason: string }>(f, "SELECT * FROM nemail_tenants")).toMatchObject({ sending_paused: 1, sending_paused_reason: "bounce_rate" });

    const g = fixture();
    const t = await seed(g, "t1");
    seedDeliveries(g, "t1", t.inboxId, 50, { 0: "complained" });
    expect(await evaluateAutoPause(g.env.PLATFORM_DB, "t1")).toBe(true); // 1/50 = 2% > 0.3%
    expect(one<{ sending_paused_reason: string }>(g, "SELECT * FROM nemail_tenants").sending_paused_reason).toBe("complaint_rate");

    // old deliveries (>7 days) are outside the window
    const h = fixture();
    const u = await seed(h, "t1");
    seedDeliveries(h, "t1", u.inboxId, 60, { 0: "bounced", 1: "bounced", 2: "bounced", 3: "bounced" }, "datetime('now','-8 days')");
    expect(await evaluateAutoPause(h.env.PLATFORM_DB, "t1")).toBe(false);
  });

  it("a bounce report that crosses the threshold pauses sending; the operator route clears it and resets the sample", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    seedDeliveries(f, "t1", inboxId, 49, { 0: "bounced", 1: "bounced" });
    const hid = await sentHeaderId(f, key, inboxId, ["bob@example.com"]); // 50th send; 2/50 = 4%
    expect((await send(f, key, inboxId, ok)).status).toBe(201);
    await deliverMail(f, dsn(hid, "bob@example.com"), "bot-t1@mail.naelao.test"); // 3/51 = 5.9%
    expect(one<{ sending_paused: number }>(f, "SELECT sending_paused FROM nemail_tenants").sending_paused).toBe(1);
    const paused = await send(f, key, inboxId, { ...ok, to: ["new@example.com"] });
    expect([paused.status, await code(paused)]).toEqual([403, "sending_paused"]);

    const internal = async (tenant: string, body: unknown, tokenTenant = tenant) =>
      call(f, "POST", "/internal/v1/tenants/sending", undefined, body, { "x-naelao-tenant-id": tenant, "x-naelao-internal-token": await mintInternalToken(SECRET, tokenTenant) });
    expect((await internal("t1", { paused: false }, "other")).status).toBe(403);
    expect((await call(f, "POST", "/internal/v1/tenants/sending", key, { paused: false })).status).toBe(403); // an API key is not an operator
    const cleared = await internal("t1", { paused: false, daily_send_limit_override: 5000 });
    expect(await cleared.json()).toMatchObject({ data: { sending_paused: false, daily_send_limit_override: 5000 } });
    expect((await send(f, key, inboxId, { ...ok, to: ["new@example.com"] })).status).toBe(201);
    // the old bounces no longer count after the resume, so a fresh evaluation does not re-pause
    f.db.prepare("UPDATE nemail_tenants SET sending_resumed_at=datetime('now','+1 minute')").run();
    expect(await evaluateAutoPause(f.env.PLATFORM_DB, "t1")).toBe(false);
    expect((await internal("t1", { paused: "x" })).status).toBe(400);
    expect((await internal("nope", { paused: true })).status).toBe(404);
  });

  it("flag off: send routes are 404", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1");
    f.env.NAELAO_EMAIL_ENABLED = "false";
    expect((await send(f, key, inboxId, ok)).status).toBe(404);
    expect((await call(f, "GET", "/v1/usage", key)).status).toBe(404);
    expect(f.sent).toHaveLength(0);
  });
});
