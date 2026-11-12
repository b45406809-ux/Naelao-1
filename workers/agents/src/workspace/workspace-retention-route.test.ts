import { mintInternalToken } from "@naelao/http";
import { describe, expect, it, vi } from "vitest";
import { app } from "../index.js";

const policy = { version: 1, stagingRetentionDays: 30, legalHold: null, updatedAt: null, updatedBy: null };

function fixture() {
  const coordinatorCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const coordinator = { fetch: vi.fn(async (request: Request) => {
    coordinatorCalls.push({ method: request.method, path: new URL(request.url).pathname,
      ...(request.method === "POST" ? { body: await request.json() } : {}) });
    return Response.json({ policy }, { headers: { "cache-control": "no-store" } });
  }) };
  const platformDb = {
    prepare(sql: string) {
      return { bind() { return { async first() {
        if (sql.includes("SELECT id FROM spaces")) return { id: "space-a" };
        if (sql.includes("FROM org_members")) return { role: "owner" };
        return null;
      } }; } };
    },
  };
  const env = {
    PLATFORM_SECRET: "workspace-retention-test-secret",
    PLATFORM_DB: platformDb,
    SPACES_WORKER: { fetch: vi.fn(async () => Response.json({ id: "project-a" })) },
    WORKSPACE_COORDINATOR: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => coordinator) },
  } as never;
  return { env, coordinator, coordinatorCalls };
}

async function headers() {
  const secret = "workspace-retention-test-secret";
  return { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a",
    "x-naelao-role": "owner", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") };
}

describe("project workspace-retention owner routes", () => {
  it("reads the current project policy and persists owner reason, hold and expiry", async () => {
    const f = fixture(), auth = await headers();
    const read = await app.request("/spaces/space-a/projects/project-a/workspace-retention", { headers: auth }, f.env);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ policy });

    const saved = await app.request("/spaces/space-a/projects/project-a/workspace-retention", { method: "POST", headers: auth,
      body: JSON.stringify({ stagingRetentionDays: 45, legalHold: true, legalHoldExpiresAt: "2026-12-01T00:00:00.000Z",
        reason: "Preserve this project for the current review." }) }, f.env);
    expect(saved.status).toBe(200);
    expect(f.coordinatorCalls).toHaveLength(2);
    expect(f.coordinatorCalls[1]).toMatchObject({ method: "POST", path: "/v1/retention/policy", body: {
      scope: { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", jurisdiction: "global" },
      stagingRetentionDays: 45, legalHold: true, legalHoldExpiresAt: "2026-12-01T00:00:00.000Z",
      reason: "Preserve this project for the current review.", actorId: "owner-a",
    } });
  });

  it("does not forward a policy write for a non-owner", async () => {
    const f = fixture();
    const memberHeaders = { ...(await headers()), "x-naelao-role": "member" };
    const read = await app.request("/spaces/space-a/projects/project-a/workspace-retention", { headers: memberHeaders }, f.env);
    expect(read.status).toBe(403);
    const response = await app.request("/spaces/space-a/projects/project-a/workspace-retention", { method: "POST", headers: memberHeaders,
      body: JSON.stringify({ stagingRetentionDays: 45, legalHold: true, reason: "Preserve this project for review." }) }, f.env);
    expect(response.status).toBe(403);
    expect(f.coordinatorCalls).toHaveLength(0);
  });
});
