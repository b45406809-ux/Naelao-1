import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireInternalHmac, mintInternalToken, verifyInternalToken } from "@naelao/http";

// B1/B3 fix: workers that trust x-naelao-tenant-id/-role/-user-id as-is must not be directly
// reachable — workers_dev is now disabled on every internal worker, and requireInternalHmac is
// the defense-in-depth backstop verified here in isolation (a forged direct request must be
// rejected even if a workers_dev misconfiguration or a missing route slips through).

const SECRET = "test-platform-secret";

function makeApp() {
  const app = new Hono<{ Bindings: { PLATFORM_SECRET: string } }>();
  app.use("/protected", requireInternalHmac((c) => (c as unknown as { env: { PLATFORM_SECRET: string } }).env.PLATFORM_SECRET));
  app.get("/protected", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: (err as Error).message }, status as 403 | 500);
  });
  return app;
}

describe("requireInternalHmac", () => {
  it("rejects a request with no internal token at all (the forged-header attack B1 describes)", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        headers: { "x-naelao-tenant-id": "victim-tenant" }, // attacker-forged identity header, no token
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const app = makeApp();
    const forgedToken = await mintInternalToken("wrong-secret", "victim-tenant");
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        headers: { "x-naelao-tenant-id": "victim-tenant", "x-naelao-internal-token": forgedToken },
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token minted for a different tenant than the request claims", async () => {
    const app = makeApp();
    const tokenForTenantA = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        // Attacker reuses a legitimately-signed token but swaps the tenant header.
        headers: { "x-naelao-tenant-id": "tenant-b", "x-naelao-internal-token": tokenForTenantA },
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });

  it("rejects an expired token (older than 60s)", async () => {
    const app = makeApp();
    const staleTs = Date.now() - 90_000;
    const { signHmac } = await import("@naelao/crypto");
    const sig = await signHmac(`internal:tenant-a:${staleTs}`, SECRET);
    const staleToken = `t=${staleTs},v1=${sig}`;
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": staleToken },
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });

  it("accepts a properly minted token for the matching tenant (the router's own proxyTo shape)", async () => {
    const app = makeApp();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken },
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects when x-naelao-tenant-id is missing entirely, even with a token present", async () => {
    const app = makeApp();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      new Request("https://worker.internal/protected", {
        headers: { "x-naelao-internal-token": validToken },
      }),
      { PLATFORM_SECRET: SECRET }
    );
    expect(res.status).toBe(403);
  });
});

describe("mintInternalToken / verifyInternalToken round-trip", () => {
  it("a freshly minted token verifies for its own tenant", async () => {
    const token = await mintInternalToken(SECRET, "space-owner-tenant");
    expect(await verifyInternalToken(token, "space-owner-tenant", SECRET)).toBe(true);
  });

  it("does not verify for a different tenant", async () => {
    const token = await mintInternalToken(SECRET, "tenant-a");
    expect(await verifyInternalToken(token, "tenant-b", SECRET)).toBe(false);
  });

  it("does not verify with the wrong secret", async () => {
    const token = await mintInternalToken(SECRET, "tenant-a");
    expect(await verifyInternalToken(token, "tenant-a", "different-secret")).toBe(false);
  });
});
