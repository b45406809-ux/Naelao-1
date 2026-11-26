import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mintInternalToken } from "@naelao/http";
import app, { type Env } from "./index.js";
import { generateApiKey, sha256Hex, keyPrefix } from "./keys.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const MIGRATION = readFileSync(fileURLToPath(new URL("../../../infra/migrations/0294_naelao_email_core.sql", import.meta.url)), "utf8");
const MIGRATION_2 = readFileSync(fileURLToPath(new URL("../../../infra/migrations/0295_naelao_email_inbound.sql", import.meta.url)), "utf8");
const SECRET = "s".repeat(32);

function fixture(over: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
  db.exec(MIGRATION);
  db.exec(MIGRATION_2);
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
  const env: Env = { PLATFORM_DB, PLATFORM_SECRET: SECRET, NAELAO_EMAIL_ENABLED: "true", NAELAO_EMAIL_DOMAINS: "mail.naelao.test", ...over };
  return { db, env };
}
async function seedTenant(f: ReturnType<typeof fixture>, tenantId: string, scopes: string[] = ["inboxes:read", "inboxes:write"]) {
  const key = generateApiKey();
  f.db.prepare("INSERT INTO nemail_tenants(id) VALUES(?)").run(tenantId);
  f.db.prepare("INSERT INTO nemail_api_keys(id,nemail_tenant_id,key_hash,key_prefix,scopes_json) VALUES(?,?,?,?,?)").run(`k_${tenantId}_${scopes.length}`, tenantId, await sha256Hex(key), keyPrefix(key), JSON.stringify(scopes));
  return key;
}
const call = (f: ReturnType<typeof fixture>, method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://email.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : null }), f.env as never);

describe("Naelao Email scaffold (MS-31)", () => {
  it("flag off or absent: every route is 404 not_found", async () => {
    for (const flag of [undefined, "false"]) {
      const f = fixture(flag === undefined ? { NAELAO_EMAIL_ENABLED: undefined as never } : { NAELAO_EMAIL_ENABLED: flag });
      const key = await seedTenant(f, "t1");
      for (const [m, p] of [["GET", "/v1/inboxes"], ["POST", "/v1/inboxes"], ["GET", "/health"], ["POST", "/internal/v1/tenants"], ["GET", "/nope"]] as const) {
        const res = await call(f, m, p, key, m === "POST" ? {} : undefined);
        expect(res.status).toBe(404);
        expect((await res.json() as { error_code: string }).error_code).toBe("not_found");
      }
    }
  });

  it("stores only the SHA-256 hash and an 8-char prefix; plaintext key is shown once", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO orgs(id) VALUES('org-1')").run();
    const token = await mintInternalToken(SECRET, "tenant-a");
    const res = await call(f, "POST", "/internal/v1/tenants", undefined, { org_id: "org-1", name: "Acme" }, { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token });
    expect(res.status).toBe(201);
    const { data } = await res.json() as { data: { api_key: string; key_prefix: string } };
    expect(data.api_key).toMatch(/^nem_[A-Za-z0-9_-]{43}$/);
    const row = f.db.prepare("SELECT * FROM nemail_api_keys").get() as Record<string, string>;
    expect(row.key_hash).toBe(await sha256Hex(data.api_key));
    expect(row.key_prefix).toBe(data.api_key.slice(0, 8));
    expect(JSON.stringify(f.db.prepare("SELECT * FROM nemail_api_keys").all())).not.toContain(data.api_key);
    expect(f.db.prepare("SELECT org_id FROM nemail_tenants WHERE id='tenant-a'").get()).toEqual({ org_id: "org-1" });
    expect((await call(f, "GET", "/v1/inboxes", data.api_key)).status).toBe(200);
    expect((await call(f, "POST", "/internal/v1/tenants", undefined, {}, { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(SECRET, "tenant-a") })).status).toBe(409);
  });

  it("internal tenant route rejects a bad or missing HMAC", async () => {
    const f = fixture();
    expect((await call(f, "POST", "/internal/v1/tenants", undefined, {})).status).toBe(403);
    const bad = await mintInternalToken("w".repeat(32), "tenant-a");
    expect((await call(f, "POST", "/internal/v1/tenants", undefined, {}, { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": bad })).status).toBe(403);
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_tenants").get()).toEqual({ n: 0 });
  });

  it("missing, malformed, unknown, revoked and expired keys are 401", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    expect((await call(f, "GET", "/v1/inboxes")).status).toBe(401);
    expect((await call(f, "GET", "/v1/inboxes", "nem_short")).status).toBe(401);
    expect((await call(f, "GET", "/v1/inboxes", generateApiKey())).status).toBe(401);
    f.db.prepare("UPDATE nemail_api_keys SET expires_at='2000-01-01T00:00:00Z'").run();
    expect((await call(f, "GET", "/v1/inboxes", key)).status).toBe(401);
    f.db.prepare("UPDATE nemail_api_keys SET expires_at=NULL, revoked_at=datetime('now')").run();
    expect((await call(f, "GET", "/v1/inboxes", key)).status).toBe(401);
  });

  it("enforces scopes", async () => {
    const f = fixture();
    const readOnly = await seedTenant(f, "t1", ["inboxes:read"]);
    const res = await call(f, "POST", "/v1/inboxes", readOnly, {});
    expect(res.status).toBe(403);
    expect((await res.json() as { error_code: string }).error_code).toBe("insufficient_scope");
    const sendOnly = await seedTenant(f, "t2", ["messages:send"]);
    expect((await call(f, "GET", "/v1/inboxes", sendOnly)).status).toBe(403);
  });

  it("create/list/get/delete an inbox; deleted inbox is not found", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const created = await call(f, "POST", "/v1/inboxes", key, { local_part: "agent.one", display_name: "Agent" });
    expect(created.status).toBe(201);
    const inbox = (await created.json() as { data: { id: string; address: string } }).data;
    expect(inbox.address).toBe("agent.one@mail.naelao.test");
    expect((await call(f, "POST", "/v1/inboxes", key, { local_part: "agent.one" })).status).toBe(409);
    expect(((await (await call(f, "GET", "/v1/inboxes", key)).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await call(f, "GET", `/v1/inboxes/${inbox.id}`, key)).status).toBe(200);
    expect((await call(f, "DELETE", `/v1/inboxes/${inbox.id}`, key)).status).toBe(200);
    expect((await call(f, "GET", `/v1/inboxes/${inbox.id}`, key)).status).toBe(404);
    expect((await call(f, "DELETE", `/v1/inboxes/${inbox.id}`, key)).status).toBe(404);
    expect((await call(f, "POST", "/v1/inboxes", key, { local_part: "agent.one" })).status).toBe(201); // address released
  });

  it("cross-tenant read and delete return the not-found shape and change nothing", async () => {
    const f = fixture();
    const a = await seedTenant(f, "ta"), b = await seedTenant(f, "tb");
    const id = ((await (await call(f, "POST", "/v1/inboxes", a, {})).json()) as { data: { id: string } }).data.id;
    const missing = await call(f, "GET", "/v1/inboxes/inb_does-not-exist", b);
    const cross = await call(f, "GET", `/v1/inboxes/${id}`, b);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json());
    const del = await call(f, "DELETE", `/v1/inboxes/${id}`, b);
    expect(del.status).toBe(404);
    expect(((await (await call(f, "GET", "/v1/inboxes", b)).json()) as { data: unknown[] }).data).toHaveLength(0);
    expect((await call(f, "GET", `/v1/inboxes/${id}`, a)).status).toBe(200);
  });

  it("idempotent create replays once; reuse with a different body is 422", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const h = { "idempotency-key": "create-1" };
    const first = await call(f, "POST", "/v1/inboxes", key, { local_part: "dup" }, h);
    const second = await call(f, "POST", "/v1/inboxes", key, { local_part: "dup" }, h);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(f.db.prepare("SELECT count(*) AS n FROM nemail_inboxes").get()).toEqual({ n: 1 });
    expect((await call(f, "POST", "/v1/inboxes", key, { local_part: "other" }, h)).status).toBe(422);
    // same key from another tenant is independent
    const other = await seedTenant(f, "t2");
    expect((await call(f, "POST", "/v1/inboxes", other, { local_part: "dup-b" }, h)).status).toBe(201);
  });

  it("idempotent delete replays the original response", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const id = ((await (await call(f, "POST", "/v1/inboxes", key, {})).json()) as { data: { id: string } }).data.id;
    const h = { "idempotency-key": "del-1" };
    expect((await call(f, "DELETE", `/v1/inboxes/${id}`, key, undefined, h)).status).toBe(200);
    const replay = await call(f, "DELETE", `/v1/inboxes/${id}`, key, undefined, h);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  it("limits a tenant to 10 active inboxes; deleting frees a slot", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await call(f, "POST", "/v1/inboxes", key, {});
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { data: { id: string } }).data.id);
    }
    const over = await call(f, "POST", "/v1/inboxes", key, {});
    expect(over.status).toBe(403);
    expect((await over.json() as { error_code: string }).error_code).toBe("inbox_limit_reached");
    await call(f, "DELETE", `/v1/inboxes/${ids[0]}`, key);
    expect((await call(f, "POST", "/v1/inboxes", key, {})).status).toBe(201);
    const other = await seedTenant(f, "t2");
    expect((await call(f, "POST", "/v1/inboxes", other, {})).status).toBe(201);
  });

  it("no configured domain is offering_unavailable; unlisted domain is refused", async () => {
    const empty = fixture({ NAELAO_EMAIL_DOMAINS: "" });
    const k1 = await seedTenant(empty, "t1");
    const r = await call(empty, "POST", "/v1/inboxes", k1, {});
    expect(r.status).toBe(503);
    expect((await r.json() as { error_code: string }).error_code).toBe("offering_unavailable");
    const f = fixture();
    const k2 = await seedTenant(f, "t1");
    expect((await call(f, "POST", "/v1/inboxes", k2, { domain: "evil.example.com" })).status).toBe(400);
  });

  it("validates inbox input", async () => {
    const f = fixture();
    const key = await seedTenant(f, "t1");
    for (const body of [{ local_part: "Bad Part" }, { local_part: "../x" }, { display_name: 5 }]) {
      expect((await call(f, "POST", "/v1/inboxes", key, body)).status).toBe(400);
    }
  });
});
