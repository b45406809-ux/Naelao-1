import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Three-Tier Platform Model, Phase 6 (Product Shell, §A1.17): the shell's data layer.
//  - GET /spaces/:spaceId/shell/manifest is a SAFE PROJECTION of the SpaceType manifest, reachable
//    both by an authenticated caller (builder JWT or product end-user session) and a pre-login
//    visitor (the login page needs branding before any token exists) — never leaks
//    agentEnvironment/backend/lifecycle or builder-only productConfig fields.
//  - GET/PATCH /spaces/:spaceId/product-users/me resolves ONLY from the caller's own verified
//    identity — there is no way to pass someone else's end_user_id and read their profile.
//  - GET /spaces/:spaceId/sessions (list) is a NEW capability distinct from the deliberately
//    builder-only /threads — for a product end user it is filtered to their own sessions only,
//    derived server-side from claims, never a client-supplied query param.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const CREDENTIALS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0046_product_end_user_credentials.sql"), "utf8");

const FAKE_MANIFEST = {
  id: "launchpad",
  name: "Launchpad",
  description: "d",
  version: "2.0.0",
  author: "naelao",
  icon: "rocket",
  tags: [],
  agentEnvironment: {
    defaultExecutionTier: "workspace", containerIdleTimeoutMs: 1, loopModel: "chat",
    alwaysLoadedSkills: ["secret-internal-skill"], disabledSkills: [], networkPolicy: "open",
    maxContextTokens: 1, agentPermissions: ["secret-permission"],
  },
  backend: { platformDOs: [], workflowTemplates: [], cronJobs: [], r2Prefixes: [], resourceBudget: {
    maxDOsPerInstance: 1, maxR2WritesPerDay: 1, maxContainerHoursPerDay: 1, maxLLMTokensPerDay: 1,
    maxCronJobsPerInstance: 1, maxWorkflowsPerInstance: 1,
  } },
  ui: {
    operatorShell: {
      sidebarItems: [{ id: "revenue", label: "Revenue", icon: "dollar", path: "/revenue" }],
      dashboardWidgets: [], hiddenCoreItems: [], defaultView: "revenue",
    },
    externalPortal: { enabled: true, deploymentType: "dynamic-worker", templateId: "t", defaultSlug: "shop", customDomain: true, authModel: "customer-auth" },
  },
  lifecycle: {},
  marketplace: { visible: true, minimumNaelaoPlan: "free" },
  productConfig: {
    membershipModel: "team", assistantMode: "per-user", allowPublicSignup: true,
    branding: { brandColor: "#e8692a", logoUrl: "https://x/logo.png" },
    authProvider: { provider: "naelao-native" },
    commerce: { enabled: true, naelaoFeeBps: 500 },
  },
};

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUILDER_DASHBOARD_MIGRATION, CREDENTIALS_MIGRATION]);
  const kvStore = new Map<string, string>();
  kvStore.set("space-type-manifest:launchpad", JSON.stringify(FAKE_MANIFEST));
  return {
    PLATFORM_SECRET: "test-platform-secret",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    NAELAO_CONFIG_KV: {
      get: async (key: string, type?: string) => {
        const raw = kvStore.get(key) ?? null;
        if (raw === null) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => { kvStore.set(key, value); },
    },
  };
}

async function seedSpace(env: ReturnType<typeof makeEnv>, id: string, tenantId: string) {
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id) VALUES (?, ?, 'active', 'Acme Store', 'launchpad')"
  ).bind(id, tenantId).run();
}

function authedReq(path: string, headers: Record<string, string> = {}, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
}

describe("GET /spaces/:spaceId/shell/manifest", () => {
  it("returns a safe projection for an authenticated (tenant-matched) caller", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(
      authedReq("/spaces/prod-1/shell/manifest", { "x-naelao-tenant-id": "tenant-1" }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.space_name).toBe("Acme Store");
    expect(body.manifest_name).toBe("Launchpad");
    expect((body.ui as { sidebar_items: unknown[] }).sidebar_items).toHaveLength(1);
    expect((body.branding as { brand_color: string }).brand_color).toBe("#e8692a");
    expect(body.auth_provider).toBe("naelao-native");
  });

  it("returns the SAME safe projection for a pre-login caller with no tenant at all", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.manifest_name).toBe("Launchpad");
    expect(body.allow_public_signup).toBe(true);
  });

  it("never serializes internal manifest fields (agentEnvironment, backend, lifecycle, marketplace, commerce)", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    const raw = await res.text();
    expect(raw).not.toContain("secret-internal-skill");
    expect(raw).not.toContain("secret-permission");
    expect(raw).not.toContain("agentEnvironment");
    expect(raw).not.toContain("resourceBudget");
    expect(raw).not.toContain("naelaoFeeBps");
    expect(raw).not.toContain("commerce");
  });

  it("404s for a nonexistent space", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(authedReq("/spaces/no-such-space/shell/manifest"), env as never, execCtx);
    expect(res.status).toBe(404);
  });
});

