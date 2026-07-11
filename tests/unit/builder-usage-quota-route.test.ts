import { describe, it, expect } from "vitest";
import billingWorker from "../../workers/billing/src/index.js";
import { mintInternalToken } from "@naelao/http";

// P0-3: /billing/usage had NO auth at all despite its own "internal route" comment, and trusted
// a client-supplied body.org_id for the actual D1 write — a legitimately-authenticated caller for
// tenant A could post {org_id: "tenant-B", ...} and pollute tenant B's usage_events (which also
// feeds a Stripe metering event enqueue). Confirmed zero production callers existed before this
// pass. Now gated with requireInternalHmac like every sibling /internal/* route in this file, and
// the org actually written is the VERIFIED x-naelao-tenant-id header, never the body.
//
// Also covers the new GET /internal/usage/llm-tokens/check route NaelaoAgentDO's builder-tier
// gate calls (see builder-tier-usage-gate.test.ts for the DO-side behavior).

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(opts: { planTier?: string; monthlyTokensUsed?: number; usageRows?: Array<{ org_id: string; quantity: number }> } = {}) {
  const { planTier = "free", monthlyTokensUsed = 0, usageRows } = opts;
  const inserts: Array<{ org_id: string; event_type: string; quantity: number }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          (stmt as unknown as { _args: unknown[] })._args = args;
          return stmt;
        },
        async first() {
          if (/FROM subscriptions WHERE/.test(sql)) return { plan_tier: planTier };
          if (/SUM\(quantity\).*usage_events/s.test(sql) || /FROM\s+usage_events/.test(sql)) {
            if (usageRows) {
              const args = (stmt as unknown as { _args: unknown[] })._args ?? [];
              const orgId = args[0] as string;
              const total = usageRows.filter((r) => r.org_id === orgId).reduce((s, r) => s + r.quantity, 0);
              return { cnt: total };
            }
            return { cnt: monthlyTokensUsed };
          }
          return null;
        },
        async run() {
          const args = (stmt as unknown as { _args: unknown[] })._args ?? [];
          // INSERT OR IGNORE INTO usage_events (id, org_id, space_id, event_type, quantity, recorded_at, event_hash)
          if (/INSERT OR IGNORE INTO usage_events/.test(sql)) {
            inserts.push({ org_id: args[1] as string, event_type: args[3] as string, quantity: args[4] as number });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  const kv = {
    async get() { return null; },
    async put() { /* no-op */ },
    async delete() { /* no-op */ },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,

    PLATFORM_DB: db,
    QUOTA_CACHE: kv,
    BILLING_EVENTS: { send: async () => { /* no-op */ } },
  };
  return { env, inserts };
}

describe("billing worker — POST /billing/usage requires a verified internal token", () => {
  it("rejects with no header at all", async () => {
    const { env } = makeEnv();
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/billing/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "tenant-1", event_type: "llm_tokens", quantity: 500 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token and records usage against the VERIFIED tenant header, not any body.org_id", async () => {
    const { env, inserts } = makeEnv();
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/billing/usage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
        // A malicious/buggy caller tries to attribute usage to a DIFFERENT org via the body —
        // this must be ignored entirely; only the verified header counts.
        body: JSON.stringify({ org_id: "tenant-EVIL", event_type: "llm_tokens", quantity: 500 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    expect(inserts).toEqual([{ org_id: "tenant-1", event_type: "llm_tokens", quantity: 500 }]);
  });

  it("a token minted for tenant-1 cannot be replayed against a different x-naelao-tenant-id header", async () => {
    const { env } = makeEnv();
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/billing/usage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-2", "x-naelao-internal-token": token },
        body: JSON.stringify({ event_type: "llm_tokens", quantity: 500 }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});

describe("billing worker — GET /internal/usage/llm-tokens/check", () => {
  it("rejects with no internal token", async () => {
    const { env } = makeEnv();
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", { headers: { "x-naelao-tenant-id": "tenant-1" } }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("allows a free-tier org under its 100,000 monthly token limit", async () => {
    const { env } = makeEnv({ planTier: "free", monthlyTokensUsed: 5_000 });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { allowed: boolean; current: number; limit: number; plan_tier: string };
    expect(body).toMatchObject({ allowed: true, current: 5_000, limit: 100_000, plan_tier: "free" });
  });

  it("blocks a free-tier org that has exceeded its monthly token limit", async () => {
    const { env } = makeEnv({ planTier: "free", monthlyTokensUsed: 150_000 });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });

  it("a growth-tier org gets the higher 2,000,000 token limit, not the free-tier ceiling", async () => {
    const { env } = makeEnv({ planTier: "growth", monthlyTokensUsed: 150_000 });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean; limit: number };
    expect(body).toMatchObject({ allowed: true, limit: 2_000_000 });
  });

  it("usage is scoped per-org — tenant-1's heavy usage never affects tenant-2's own check", async () => {
    const { env } = makeEnv({ planTier: "free", usageRows: [{ org_id: "tenant-1", quantity: 500_000 }] });
    const token = await mintInternalToken(SECRET, "tenant-2");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-2", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean; current: number };
    expect(body).toMatchObject({ allowed: true, current: 0 });
  });
});
