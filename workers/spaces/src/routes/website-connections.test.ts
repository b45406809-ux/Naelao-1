import { Hono } from "hono";
import { it, expect, describe, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { registerWebsiteConnectionRoutes } from "./website-connections.js";
import type { Env } from "../index.js";
const base = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "user",
  projectId: "project",
  agentId: "worker",
  connectionId: "connection",
  authorizedOrigins: ["https://example.com"],
};
function fixture(row: Record<string, unknown> | null) {
  const first = vi.fn(async () => row);
  const app = new Hono<{ Bindings: Env }>();
  registerWebsiteConnectionRoutes(app);
  return {
    app,
    env: {
      PLATFORM_SECRET: "secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first }) }) },
    } as unknown as Env,
    first,
  };
}
async function headers() {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant",
    "x-naelao-internal-token": await mintInternalToken("secret", "tenant"),
  };
}
const row = {
  tenant_id: "tenant",
  space_id: "space",
  owner_user_id: "user",
  project_id: "project",
  agent_ids_json: '["worker"]',
  origins_json: '["https://example.com"]',
};
describe("website account authorization", () => {
  it("rejects unsigned requests before reading account data", async () => {
    const f = fixture(row);
    const res = await f.app.request(
      "/spaces/space/website-connections",
      {},
      f.env
    );
    expect(res.status).toBe(403);
    expect(f.first).not.toHaveBeenCalled();
  });
  it.each([
    { actorId: "other" },
    { projectId: "other" },
    { spaceId: "other" },
    { tenantId: "other" },
    { agentId: "other" },
    { agentId: "website-login" },
    { authorizedOrigins: ["https://attacker.example"] },
  ])("rejects changed identity/workspace/origin %j", async (change) => {
    const f = fixture(row);
    const res = await f.app.request(
      "/internal/website-connection-authorize",
      {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ ...base, ...change }),
      },
      f.env
    );
    expect(res.status).toBe(403);
  });
  it("rejects revoked or nonexistent accounts", async () => {
    const f = fixture(null);
    const res = await f.app.request(
      "/internal/website-connection-authorize",
      { method: "POST", headers: await headers(), body: JSON.stringify(base) },
      f.env
    );
    expect(res.status).toBe(403);
  });
});
