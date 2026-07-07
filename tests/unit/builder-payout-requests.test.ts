import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";

// Go-live monetization pass, final piece: a builder's accumulated reseller_ledger cut (business
// subscriptions, product orders, seat activations, revenue-cut surcharges) sat in the ledger with
// no way to actually GET PAID it. v1 is manual-fulfillment by design — no automated payout API
// exists (Lemon Squeezy has no Stripe-Connect-style split-payment primitive) — so this exercises
// the request/list/fulfill lifecycle against real SQL (node:sqlite), same rigor as every other
// money-integrity suite in this repo.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const SECRET = "test-platform-secret";
const RESELLER_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0033_reseller_accounts.sql"), "utf8");
const PAYOUT_REQUESTS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0053_payout_requests.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([RESELLER_MIGRATION, PAYOUT_REQUESTS_MIGRATION]);
  return { PLATFORM_SECRET: SECRET, ENVIRONMENT: "test", PLATFORM_DB: fakeDb };
}

async function earn(env: ReturnType<typeof makeEnv>, tenantId: string, marginCents: number, currency = "USD"): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO reseller_ledger (id, parent_tenant_id, child_tenant_id, child_space_id, event_type, retail_cents, wholesale_cents, margin_cents, currency, period)
     VALUES (?, ?, 'child-tenant', 'child-space', 'payment.success', ?, 0, ?, ?, '2026-07')`
  ).bind(crypto.randomUUID(), tenantId, marginCents, marginCents, currency).run();
}

function req(path: string, opts: { method?: string; body?: unknown; tenant?: string } = {}): Request {
  const headers = new Headers();
  if (opts.tenant) headers.set("x-naelao-tenant-id", opts.tenant);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET", headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("GET /builder/payouts/balance", () => {
  it("401s without builder auth", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/builder/payouts/balance"), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("reflects the builder's total earned margin across all periods", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    await earn(env, "tenant-1", 3000);
    const res = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    expect(await res.json()).toMatchObject({ balances: [{ cents: 8000, currency: "USD" }] });
  });

  it("is scoped per-tenant — another builder's earnings never leak in", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    const res = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-2" }), env as never, execCtx);
    expect(await res.json()).toMatchObject({ balances: [] });
  });

  it("returns a separate balance per currency — a builder earning in more than one currency never has one silently hidden", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000, "USD");
    await earn(env, "tenant-1", 3000, "EUR");
    const res = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    const body = await res.json() as { balances: Array<{ cents: number; currency: string }> };
    expect(body.balances).toHaveLength(2);
    expect(body.balances).toContainEqual({ cents: 5000, currency: "USD" });
    expect(body.balances).toContainEqual({ cents: 3000, currency: "EUR" });
  });
});

describe("POST /builder/payouts/request", () => {
  it("401s without builder auth", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(401);
  });

  it("requests the full available balance and reduces it to zero for a second request", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 10_000);

    const first = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ amount_cents: 10_000, status: "pending" });

    const balance = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    expect(await balance.json()).toMatchObject({ balances: [{ cents: 0, currency: "USD" }] });
  });

  it("rejects a request when there is nothing to withdraw", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("new earnings after a pending request become newly available", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    await earn(env, "tenant-1", 2000);

    const balance = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    expect(await balance.json()).toMatchObject({ balances: [{ cents: 2000, currency: "USD" }] });
  });

  it("requires an explicit currency when more than one has a balance, and never silently drops the others", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000, "USD");
    await earn(env, "tenant-1", 3000, "EUR");

    const ambiguous = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error_code: "currency_required" });

    const eur = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1", body: { currency: "EUR" } }), env as never, execCtx);
    expect(eur.status).toBe(201);
    expect(await eur.json()).toMatchObject({ amount_cents: 3000, currency: "EUR" });

    // The USD balance is untouched by the EUR request.
    const balance = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    const body = await balance.json() as { balances: Array<{ cents: number; currency: string }> };
    expect(body.balances).toContainEqual({ cents: 5000, currency: "USD" });
    expect(body.balances).toContainEqual({ cents: 0, currency: "EUR" });
  });
});

describe("GET /builder/payouts", () => {
  it("lists a builder's own requests newest-first", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);

    const res = await spacesWorker.fetch(req("/builder/payouts", { tenant: "tenant-1" }), env as never, execCtx);
    const body = await res.json() as { data: Array<{ amount_cents: number; status: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ amount_cents: 5000, status: "pending" });
  });
});

describe("POST /internal/payout-requests/:id/fulfill", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/internal/payout-requests/abc/fulfill", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "paid" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("marks a pending request paid, and it can never be fulfilled twice", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    const createRes = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    const { id } = await createRes.json() as { id: string };

    const token = await mintInternalToken(SECRET, "internal-ops");
    const fulfillRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/payout-requests/${id}/fulfill`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "internal-ops", "x-naelao-internal-token": token },
        body: JSON.stringify({ status: "paid", fulfilled_by: "ops-alice" }),
      }),
      env as never, execCtx
    );
    expect(fulfillRes.status).toBe(200);

    const listRes = await spacesWorker.fetch(req("/builder/payouts", { tenant: "tenant-1" }), env as never, execCtx);
    const list = await listRes.json() as { data: Array<{ status: string }> };
    expect(list.data[0]!.status).toBe("paid");

    // Fulfilling again (already paid, no longer pending) is rejected, not silently re-applied.
    const secondFulfill = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/payout-requests/${id}/fulfill`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "internal-ops", "x-naelao-internal-token": token },
        body: JSON.stringify({ status: "paid" }),
      }),
      env as never, execCtx
    );
    expect(secondFulfill.status).toBe(404);
  });

  it("a rejected request frees its amount back up for a new request", async () => {
    const env = makeEnv();
    await earn(env, "tenant-1", 5000);
    const createRes = await spacesWorker.fetch(req("/builder/payouts/request", { method: "POST", tenant: "tenant-1" }), env as never, execCtx);
    const { id } = await createRes.json() as { id: string };

    const token = await mintInternalToken(SECRET, "internal-ops");
    await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/internal/payout-requests/${id}/fulfill`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "internal-ops", "x-naelao-internal-token": token },
        body: JSON.stringify({ status: "rejected", notes: "wrong bank details" }),
      }),
      env as never, execCtx
    );

    const balance = await spacesWorker.fetch(req("/builder/payouts/balance", { tenant: "tenant-1" }), env as never, execCtx);
    expect(await balance.json()).toMatchObject({ balances: [{ cents: 5000, currency: "USD" }] });
  });
});
