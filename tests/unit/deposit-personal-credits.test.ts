import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";

// Phase 4 (money): "deposit my personal credits into this business" — a real, ledger-safe
// transfer between ProductUserDO's personal credit_ledger and a project's own wallet_ledger
// (SpaceDO). Drives BOTH real, stateful DOs through the real spaces-worker HTTP surface — this is
// the only way to prove the two-phase deduct-then-credit (and its reversal on failure) actually
// holds end to end, not just that each DO's own route works in isolation.
//
// alice is the business OWNER — needed to PATCH kind='wallet' (an admin-level setup action, per
// requireBusinessMembership's real default-to-"admin" floor for any unlisted method). bob is a
// plain MEMBER, which is who actually exercises the deposit route in most of these tests — the
// deposit action itself is member-level (it's the caller's OWN credits moving), a genuinely
// different privilege than configuring the wallet project.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SCHEMA = [
  `CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  );`,
  `CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );`,
  `CREATE TABLE space_members (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', suspended_at TEXT
  );`,
];

function makeEnv() {
  const fakeDb = createFakeD1(SCHEMA);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'root-tenant', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-1', 'biz-tenant', 'active', 'Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-1', 'prod-root', 'alice', 'owner', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-1', 'prod-root', 'bob', 'member', 'active')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
  };
}

async function endUserHeaders(tenant: string, userId: string): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": userId,
    "x-naelao-tenant-id": tenant,
    "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenant),
  };
}

function req(path: string, h: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...h, ...(init?.headers as Record<string, string> | undefined) } });
}

async function grantCredits(env: ReturnType<typeof makeEnv>, endUserId: string, credits: number): Promise<void> {
  const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
  const res = await spacesWorker.fetch(
    req("/internal/credit-packs/grant", {
      "content-type": "application/json",
      "x-naelao-tenant-id": "root-tenant",
      "x-naelao-internal-token": token,
    }, { method: "POST", body: JSON.stringify({ product_space_id: "prod-root", end_user_id: endUserId, credits, idempotency_key: `seed-${endUserId}-${credits}-${Date.now()}-${Math.random()}` }) }),
    env as never, execCtx
  );
  expect(res.status).toBe(201);
}

/** alice (owner) creates and configures the wallet project — a setup action, distinct from who
 *  later deposits into it. */
async function createWalletProject(env: ReturnType<typeof makeEnv>): Promise<string> {
  const h = await endUserHeaders("biz-tenant", "alice");
  const createRes = await spacesWorker.fetch(
    req("/spaces/biz-1/projects", h, { method: "POST", body: JSON.stringify({ space_id: "biz-1", name: "Wallet" }) }),
    env as never, execCtx
  );
  const { id } = (await createRes.json()) as { id: string };
  const patchRes = await spacesWorker.fetch(
    req(`/spaces/biz-1/projects/${id}`, h, { method: "PATCH", body: JSON.stringify({ kind: "wallet" }) }),
    env as never, execCtx
  );
  expect(patchRes.status).toBe(200);
  return id;
}

