import { describe, it, expect } from "vitest";
import { seedWallet } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import { verifyInternalToken } from "@naelao/http";

// Metering enforcement follow-up: a project-scoped run (customer-bot type projects) with no
// builder-configured daily_spend_cap_credits used to run completely unmetered — no payer of any
// kind. seedWallet (provisioner step 9a) auto-creates a kind='wallet' project + a bounded starter
// balance so the space always has a real payer for NaelaoAgentDO's wallet gate to check.
//
// P0-4: the starter credit grant itself had no per-user limit — one person could create
// unlimited spaces to farm $10 of free compute each. Now it's granted only on verifiably the
// user's FIRST space (tenant_id + created_by, excluding the space being provisioned) — every
// subsequent space still gets a real wallet project (a real payer to gate against), just at $0.

const SECRET = "test-platform-secret";

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

function makeEnv(opts: { createOk?: boolean; patchOk?: boolean; creditOk?: boolean; priorSpaceCount?: number; dbThrows?: boolean } = {}): { env: Env; calls: Call[] } {
  const { createOk = true, patchOk = true, creditOk = true, priorSpaceCount = 0, dbThrows = false } = opts;
  const calls: Call[] = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      calls.push({ url: req.url, method: req.method, body, headers });

      if (req.method === "POST" && /\/projects$/.test(req.url)) {
        return createOk
          ? new Response(JSON.stringify({ id: "wallet-proj-1" }), { status: 201 })
          : new Response("nope", { status: 500 });
      }
      if (req.method === "PATCH" && /\/projects\/wallet-proj-1$/.test(req.url)) {
        return patchOk
          ? new Response(JSON.stringify({ id: "wallet-proj-1", kind: "wallet" }), { status: 200 })
          : new Response("nope", { status: 500 });
      }
      if (req.method === "POST" && /\/wallet\/credit$/.test(req.url)) {
        return creditOk
          ? new Response(JSON.stringify({ balance_cents: 1000 }), { status: 201 })
          : new Response("nope", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  const db = {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() {
          if (dbThrows) throw new Error("D1 unreachable");
          return { cnt: priorSpaceCount };
        },
      };
      return stmt;
    },
  };
  const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, SPACES_WORKER: spacesWorker, PLATFORM_DB: db } as unknown as Env;
  return { env, calls };
}

