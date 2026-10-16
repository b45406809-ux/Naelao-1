import { describe, expect, it, vi } from "vitest";
import { type Env, app } from "./index";

describe("service dependency health", () => {
  it("checks auth and spaces independently and does not expose dependency bodies", async () => {
    const authFetch = vi.fn(async (_request: Request) =>
      Response.json({ ok: true, service: "auth", secret: "must-not-leak" })
    );
    const spacesFetch = vi.fn(async (_request: Request) =>
      Response.json({ ok: true, service: "spaces" })
    );
    const response = await app.request("/health/dependencies", {}, {
      ENVIRONMENT: "test",
      JWT_SECRET: "test-secret",
      PLATFORM_SECRET: "test-secret",
      AUTH_WORKER: { fetch: authFetch },
      SPACES_WORKER: { fetch: spacesFetch },
    } as unknown as Env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      services: Array<{ service: string; ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.services.map((service) => service.service)).toEqual([
      "auth",
      "spaces",
    ]);
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(spacesFetch).toHaveBeenCalledTimes(1);
    expect(authFetch.mock.calls[0]?.[0]).toMatchObject({
      url: "http://internal/health",
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("returns 503 when a dependency fails", async () => {
    const response = await app.request("/health/dependencies", {}, {
      ENVIRONMENT: "test",
      JWT_SECRET: "test-secret",
      PLATFORM_SECRET: "test-secret",
      AUTH_WORKER: {
        fetch: vi.fn(
          async (_request: Request) => new Response(null, { status: 500 })
        ),
      },
      SPACES_WORKER: {
        fetch: vi.fn(async (_request: Request) => {
          throw new Error("offline");
        }),
      },
    } as unknown as Env);

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ok: boolean;
      services: Array<{ ok: boolean }>;
    };
    expect(body.ok).toBe(false);
    expect(body.services.every((service) => !service.ok)).toBe(true);
  });
});
