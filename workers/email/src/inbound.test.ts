import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import app, { type Env } from "./index.js";
import { generateApiKey, sha256Hex, keyPrefix } from "./keys.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../../../infra/migrations/${n}`, import.meta.url)), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  db.exec(mig("0294_naelao_email_core.sql"));
  db.exec(mig("0295_naelao_email_inbound.sql"));
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
  const store = new Map<string, Uint8Array>();
  const NEMAIL_R2 = {
    put: async (k: string, v: Uint8Array) => { store.set(k, new Uint8Array(v)); },
    get: async (k: string) => store.get(k) ?? null,
    delete: async (k: string) => { store.delete(k); },
  } as unknown as R2Bucket;
  const env: Env = { PLATFORM_DB, NEMAIL_R2, NAELAO_EMAIL_ENABLED: "true", NAELAO_EMAIL_DOMAINS: "mail.naelao.test" };
  return { db, env, store };
}
type F = ReturnType<typeof fixture>;

async function seed(f: F, tenant: string, inboxAddr: string, inboxId = `inb_${tenant}`) {
  const key = generateApiKey();
  f.db.prepare("INSERT INTO nemail_tenants(id) VALUES(?)").run(tenant);
  f.db.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json) VALUES(?,?,?,?,?)").run(`k_${tenant}`, tenant, await sha256Hex(key), keyPrefix(key), JSON.stringify(["messages:read", "inboxes:read"]));
  f.db.prepare("INSERT INTO nemail_inboxes(id,nemail_tenant_id,domain,local_part,address) VALUES(?,?,?,?,?)").run(inboxId, tenant, "mail.naelao.test", inboxAddr.split("@")[0], inboxAddr);
  return { key, inboxId };
}

