import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// Launchpad Wallet (user-directed feature): exercises the REAL SpaceDO migration chain (through
// the actual spaces worker HTTP surface, not a mock) — this is the safety-critical proof that the
// v25 table-rebuild migration (widening projects.kind's CHECK constraint to add 'wallet' via
// CREATE TABLE projects_new / INSERT ... SELECT / DROP / RENAME, since SQLite can't ALTER a CHECK
// constraint in place) preserves every pre-existing projects column correctly and that the new
// wallet_ledger table's idempotency + fail-closed-debit contract holds.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

function makeEnv() {
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
  };
}

async function headers(tenantId: string): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenantId),
  };
}

function req(path: string, h: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...h, ...(init?.headers as Record<string, string> | undefined) } });
}

async function createProject(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string, name: string): Promise<string> {
  const h = await headers(tenantId);
  const res = await spacesWorker.fetch(
    req(`/spaces/${spaceId}/projects`, h, { method: "POST", body: JSON.stringify({ space_id: spaceId, name }) }),
    env as never, execCtx
  );
  const { id } = await res.json() as { id: string };
  return id;
}

async function makeWalletProject(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string, name: string): Promise<string> {
  const projectId = await createProject(env, spaceId, tenantId, name);
  const h = await headers(tenantId);
  const patchRes = await spacesWorker.fetch(
    req(`/spaces/${spaceId}/projects/${projectId}`, h, { method: "PATCH", body: JSON.stringify({ kind: "wallet" }) }),
    env as never, execCtx
  );
  expect(patchRes.status).toBe(200);
  return projectId;
}

