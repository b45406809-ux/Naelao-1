import { describe, it, expect } from "vitest";
import { seedOwnerMember } from "../../workers/provisioner/src/index.js";
import type { Env } from "../../workers/provisioner/src/index.js";
import { verifyInternalToken } from "@naelao/http";

// Regression: neither POST /spaces (a normal builder) nor POST /reseller/spaces (a customer
// creating their own business) ever registered the creator as a space_members row — the ONLY
// INSERT into space_members anywhere in the platform was paid seat activation
// (billing/lemon-squeezy.ts). This meant a space's actual owner was invisible to
// SpaceDO.checkCrossSpace's "is this user a direct member" gate and to any team-listing UI.
// seedOwnerMember (provisioner step 5c) closes it — called from provisionSpace for both the
// normal and reseller creation paths (both funnel through the same 10-step provisioner).

const SECRET = "test-platform-secret";

function makeEnv(): { env: Env; calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const spacesWorker = {
    async fetch(reqInput: Request | string, init?: RequestInit): Promise<Response> {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      const body = await req.clone().json().catch(() => null);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      calls.push({ url: req.url, body, headers });
      return new Response(JSON.stringify({ space_id: "space-1", user_id: "user-1", role: "owner" }), { status: 201 });
    },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: SECRET,
    SPACES_WORKER: spacesWorker,
  } as unknown as Env;
  return { env, calls };
}

describe("seedOwnerMember (provisioner step 5c)", () => {
  it("registers the creator as space_members owner via a verified internal token", async () => {
    const { env, calls } = makeEnv();
    const seeded = await seedOwnerMember(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://spaces-worker/spaces/space-1/members");
    expect(calls[0]!.body).toEqual({ space_id: "space-1", user_id: "user-1", role: "owner" });

    const token = calls[0]!.headers["x-naelao-internal-token"];
    expect(token).toBeTruthy();
    expect(await verifyInternalToken(token, "tenant-1", SECRET)).toBe(true);
  });

  it("is a no-op (not a throw) when userId is missing — a message queued before this fix shipped", async () => {
    const { env, calls } = makeEnv();
    const seeded = await seedOwnerMember(env, "space-1", "tenant-1", undefined);
    expect(seeded).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false (not a throw) when the spaces worker rejects the call — must not fail the whole provision", async () => {
    const env = {
      ENVIRONMENT: "test",
      PLATFORM_SECRET: SECRET,
      SPACES_WORKER: { async fetch() { return new Response("nope", { status: 500 }); } },
    } as unknown as Env;
    const seeded = await seedOwnerMember(env, "space-1", "tenant-1", "user-1");
    expect(seeded).toBe(false);
  });

  it("mints a token scoped to the space's own tenant (the reseller child-tenant shape)", async () => {
    // POST /reseller/spaces provisions under the CUSTOMER's own new child tenant, not the
    // reseller's — the owner-member call must be scoped the same way.
    const { env, calls } = makeEnv();
    await seedOwnerMember(env, "child-space-1", "ten_customerchild", "customer-user-1");
    expect(calls[0]!.body).toEqual({ space_id: "child-space-1", user_id: "customer-user-1", role: "owner" });
    const token = calls[0]!.headers["x-naelao-internal-token"];
    expect(await verifyInternalToken(token, "ten_customerchild", SECRET)).toBe(true);
    expect(await verifyInternalToken(token, "some-other-tenant", SECRET)).toBe(false);
  });
});
