import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";
import {
  BUSINESS_FEATURE_KIND_REGISTRY, getBusinessFeatureKind, isKnownProjectKind,
  roleMeetsMinimum, creatableFeatureKindsForRole,
} from "@naelao/events";

// F-32/F-33/F-34/F-35: Business Feature Projects registry — createProject accepts `kind`, validates
// against the registry, role-gates feature kinds, and DB-enforces singleton kinds via a partial
// unique index.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

function makeEnv() {
  return { PLATFORM_SECRET, ENVIRONMENT: "test", SPACE_DO: makeStatefulDoNamespace(SpaceDO) };
}
async function headers(tenantId: string): Promise<Record<string, string>> {
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, tenantId) };
}
function req(path: string, h: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...h, ...(init?.headers as Record<string, string> | undefined) } });
}
async function createProject(env: ReturnType<typeof makeEnv>, spaceId: string, body: Record<string, unknown>): Promise<Response> {
  const h = await headers("tenant-1");
  return spacesWorker.fetch(req(`/spaces/${spaceId}/projects`, h, { method: "POST", body: JSON.stringify({ space_id: spaceId, ...body }) }), env as never, execCtx);
}

describe("BUSINESS_FEATURE_KIND_REGISTRY (F-34 registry, pure)", () => {
  it("has wallet as a singleton admin-gated kind", () => {
    const wallet = getBusinessFeatureKind("wallet");
    expect(wallet).toMatchObject({ kind: "wallet", singleton: true, minCreationRole: "admin" });
  });
  it("recognizes structural kinds without a registry entry", () => {
    expect(isKnownProjectKind("workspace")).toBe(true);
    expect(isKnownProjectKind("customer_bot")).toBe(true);
    expect(getBusinessFeatureKind("workspace")).toBeUndefined();
    expect(isKnownProjectKind("not_a_kind")).toBe(false);
  });
  it("role ranking: owner >= admin >= editor", () => {
    expect(roleMeetsMinimum("owner", "admin")).toBe(true);
    expect(roleMeetsMinimum("editor", "admin")).toBe(false);
    expect(roleMeetsMinimum("admin", "admin")).toBe(true);
    expect(roleMeetsMinimum("viewer", "editor")).toBe(false);
  });
  it("creatableFeatureKindsForRole filters by minCreationRole", () => {
    const editorKinds = creatableFeatureKindsForRole("editor").map((k) => k.kind);
    expect(editorKinds).toContain("crm");        // editor-creatable
    expect(editorKinds).not.toContain("wallet"); // admin-only
    const ownerKinds = creatableFeatureKindsForRole("owner").map((k) => k.kind);
    expect(ownerKinds.length).toBe(BUSINESS_FEATURE_KIND_REGISTRY.length); // owner sees all
  });
});

describe("createProject with kind (F-33/F-35, via the real spaces worker)", () => {
  it("defaults to kind='workspace' and is unchanged for existing callers", async () => {
    const env = makeEnv();
    const res = await createProject(env, "space-1", { name: "Plain" });
    expect(res.status).toBe(201);
  });

  it("rejects an unknown kind with 400", async () => {
    const env = makeEnv();
    const res = await createProject(env, "space-1", { name: "Bad", kind: "not_a_kind" });
    expect(res.status).toBe(400);
  });

  it("creates a wallet (singleton) project and then 409s a second wallet", async () => {
    const env = makeEnv();
    const first = await createProject(env, "space-1", { name: "Wallet", kind: "wallet" });
    expect(first.status).toBe(201);
    const second = await createProject(env, "space-1", { name: "Wallet 2", kind: "wallet" });
    expect(second.status).toBe(409);
    const body = await second.json() as { error_code: string; existing_project_id: string };
    expect(body.error_code).toBe("duplicate_singleton_project");
    expect(body.existing_project_id).toBeTruthy();
  });

  it("allows multiple non-singleton feature kinds (market_research)", async () => {
    const env = makeEnv();
    const a = await createProject(env, "space-1", { name: "Research A", kind: "market_research" });
    const b = await createProject(env, "space-1", { name: "Research B", kind: "market_research" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("role-gates a feature kind: an editor can't create wallet (admin-only) → 403", async () => {
    const env = makeEnv();
    // Register the creator as an 'editor' space member, then create AS that user (x-naelao-user-id
    // — the route derives created_by from the verified caller identity, never a body field).
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req(`/spaces/space-1/members`, h, { method: "POST", body: JSON.stringify({ space_id: "space-1", user_id: "u-editor", role: "editor" }) }), env as never, execCtx);
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects`, { ...h, "x-naelao-user-id": "u-editor" }, { method: "POST", body: JSON.stringify({ space_id: "space-1", name: "Wallet", kind: "wallet" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("lets an admin create the admin-gated wallet kind", async () => {
    const env = makeEnv();
    const h = await headers("tenant-1");
    await spacesWorker.fetch(req(`/spaces/space-1/members`, h, { method: "POST", body: JSON.stringify({ space_id: "space-1", user_id: "u-admin", role: "admin" }) }), env as never, execCtx);
    const res = await spacesWorker.fetch(
      req(`/spaces/space-1/projects`, { ...h, "x-naelao-user-id": "u-admin" }, { method: "POST", body: JSON.stringify({ space_id: "space-1", name: "Wallet", kind: "wallet" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
  });
});
