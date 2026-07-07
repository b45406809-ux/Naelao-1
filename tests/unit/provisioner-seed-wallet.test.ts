import { describe, it, expect } from "vitest";
import { seedWallet } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import { verifyInternalToken } from "@naelao/http";

// Metering enforcement follow-up: a project-scoped run (customer-bot type projects) with no
// builder-configured daily_spend_cap_credits used to run completely unmetered — no payer of any
// kind. seedWallet (provisioner step 9a) auto-creates a kind='wallet' project + a bounded starter
// balance so the space always has a real payer for NaelaoAgentDO's wallet gate to check.

const SECRET = "test-platform-secret";

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

function makeEnv(opts: { createOk?: boolean; patchOk?: boolean; creditOk?: boolean } = {}): { env: Env; calls: Call[] } {
  const { createOk = true, patchOk = true, creditOk = true } = opts;
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
  const env = { ENVIRONMENT: "test", PLATFORM_SECRET: SECRET, SPACES_WORKER: spacesWorker } as unknown as Env;
  return { env, calls };
}

describe("seedWallet (provisioner step 9a)", () => {
  it("creates a wallet project and grants the starter balance via verified internal tokens", async () => {
    const { env, calls } = makeEnv();
    const seeded = await seedWallet(env, "space-1", "tenant-1");
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

  it("returns false (not a throw) when project creation fails — must not fail the whole provision", async () => {
    const { env } = makeEnv({ createOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1");
    expect(seeded).toBe(false);
  });

  it("returns false when the kind=wallet PATCH fails", async () => {
    const { env } = makeEnv({ patchOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1");
    expect(seeded).toBe(false);
  });

  it("still returns true when only the starter-grant credit call fails (the wallet project itself exists, which is the real payer gate)", async () => {
    const { env } = makeEnv({ creditOk: false });
    const seeded = await seedWallet(env, "space-1", "tenant-1");
    expect(seeded).toBe(true);
  });

  it("never throws even when the spaces worker is completely unreachable", async () => {
    const env = {
      ENVIRONMENT: "test", PLATFORM_SECRET: SECRET,
      SPACES_WORKER: { async fetch() { throw new Error("network down"); } },
    } as unknown as Env;
    await expect(seedWallet(env, "space-1", "tenant-1")).resolves.toBe(false);
  });

  it("mints a token scoped to the space's own tenant (the reseller child-tenant shape)", async () => {
    const { env, calls } = makeEnv();
    await seedWallet(env, "child-space-1", "ten_customerchild");
    expect(calls[0]!.body).toMatchObject({ space_id: "child-space-1" });
    expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "ten_customerchild", SECRET)).toBe(true);
    expect(await verifyInternalToken(calls[0]!.headers["x-naelao-internal-token"], "some-other-tenant", SECRET)).toBe(false);
  });
});
