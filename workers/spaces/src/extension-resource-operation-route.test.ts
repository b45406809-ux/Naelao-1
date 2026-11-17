import { describe, expect, it, vi } from "vitest";
import { mintInternalToken, verifyInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "extension-resource-lease-route-secret";

function harness(active = true) {
  const databaseCalls: string[] = [];
  const db = { prepare(query: string) { databaseCalls.push(query); return { bind() { return { first: async () => active ? { active: 1 } : null }; } }; } };
  const forwarded: Request[] = [];
  const spaceDo = { fetch: vi.fn(async (request: Request) => { forwarded.push(request); return Response.json({ lease_id: "12345678-1234-1234-1234-123456789abc" }); }) };
  const env = { PLATFORM_SECRET: secret, PLATFORM_DB: db,
    SPACE_DO: { idFromName: vi.fn(() => "space-do-id"), get: vi.fn(() => spaceDo) } };
  return { env, databaseCalls, forwarded, spaceDo };
}

async function post(env: ReturnType<typeof harness>["env"], action: string, body: Record<string, unknown>, signed = true) {
  const token = signed ? await mintInternalToken(secret, "tenant-a") : "invalid";
  return worker.fetch(new Request(`https://spaces.test/internal/spaces/space-a/extension-resource-operation/${action}`, { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
    body: JSON.stringify(body) }), env as never, {} as never);
}

describe("internal workflow resource lease route", () => {
  const claim = { projectId: "project-a", instanceId: "install-a", requirementId: "knowledge_search", operationId: "search",
    publicationId: "owner_docs", manifestSha256: "a".repeat(64), resourceSha256: "b".repeat(64), installationGeneration: 2, grantRevision: 3 };

  it("forwards only the scoped owner-grant proof to SpaceDO", async () => {
    const f = harness();
    const response = await post(f.env, "claim", claim);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lease_id: "12345678-1234-1234-1234-123456789abc" });
    expect(f.spaceDo.fetch).toHaveBeenCalledOnce();
    const forwarded = f.forwarded[0]!;
    expect(new URL(forwarded.url).pathname).toBe("/extension-resource-operation");
    expect(await verifyInternalToken(forwarded.headers.get("x-naelao-internal-token") ?? undefined, "tenant-a", secret)).toBe(true);
    expect(await forwarded.json()).toEqual({ tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", instanceId: "install-a",
      requirementId: "knowledge_search", operationId: "search", resourceKind: "knowledge", gadgetId: "knowledge", table: "owner_docs",
      manifestSha256: "a".repeat(64), resourceSha256: "b".repeat(64), installationGeneration: 2, grantRevision: 3 });
  });

  it("rejects invalid or unsigned scope before it reaches SpaceDO", async () => {
    const f = harness();
    expect((await post(f.env, "claim", { ...claim, publicationId: "ab" })).status).toBe(400);
    expect((await post(f.env, "claim", claim, false)).status).toBe(403);
    expect(f.spaceDo.fetch).not.toHaveBeenCalled();
  });

  it("does not acquire a lease for an inactive Space", async () => {
    const f = harness(false);
    expect((await post(f.env, "claim", claim)).status).toBe(404);
    expect(f.spaceDo.fetch).not.toHaveBeenCalled();
  });
});
