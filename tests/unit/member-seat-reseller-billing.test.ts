import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { verifyInternalToken } from "@naelao/http";

// Member/seat billing (builder-facing enable + seat-variant provisioning) and the reseller
// consolidated wholesale statement. The checkout/activation and per-event ledger writes already
// exist; these lock the two config/read surfaces that make both features usable end-to-end.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface SpaceRow { name: string; spacetype_id: string; config_json: string | null }
interface LedgerAgg { currency: string; retail_cents: number; wholesale_cents: number; margin_cents: number; events: number; child_tenant_id?: string }

interface DBState {
  space?: SpaceRow | null;
  manifest?: unknown;
  totals?: LedgerAgg[];
  byClient?: LedgerAgg[];
  lastConfigJson?: string;
}

const PLATFORM_SECRET_FOR_TESTS = "s";

function makeEnv(state: DBState, billingVariantId?: string): Record<string, unknown> {
  const billingCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (/FROM spaces WHERE id = \? AND tenant_id = \?/.test(sql)) return state.space ?? null;
          return null;
        },
        async all() {
          if (/FROM reseller_ledger/.test(sql)) {
            return { results: /GROUP BY child_tenant_id/.test(sql) ? (state.byClient ?? []) : (state.totals ?? []) };
          }
          return { results: [] };
        },
        async run() {
          if (/UPDATE spaces SET config_json/.test(sql)) {
            state.lastConfigJson = args[0] as string;
            if (state.space) state.space.config_json = args[0] as string;
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  const kv = { async get() { return state.manifest ?? null; }, async put() {}, async delete() {} };
  const billingWorker = {
    async fetch(req: Request): Promise<Response> {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      billingCalls.push({ url: req.url, body: await req.json(), headers });
      if (billingVariantId) {
        return new Response(JSON.stringify({ ls_variant_id: billingVariantId, ls_product_id: "prod-x" }), { status: 200 });
      }
      return new Response("no LS creds", { status: 502 });
    },
  };
  return {
    PLATFORM_SECRET: PLATFORM_SECRET_FOR_TESTS, ENVIRONMENT: "test",
    PLATFORM_DB: db, NAELAO_CONFIG_KV: kv, BILLING_WORKER: billingWorker,
    __billingCalls: billingCalls,
  };
}

function req(path: string, init: RequestInit & { tenant?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-naelao-tenant-id", init.tenant ?? "tenant-1");
  headers.set("x-naelao-role", "owner");
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers });
}

