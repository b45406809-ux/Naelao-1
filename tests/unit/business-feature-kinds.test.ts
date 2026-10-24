import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUSINESS_FEATURE_KIND_REGISTRY, getBusinessFeatureKind, isKnownProjectKind,
  roleMeetsMinimum, creatableFeatureKindsForRole,
} from "@naelao/events";

// The kernel no longer ships native business feature kinds; domain features arrive through
// templates, extensions, and connected MCP servers.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";
const ORG_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0002_orgs.sql"), "utf8");
const SPACES_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0003_spaces.sql"), "utf8");

function makeEnv() {
  const db = createFakeD1([ORG_MIGRATION, SPACES_MIGRATION]);
  db.db.exec("INSERT INTO orgs (id, name, owner_id, status) VALUES ('tenant-1', 'Test tenant', 'owner-1', 'active')");
  db.db.exec("INSERT INTO spaces (id, tenant_id, spacetype_id, name, status) VALUES ('space-1', 'tenant-1', 'type-1', 'Test space', 'active')");
  return { PLATFORM_SECRET, ENVIRONMENT: "test", PLATFORM_DB: db, SPACE_DO: makeStatefulDoNamespace(SpaceDO) };
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

describe("BUSINESS_FEATURE_KIND_REGISTRY", () => {
  it("is empty and does not expose native business features", () => {
    expect(Object.isFrozen(BUSINESS_FEATURE_KIND_REGISTRY)).toBe(true);
    expect(BUSINESS_FEATURE_KIND_REGISTRY).toEqual([]);
    expect(getBusinessFeatureKind("wallet")).toBeUndefined();
    expect(creatableFeatureKindsForRole("owner")).toEqual([]);
  });
  it("recognizes generic structural kinds without a registry entry", () => {
    expect(isKnownProjectKind("workspace")).toBe(true);
    expect(isKnownProjectKind("customer_bot")).toBe(true);
    expect(getBusinessFeatureKind("workspace")).toBeUndefined();
    expect(isKnownProjectKind("not_a_kind")).toBe(false);
  });
  it("retains role ranking for future scoped extension capabilities", () => {
    expect(roleMeetsMinimum("owner", "admin")).toBe(true);
    expect(roleMeetsMinimum("editor", "admin")).toBe(false);
    expect(roleMeetsMinimum("admin", "admin")).toBe(true);
    expect(roleMeetsMinimum("viewer", "editor")).toBe(false);
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


});
