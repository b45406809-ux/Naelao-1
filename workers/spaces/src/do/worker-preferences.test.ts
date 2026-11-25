import { describe, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import spacesWorker from "../index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "./SpaceDO.js";

async function setup() {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, { PLATFORM_SECRET: "wp-test" } as never);
  await space.fetch(new Request("http://space/"));
  storage.sql.exec("INSERT INTO spaces(id,name,space_type,depth) VALUES('space','Test','business',0)");
  storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('p1','space','P1','active')");
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await space.fetch(new Request(`http://space${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    return { status: res.status, json: await res.json() as any };
  };
  const auditCount = () => (storage.sql.exec("SELECT COUNT(*) AS n FROM worker_preference_audit").toArray()[0] as { n: number }).n;
  return { storage, call, auditCount };
}

describe("worker preference limits (DO)", () => {
  it("admin sets and reads Space limits and a Project override, one audit row each", async () => {
    const { call, auditCount } = await setup();
    expect((await call("/worker-preference-limits")).json.limits).toBeNull();
    const put = await call("/worker-preference-limits?actor_id=admin-1", "PUT", { max_workers: 5, allowed_model_tiers: ["economy", "standard", "economy"], goal_credit_ceiling: 500 });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ scope: "space", changed: true, limits: { max_workers: 5, allowed_model_tiers: ["economy", "standard"], goal_credit_ceiling: 500, updated_by: "admin-1" } });
    expect(auditCount()).toBe(1);
    const proj = await call("/worker-preference-limits?project_id=p1&actor_id=admin-1", "PUT", { max_workers: 2 });
    expect(proj.json).toMatchObject({ scope: "project", project_id: "p1", limits: { max_workers: 2, allowed_model_tiers: null } });
    expect((await call("/worker-preference-limits")).json.limits.max_workers).toBe(5);
    expect(auditCount()).toBe(2);
    const audit = (await call("/worker-preference-audit")).json.entries;
    expect(audit.map((e: any) => e.scope).sort()).toEqual(["project_limits:p1", "space_limits"]);
    const spaceEntry = audit.find((e: any) => e.scope === "space_limits");
    expect(spaceEntry).toMatchObject({ actor_id: "admin-1", before: null, after: { max_workers: 5 } });
  });

  it("a no-op PUT writes no audit row and a change records before and after", async () => {
    const { call, auditCount } = await setup();
    await call("/worker-preference-limits?actor_id=a", "PUT", { max_workers: 4 });
    expect((await call("/worker-preference-limits?actor_id=a", "PUT", { max_workers: 4 })).json.changed).toBe(false);
    expect((await call("/worker-preference-limits?actor_id=b", "PUT", {})).json.changed).toBe(true); // clears
    expect((await call("/worker-preference-limits?actor_id=b", "PUT", {})).json.changed).toBe(false);
    expect(auditCount()).toBe(2);
    const entries = (await call("/worker-preference-audit")).json.entries;
    expect(entries[0]).toMatchObject({ actor_id: "b", before: { max_workers: 4 }, after: null });
  });

  it("rejects values outside the bounds and unknown fields without writing", async () => {
    const { call, auditCount } = await setup();
    const bad: unknown[] = [{ max_workers: 0 }, { max_workers: 11 }, { max_workers: 2.5 }, { max_workers: "3" },
      { goal_credit_ceiling: 0 }, { goal_credit_ceiling: 10_000_001 }, { goal_credit_ceiling: -5 }, { goal_credit_ceiling: 1.5 },
      { allowed_model_tiers: [] }, { allowed_model_tiers: [""] }, { allowed_model_tiers: ["  "] }, { allowed_model_tiers: [1] },
      { allowed_model_tiers: Array.from({ length: 11 }, (_, i) => `t${i}`) }, { allowed_model_tiers: ["x".repeat(65)] },
      { allowed_model_tiers: "economy" }, { surprise: 1 }, [], null];
    for (const body of bad) expect((await call("/worker-preference-limits?actor_id=a", "PUT", body)).status).toBe(400);
    expect((await call("/worker-preference-limits?actor_id=a", "PUT", { max_workers: 10, goal_credit_ceiling: 10_000_000, allowed_model_tiers: ["x".repeat(64)] })).status).toBe(200);
    expect(auditCount()).toBe(1);
  });

  it("unknown Project is not found", async () => {
    const { call } = await setup();
    expect((await call("/worker-preference-limits?project_id=nope", "GET")).status).toBe(404);
    expect((await call("/worker-preference-limits?project_id=nope&actor_id=a", "PUT", { max_workers: 1 })).status).toBe(404);
  });
});

describe("worker user preferences (DO)", () => {
  it("each user edits only their own row and every change is audited once", async () => {
    const { call, auditCount, storage } = await setup();
    expect((await call("/worker-user-preferences?user_id=u1", "PUT", { worker_count: 4, preferred_model_tier: "standard", goal_credit_ceiling: 100 })).json)
      .toMatchObject({ changed: true, preferences: { worker_count: 4, preferred_model_tier: "standard", goal_credit_ceiling: 100 } });
    expect((await call("/worker-user-preferences?user_id=u2")).json.preferences).toBeNull();
    await call("/worker-user-preferences?user_id=u2", "PUT", { worker_count: 1 });
    expect((await call("/worker-user-preferences?user_id=u1")).json.preferences.worker_count).toBe(4);
    expect((await call("/worker-user-preferences?user_id=u1", "PUT", { worker_count: 4, preferred_model_tier: "standard", goal_credit_ceiling: 100 })).json.changed).toBe(false);
    expect(auditCount()).toBe(2);
    expect(storage.sql.exec("SELECT actor_id,scope FROM worker_preference_audit ORDER BY scope").toArray()).toEqual([
      { actor_id: "u1", scope: "user_preferences:u1" }, { actor_id: "u2", scope: "user_preferences:u2" }]);
  });

  it("rejects out-of-bound values and a missing user", async () => {
    const { call, auditCount } = await setup();
    for (const body of [{ worker_count: 0 }, { worker_count: 11 }, { worker_count: 1.5 }, { preferred_model_tier: "" }, { preferred_model_tier: "y".repeat(65) },
      { preferred_model_tier: 3 }, { goal_credit_ceiling: 0 }, { goal_credit_ceiling: 10_000_001 }, { user_id: "other" }])
      expect((await call("/worker-user-preferences?user_id=u1", "PUT", body)).status).toBe(400);
    expect((await call("/worker-user-preferences", "GET")).status).toBe(404);
    expect(auditCount()).toBe(0);
  });
});

describe("worker preference routes (Worker)", () => {
  const secret = "wp-route-secret";
  const build = (members: Array<{ user_id: string; role: string }> = [], endUserRole = "member") => {
    const calls: string[] = [];
    const stub = { fetch: vi.fn(async (r: Request) => { const u = new URL(r.url); calls.push(`${r.method} ${u.pathname}${u.search}`);
      if (u.pathname.endsWith("/members")) return Response.json({ data: members });
      return Response.json({ ok: true }); }) };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: secret,
      PLATFORM_DB: { prepare: () => { const s: { bind: () => unknown; first: () => Promise<unknown> } = { bind: () => s, first: async () => ({ found: 1, role: endUserRole }) }; return s; } },
      SPACE_DO: { idFromName: (n: string) => n as never, get: () => stub } } as never;
    return { calls, env };
  };
  const send = async (env: never, path: string, role: string, method = "GET", body: unknown = { max_workers: 2 }, userId = "u1") =>
    spacesWorker.fetch(new Request(`https://spaces.test/spaces/space-a/${path}`, {
      method, headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": userId, "x-naelao-role": role,
        "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
      ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) }), env);

  it("limits: owner and admin pass; member and viewer get the not-found shape and never reach the Space", async () => {
    const { calls, env } = build();
    expect((await send(env, "worker-preference-limits", "owner", "PUT")).status).toBe(200);
    expect((await send(env, "worker-preference-limits", "admin")).status).toBe(200);
    expect(calls[0]).toBe("PUT /worker-preference-limits?project_id=&actor_id=u1");
    const before = calls.length;
    for (const role of ["member", "viewer"]) for (const method of ["GET", "PUT"]) {
      const res = await send(env, "worker-preference-limits", role, method);
      expect(res.status).toBe(404);
    }
    expect(calls.length).toBe(before);
  });

  it("limits: a Project owner member may manage that Project override only, never Space limits", async () => {
    const { calls, env } = build([{ user_id: "u1", role: "owner" }, { user_id: "u2", role: "member" }]);
    expect((await send(env, "worker-preference-limits?project_id=p1", "member", "PUT")).status).toBe(200);
    expect(calls.some(c => c.startsWith("PUT /worker-preference-limits?project_id=p1&actor_id=u1"))).toBe(true);
    expect((await send(env, "worker-preference-limits", "member", "PUT")).status).toBe(404);
    expect((await send(env, "worker-preference-limits?project_id=p1", "member", "PUT", { max_workers: 1 }, "u2")).status).toBe(404);
  });

  it("limits: a product end user resolves their live Space role", async () => {
    expect((await send(build([], "admin").env, "worker-preference-limits", "product_end_user")).status).toBe(200);
    expect((await send(build([], "member").env, "worker-preference-limits", "product_end_user")).status).toBe(404);
  });

  it("user preferences: any member, always the caller's own id even if the client sends another", async () => {
    const { calls, env } = build();
    for (const role of ["owner", "admin", "member", "viewer"]) expect((await send(env, "worker-user-preferences?user_id=victim", role, "PUT", { worker_count: 2 })).status).toBe(200);
    expect(calls.every(c => c.endsWith("?user_id=u1"))).toBe(true);
    expect((await send(build([], "viewer").env, "worker-user-preferences", "product_end_user")).status).toBe(200);
  });

  it("user preferences and audit: no identity, unknown role or non-owner/admin get not-found; audit forwards for admin", async () => {
    const { calls, env } = build();
    expect((await send(env, "worker-user-preferences", "stranger")).status).toBe(404);
    expect((await send(env, "worker-user-preferences", "owner", "GET", {}, "")).status).toBe(404);
    for (const role of ["member", "viewer"]) expect((await send(env, "worker-preference-audit", role)).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect((await send(env, "worker-preference-audit?limit=5", "admin")).status).toBe(200);
    expect(calls[0]).toBe("GET /worker-preference-audit?limit=5");
  });

  it("requires the internal token", async () => {
    const { env } = build();
    const res = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/worker-user-preferences", { headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "u1", "x-naelao-role": "owner" } }), env);
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
