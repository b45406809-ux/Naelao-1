import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import worker from "./index.js";

const secret = "project-steward-service-identity-secret";
const capability = "space.project_steward.read_summary";

function harness(identity: { installation_id: string; generation: number; status: string; capabilities: string[] }) {
  const prepare = vi.fn((sql: string) => ({ bind: vi.fn(() => ({
    first: async () => sql.includes("s.status='active'") ? { id: "space-a" } : { tenant_id: "tenant-a" },
    all: async () => ({ results: [] }),
  })) }));
  const paths: string[] = [];
  const stub = { fetch: async (request: Request) => {
    const url = new URL(request.url); paths.push(url.pathname);
    if (url.pathname === "/extension-service-identity") return Response.json(identity);
    if (url.pathname === "/extensions") return Response.json({ installationId: identity.installation_id }, { status: 201 });
    return Response.json({ data: [] });
  } };
  return { env: { PLATFORM_SECRET: secret, PLATFORM_DB: { prepare }, SPACE_DO: { idFromName: vi.fn(value => value), get: vi.fn(() => stub) } } as never, paths };
}

async function request(path: string) {
  return new Request(`https://spaces.test${path}`, {
    method: path.endsWith("installation") ? "POST" : "GET",
    headers: { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": await mintInternalToken(secret, "tenant-a") },
  });
}

describe("Project Steward service identity", () => {
  it("does not reactivate a disabled installation through the scheduler bootstrap route", async () => {
    const h = harness({ installation_id: "install-a", generation: 2, status: "disabled", capabilities: [capability] });
    const response = await worker.fetch(await request("/internal/spaces/space-a/project-steward/installation"), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error_code: "project_steward_service_identity_revoked" });
    expect(h.paths).toEqual(["/extension-service-identity"]);
  });

  it("reuses only the already-active installation without reinstalling it", async () => {
    const h = harness({ installation_id: "install-a", generation: 2, status: "active", capabilities: [capability] });
    const response = await worker.fetch(await request("/internal/spaces/space-a/project-steward/installation"), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installation_id: "install-a", generation: 2, platform_managed: true });
    expect(h.paths).toEqual(["/extension-service-identity"]);
  });

  it("requires the exact active installation and read-summary capability for the summary", async () => {
    const h = harness({ installation_id: "install-a", generation: 2, status: "active", capabilities: [capability] });
    const summary = await worker.fetch(await request("/internal/spaces/space-a/project-steward/summary?installation_id=other-install&generation=2"), h.env, { waitUntil: vi.fn() } as never);
    expect(summary.status).toBe(403);
    expect(await summary.json()).toEqual({ error_code: "project_steward_service_identity_revoked" });
    expect(h.paths).toEqual(["/extension-service-identity"]);
  });

  it("allows summary reads only for the exact active identity and current host capability", async () => {
    const h = harness({ installation_id: "install-a", generation: 2, status: "active", capabilities: [capability] });
    const response = await worker.fetch(await request("/internal/spaces/space-a/project-steward/summary?installation_id=install-a&generation=2"), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grant: "space.project_steward.read_summary.v1", data: [] });
    expect(h.paths).toEqual(["/extension-service-identity", "/project-steward-facts"]);
  });

  it("refuses an active extension whose signed declaration lacks the host read capability", async () => {
    const h = harness({ installation_id: "install-a", generation: 2, status: "active", capabilities: [] });
    const response = await worker.fetch(await request("/internal/spaces/space-a/project-steward/installation"), h.env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(409);
    expect(h.paths).toEqual(["/extension-service-identity"]);
  });
});