describe("Launchpad Wallet ledger (SpaceDO, real migration chain)", () => {
  it("PATCH kind='wallet' is accepted — proves the v25 CHECK-constraint rebuild actually widened it", async () => {
    const env = makeEnv();
    const projectId = await createProject(env, "space-1", "tenant-1", "My Wallet");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}`, h, { method: "PATCH", body: JSON.stringify({ kind: "wallet" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const getRes = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}`, h), env as never, execCtx);
    const project = await getRes.json() as { kind: string };
    expect(project.kind).toBe("wallet");
  });

  it("rejects an invalid kind value (rebuild didn't accidentally drop the CHECK constraint entirely)", async () => {
    const env = makeEnv();
    const projectId = await createProject(env, "space-1", "tenant-1", "Regular Project");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}`, h, { method: "PATCH", body: JSON.stringify({ kind: "not_a_real_kind" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("balance/credit/debit/history 404 on a project that isn't kind='wallet'", async () => {
    const env = makeEnv();
    const projectId = await createProject(env, "space-1", "tenant-1", "Workspace Project");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}/wallet/balance`, h), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("credits the wallet and returns the running balance", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet A");
    const h = await headers("tenant-1");

    const creditRes = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, {
        method: "POST", body: JSON.stringify({ cents: 2500, reason: "top_up" }),
      }),
      env as never, execCtx
    );
    expect(creditRes.status).toBe(201);
    expect(await creditRes.json()).toEqual({ balance_cents: 2500 });

    const balRes = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}/wallet/balance`, h), env as never, execCtx);
    // `credited_cents` (money that has EVER gone in) is what lets the run gate tell a
    // never-funded wallet apart from a depleted one — a brand-new business auto-provisions an
    // empty wallet, and blocking on the balance alone refused it its own agents on day one.
    expect(await balRes.json()).toEqual({
      project_id: projectId, balance_cents: 2500, credited_cents: 2500, currency: "USD",
    });
  });

  it("rejects a non-USD credit with a clear 400 — walletBalance sums delta_cents with no currency filter, so a single-currency ledger is the only currently-correct semantics (cf. item 39's builder-payout multi-currency bug)", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet EUR");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, {
        method: "POST", body: JSON.stringify({ cents: 1000, currency: "EUR" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error_code: string }).error_code).toBe("unsupported_currency");
    // The rejected credit must not have landed in the ledger at all.
    const balRes = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}/wallet/balance`, h), env as never, execCtx);
    expect((await balRes.json() as { balance_cents: number }).balance_cents).toBe(0);
  });

  it("an explicit currency:'USD' credit is accepted (unchanged behavior)", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet USD explicit");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, {
        method: "POST", body: JSON.stringify({ cents: 1500, currency: "USD" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ balance_cents: 1500 });
  });

  it("a replayed credit with the same idempotency_key does not double-credit", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet B");
    const h = await headers("tenant-1");
    const body = JSON.stringify({ cents: 1000, idempotency_key: "ls-event-42" });

    const first = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, { method: "POST", body }),
      env as never, execCtx
    );
    expect(await first.json()).toEqual({ balance_cents: 1000 });

    const second = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, { method: "POST", body }),
      env as never, execCtx
    );
    expect(await second.json()).toEqual({ balance_cents: 1000, deduplicated: true });

    const balRes = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}/wallet/balance`, h), env as never, execCtx);
    expect((await balRes.json() as { balance_cents: number }).balance_cents).toBe(1000);
  });

  it("debit fails closed (402) on an over-draw, never going negative", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet C");
    const h = await headers("tenant-1");
    await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, { method: "POST", body: JSON.stringify({ cents: 500 }) }),
      env as never, execCtx
    );
    const debitRes = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/debit?tenant_id=tenant-1`, h, { method: "POST", body: JSON.stringify({ cents: 600 }) }),
      env as never, execCtx
    );
    expect(debitRes.status).toBe(402);
    expect(await debitRes.json()).toEqual({ error_code: "insufficient_balance", balance_cents: 500 });
  });

  it("a successful debit reduces the balance and appears in history", async () => {
    const env = makeEnv();
    const projectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet D");
    const h = await headers("tenant-1");
    await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/credit?tenant_id=tenant-1`, h, { method: "POST", body: JSON.stringify({ cents: 1000 }) }),
      env as never, execCtx
    );
    const debitRes = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectId}/wallet/debit?tenant_id=tenant-1`, h, { method: "POST", body: JSON.stringify({ cents: 300, reason: "platform_usage" }) }),
      env as never, execCtx
    );
    expect(debitRes.status).toBe(200);
    expect(await debitRes.json()).toEqual({ balance_cents: 700 });

    const historyRes = await spacesWorker.fetch(req(`/spaces/space-1/projects/${projectId}/wallet/history`, h), env as never, execCtx);
    const { data } = await historyRes.json() as { data: Array<{ delta_cents: number; reason: string; balance_after_cents: number }> };
    expect(data).toHaveLength(2);
    // ORDER BY created_at DESC — most recent (the debit) first.
    expect(data[0]).toMatchObject({ delta_cents: -300, reason: "platform_usage", balance_after_cents: 700 });
    expect(data[1]).toMatchObject({ delta_cents: 1000, balance_after_cents: 1000 });
  });

  it("F-32: a space can have only ONE active wallet project — a second returns 409", async () => {
    const env = makeEnv();
    await makeWalletProject(env, "space-1", "tenant-1", "Wallet E");
    // A second attempt to PATCH kind='wallet' on a different project hits the singleton index.
    const projectB = await createProject(env, "space-1", "tenant-1", "Wallet F");
    const h = await headers("tenant-1");
    const patchRes = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectB}/wallet/balance`, h),
      env as never, execCtx
    );
    // projectB is not a wallet yet, so its balance route 404s (not a wallet project).
    expect(patchRes.status).toBe(404);
    const dupRes = await spacesWorker.fetch(
      req(`/spaces/space-1/projects/${projectB}`, h, { method: "PATCH", body: JSON.stringify({ kind: "wallet" }) }),
      env as never, execCtx
    );
    expect(dupRes.status).toBe(409);
    expect((await dupRes.json() as { error_code: string }).error_code).toBe("duplicate_singleton_project");
  });
});

// Metering enforcement follow-up: NaelaoAgentDO looks up a space's wallet project via this route
// before gating/debiting a project-scoped run's real LLM cost against it.
describe("GET /spaces/:spaceId/wallet-project", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/wallet-project", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("finds the space's wallet project by kind", async () => {
    const env = makeEnv();
    const walletProjectId = await makeWalletProject(env, "space-1", "tenant-1", "Wallet G");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-1/wallet-project", h), env as never, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json() as { project_id: string | null }).project_id).toBe(walletProjectId);
  });

  it("returns project_id: null for a space with no wallet project", async () => {
    const env = makeEnv();
    await createProject(env, "space-1", "tenant-1", "Just a regular project");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-1/wallet-project", h), env as never, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json() as { project_id: string | null }).project_id).toBeNull();
  });

  it("never confuses a wallet in a DIFFERENT space", async () => {
    const env = makeEnv();
    await makeWalletProject(env, "space-1", "tenant-1", "Wallet H");
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-2/wallet-project", h), env as never, execCtx);
    expect((await res.json() as { project_id: string | null }).project_id).toBeNull();
  });
});

// F-WALLET-6/7: the consolidated per-business wallet view (dashboard tab + shell section).
describe("GET /spaces/:spaceId/wallet (consolidated)", () => {
  it("requires a verified internal token — a spoofed tenant header alone is rejected (403)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/wallet", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("returns the consolidated shape (balance + lifetime + transactions) with a valid token", async () => {
    const env = makeEnv();
    await makeWalletProject(env, "space-1", "tenant-1", "Wallet");
    // The consolidated route reads a launchpad_orders lifetime summary from PLATFORM_DB (always
    // bound in production); provide a minimal stub returning a zero summary.
    const zeroSummary = { gross_cents: 0, naelao_cut_cents: 0, builder_cut_cents: 0, net_settled_cents: 0, order_count: 0 };
    (env as unknown as { PLATFORM_DB: unknown }).PLATFORM_DB = { prepare: () => ({ bind: () => ({ first: async () => zeroSummary }) }) };
    const h = await headers("tenant-1");
    const res = await spacesWorker.fetch(req("/spaces/space-1/wallet", h), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { available_balance_cents: number; lifetime: { gross_cents: number }; transactions: unknown[] };
    expect(body).toHaveProperty("available_balance_cents");
    expect(body).toHaveProperty("lifetime");
    expect(Array.isArray(body.transactions)).toBe(true);
  });
});
