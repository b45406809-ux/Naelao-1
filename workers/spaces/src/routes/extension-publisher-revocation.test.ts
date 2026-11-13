import { describe, expect, it, vi } from "vitest";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import spacesWorker from "../index.js";
import type { Env } from "../index.js";

const secret = "publisher-revocation-route-secret";

function setup(role: string | null) {
  const forwarded: Request[] = [];
  const stub = { fetch: vi.fn(async (request: Request) => {
    forwarded.push(request);
    return Response.json({ receipt: { tenant_id: "tenant-a", space_id: "space-a", key_id: "a".repeat(64),
      revoked_by: "owner-a", revoked_at: "2026-11-13T00:00:00.000Z", release_count: 2, disabled_installation_count: 1,
      active_work_count: 1, status: "draining", updated_at: "2026-11-13T00:01:00.000Z" } }, { headers: { "cache-control": "private, no-store" } });
  }) };
  const env = {
    PLATFORM_SECRET: secret,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes("JOIN space_members") && role ? { role } : null }) }) },
    SPACE_DO: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
  return { env, forwarded, stub };
}

async function request(signed = true) {
  const headers = new Headers({ "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "user-a", "x-naelao-role": "product_end_user" });
  if (signed) headers.set("x-naelao-internal-token", await mintInternalToken(secret, "tenant-a"));
  return new Request(`https://spaces.test/spaces/space-a/extension-publishers/${"a".repeat(64)}/revocation`, { headers,
    method: "GET" });
}

describe("publisher revocation receipt route", () => {
  it("requires an authenticated owner/admin membership before reading a receipt", async () => {
    const member = setup("member");
    expect((await spacesWorker.fetch(await request(), member.env)).status).toBe(403);
    expect(member.stub.fetch).not.toHaveBeenCalled();

    const nonMember = setup(null);
    expect((await spacesWorker.fetch(await request(), nonMember.env)).status).toBe(403);
    expect(nonMember.stub.fetch).not.toHaveBeenCalled();
  });

  it("forwards a no-store read scoped to the authenticated tenant, Space and publisher key", async () => {
    const owner = setup("owner");
    const response = await spacesWorker.fetch(await request(), owner.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ receipt: { tenant_id: "tenant-a", space_id: "space-a", key_id: "a".repeat(64),
      active_work_count: 1, status: "draining" } });
    expect(owner.forwarded).toHaveLength(1);
    const forwarded = owner.forwarded[0]!;
    expect(new URL(forwarded.url).searchParams.get("tenant_id")).toBe("tenant-a");
    expect(new URL(forwarded.url).searchParams.get("space_id")).toBe("space-a");
    expect(new URL(forwarded.url).searchParams.get("key_id")).toBe("a".repeat(64));
    expect(await forwarded.text()).toBe("");
    expect(await verifyInternalToken(forwarded.headers.get("x-naelao-internal-token") ?? undefined, "tenant-a", secret)).toBe(true);
  });

  it("rejects requests that did not pass through the authenticated Router", async () => {
    const owner = setup("owner");
    expect((await spacesWorker.fetch(await request(false), owner.env)).status).toBe(403);
    expect(owner.stub.fetch).not.toHaveBeenCalled();
  });
});
