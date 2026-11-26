import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import app from "./index.js";
import { ensureAgentPortOrgLink, linkedOrgId } from "./org-link.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
function fixture(flag?: string) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE orgs(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,plan_tier TEXT NOT NULL DEFAULT 'free',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
    CREATE TABLE agentport_organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_developer_id TEXT NOT NULL,status TEXT,created_at TEXT,updated_at TEXT,org_id TEXT REFERENCES orgs(id));
    CREATE UNIQUE INDEX idx_apo ON agentport_organizations(org_id) WHERE org_id IS NOT NULL;
    CREATE TABLE agentport_developers(id TEXT PRIMARY KEY,tenant_id TEXT,email TEXT,email_normalized TEXT UNIQUE,password_hash TEXT,role TEXT,status TEXT,token_version INTEGER,last_login_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE agentport_auth_rate_limits(bucket_key TEXT PRIMARY KEY,window_started_ms INTEGER,attempts INTEGER,updated_at TEXT);`);
  const stmt = (sql: string, values: unknown[]) => ({
    sql, values,
    first: async <T>() => db.prepare(sql).get(...values as never[]) as T | undefined,
    run: async () => { const r = db.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  const PLATFORM_DB = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => stmt(sql, values) }),
    batch: async (statements: Array<ReturnType<typeof stmt>>) => {
      db.exec("BEGIN");
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  } as unknown as D1Database;
  const env = { PLATFORM_DB, PLATFORM_SECRET: "s".repeat(32), AGENTPORT_JWT_SECRET: "jwt-secret-for-org-link", ENVIRONMENT: "test", AGENTPORT_ISSUER: "https://agentport.test", ...(flag ? { AGENTPORT_ORG_LINK_ENABLED: flag } : {}) };
  return { db, env, PLATFORM_DB };
}
async function register(env: object, email = "owner@example.test") {
  const res = await app.fetch(new Request("https://agentport.test/v1/auth/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.9" }, body: JSON.stringify({ email, password: "a-secure-passphrase", org_name: "Acme" }) }), env as never);
  return { status: res.status, body: await res.json() as { data?: { organization: { id: string }; user: { id: string } } } };
}

describe("AgentPort organization to orgs link (OD-7, flag AGENTPORT_ORG_LINK_ENABLED)", () => {
  it("flag on: create produces exactly one linked free orgs row owned by the AgentPort owner", async () => {
    const { db, env } = fixture("true");
    const { status, body } = await register(env);
    expect(status).toBe(201);
    const tenantId = body.data!.organization.id;
    const orgs = db.prepare("SELECT * FROM orgs").all() as Array<Record<string, string>>;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ id: linkedOrgId(tenantId), plan_tier: "free", status: "active", owner_id: body.data!.user.id, name: "Acme" });
    expect(db.prepare("SELECT org_id FROM agentport_organizations WHERE id=?").get(tenantId)).toEqual({ org_id: linkedOrgId(tenantId) });
  });
  it("flag on: registering the same email again is refused and creates no second orgs row", async () => {
    const { db, env } = fixture("true");
    await register(env);
    expect((await register(env)).status).toBe(409);
    expect(db.prepare("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
  });
  it("flag off or absent: no orgs row and no link, exactly the previous behavior", async () => {
    for (const flag of [undefined, "false"]) {
      const { db, env } = fixture(flag);
      db.exec("DROP INDEX idx_apo; ALTER TABLE agentport_organizations DROP COLUMN org_id; DROP TABLE orgs;"); // schema without the migration still works
      const { status, body } = await register(env);
      expect(status).toBe(201);
      expect(db.prepare("SELECT id FROM agentport_organizations WHERE id=?").get(body.data!.organization.id)).toBeTruthy();
    }
  });
  it("ensureAgentPortOrgLink is idempotent on replay and leaves an existing link untouched", async () => {
    const { db, PLATFORM_DB } = fixture();
    db.exec("INSERT INTO agentport_organizations(id,name,owner_developer_id,status,created_at,updated_at) VALUES('t1','Old','dev1','active','x','x')");
    const first = await ensureAgentPortOrgLink(PLATFORM_DB, "t1", "2026-01-01");
    expect(first).toEqual({ ok: true, orgId: linkedOrgId("t1"), created: true });
    const again = await ensureAgentPortOrgLink(PLATFORM_DB, "t1", "2027-01-01");
    expect(again).toEqual({ ok: true, orgId: linkedOrgId("t1"), created: false });
    expect(db.prepare("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT created_at FROM orgs").get()).toEqual({ created_at: "2026-01-01" });
    // a pre-existing, different link is never re-pointed
    db.exec("INSERT INTO orgs VALUES('other','Other','dev9','free','active','x'); INSERT INTO agentport_organizations(id,name,owner_developer_id,status,created_at,updated_at,org_id) VALUES('t2','T2','dev2','active','x','x','other')");
    expect(await ensureAgentPortOrgLink(PLATFORM_DB, "t2", "2026-01-01")).toEqual({ ok: true, orgId: "other", created: false });
    expect(db.prepare("SELECT org_id FROM agentport_organizations WHERE id='t2'").get()).toEqual({ org_id: "other" });
    expect(db.prepare("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 2 });
  });
  it("refuses to link to an orgs row owned by another tenant or owner, writing nothing", async () => {
    const { db, PLATFORM_DB } = fixture();
    db.exec(`INSERT INTO orgs VALUES('${linkedOrgId("t3")}','Victim','someone-else','pro','active','x');
      INSERT INTO agentport_organizations(id,name,owner_developer_id,status,created_at,updated_at) VALUES('t3','T3','dev3','active','x','x')`);
    expect(await ensureAgentPortOrgLink(PLATFORM_DB, "t3", "now")).toEqual({ ok: false, error_code: "org_link_conflict" });
    expect(db.prepare("SELECT org_id FROM agentport_organizations WHERE id='t3'").get()).toEqual({ org_id: null });
    expect(db.prepare("SELECT plan_tier,owner_id FROM orgs").get()).toEqual({ plan_tier: "pro", owner_id: "someone-else" });
    expect(await ensureAgentPortOrgLink(PLATFORM_DB, "missing", "now")).toEqual({ ok: false, error_code: "agentport_org_unavailable" });
  });
  it("the unique index refuses two AgentPort organizations linking the same orgs row", () => {
    const { db } = fixture();
    db.exec(`INSERT INTO orgs VALUES('o1','O','d','free','active','x');
      INSERT INTO agentport_organizations(id,name,owner_developer_id,org_id) VALUES('a','A','d','o1')`);
    expect(() => db.exec("INSERT INTO agentport_organizations(id,name,owner_developer_id,org_id) VALUES('b','B','d2','o1')")).toThrow();
  });
});