describe("seedWallet (provisioner step 9a)", () => {
  it("creates a wallet project and grants the starter balance on the user's first space", async () => {
    const { env, calls } = makeEnv({ priorSpaceCount: 0 });
    const seeded = await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(true);
    expect(calls).toHaveLength(3);

    const [create, patch, credit] = calls;
    expect(create!.url).toBe("http://spaces-worker/spaces/space-1/projects");
    expect(create!.body).toMatchObject({ space_id: "space-1", name: "Wallet", visibility: "private" });
    expect(await verifyInternalToken(create!.headers["x-naelao-internal-token"], "tenant-1", SECRET)).toBe(true);

    expect(patch!.url).toBe("http://spaces-worker/spaces/space-1/projects/wallet-proj-1");
    expect(patch!.body).toEqual({ kind: "wallet" });

    expect(credit!.url).toBe("http://spaces-worker/spaces/space-1/projects/wallet-proj-1/wallet/credit");
    expect(credit!.body).toMatchObject({ cents: 1000, reason: "starter_grant", idempotency_key: "starter:space-1" });
  });

  it("P0-4: creates the wallet project but skips the starter grant on a user's SECOND+ space", async () => {
    const { env, calls } = makeEnv({ priorSpaceCount: 1 });
    const seeded = await seedWallet(env, "space-2", "tenant-1", "user-1");
    expect(seeded).toBe(true);
    expect(calls).toHaveLength(2); // create + kind=wallet PATCH only, no /wallet/credit call
    expect(calls.some((c) => /\/wallet\/credit$/.test(c.url))).toBe(false);
  });

  it("P0-4: skips the starter grant when userId is missing (a message queued before this fix, or a system-initiated provision)", async () => {
    const { env, calls } = makeEnv({ priorSpaceCount: 0 });
    const seeded = await seedWallet(env, "space-1", "tenant-1", undefined);
    expect(seeded).toBe(true);
    expect(calls.some((c) => /\/wallet\/credit$/.test(c.url))).toBe(false);
  });

  it("P0-4: treats a first-space lookup failure as 'not eligible' rather than granting on every error", async () => {
    const { env, calls } = makeEnv({ dbThrows: true });
    const seeded = await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(true);
    expect(calls.some((c) => /\/wallet\/credit$/.test(c.url))).toBe(false);
  });

  it("returns false (not a throw) when project creation fails — must not fail the whole provision", async () => {
    const { env } = makeEnv({ createOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(false);
  });

  it("returns false when the kind=wallet PATCH fails", async () => {
    const { env } = makeEnv({ patchOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(false);
  });

  it("still returns true when only the starter-grant credit call fails (the wallet project itself exists, which is the real payer gate)", async () => {
    const { env } = makeEnv({ creditOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(true);
  });

  it("never throws even when the spaces worker is completely unreachable", async () => {
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: SECRET,
      SPACES_WORKER: { async fetch() { throw new Error("network down"); } },
    } as unknown as Env;
    await expect(seedWallet(env, "space-1", "tenant-1", "user-1")).resolves.toBe(false);
  });

  it("F-46: a retried provision (seedWallet twice for the same space) grants the starter balance exactly once", async () => {
    // Model the real /wallet/credit endpoint's idempotency: it dedups on idempotency_key (see
    // SpaceDO.creditWallet). If seedWallet sends a STABLE key across retries (`starter:{spaceId}`),
    // the second call is a no-op and the balance stays $10, never $20.
    const seenKeys = new Set<string>();
    let balanceCents = 0;
    const creditCalls: string[] = [];
    const statefulSpaces = {
      async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
        const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
        const body = await req.clone().json().catch(() => null) as { idempotency_key?: string; cents?: number } | null;
        if (req.method === "POST" && /\/projects$/.test(req.url)) return new Response(JSON.stringify({ id: "wallet-proj-1" }), { status: 201 });
        if (req.method === "PATCH" && /\/projects\/wallet-proj-1$/.test(req.url)) return new Response(JSON.stringify({ id: "wallet-proj-1", kind: "wallet" }), { status: 200 });
        if (req.method === "POST" && /\/wallet\/credit$/.test(req.url)) {
          creditCalls.push(body?.idempotency_key ?? "");
          if (body?.idempotency_key && seenKeys.has(body.idempotency_key)) {
            return new Response(JSON.stringify({ balance_cents: balanceCents, deduplicated: true }), { status: 200 });
          }
          if (body?.idempotency_key) seenKeys.add(body.idempotency_key);
          balanceCents += body?.cents ?? 0;
          return new Response(JSON.stringify({ balance_cents: balanceCents }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    };
    const db = { prepare() { const s = { bind() { return s; }, async first() { return { cnt: 0 }; } }; return s; } };
    const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, SPACES_WORKER: statefulSpaces, PLATFORM_DB: db } as unknown as Env;

    await seedWallet(env, "space-1", "tenant-1", "user-1");
    await seedWallet(env, "space-1", "tenant-1", "user-1");
    expect(creditCalls).toEqual(["starter:space-1", "starter:space-1"]); // stable key both times
    expect(balanceCents).toBe(1000); // granted once, not twice
  });

  it("mints a token scoped to the space's own tenant (the reseller child-tenant shape)", async () => {
    const { env, calls } = makeEnv();
    await seedWallet(env, "child-space-1", "ten_customerchild", "user-1");
    expect(calls[0]!.body).toMatchObject({ space_id: "child-space-1" });
    expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "ten_customerchild", SECRET)).toBe(true);
    expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "some-other-tenant", SECRET)).toBe(false);
  });
});
