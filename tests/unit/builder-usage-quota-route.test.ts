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

function makeEnv(opts: { planTier?: string; orgPlanTier?: string; monthlyTokensUsed?: number; usageRows?: Array<{ org_id: string; quantity: number }>; allowOverage?: boolean } = {}) {
  const { planTier = "free", orgPlanTier, monthlyTokensUsed = 0, usageRows, allowOverage = false } = opts;
  const inserts: Array<{ org_id: string; event_type: string; quantity: number }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          (stmt as unknown as { _args: unknown[] })._args = args;
          return stmt;
        },
        async first() {
          // Two different tier sources exist in this schema; the route must prefer orgs.
          if (/allow_quota_overage FROM orgs/.test(sql)) return { allow_quota_overage: allowOverage ? 1 : 0 };
          if (/FROM orgs WHERE/.test(sql)) return orgPlanTier ? { plan_tier: orgPlanTier } : null;
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

  // Phase 4 (money): checkQuota → checkWindowedQuota — a real breach now blocks on the FIRST
  // window it crosses (day/week/month), not just month; allow_quota_overage turns that block
  // into a soft pass instead.
  it("blocks a free-tier org that breaches only the DAILY ceiling, even though monthly usage is still low", async () => {
    // free daily ceiling is 20_000 — this fake DB returns the same figure for every window, so
    // 25_000 breaches day (20_000) well before it would ever threaten month (100_000).
    const { env } = makeEnv({ planTier: "free", monthlyTokensUsed: 25_000 });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean; window: string };
    expect(body).toMatchObject({ allowed: false, window: "day" });
  });

  it("allow_quota_overage=true turns a real breach into a soft pass with overage:true, not a block", async () => {
    const { env } = makeEnv({ planTier: "free", monthlyTokensUsed: 150_000, allowOverage: true });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean; overage?: boolean };
    expect(body).toMatchObject({ allowed: true, overage: true });
  });

  it("allow_quota_overage=false (the default) still blocks exactly as before", async () => {
    const { env } = makeEnv({ planTier: "free", monthlyTokensUsed: 150_000, allowOverage: false });
    const token = await mintInternalToken(SECRET, "tenant-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
      }),
      env as never, execCtx
    );
    const body = await res.json() as { allowed: boolean; overage?: boolean };
    expect(body.allowed).toBe(false);
    expect(body.overage).toBeUndefined();
  });
});

// The quota gate resolved the plan tier from `subscriptions.plan_tier` alone, while
// EntitlementsChecker.getTenantTier — the documented authority, and what gates free-tier
// templates — reads `orgs.plan_tier`. An org upgraded on `orgs` only (exactly what the operator
// docs instruct for one's own account) therefore showed as enterprise everywhere while still
// being held to the free tier's 100k monthly tokens. Found by hitting that wall for real during
// a live eval run. Item 45 fixed this same split-brain on the WRITE side; this is the read side.
describe("quota gate — plan tier comes from the same authority everything else enforces", () => {
  async function checkQuotaRoute(made: ReturnType<typeof makeEnv>) {
    const token = await mintInternalToken(SECRET, "org-1");
    const res = await billingWorker.fetch(
      new Request("https://billing.naelao.com/internal/usage/llm-tokens/check", {
        headers: { "x-naelao-tenant-id": "org-1", "x-naelao-internal-token": token },
      }),
      made.env as never,
      execCtx
    );
    return res.json<{ allowed: boolean; limit: number; plan_tier: string }>();
  }

  it("honors orgs.plan_tier when there is no subscription row shape to match", async () => {
    const body = await checkQuotaRoute(makeEnv({ orgPlanTier: "enterprise", monthlyTokensUsed: 500_000 }));
    expect(body.plan_tier).toBe("enterprise");
    // 500k tokens would be far past free's 100k ceiling; on enterprise it must not be blocked.
    expect(body.allowed).toBe(true);
  });

  it("prefers orgs.plan_tier over a stale subscriptions row", async () => {
    const body = await checkQuotaRoute(makeEnv({ orgPlanTier: "enterprise", planTier: "free", monthlyTokensUsed: 500_000 }));
    expect(body.plan_tier).toBe("enterprise");
    expect(body.allowed).toBe(true);
  });

  it("falls back to subscriptions.plan_tier when orgs has no row", async () => {
    const body = await checkQuotaRoute(makeEnv({ planTier: "growth", monthlyTokensUsed: 10 }));
    expect(body.plan_tier).toBe("growth");
  });

  it("resolves to free — the most restrictive tier — when neither source knows the org", async () => {
    const body = await checkQuotaRoute(makeEnv({ planTier: undefined as unknown as string, monthlyTokensUsed: 200_000 }));
    expect(body.allowed).toBe(false);
  });
});
