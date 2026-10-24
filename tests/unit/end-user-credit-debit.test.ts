import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken } from "@naelao/http";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// §A1.17 Phase I: a signed-in product end user's non-project (Space Assistant / Home chat) run
// debits THEIR OWN ProductUserDO balance for real LLM usage — the sink existed
// (POST /credits/deduct on ProductUserDO, idempotent, fails closed) but nothing in the platform
// ever called it. This is the new spaces-worker wrapper NaelaoAgentDO.debitEndUserCredits calls.

const PLATFORM_SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT, parent_space_id TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
  };
}

async function seedProduct(env: ReturnType<typeof makeEnv>, id: string, tenantId: string) {
  await env.PLATFORM_DB.prepare("INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES (?, ?, 'active', 'Product', 'launchpad')")
    .bind(id, tenantId).run();
}

async function seedBusiness(env: ReturnType<typeof makeEnv>, id: string, tenantId: string, parentSpaceId: string) {
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, parent_space_id) VALUES (?, ?, 'active', 'Business', 'launchpad', ?)"
  ).bind(id, tenantId, parentSpaceId).run();
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function grantCredits(env: ReturnType<typeof makeEnv>, spaceId: string, endUserId: string, credits: number) {
  // Seed the actual DO directly; the old commerce-specific credit-pack route was removed.
  const stub=env.PRODUCT_USER_DO.get(env.PRODUCT_USER_DO.idFromName(await getDOName("produser",`${spaceId}:${endUserId}`,"tenant-1",PLATFORM_SECRET)));
  const response=await stub.fetch(new Request("https://user/credits/grant",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({credits,idempotency_key:`fixture:${crypto.randomUUID()}`})}));
  expect(response.status).toBe(201);
}

describe("POST /internal/product-users/:spaceId/:endUserId/credits/deduct", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/deduct", { method: "POST", body: JSON.stringify({ credits: 5 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("debits the end user's own ProductUserDO balance", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await grantCredits(env, "prod-1", "alice", 100);

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/deduct", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ credits: 30, reason: "agent_run", model: "claude-haiku-4-5-20251001" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { balance_credits: number };
    expect(body.balance_credits).toBe(70);
  });

  it("preserves the retry key through the route and charges a repeated run once", async () => {
    const env=makeEnv();await seedProduct(env,"prod-1","tenant-1");await grantCredits(env,"prod-1","alice",100);
    const headers={"x-naelao-tenant-id":"tenant-1","x-naelao-internal-token":await mintInternalToken(PLATFORM_SECRET,"tenant-1")};
    const responses=await Promise.all(Array.from({length:30},()=>spacesWorker.fetch(req("/internal/product-users/prod-1/alice/credits/deduct",{method:"POST",headers,body:JSON.stringify({credits:30,idempotency_key:"run:retry-regression"})}),env as never,execCtx)));
    const bodies=await Promise.all(responses.map(r=>r.json() as Promise<{balance_credits:number;deduplicated?:boolean}>));
    expect(bodies.every(b=>b.balance_credits===70)).toBe(true);
    expect(bodies.filter(b=>b.deduplicated)).toHaveLength(29);
  });
  it("does not let a valid signature for another tenant debit or reserve this tenant's credits", async () => {
    const env=makeEnv();await seedProduct(env,"prod-1","tenant-1");await grantCredits(env,"prod-1","alice",100);
    const headers={"x-naelao-tenant-id":"other-tenant","x-naelao-internal-token":await mintInternalToken(PLATFORM_SECRET,"other-tenant")};
    for(const [path,payload] of [["deduct",{credits:30,idempotency_key:"cross-tenant"}],["reservations",{action:"reserve",run_id:"r",reservation_id:"r:1",credits:30}]] as const){
      const response=await spacesWorker.fetch(req("/internal/product-users/prod-1/alice/credits/"+path,{method:"POST",headers,body:JSON.stringify(payload)}),env as never,execCtx);
      expect(response.status).toBe(403);
    }
  });
  it("rejects malformed debit bodies and oversized or empty retry keys before reaching a DO", async () => {
    const env=makeEnv();await seedProduct(env,"prod-1","tenant-1");
    const headers={"x-naelao-tenant-id":"tenant-1","x-naelao-internal-token":await mintInternalToken(PLATFORM_SECRET,"tenant-1")};
    for(const body of ['{','null',JSON.stringify({credits:0.5}),JSON.stringify({credits:10,idempotency_key:""}),JSON.stringify({credits:10,idempotency_key:"x".repeat(201)})]){
      const r=await spacesWorker.fetch(req("/internal/product-users/prod-1/alice/credits/deduct",{method:"POST",headers,body}),env as never,execCtx);expect(r.status).toBe(400);
    }
  });

  it("fails CLOSED (402) on insufficient balance — does not go negative", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await grantCredits(env, "prod-1", "bob", 10);

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/bob/credits/deduct", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ credits: 50 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; balance_credits: number };
    expect(body.error).toBe("insufficient_credits");
    expect(body.balance_credits).toBe(10);
  });

  it("404s for a nonexistent product space", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/no-such-product/alice/credits/deduct", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ credits: 5 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-positive credits value", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/deduct", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ credits: 0 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });
});