describe("POST /spaces/:spaceId/projects/:projectId/wallet/deposit-personal-credits", () => {
  it("a plain MEMBER (bob) moves credits from their own personal balance into the project's wallet — real ledger transfer", async () => {
    const env = makeEnv();
    await grantCredits(env, "bob", 1000);
    const projectId = await createWalletProject(env);
    const bobHeaders = await endUserHeaders("biz-tenant", "bob");

    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, bobHeaders, { method: "POST", body: JSON.stringify({ credits: 400 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deposited_credits: number; personal_balance_credits: number; wallet_balance_cents: number };
    expect(body).toMatchObject({ deposited_credits: 400, personal_balance_credits: 600, wallet_balance_cents: 400 });

    // Independently confirm the wallet really moved, not just the response claiming so.
    const walletRes = await spacesWorker.fetch(req(`/spaces/biz-1/projects/${projectId}/wallet/balance`, bobHeaders), env as never, execCtx);
    const wallet = (await walletRes.json()) as { balance_cents: number };
    expect(wallet.balance_cents).toBe(400);
  });

  it("1 credit = 1 cent exactly (CREDITS_PER_USD = 100)", async () => {
    const env = makeEnv();
    await grantCredits(env, "bob", 250);
    const projectId = await createWalletProject(env);
    const bobHeaders = await endUserHeaders("biz-tenant", "bob");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, bobHeaders, { method: "POST", body: JSON.stringify({ credits: 250 }) }),
      env as never, execCtx
    );
    const body = (await res.json()) as { wallet_balance_cents: number };
    expect(body.wallet_balance_cents).toBe(250);
  });

  it("fails CLOSED on insufficient personal balance — never overdraws, never touches the wallet", async () => {
    const env = makeEnv();
    await grantCredits(env, "bob", 100);
    const projectId = await createWalletProject(env);
    const bobHeaders = await endUserHeaders("biz-tenant", "bob");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, bobHeaders, { method: "POST", body: JSON.stringify({ credits: 500 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(402);
    const walletRes = await spacesWorker.fetch(req(`/spaces/biz-1/projects/${projectId}/wallet/balance`, bobHeaders), env as never, execCtx);
    const wallet = (await walletRes.json()) as { balance_cents: number };
    expect(wallet.balance_cents).toBe(0); // untouched
  });

  it("REVERSES the personal deduction when the wallet credit itself fails (a project that is NOT kind='wallet')", async () => {
    const env = makeEnv();
    await grantCredits(env, "bob", 500);
    const bobHeaders = await endUserHeaders("biz-tenant", "bob");
    // An ordinary project, never PATCHed to kind='wallet' — creditWallet will 404 it.
    const createRes = await spacesWorker.fetch(
      req("/spaces/biz-1/projects", await endUserHeaders("biz-tenant", "alice"), { method: "POST", body: JSON.stringify({ space_id: "biz-1", name: "Not A Wallet" }) }),
      env as never, execCtx
    );
    const { id: projectId } = (await createRes.json()) as { id: string };

    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, bobHeaders, { method: "POST", body: JSON.stringify({ credits: 300 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/not.*charged/i);

    // The critical assertion: bob's 300 credits are back, not lost. Probe by granting +1 and
    // reading the resulting balance rather than trusting a GET (grant's own response IS the
    // authoritative post-grant balance, from the real credit_ledger).
    const token = await mintInternalToken(PLATFORM_SECRET, "root-tenant");
    const probeRes = await spacesWorker.fetch(
      req("/internal/credit-packs/grant", {
        "content-type": "application/json",
        "x-naelao-tenant-id": "root-tenant",
        "x-naelao-internal-token": token,
      }, { method: "POST", body: JSON.stringify({ product_space_id: "prod-root", end_user_id: "bob", credits: 1, idempotency_key: "probe-1" }) }),
      env as never, execCtx
    );
    const probeBalance = (await probeRes.json()) as { balance_credits: number };
    // 500 granted, none successfully deducted (reversed), +1 probe credit = 501.
    expect(probeBalance.balance_credits).toBe(501);
  });

  it("rejects a non-positive credits value", async () => {
    const env = makeEnv();
    const projectId = await createWalletProject(env);
    const bobHeaders = await endUserHeaders("biz-tenant", "bob");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, bobHeaders, { method: "POST", body: JSON.stringify({ credits: -5 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("CRITICAL: a non-member of the business cannot deposit into its wallet", async () => {
    const env = makeEnv();
    const projectId = await createWalletProject(env);
    const strangerHeaders = await endUserHeaders("biz-tenant", "mallory");
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, strangerHeaders, { method: "POST", body: JSON.stringify({ credits: 100 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const projectId = await createWalletProject(env);
    const res = await spacesWorker.fetch(
      req(`/spaces/biz-1/projects/${projectId}/wallet/deposit-personal-credits`, { "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ credits: 100 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});
