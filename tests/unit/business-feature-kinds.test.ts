import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { seedWallet } from "../../workers/provisioner/src/index.js";
import type { Env as ProvisionerEnv } from "../../workers/provisioner/src/index.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";
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

// Defense in depth: createProject's feature-kind role check used to treat a MISSING created_by as
// privileged 'owner' outright. Not exploitable through the real spaces-worker route today (it
// always derives created_by from verified identity — see the `system_caller` computation in
// index.ts's POST /spaces/:spaceId/projects handler), but any FUTURE route that forwards a client
// body straight into SpaceDO.createProject without forcing created_by would have been an instant
// wallet/feature-kind privilege bypass. Fixed: a missing created_by now fails CLOSED unless the
// request explicitly carries `system_caller: true` — a value only the trusted spaces-worker route
// computes server-side (from the verified absence of x-naelao-user-id), never read from a client
// body field. These tests talk to the SpaceDO directly (bypassing index.ts entirely) to prove the
// DO itself, not just the router in front of it, refuses to grant privilege on a missing creator.
describe("createProject feature-kind gate — fail closed on missing created_by (defense in depth)", () => {
  function makeDO(): SpaceDO {
    const ctx = { storage: createDOStorage() };
    return new SpaceDO(ctx as never, {} as never);
  }
  function doReq(body: Record<string, unknown>): Request {
    return new Request("http://space-do/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("kind='wallet' with no created_by and no system_caller marker => 403 (fails closed)", async () => {
    const spaceDO = makeDO();
    const res = await spaceDO.fetch(doReq({ space_id: "space-1", name: "Wallet", kind: "wallet" }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("forbidden");
  });

  it("kind='wallet' with no created_by but system_caller: true => allowed (the provisioner's path)", async () => {
    const spaceDO = makeDO();
    const res = await spaceDO.fetch(doReq({ space_id: "space-1", name: "Wallet", kind: "wallet", system_caller: true }));
    expect(res.status).toBe(201);
  });

  it("a resolvable but insufficient created_by role is rejected even if system_caller is also (wrongly) set", async () => {
    const spaceDO = makeDO();
    // Register 'u-viewer' as a plain member (no explicit role row => role query returns "" => not
    // >= 'admin'). system_caller must NOT become a blanket override once created_by IS present.
    await spaceDO.fetch(new Request("http://space-do/members", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: "space-1", user_id: "u-viewer", role: "viewer" }),
    }));
    const res = await spaceDO.fetch(doReq({ space_id: "space-1", name: "Wallet", kind: "wallet", created_by: "u-viewer", system_caller: true }));
    expect(res.status).toBe(403);
  });

  it("structural kinds (workspace, customer_bot) are unaffected — no created_by needed at all", async () => {
    const spaceDO = makeDO();
    const res = await spaceDO.fetch(doReq({ space_id: "space-1", name: "Plain" }));
    expect(res.status).toBe(201);
  });

  it("seedWallet (the provisioner's real system-initiated call) still succeeds end to end through the real spaces-worker route", async () => {
    const env = makeEnv();
    const spacesWorkerBinding = { fetch: (r: Request) => spacesWorker.fetch(r, env as never, execCtx) };
    const provisionerEnv = { ENVIRONMENT: "test", PLATFORM_SECRET, SPACES_WORKER: spacesWorkerBinding, PLATFORM_DB: { prepare() { const s = { bind() { return s; }, async first() { return { cnt: 0 }; } }; return s; } } } as unknown as ProvisionerEnv;
    const seeded = await seedWallet(provisionerEnv, "space-seed-1", "tenant-1", "user-1");
    expect(seeded).toBe(true);
  });
});
