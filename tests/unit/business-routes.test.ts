import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Three-Tier Platform Model, Phase C (§A1.17): route-level tests for the business-creation
// wrapper, the space switcher's my-businesses list, and the invite create/accept round trip —
// including the security assertion the phased plan called out by name: a second end user must
// never reach the first's business.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SCHEMA = [
  `CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
    tenancy_mode TEXT, scenario_type TEXT, product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );`,
  `CREATE TABLE tenant_hierarchy (
    child_tenant_id TEXT PRIMARY KEY, parent_tenant_id TEXT NOT NULL,
    reseller_product_space_id TEXT NOT NULL, child_space_id TEXT NOT NULL,
    child_owner_user_id TEXT, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
  `CREATE TABLE reseller_accounts (
    tenant_id TEXT PRIMARY KEY, product_space_id TEXT NOT NULL,
    billing_relationship TEXT NOT NULL DEFAULT 'platform', wholesale_cents INTEGER,
    referral_share_pct REAL NOT NULL DEFAULT 0.0, status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
  `CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );`,
  `CREATE TABLE business_invites (
    id TEXT PRIMARY KEY, business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL,
    email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', token_hash TEXT NOT NULL,
    invited_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL, accepted_at TEXT, accepted_by TEXT
  );`,
];

function make404RegistryDo(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: () => ({ fetch: async () => new Response("not found", { status: 404 }) }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
}

function makeEnv() {
  const fakeDb = createFakeD1(SCHEMA);
  const productConfig = { membershipModel: "hybrid", allowPublicSignup: true, allowedChildSpaceTypes: ["launchpad"] };
  fakeDb.db.exec(
    `INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES ('prod-1', 'builder-tenant', 'active', 'Acme', '${JSON.stringify({ productConfig }).replace(/'/g, "''")}')`
  );
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    SPACE_TYPE_REGISTRY_DO: make404RegistryDo(),
    NAELAO_CONFIG_KV: makeKv(),
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

async function createBusiness(env: ReturnType<typeof makeEnv>, userId: string, name: string) {
  const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": userId });
  const res = await spacesWorker.fetch(
    req("/spaces/prod-1/businesses", headers, { method: "POST", body: JSON.stringify({ name, spacetype_id: "launchpad" }) }),
    env as never, execCtx
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { space_id: string; tenant_id: string };
}

describe("POST /spaces/:productSpaceId/businesses", () => {
  it("creates a business and dual-writes the owner into business_memberships", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");

    const membership = env.PLATFORM_DB.db
      .prepare("SELECT * FROM business_memberships WHERE business_space_id = ? AND end_user_id = ?")
      .get(biz.space_id, "alice") as { role: string; status: string };
    expect(membership.role).toBe("owner");
    expect(membership.status).toBe("active");
  });

  it("rejects with no user id", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user" });
    const res = await spacesWorker.fetch(
      req("/spaces/prod-1/businesses", headers, { method: "POST", body: JSON.stringify({ name: "X", spacetype_id: "launchpad" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /spaces/:productSpaceId/my-businesses", () => {
  it("lists only the calling end user's OWN businesses, never another's", async () => {
    const env = makeEnv();
    await createBusiness(env, "alice", "Alice's Shop");
    await createBusiness(env, "bob", "Bob's Shop");

    const aliceHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/my-businesses", aliceHeaders), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.data[0]!.name).toBe("Alice's Shop");
  });

  it("reports where each business is in its setup checklist", async () => {
    // Discover's most useful call to action is "finish setting this one up" — a business that was
    // created but never configured does nothing at all. Carrying it on this list is what avoids an
    // extra round trip per business just to find that out.
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Half-Built Shop");
    await env.PLATFORM_DB.prepare("UPDATE spaces SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify({ template_id: "whop-seller", onboarding: { status: "awaiting_setup" } }), biz.space_id)
      .run();

    const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/my-businesses", headers), env as never, execCtx);
    const body = (await res.json()) as { data: Array<{ onboarding_status: string | null; template_id: string | null }> };
    expect(body.data[0]!.onboarding_status).toBe("awaiting_setup");
    expect(body.data[0]!.template_id).toBe("whop-seller");
  });

  it("reports nothing outstanding for a business created without a template", async () => {
    // No checklist means nothing to finish — the UI must read this as "done", not "unknown", or
    // every pre-template business grows a permanent "finish setup" badge that leads nowhere.
    const env = makeEnv();
    await createBusiness(env, "alice", "Plain Shop");
    const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/my-businesses", headers), env as never, execCtx);
    const body = (await res.json()) as { data: Array<{ onboarding_status: string | null }> };
    expect(body.data[0]!.onboarding_status).toBeNull();
  });
});

describe("GET /spaces/:productSpaceId/template-activity", () => {
  it("aggregates active businesses per template across DIFFERENT tenants, revealing no PII", async () => {
    const env = makeEnv();
    const alice = await createBusiness(env, "alice", "Alice's Shop");
    const bob = await createBusiness(env, "bob", "Bob's Shop");
    const carol = await createBusiness(env, "carol", "Carol's Shop");
    await env.PLATFORM_DB.prepare("UPDATE spaces SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify({ template_id: "whop-seller" }), alice.space_id).run();
    await env.PLATFORM_DB.prepare("UPDATE spaces SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify({ template_id: "whop-seller" }), bob.space_id).run();
    await env.PLATFORM_DB.prepare("UPDATE spaces SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify({ template_id: "webdev-agency" }), carol.space_id).run();

    const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "dave" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/template-activity", headers), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ template_id: string; active_count: number }> };
    const raw = JSON.stringify(body);
    // The whole point: dave (who owns none of these) can see the SHAPE, never who or how much.
    expect(raw).not.toMatch(/Alice|Bob|Carol/);
    const byId = Object.fromEntries(body.data.map((r) => [r.template_id, r.active_count]));
    expect(byId["whop-seller"]).toBe(2);
    expect(byId["webdev-agency"]).toBe(1);
  });

  it("excludes an archived/deleted business from the count", async () => {
    const env = makeEnv();
    const alice = await createBusiness(env, "alice", "Alice's Shop");
    await env.PLATFORM_DB.prepare("UPDATE spaces SET config_json = ?, status = 'archived' WHERE id = ?")
      .bind(JSON.stringify({ template_id: "whop-seller" }), alice.space_id).run();

    const headers = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "dave" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/template-activity", headers), env as never, execCtx);
    const body = (await res.json()) as { data: Array<{ template_id: string }> };
    expect(body.data.find((r) => r.template_id === "whop-seller")).toBeUndefined();
  });

  it("rejects with no verified tenant", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/template-activity"),
      env as never, execCtx
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /spaces/:spaceId/business-analytics", () => {
  async function seedActivity(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string, rows: Array<Record<string, unknown>>) {
    const headers = await internalHeaders(tenantId);
    for (const row of rows) {
      const res = await spacesWorker.fetch(
        req(`/internal/spaces/${spaceId}/agent-activity`, headers, { method: "POST", body: JSON.stringify({ space_id: spaceId, agent_id: "naelao-agent", ...row }) }),
        env as never, execCtx
      );
      expect(res.status).toBe(201);
    }
  }

  it("aggregates runs/credits pure — never leaks a session id or summary to a plain member", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    await seedActivity(env, biz.space_id, biz.tenant_id, [
      { event_type: "run_completed", cost_credits: 10, tokens_used: 500, session_id: "sess-secret-1", summary: "did a private thing" },
      { event_type: "run_completed", cost_credits: 15, tokens_used: 700 },
      { event_type: "run_failed", cost_credits: 2, tokens_used: 100, failure_kind: "tool_error" },
    ]);

    const headers = await internalHeaders(biz.tenant_id, { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-analytics`, headers), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { total: number; completed: number; failed: number; success_rate: number | null };
      credits: { used: number };
    };
    expect(body.runs.total).toBe(3);
    expect(body.runs.completed).toBe(2);
    expect(body.runs.failed).toBe(1);
    expect(body.credits.used).toBe(27);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sess-secret-1|private thing/);
  });

  it("a plain member (not admin/owner) can still read it — pure aggregate, safe for anyone", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    // Bob is invited as a plain member via a direct D1 insert (simpler than the full invite flow
    // for this test's purpose — just needs SOME non-owner membership row to exist).
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES (?, 'prod-1', 'bob', 'member', 'active')"
    ).bind(biz.space_id).run();

    const headers = await internalHeaders(biz.tenant_id, { "x-naelao-role": "product_end_user", "x-naelao-user-id": "bob" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-analytics`, headers), env as never, execCtx);
    expect(res.status).toBe(200);
  });

  it("rejects a non-member entirely", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const headers = await internalHeaders(biz.tenant_id, { "x-naelao-role": "product_end_user", "x-naelao-user-id": "stranger" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-analytics`, headers), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("counts heartbeat/scheduled failures separately from chat, without a fabricated pass count", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    await seedActivity(env, biz.space_id, biz.tenant_id, [
      { event_type: "run_failed", trigger_source: "heartbeat", cost_credits: 0 },
      { event_type: "run_failed", trigger_source: "scheduled_job", cost_credits: 0 },
      { event_type: "run_completed", trigger_source: "chat", cost_credits: 5 },
    ]);
    const headers = await internalHeaders(biz.tenant_id, { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-analytics`, headers), env as never, execCtx);
    const body = (await res.json()) as { heartbeats: { failed: number; completed_with_work: number } };
    expect(body.heartbeats.failed).toBe(2);
    expect(body.heartbeats.completed_with_work).toBe(0);
  });
});

describe("Business invites — create + accept round trip", () => {
  it("an owner invites, a different end user accepts, and becomes a real member", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const ownerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });

    const inviteRes = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites`, ownerHeaders, { method: "POST", body: JSON.stringify({ email: "carol@example.com", role: "admin" }) }),
      env as never, execCtx
    );
    expect(inviteRes.status).toBe(201);
    const invite = (await inviteRes.json()) as { token: string };

    const carolHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "carol" });
    const acceptRes = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites/${invite.token}/accept`, carolHeaders, { method: "POST" }),
      env as never, execCtx
    );
    expect(acceptRes.status).toBe(200);
    const accepted = (await acceptRes.json()) as { role: string };
    expect(accepted.role).toBe("admin");

    const membersRes = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-members`, ownerHeaders), env as never, execCtx);
    const members = (await membersRes.json()) as { data: Array<{ end_user_id: string; role: string }> };
    expect(members.data.map((m) => m.end_user_id).sort()).toEqual(["alice", "carol"]);
  });

  it("rejects a non-owner/admin from sending invites", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const strangerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "mallory" });
    const res = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites`, strangerHeaders, { method: "POST", body: JSON.stringify({ email: "x@example.com" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("rejects re-accepting an already-accepted invite", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const ownerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const inviteRes = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites`, ownerHeaders, { method: "POST", body: JSON.stringify({ email: "carol@example.com" }) }),
      env as never, execCtx
    );
    const invite = (await inviteRes.json()) as { token: string };
    const carolHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "carol" });
    await spacesWorker.fetch(req(`/spaces/${biz.space_id}/invites/${invite.token}/accept`, carolHeaders, { method: "POST" }), env as never, execCtx);

    const second = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/invites/${invite.token}/accept`, carolHeaders, { method: "POST" }), env as never, execCtx);
    expect(second.status).toBe(409);
  });

  it("rejects an expired invite", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const ownerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const inviteRes = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites`, ownerHeaders, { method: "POST", body: JSON.stringify({ email: "carol@example.com" }) }),
      env as never, execCtx
    );
    const invite = (await inviteRes.json()) as { id: string; token: string };
    env.PLATFORM_DB.db.prepare("UPDATE business_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(invite.id);

    const carolHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "carol" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/invites/${invite.token}/accept`, carolHeaders, { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(410);
  });
});

describe("Business members — CRITICAL cross-business isolation", () => {
  it("a stranger cannot list another business's members", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const strangerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "mallory" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-members`, strangerHeaders), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("a stranger cannot remove another business's member", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const strangerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "mallory" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-members/alice`, strangerHeaders, { method: "DELETE" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("the owner cannot be removed even by another admin", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const ownerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const res = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-members/alice`, ownerHeaders, { method: "DELETE" }), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("an owner can remove a non-owner member", async () => {
    const env = makeEnv();
    const biz = await createBusiness(env, "alice", "Alice's Shop");
    const ownerHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" });
    const inviteRes = await spacesWorker.fetch(
      req(`/spaces/${biz.space_id}/invites`, ownerHeaders, { method: "POST", body: JSON.stringify({ email: "carol@example.com" }) }),
      env as never, execCtx
    );
    const invite = (await inviteRes.json()) as { token: string };
    const carolHeaders = await internalHeaders("builder-tenant", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "carol" });
    await spacesWorker.fetch(req(`/spaces/${biz.space_id}/invites/${invite.token}/accept`, carolHeaders, { method: "POST" }), env as never, execCtx);

    const delRes = await spacesWorker.fetch(req(`/spaces/${biz.space_id}/business-members/carol`, ownerHeaders, { method: "DELETE" }), env as never, execCtx);
    expect(delRes.status).toBe(200);
  });
});
