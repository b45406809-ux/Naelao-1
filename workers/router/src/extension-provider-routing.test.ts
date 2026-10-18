import { describe, expect, it, vi } from "vitest";
import { signJwt } from "@naelao/auth";
import { app, type Env } from "./index";

describe("project extension provider routing", () => {
  it("forwards the authenticated connection setup path to Agents", async () => {
    const secret = "router-test-platform-secret";
    const workerFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/spaces/space-1/projects/project-1/extensions/install-1/connections/slack-main/oauth/slack/start");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ authorize_url: "https://slack.com/oauth/v2/authorize" });
    });
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, AGENTS_WORKER: { fetch: workerFetch },
      SPACES_WORKER: { fetch: vi.fn(() => Response.json({ wrong_worker: true })) } } as unknown as Env;
    const response = await app.request("/v1/spaces/space-1/projects/project-1/extensions/install-1/connections/slack-main/oauth/slack/start", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ return_url: "https://shell.example.test" }),
    }, env);
    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(env.SPACES_WORKER.fetch).not.toHaveBeenCalled();
  });

  it("forwards the installation-scoped external inbox subtree to Agents", async () => {
    const secret = "router-test-platform-secret";
    const workerFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/spaces/space-1/projects/project-1/channel-extensions/install-1/inbox/assign");
      expect(request.headers.get("x-naelao-user-id")).toBe("owner-1");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ assigned: true });
    });
    const token = await signJwt({ sub: "owner-1", tid: "tenant-1", email: "owner@example.test", role: "owner", scopes: [] }, secret);
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, AGENTS_WORKER: { fetch: workerFetch },
      SPACES_WORKER: { fetch: vi.fn(() => Response.json({ wrong_worker: true })) } } as unknown as Env;
    const response = await app.request("/v1/spaces/space-1/projects/project-1/channel-extensions/install-1/inbox/assign", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ event_id: "event-1" }),
    }, env);
    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(env.SPACES_WORKER.fetch).not.toHaveBeenCalled();
  });

  it("leaves the Slack callback and per-install Telegram webhook public for providers", async () => {
    const workerFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const secret = "router-test-platform-secret";
    const env = { ENVIRONMENT: "test", JWT_SECRET: secret, PLATFORM_SECRET: secret, AGENTS_WORKER: { fetch: workerFetch } } as unknown as Env;
    const callback = await app.request("/v1/extensions/oauth/slack/callback?state=opaque", { method: "GET" }, env);
    const webhook = await app.request("/v1/channels/telegram/extensions/space-1/install-1/bot-main", { method: "POST", body: "{}" }, env);
    expect(await callback.json()).toEqual({ path: "/extensions/oauth/slack/callback" });
    expect(await webhook.json()).toEqual({ path: "/channels/telegram/extensions/space-1/install-1/bot-main" });
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });
});
