import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// Leak fix: the PRODUCT ROOT space's kind='wallet' project (seeded for every space by the
// provisioner's seedWallet step) is the BUILDER's own platform-cost ledger — but
// requireBusinessMembership's generic "root space implies member" shortcut (safe for sessions,
// projects, threads — resources a verified end-user product session legitimately reaches) also
// let ANY product_end_user read it: GET /spaces/:spaceId/projects lists the root wallet project id
// (member-readable), then GET .../wallet/balance and /wallet/history disclosed the builder's full
// ledger (ScriptDO reasons + amounts) to any signed-up end user of the product.
//
// Fix: requireBusinessMembershipForWallet (business-auth.ts) resolves access via the new
// resolveWalletAccessRole, which returns null (not "member") for a product_end_user on a space
// with no parent_space_id — the wallet-only carve-out. A business (child) space's own wallet is
// unaffected: its owner/admin members still read it via the real business_memberships row.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUSINESS_MEMBERSHIPS_SQL = `
  CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );
`;
// Minimal shape for the consolidated GET /wallet route's lifetime money-in summary query.
const LAUNCHPAD_ORDERS_SQL = `
  CREATE TABLE launchpad_orders (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paid',
    gross_cents INTEGER NOT NULL DEFAULT 0, fee_cents INTEGER NOT NULL DEFAULT 0,
    builder_fee_cents INTEGER NOT NULL DEFAULT 0, net_cents INTEGER NOT NULL DEFAULT 0
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, LAUNCHPAD_ORDERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-1', 'tenant-1', 'active', 'Product Root')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-1', 'tenant-1', 'active', 'Alice Biz', 'prod-1')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-1', 'prod-1', 'eu-1', 'owner', 'active')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

async function seedWalletProject(env: ReturnType<typeof makeEnv>, spaceId: string, cents: number): Promise<string> {
  const builderHeaders = await internalHeaders("tenant-1");
  const created = await spacesWorker.fetch(
    req(`/spaces/${spaceId}/projects`, builderHeaders, { method: "POST", body: JSON.stringify({ name: "Wallet", visibility: "private", kind: "wallet" }) }),
    env as never, execCtx
  );
  expect(created.status).toBe(201);
  const { id: projectId } = await created.json() as { id: string };
  if (cents > 0) {
    const creditRes = await spacesWorker.fetch(
      req(`/spaces/${spaceId}/projects/${projectId}/wallet/credit`, builderHeaders, {
        method: "POST",
        body: JSON.stringify({ cents, reason: "test_seed", idempotency_key: `seed-${spaceId}` }),
      }),
      env as never, execCtx
    );
    expect(creditRes.status).toBe(201);
  }
  return projectId;
}

describe("Wallet reads — product-root wallet is builder-only, not end-user member-readable", () => {
  it("a product_end_user is refused (403) reading the ROOT wallet's balance and history", async () => {
    const env = makeEnv();
    const projectId = await seedWalletProject(env, "prod-1", 5000);
    const euHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });

    const balRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}/wallet/balance`, euHeaders), env as never, execCtx);
    expect(balRes.status).toBe(403);

    const histRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}/wallet/history`, euHeaders), env as never, execCtx);
    expect(histRes.status).toBe(403);
  });

  it("a product_end_user is refused (403) reading the consolidated ROOT /wallet view", async () => {
    const env = makeEnv();
    await seedWalletProject(env, "prod-1", 5000);
    const euHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });
    const res = await spacesWorker.fetch(req("/spaces/prod-1/wallet", euHeaders), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("the builder (owner) still reads the ROOT wallet fine", async () => {
    const env = makeEnv();
    const projectId = await seedWalletProject(env, "prod-1", 5000);
    const builderHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });

    const balRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}/wallet/balance`, builderHeaders), env as never, execCtx);
    expect(balRes.status).toBe(200);
    const bal = await balRes.json() as { balance_cents: number };
    expect(bal.balance_cents).toBe(5000);

    const walletRes = await spacesWorker.fetch(req("/spaces/prod-1/wallet", builderHeaders), env as never, execCtx);
    expect(walletRes.status).toBe(200);
  });

  it("a business owner still reads their OWN business's wallet", async () => {
    const env = makeEnv();
    const projectId = await seedWalletProject(env, "biz-1", 2500);
    const ownerHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-1" });

    const balRes = await spacesWorker.fetch(req(`/spaces/biz-1/projects/${projectId}/wallet/balance`, ownerHeaders), env as never, execCtx);
    expect(balRes.status).toBe(200);
    const bal = await balRes.json() as { balance_cents: number };
    expect(bal.balance_cents).toBe(2500);

    const walletRes = await spacesWorker.fetch(req("/spaces/biz-1/wallet", ownerHeaders), env as never, execCtx);
    expect(walletRes.status).toBe(200);
  });

  it("a DIFFERENT end user (no membership) cannot read biz-1's wallet", async () => {
    const env = makeEnv();
    const projectId = await seedWalletProject(env, "biz-1", 2500);
    const strangerHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "eu-stranger" });
    const balRes = await spacesWorker.fetch(req(`/spaces/biz-1/projects/${projectId}/wallet/balance`, strangerHeaders), env as never, execCtx);
    expect(balRes.status).toBe(403);
  });
});
