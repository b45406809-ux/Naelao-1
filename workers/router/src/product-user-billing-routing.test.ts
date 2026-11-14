import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import worker from "./index.js";

function environment() {
  const databaseQueries: string[] = [];
  const db = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        databaseQueries.push(sql);
        return { async first() {
          if (sql.includes("SELECT id FROM products WHERE id = ? AND status = 'active'")) return { id: args[0] };
          if (sql.includes("SELECT status FROM orgs WHERE id = ?")) return { status: "active" };
          return null;
        } };
      } };
    },
  } as unknown as D1Database;
  const forwarded: Request[] = [];
  const spaces = { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/product-sessions/verify") {
      const body = await request.json() as { productId: string; endUserId: string; sessionToken: string };
      return body.productId === "product-1" && body.endUserId === "verified-user" && body.sessionToken === "nps_session"
        ? Response.json({ valid: true, tenant_id: "org-1" })
        : Response.json({ valid: false });
    }
    forwarded.push(request);
    return Response.json({ subscription: null, notifications: [] });
  }) };
  return {
    env: { ENVIRONMENT: "test", JWT_SECRET: "jwt-test", PLATFORM_SECRET: "internal-test", PLATFORM_DB: db, SPACES_WORKER: spaces } as unknown as Env,
    spaces,
    forwarded,
    databaseQueries,
  };
}

async function request(env: Env, headers: Record<string, string> = {}) {
  return worker.fetch(new Request("https://router.test/v1/spaces/product-1/customer-billing-status", {
    method: "GET",
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
});