describe("GET/PATCH /spaces/:spaceId/product-users/me", () => {
  async function signupEndUser(env: ReturnType<typeof makeEnv>, spaceId: string) {
    const res = await spacesWorker.fetch(
      authedReq(`/spaces/${spaceId}/end-users/signup`, {}, { method: "POST", body: JSON.stringify({ email: "jane@acme.com", password: "hunter22" }) }),
      env as never, execCtx
    );
    return res.json() as Promise<{ end_user_id: string; session_token: string }>;
  }

  it("returns the caller's own profile + credit balance", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const signup = await signupEndUser(env, "prod-1");
    const res = await spacesWorker.fetch(
      authedReq("/spaces/prod-1/product-users/me", {
        "x-naelao-role": "product_end_user", "x-naelao-user-id": signup.end_user_id, "x-naelao-tenant-id": "tenant-1",
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { email: string; credits_balance: number; end_user_id: string };
    expect(body.email).toBe("jane@acme.com");
    expect(body.end_user_id).toBe(signup.end_user_id);
    expect(body.credits_balance).toBe(0);
  });

  it("404s for a non-end-user (builder) caller", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(
      authedReq("/spaces/prod-1/product-users/me", { "x-naelao-role": "owner", "x-naelao-user-id": "u1", "x-naelao-tenant-id": "tenant-1" }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("PATCH updates display_name and GET reflects it", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const signup = await signupEndUser(env, "prod-1");
    const headers = { "x-naelao-role": "product_end_user", "x-naelao-user-id": signup.end_user_id, "x-naelao-tenant-id": "tenant-1" };
    const patchRes = await spacesWorker.fetch(
      authedReq("/spaces/prod-1/product-users/me", headers, { method: "PATCH", body: JSON.stringify({ display_name: "Jane D." }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(200);
    const getRes = await spacesWorker.fetch(authedReq("/spaces/prod-1/product-users/me", headers), env as never, execCtx);
    const body = await getRes.json() as { display_name: string };
    expect(body.display_name).toBe("Jane D.");
  });
});

describe("GET /spaces/:spaceId/sessions (list)", () => {
  async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await mintInternalToken("test-platform-secret", tenantId);
    return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
  }

  async function createSession(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string, endUserId?: string) {
    const res = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/${spaceId}/sessions`, {
        method: "POST",
        headers: await internalHeaders(tenantId),
        body: JSON.stringify({ space_id: spaceId, tenant_id: tenantId, end_user_id: endUserId }),
      }),
      env as never, execCtx
    );
    if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string }>;
  }

  it("a product end user's list is filtered to their own sessions only", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    await createSession(env, "prod-1", "tenant-1", "user-a");
    await createSession(env, "prod-1", "tenant-1", "user-a");
    await createSession(env, "prod-1", "tenant-1", "user-b");

    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { end_user_id: string }[]; count: number };
    expect(body.count).toBe(2);
    expect(body.data.every((s) => s.end_user_id === "user-a")).toBe(true);
  });

  it("ignores a client-supplied end_user_id query param and uses the caller's own claims instead", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    await createSession(env, "prod-1", "tenant-1", "user-a");
    await createSession(env, "prod-1", "tenant-1", "user-b");

    // Caller is authenticated as user-a but tries to spoof user-b's sessions via the query string.
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions?end_user_id=user-b", {
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" }),
      }),
      env as never, execCtx
    );
    const body = await res.json() as { data: { end_user_id: string }[] };
    expect(body.data.every((s) => s.end_user_id === "user-a")).toBe(true);
  });

  it("a builder-role caller (no end_user_id filter) sees the space-wide list", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    await createSession(env, "prod-1", "tenant-1", "user-a");
    await createSession(env, "prod-1", "tenant-1", "user-b");

    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" }),
      }),
      env as never, execCtx
    );
    const body = await res.json() as { count: number };
    expect(body.count).toBe(2);
  });
});

describe("GET /products/by-slug/:slug", () => {
  it("resolves an active product's space id + safe branding from its slug, with no credentials at all", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, product_slug) VALUES ('prod-1', 'tenant-1', 'active', 'Acme Store', 'launchpad', 'acme-store')"
    ).bind().run();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/products/by-slug/acme-store"), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.space_id).toBe("prod-1");
    expect(body.product_name).toBe("Acme Store");
    expect(body.brand_color).toBe("#e8692a");
    expect(body.auth_provider).toBe("naelao-native");
  });

  it("404s for an unknown slug", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/products/by-slug/no-such-slug"), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("404s for a slug belonging to a non-active (e.g. suspended) product", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, product_slug) VALUES ('prod-2', 'tenant-1', 'suspended', 'Suspended Co', 'launchpad', 'suspended-co')"
    ).bind().run();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/products/by-slug/suspended-co"), env as never, execCtx);
    expect(res.status).toBe(404);
  });

  it("never leaks internal manifest or productConfig fields not in the safe projection", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, product_slug) VALUES ('prod-1', 'tenant-1', 'active', 'Acme Store', 'launchpad', 'acme-store')"
    ).bind().run();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/products/by-slug/acme-store"), env as never, execCtx);
    const raw = await res.text();
    expect(raw).not.toContain("secret-internal-skill");
    expect(raw).not.toContain("naelaoFeeBps");
    expect(raw).not.toContain("commerce");
  });
});
