import { describe, expect, it, vi } from "vitest";
import { type Env, app } from "./index";

describe("service dependency health", () => {
  it("checks every configured router service binding and does not expose dependency bodies", async () => {
    const names = ["auth", "spaces", "knowledge", "eval", "agents", "credentials", "analytics", "billing", "marketplace", "portal-router", "sandboxes"];
    const fetchers = Object.fromEntries(names.map(name => [name, vi.fn(async (_request: Request) =>
      Response.json({ status: "ok", service: name, env: "test", secret: "must-not-leak" }))]));
    const response = await app.request("/health/dependencies", {}, {
      ENVIRONMENT: "test",
      JWT_SECRET: "test-secret",
      PLATFORM_SECRET: "test-secret",
      AUTH_WORKER: { fetch: fetchers.auth },
      SPACES_WORKER: { fetch: fetchers.spaces },
      KNOWLEDGE_WORKER: { fetch: fetchers.knowledge },
      EVAL_WORKER: { fetch: fetchers.eval },
      AGENTS_WORKER: { fetch: fetchers.agents },
      CREDENTIALS_WORKER: { fetch: fetchers.credentials },
      ANALYTICS_WORKER: { fetch: fetchers.analytics },
      BILLING_WORKER: { fetch: fetchers.billing },
      MARKETPLACE_WORKER: { fetch: fetchers.marketplace },
      PORTAL_ROUTER: { fetch: fetchers["portal-router"] },
      SANDBOXES_WORKER: { fetch: fetchers.sandboxes },
    } as unknown as Env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      checked: number;
      failed: number;
    };
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(names.length);
    expect(body.failed).toBe(0);
    for (const name of names) expect(fetchers[name]).toHaveBeenCalledTimes(1);
    expect(fetchers.auth.mock.calls[0]?.[0]).toMatchObject({
      url: "http://internal/health",
    });
    expect(JSON.stringify(body)).not.toContain("auth");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("returns 503 when a dependency is missing or fails", async () => {
    const worker = (service: string) => vi.fn(async (_request: Request) =>
      Response.json({ status: "ok", service, env: "test" }));
    const response = await app.request("/health/dependencies", {}, {
      ENVIRONMENT: "test",
      JWT_SECRET: "test-secret",
      PLATFORM_SECRET: "test-secret",
      AUTH_WORKER: { fetch: vi.fn(async (_request: Request) => new Response(null, { status: 500 })) },
      SPACES_WORKER: { fetch: vi.fn(async (_request: Request) => { throw new Error("offline"); }) },
      KNOWLEDGE_WORKER: { fetch: worker("knowledge") }, EVAL_WORKER: { fetch: worker("eval") }, AGENTS_WORKER: { fetch: worker("agents") },
      CREDENTIALS_WORKER: { fetch: worker("credentials") }, ANALYTICS_WORKER: { fetch: worker("analytics") }, BILLING_WORKER: { fetch: worker("billing") },
      MARKETPLACE_WORKER: { fetch: worker("marketplace") }, PORTAL_ROUTER: { fetch: worker("portal-router") },
      // The sandbox binding is required by both named deploy environments.
    } as unknown as Env);

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      ok: boolean;
      checked: number;
      failed: number;
    };
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(11);
    expect(body.failed).toBe(3);
    expect(JSON.stringify(body)).not.toContain("auth");
  });

  it("rejects a healthy Worker bound to the wrong release environment", async () => {
    const healthy = (service: string, env = "staging") => ({ fetch: vi.fn(async () =>
      Response.json({ status: "ok", service, env })) });
    const response = await app.request("/health/dependencies", {}, {
      ENVIRONMENT: "staging", JWT_SECRET: "test-secret", PLATFORM_SECRET: "test-secret",
      AUTH_WORKER: healthy("auth"), SPACES_WORKER: healthy("spaces"), KNOWLEDGE_WORKER: healthy("knowledge"),
      EVAL_WORKER: healthy("eval"), AGENTS_WORKER: healthy("agents"), CREDENTIALS_WORKER: healthy("credentials"),
      ANALYTICS_WORKER: healthy("analytics", "production"), BILLING_WORKER: healthy("billing"),
      MARKETPLACE_WORKER: healthy("marketplace"), PORTAL_ROUTER: healthy("portal-router"), SANDBOXES_WORKER: healthy("sandboxes"),
    } as unknown as Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, checked: 11, failed: 1 });
  });
});