// Metering enforcement pass: NaelaoAgentDO's pre-run credit gate calls this route BEFORE running
// the reasoning loop, so a zero/negative balance is caught before the LLM cost is paid — not just
// after, the way /credits/deduct alone (above) could only ever report it post-hoc.
describe("GET /internal/product-users/:spaceId/:endUserId/credits/balance", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/internal/product-users/prod-1/alice/credits/balance"), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("reports the current balance without mutating it", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    await grantCredits(env, "prod-1", "alice", 100);

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { balance_credits: number }).balance_credits).toBe(100);

    // Reading again returns the same number — a GET must never itself debit.
    const again = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await again.json() as { balance_credits: number }).balance_credits).toBe(100);
  });

  it("reports 0 for an end user who has never been granted credits", async () => {
    const env = makeEnv();
    await seedProduct(env, "prod-1", "tenant-1");
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/prod-1/nobody/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { balance_credits: number }).balance_credits).toBe(0);
  });

  it("404s for a nonexistent product space", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/no-such-product/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });
});

// Live-reported bug: a signed-in end user with a real, positive balance saw "insufficient
// credits" while chatting in a BUSINESS-scoped assistant session (no projectId) — but the same
// business's project-thread chat worked fine (that path checks the project WALLET, a different
// gate). Root cause: ProductUserDO is a product-scoped concept (one instance per productId x
// endUserId, addressed by the PRODUCT ROOT's space id) — but enforceRunGates calls these credit
// routes with whatever spaceId the run is actually happening in, which for a business-scoped
// session is the BUSINESS's own space id, not the root. These prove the routes now resolve a
// business's requests to the SAME ProductUserDO as the root, instead of a phantom, never-signed-
// up one that's permanently stuck at 0.
describe("credit routes resolve a business-scoped spaceId to its product root's ProductUserDO", () => {
  it("credits/balance: a grant made at the root is visible when queried with the BUSINESS's own space id", async () => {
    const env = makeEnv();
    await seedProduct(env, "root-1", "tenant-1");
    await seedBusiness(env, "biz-1", "tenant-1", "root-1");
    await grantCredits(env, "root-1", "alice", 5000);

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/biz-1/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { balance_credits: number }).balance_credits).toBe(5000);
  });

  it("credits/deduct: debiting via the business's space id draws down the SAME balance as the root", async () => {
    const env = makeEnv();
    await seedProduct(env, "root-1", "tenant-1");
    await seedBusiness(env, "biz-1", "tenant-1", "root-1");
    await grantCredits(env, "root-1", "alice", 100);

    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const deductRes = await spacesWorker.fetch(
      req("/internal/product-users/biz-1/alice/credits/deduct", {
        method: "POST",
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        body: JSON.stringify({ credits: 30 }),
      }),
      env as never, execCtx
    );
    expect(deductRes.status).toBe(201);
    expect((await deductRes.json() as { balance_credits: number }).balance_credits).toBe(70);

    // Reading back from the ROOT id shows the same drawn-down balance — proof it's the same DO.
    const rootBalRes = await spacesWorker.fetch(
      req("/internal/product-users/root-1/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await rootBalRes.json() as { balance_credits: number }).balance_credits).toBe(70);
  });

  it("credits/balance: 404s when the business's own row references a since-deleted root", async () => {
    const env = makeEnv();
    await seedBusiness(env, "biz-orphan", "tenant-1", "no-such-root");
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/biz-orphan/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("a space with no parent_space_id (an ordinary product root) behaves exactly as before", async () => {
    const env = makeEnv();
    await seedProduct(env, "root-1", "tenant-1");
    await grantCredits(env, "root-1", "alice", 42);
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const res = await spacesWorker.fetch(
      req("/internal/product-users/root-1/alice/credits/balance", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect((await res.json() as { balance_credits: number }).balance_credits).toBe(42);
  });
});