function mime(o: { id?: string | null; inReplyTo?: string; refs?: string; subject?: string; html?: string; text?: string; atts?: Array<{ name: string; size: number }>; to?: string }) {
  const lines = ["From: Alice <alice@example.com>", `To: ${o.to ?? "bot@mail.naelao.test"}`, `Subject: ${o.subject ?? "Hello"}`];
  if (o.id !== null) lines.push(`Message-ID: <${o.id ?? "m1@example.com"}>`);
  if (o.inReplyTo) lines.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.refs) lines.push(`References: ${o.refs}`);
  lines.push("MIME-Version: 1.0");
  if (!o.atts && !o.html) return lines.join("\r\n") + `\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${o.text ?? "hi there"}\r\n`;
  lines.push('Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: multipart/alternative; boundary=\"A\"", "", "--A", "Content-Type: text/plain; charset=utf-8", "", o.text ?? "plain body", "--A");
  lines.push("Content-Type: text/html; charset=utf-8", "", o.html ?? "<p>x</p>", "--A--");
  for (const a of o.atts ?? []) lines.push("--B", `Content-Type: application/octet-stream; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.alloc(a.size, 1).toString("base64").replace(/(.{76})/g, "$1\r\n"));
  lines.push("--B--", "");
  return lines.join("\r\n");
}

function deliver(f: F, raw: string | Uint8Array, to = "bot@mail.naelao.test") {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const rejects: string[] = [];
  const msg = {
    from: "alice@example.com", to, rawSize: bytes.byteLength,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    headers: new Headers(), setReject: (r: string) => { rejects.push(r); },
  } as unknown as ForwardableEmailMessage;
  const p = (app as unknown as { email: (m: ForwardableEmailMessage, e: Env) => Promise<void> }).email(msg, f.env);
  return { done: p, rejects };
}
const get = (f: F, key: string, path: string) => app.fetch(new Request(`https://email.test${path}`, { headers: { authorization: `Bearer ${key}` } }), f.env as never);
const msgs = (f: F) => f.db.prepare("SELECT * FROM nemail_messages ORDER BY received_at, id").all() as Array<Record<string, unknown>>;

describe("Naelao Email inbound (MS-32)", () => {
  it("rejects an unknown recipient and a disabled worker without storing anything", async () => {
    const f = fixture();
    await seed(f, "t1", "bot@mail.naelao.test");
    const r = deliver(f, mime({ to: "nobody@mail.naelao.test" }), "nobody@mail.naelao.test"); await r.done;
    expect(r.rejects).toEqual(["Unknown recipient"]);
    expect(f.store.size).toBe(0);
    f.env.NAELAO_EMAIL_ENABLED = "false";
    const r2 = deliver(f, mime({})); await r2.done;
    expect(r2.rejects.length).toBe(1);
    expect(msgs(f)).toHaveLength(0);
  });

  it("stores raw MIME in R2 under raw/<tenant>/<inbox>/<sha>.eml and the parsed message", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1", "bot@mail.naelao.test");
    const raw = mime({ id: "a@x" });
    await deliver(f, raw).done;
    const sha = await sha256Of(new TextEncoder().encode(raw));
    expect(f.store.has(`raw/t1/${inboxId}/${sha}.eml`)).toBe(true);
    const [m] = msgs(f);
    expect(m).toMatchObject({ state: "parsed", message_id_header: "a@x", raw_sha256: sha, direction: "inbound" });
    const list = await (await get(f, key, `/v1/inboxes/${inboxId}/messages`)).json() as { data: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(list.data[0]).toMatchObject({ subject: "Hello", from: "alice@example.com", status: "parsed" });
    expect(list.next_cursor).toBeNull();
    const ev = f.db.prepare("SELECT * FROM nemail_events").all() as Array<Record<string, unknown>>;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "email.message.received", nemail_tenant_id: "t1", inbox_id: inboxId, message_id: m!.id, dispatched_at: null });
  });

  it("duplicate delivery (same Message-ID, or same raw when no Message-ID) is stored once", async () => {
    const f = fixture();
    await seed(f, "t1", "bot@mail.naelao.test");
    await deliver(f, mime({ id: "dup@x" })).done;
    await deliver(f, mime({ id: "dup@x", text: "different bytes" })).done;
    expect(msgs(f)).toHaveLength(1);
    const noId = mime({ id: null });
    await deliver(f, noId).done; await deliver(f, noId).done;
    expect(msgs(f)).toHaveLength(2);
    expect((f.db.prepare("SELECT count(*) n FROM nemail_events").get() as { n: number }).n).toBe(2);
  });

  it("threads replies by In-Reply-To and References within the inbox only", async () => {
    const f = fixture();
    const a = await seed(f, "t1", "bot@mail.naelao.test");
    const b = await seed(f, "t2", "other@mail.naelao.test");
    await deliver(f, mime({ id: "root@x", subject: "Topic" })).done;
    await deliver(f, mime({ id: "r1@x", inReplyTo: "root@x", subject: "Re: Topic" })).done;
    await deliver(f, mime({ id: "r2@x", refs: "<root@x> <r1@x>", subject: "Re: Re: Topic" })).done;
    // Same Message-ID chain referenced from another tenant's inbox must not join the first thread.
    await deliver(f, mime({ id: "x1@x", inReplyTo: "root@x", to: "other@mail.naelao.test" }), "other@mail.naelao.test").done;
    const rows = msgs(f);
    const t1 = rows.filter(r => r.nemail_tenant_id === "t1").map(r => r.thread_id);
    expect(new Set(t1).size).toBe(1);
    const other = rows.find(r => r.nemail_tenant_id === "t2")!;
    expect(other.thread_id).not.toBe(t1[0]);
    const threads = await (await get(f, a.key, `/v1/inboxes/${a.inboxId}/threads`)).json() as { data: Array<{ id: string }> };
    expect(threads.data).toHaveLength(1);
    const th = await (await get(f, a.key, `/v1/threads/${threads.data[0]!.id}`)).json() as { data: { messages: unknown[] } };
    expect(th.data.messages).toHaveLength(3);
    expect((await get(f, b.key, `/v1/threads/${threads.data[0]!.id}`)).status).toBe(404);
  });

  it("stores attachments in R2 with metadata, and enforces count and size limits", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1", "bot@mail.naelao.test");
    await deliver(f, mime({ id: "ok@x", atts: [{ name: "a.bin", size: 1000 }, { name: "b.bin", size: 2000 }] })).done;
    const atts = f.db.prepare("SELECT * FROM nemail_attachments ORDER BY size_bytes").all() as Array<Record<string, unknown>>;
    expect(atts.map(a => a.size_bytes)).toEqual([1000, 2000]);
    for (const a of atts) { expect(String(a.r2_key)).toMatch(/^att\/t1\/inb_t1\/msg_/); expect(f.store.has(String(a.r2_key))).toBe(true); }
    const id = (msgs(f)[0] as { id: string }).id;
    const detail = await (await get(f, key, `/v1/messages/${id}`)).json() as { data: { attachments: unknown[] } };
    expect(detail.data.attachments).toHaveLength(2);

    const many = deliver(f, mime({ id: "many@x", atts: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 10 })) })); await many.done;
    expect(many.rejects).toHaveLength(1);
    const big = deliver(f, mime({ id: "big@x", atts: [{ name: "big.bin", size: 10 * 1024 * 1024 + 1 }] })); await big.done;
    expect(big.rejects).toHaveLength(1);
    const codes = (f.db.prepare("SELECT message_id_header h, state, error_code FROM nemail_messages WHERE state='rejected' ORDER BY h").all() as Array<Record<string, string>>);
    expect(codes).toEqual([{ h: "big@x", state: "rejected", error_code: "attachment_too_large" }, { h: "many@x", state: "rejected", error_code: "too_many_attachments" }]);
    expect((f.db.prepare("SELECT count(*) n FROM nemail_attachments").get() as { n: number }).n).toBe(2);
    expect(await (await get(f, key, `/v1/inboxes/${inboxId}/messages`)).json()).toHaveProperty("data");
  });

  it("rejects a message over 20 MB and records it without storing raw", async () => {
    const f = fixture();
    await seed(f, "t1", "bot@mail.naelao.test");
    const r = deliver(f, new Uint8Array(20 * 1024 * 1024 + 1)); await r.done;
    expect(r.rejects).toHaveLength(1);
    expect(msgs(f)[0]).toMatchObject({ state: "rejected", error_code: "message_too_large", raw_r2_key: null });
    expect(f.store.size).toBe(0);
  });

  it("raw is stored before parsing; parse failure keeps raw, records parse_error and does not throw", async () => {
    const f = fixture();
    const { inboxId } = await seed(f, "t1", "bot@mail.naelao.test");
    const order: string[] = [];
    const realPut = (f.env.NEMAIL_R2 as unknown as { put: (...a: unknown[]) => Promise<void> }).put;
    (f.env.NEMAIL_R2 as unknown as { put: unknown }).put = async (...a: unknown[]) => { order.push("put"); return realPut(...a); };
    const PostalMime = (await import("postal-mime")).default;
    const orig = PostalMime.parse;
    PostalMime.parse = (async () => { order.push("parse"); throw new Error("boom"); }) as never;
    try {
      const r = deliver(f, mime({ id: "bad@x" }));
      await expect(r.done).resolves.toBeUndefined();
      expect(order).toEqual(["put", "parse"]);
      expect(r.rejects).toEqual([]);
      const [m] = msgs(f);
      expect(m).toMatchObject({ state: "parse_error", error_code: "parse_failed", message_id_header: null, inbox_id: inboxId });
      expect(f.store.has(String(m!.raw_r2_key))).toBe(true);
      await deliver(f, mime({ id: "bad@x" })).done; // identical redelivery dedupes by raw hash
      expect(msgs(f)).toHaveLength(1);
    } finally { PostalMime.parse = orig; }
  });

  it("returns HTML as an inert string marked untrusted, with locked-down headers", async () => {
    const f = fixture();
    const { key } = await seed(f, "t1", "bot@mail.naelao.test");
    const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    await deliver(f, mime({ id: "h@x", html })).done;
    const id = (msgs(f)[0] as { id: string }).id;
    const res = await get(f, key, `/v1/messages/${id}`);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const { data } = await res.json() as { data: { html: string; html_untrusted: boolean; text: string } };
    expect(data.html.trim()).toBe(html);
    expect(data.html_untrusted).toBe(true);
    expect(data.text.trim()).toBe("plain body");
    const list = await (await get(f, key, "/v1/inboxes/inb_t1/messages")).json() as { data: Array<Record<string, unknown>> };
    expect(list.data[0]).not.toHaveProperty("html");
  });

  it("cursor pagination: opaque cursor, limit capped at 100, stable order, no duplicates", async () => {
    const f = fixture();
    const { key, inboxId } = await seed(f, "t1", "bot@mail.naelao.test");
    for (let i = 0; i < 5; i++) await deliver(f, mime({ id: `p${i}@x` })).done;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await get(f, key, `/v1/inboxes/${inboxId}/messages?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      const body = await res.json() as { data: Array<{ id: string }>; next_cursor: string | null };
      seen.push(...body.data.map(d => d.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect((await get(f, key, `/v1/inboxes/${inboxId}/messages?limit=101`)).status).toBe(400);
    expect((await get(f, key, `/v1/inboxes/${inboxId}/messages?limit=0`)).status).toBe(400);
    expect((await get(f, key, `/v1/inboxes/${inboxId}/messages?cursor=garbage!`)).status).toBe(400);
  });

  it("cross-tenant reads and missing scope: not-found shape and 403", async () => {
    const f = fixture();
    const a = await seed(f, "t1", "bot@mail.naelao.test");
    const b = await seed(f, "t2", "other@mail.naelao.test");
    await deliver(f, mime({ id: "s@x" })).done;
    const id = (msgs(f)[0] as { id: string }).id;
    for (const p of [`/v1/messages/${id}`, `/v1/inboxes/${a.inboxId}/messages`, `/v1/inboxes/${a.inboxId}/threads`]) {
      const res = await get(f, b.key, p);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error_code: "not_found", message: "Not found." });
    }
    const noScope = generateApiKey();
    f.db.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json) VALUES('k3','t1',?,?,?)").run(await sha256Hex(noScope), keyPrefix(noScope), JSON.stringify(["inboxes:read"]));
    expect((await get(f, noScope, `/v1/messages/${id}`)).status).toBe(403);
    expect((await get(f, a.key, `/v1/messages/${id}`)).status).toBe(200);
    expect((await app.fetch(new Request(`https://email.test/v1/messages/${id}`), f.env as never)).status).toBe(401);
  });
});

async function sha256Of(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), b => b.toString(16).padStart(2, "0")).join("");
}
