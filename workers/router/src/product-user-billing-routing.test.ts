import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";

function environment() {
  const databaseQueries: string[] = [];
  let productErasureStarted = false;
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        databaseQueries.push(sql);
        return { async first() {
          if (sql.includes("SELECT id FROM products WHERE id = ? AND status = 'active'")) return { id: args[0] };
          if (sql.includes("SELECT erasure_started_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"))
            return { erasure_started_at: productErasureStarted ? "2026-11-15 00:00:00" : null };
          if (sql.includes("SELECT status FROM orgs WHERE id = ?")) return { status: "active" };
          return null;
        } };
      } };
    },
  } as unknown as D1Database;
  const forwarded: Request[] = [];
  const ticketConsumes: Request[] = [];
  const spaces = { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/product-sessions/verify") {
      const body = await request.json() as { productId: string; endUserId: string; sessionToken: string };
      return body.productId === "product-1" && body.endUserId === "verified-user" && body.sessionToken === "nps_session"
        ? Response.json({ valid: true, tenant_id: "org-1" })
        : Response.json({ valid: false });
    }
    if (path === "/internal/stream-tickets/consume") {
      ticketConsumes.push(request);
      const body = await request.json() as { productId: string; endUserId: string; ticket: string };
      return body.productId === "product-1" && body.endUserId === "verified-user" && body.ticket === "ticket-a"
        ? Response.json({ valid: true, tenant_id: "org-1" })
        : Response.json({ valid: false }, { status: 401 });
    }
    forwarded.push(request);
    return Response.json({ subscription: null, notifications: [] });
  }) };
  return {
    env: { ENVIRONMENT: "test", JWT_SECRET: "jwt-test", PLATFORM_SECRET: "internal-test", PLATFORM_DB: db, SPACES_WORKER: spaces } as unknown as Env,
    spaces,
    forwarded,
    ticketConsumes,
    databaseQueries,
    setErasureStarted(value: boolean) { productErasureStarted = value; },
  };
}

async function request(env: Env, headers: Record<string, string> = {}, path = "/v1/spaces/product-1/customer-billing-status", method = "GET") {
  return worker.fetch(new Request(`https://router.test${path}`, {
    method,
    headers: { authorization: "Bearer nps_session", "x-naelao-end-user-id": "verified-user", ...headers },
  }), env, {} as never);
}

describe("Product-user billing status router identity", () => {
  it("forwards only verified session claims, overwriting all client identity headers", async () => {
    const context = environment();
    const response = await request(context.env, {
      "x-naelao-user-id": "forged-user", "x-naelao-tenant-id": "forged-tenant", "x-naelao-role": "owner",
      "x-naelao-internal-token": "forged", "x-naelao-end-user-id": "verified-user",
    });
    expect(response.status).toBe(200);
    const forwarded = context.forwarded[0];
    expect(forwarded).toBeTruthy();
    expect(forwarded!.headers.get("x-naelao-user-id")).toBe("verified-user");
    expect(forwarded!.headers.get("x-naelao-end-user-id")).toBe("verified-user");
    expect(forwarded!.headers.get("x-naelao-tenant-id")).toBe("org-1");
    expect(forwarded!.headers.get("x-naelao-role")).toBe("product_end_user");
    expect(forwarded!.headers.get("x-naelao-internal-token")).not.toBe("forged");
  });

  it("rejects a request that pairs a real session token with another user's claimed ID", async () => {
    const context = environment();
    const response = await request(context.env, { "x-naelao-end-user-id": "other-user" });
    expect(response.status).toBe(401);
    expect(context.forwarded).toHaveLength(0);
  });

  it("blocks product-session routes after erasure begins but leaves account DELETE retryable", async () => {
    const context = environment();
    context.setErasureStarted(true);

    const profile = await request(context.env);
    expect(profile.status).toBe(410);
    expect(await profile.json()).toMatchObject({ error_code: "product_user_erasure_started" });
    expect(context.forwarded).toHaveLength(0);

    const retry = await request(context.env, {}, "/v1/spaces/product-1/product-users/me", "DELETE");
    expect(retry.status).toBe(200);
    expect(context.forwarded).toHaveLength(1);
  });

  it("blocks stream tickets for an account whose erasure has started", async () => {
    const context = environment();
    context.setErasureStarted(true);
    const response = await request(context.env, {},
      "/v1/spaces/product-1/sessions/agent/runs/run-1/stream?stream_ticket=ticket-a&end_user_id=verified-user");
    expect(response.status).toBe(410);
    expect(context.ticketConsumes).toHaveLength(1);
    expect(context.forwarded).toHaveLength(0);
  });

  it("does not disclose erasure state to an invalid stream ticket", async () => {
    const context = environment();
    context.setErasureStarted(true);
    const response = await request(context.env, {},
      "/v1/spaces/product-1/sessions/agent/runs/run-1/stream?stream_ticket=wrong&end_user_id=verified-user");
    expect(response.status).toBe(401);
    expect(context.forwarded).toHaveLength(0);
  });
});