// ── Member/seat billing ─────────────────────────────────────────────────────
describe("member/seat billing config", () => {
  it("GET returns disabled defaults when nothing is configured", async () => {
    const env = makeEnv({ space: { name: "Shop", spacetype_id: "launchpad", config_json: null }, manifest: { productConfig: {} } });
    const res = await spacesWorker.fetch(req("/spaces/space-1/member-billing"), env as never, execCtx);
    expect(res.status).toBe(200);
    const json = await res.json() as { member_billing: { enabled: boolean } };
    expect(json.member_billing.enabled).toBe(false);
  });

  it("PATCH enable provisions the seat LS variant and persists the override", async () => {
    const state: DBState = { space: { name: "Aria's Studio", spacetype_id: "launchpad", config_json: null }, manifest: { productConfig: {} } };
    const env = makeEnv(state, "var_seat_123");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/member-billing", { method: "PATCH", body: JSON.stringify({ enabled: true, seatPriceCents: 1500, interval: "subscription" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { member_billing: { enabled: boolean; seatPriceCents: number; currency: string; lsVariantId?: string } };
    expect(json.member_billing).toMatchObject({ enabled: true, seatPriceCents: 1500, currency: "USD", lsVariantId: "var_seat_123" });
    // The billing worker was asked to create a seat variant priced at the seat price.
    const calls = (env as { __billingCalls: Array<{ url: string; body: { price_cents: number; kind: string }; headers: Record<string, string> }> }).__billingCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ price_cents: 1500, kind: "subscription" });
    // F20 / A1.16.8: this call now mints a verified requireInternalHmac token instead of the
    // old forgeable `x-naelao-internal: "publish"` static header.
    expect(calls[0]!.headers["x-naelao-internal"]).toBeUndefined();
    expect(calls[0]!.headers["x-naelao-tenant-id"]).toBe("tenant-1");
    const token = calls[0]!.headers["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", PLATFORM_SECRET_FOR_TESTS)).toBe(true);
    // The override is written under config_json.productConfig.memberBilling (never forks the manifest).
    const written = JSON.parse(state.lastConfigJson!) as { productConfig: { memberBilling: { lsVariantId: string } } };
    expect(written.productConfig.memberBilling.lsVariantId).toBe("var_seat_123");
  });

  it("PATCH enable without a positive seat price is rejected", async () => {
    const env = makeEnv({ space: { name: "Shop", spacetype_id: "launchpad", config_json: null }, manifest: { productConfig: {} } });
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/member-billing", { method: "PATCH", body: JSON.stringify({ enabled: true, seatPriceCents: 0 }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("PATCH does not re-provision when a variant already exists (merges over current)", async () => {
    const existing = JSON.stringify({ productConfig: { memberBilling: { enabled: false, seatPriceCents: 900, currency: "USD", interval: "subscription", lsVariantId: "var_existing" } } });
    const state: DBState = { space: { name: "Shop", spacetype_id: "launchpad", config_json: existing }, manifest: { productConfig: {} } };
    const env = makeEnv(state, "var_should_not_be_used");
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/member-billing", { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { member_billing: { lsVariantId: string; seatPriceCents: number } };
    expect(json.member_billing.lsVariantId).toBe("var_existing");
    expect(json.member_billing.seatPriceCents).toBe(900);
    expect((env as { __billingCalls: unknown[] }).__billingCalls).toHaveLength(0);
  });

  it("404s for a space the calling tenant does not own", async () => {
    const env = makeEnv({ space: null });
    const res = await spacesWorker.fetch(req("/spaces/space-x/member-billing"), env as never, execCtx);
    expect(res.status).toBe(404);
  });
});

// ── Reseller consolidated statement ─────────────────────────────────────────
describe("reseller consolidated statement", () => {
  it("aggregates the ledger for the period with a per-client breakdown", async () => {
    const env = makeEnv({
      totals: [{ currency: "USD", retail_cents: 30000, wholesale_cents: 21000, margin_cents: 9000, events: 12 }],
      byClient: [
        { child_tenant_id: "ten_a", currency: "USD", retail_cents: 20000, wholesale_cents: 14000, margin_cents: 6000, events: 8 },
        { child_tenant_id: "ten_b", currency: "USD", retail_cents: 10000, wholesale_cents: 7000, margin_cents: 3000, events: 4 },
      ],
    });
    const res = await spacesWorker.fetch(req("/reseller/statement?period=2026-06"), env as never, execCtx);
    expect(res.status).toBe(200);
    const json = await res.json() as { period: string; totals: LedgerAgg[]; by_client: LedgerAgg[]; client_count: number };
    expect(json.period).toBe("2026-06");
    expect(json.totals[0]).toMatchObject({ wholesale_cents: 21000, margin_cents: 9000 });
    expect(json.by_client).toHaveLength(2);
    expect(json.client_count).toBe(2);
  });

  it("defaults to the current month when no period is given", async () => {
    const env = makeEnv({ totals: [], byClient: [] });
    const res = await spacesWorker.fetch(req("/reseller/statement"), env as never, execCtx);
    expect(res.status).toBe(200);
    const json = await res.json() as { period: string };
    expect(json.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("rejects a malformed period", async () => {
    const env = makeEnv({});
    const res = await spacesWorker.fetch(req("/reseller/statement?period=June"), env as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("401s without a tenant", async () => {
    const env = makeEnv({});
    const headers = new Headers(); // no x-naelao-tenant-id
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/reseller/statement", { headers }), env as never, execCtx);
    expect(res.status).toBe(401);
  });
});
