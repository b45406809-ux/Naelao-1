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
    config_json TEXT NOT NULL DEFAULT '{}', product_slug TEXT, parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const USERS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0001_users.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const CREDENTIALS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0046_product_end_user_credentials.sql"), "utf8");
const EMAIL_VERIFICATION_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0055_email_verification.sql"), "utf8");
const SPACE_MEMBERS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0021_space_members.sql"), "utf8");
const PRODUCT_END_USER_LANGUAGE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0096_product_end_user_language.sql"), "utf8");

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

const FAKE_TEMPLATES = [
  { id: "creator-store", name: "Creator Store", description: "d", free_tier_eligible: true, connectors: [], coming_soon: true },
  { id: "whop-seller", name: "Whop Seller", description: "d", free_tier_eligible: false, connectors: ["whop"], coming_soon: false },
  { id: "micro-saas", name: "Micro-SaaS", description: "d", free_tier_eligible: false, connectors: [], coming_soon: true },
];

const FAKE_PROJECT_TEMPLATES = [
  { id: "community-member-monitoring", name: "Community Member Monitoring", description: "d" },
];
const FAKE_AGENTS = [{ id: "launchpad-support-v1", name: "Support Agent", description: "d" }];

function makeEnv(opts: { withAgentsWorker?: boolean; templateFetchCalls?: number[] } = {}) {
  const fakeDb = createFakeD1([USERS_MIGRATION, SPACES_TABLE_SQL, BUILDER_DASHBOARD_MIGRATION, CREDENTIALS_MIGRATION, EMAIL_VERIFICATION_MIGRATION, SPACE_MEMBERS_MIGRATION, PRODUCT_END_USER_LANGUAGE_MIGRATION]);
  const kvStore = new Map<string, string>();
  kvStore.set("space-type-manifest:v2:launchpad", JSON.stringify(FAKE_MANIFEST));
  // Routes by path like the real agents worker: the manifest handler now fetches TWO catalogues
  // (GET /templates for business templates, GET /catalog/shell for the Discover page's project
  // presets + agents). A stub that answered every path with the template payload would let a
  // wrong-path regression pass silently, and would make templateFetchCalls count both.
  const agentsWorker = opts.withAgentsWorker
    ? {
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === "/catalog/shell") {
            return new Response(JSON.stringify({ project_templates: FAKE_PROJECT_TEMPLATES, agents: FAKE_AGENTS }), { status: 200 });
          }
          if (opts.templateFetchCalls) opts.templateFetchCalls.push(1);
          return new Response(JSON.stringify({ templates: FAKE_TEMPLATES }), { status: 200 });
        },
      }
    : undefined;
  return {
    PLATFORM_SECRET: "test-platform-secret",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    AGENTS_WORKER: agentsWorker,
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
  for (const endUserId of ["user-a", "user-b"]) {
    await env.PLATFORM_DB.prepare(
      "INSERT INTO space_members (id, space_id, tenant_id, end_user_id, role) VALUES (?, ?, ?, ?, 'member')"
    ).bind(`member-${id}-${endUserId}`, id, tenantId, endUserId).run();
  }
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

  // Phase C (§A1.17): membership_model + allowed_child_space_types tell the shell whether to show
  // a "Create Business" entry point at all — the manifest's base productConfig is "team", so a
  // product without a per-space override never shows it.
  it("exposes membership_model (team, from the manifest base) and an empty allowed_child_space_types", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { membership_model: string; allowed_child_space_types: string[] };
    expect(body.membership_model).toBe("team");
    expect(body.allowed_child_space_types).toEqual([]);
  });

  it("a per-space hybrid override surfaces membership_model + allowed_child_space_types for real", async () => {
    const env = makeEnv();
    await env.PLATFORM_DB.prepare(
      `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json) VALUES
       ('prod-hybrid', 'tenant-1', 'launchpad', 'Hybrid Store', 'active', ?)`
    ).bind(JSON.stringify({ productConfig: { membershipModel: "hybrid", allowedChildSpaceTypes: ["launchpad"] } })).run();
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-hybrid/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { membership_model: string; allowed_child_space_types: string[] };
    expect(body.membership_model).toBe("hybrid");
    expect(body.allowed_child_space_types).toEqual(["launchpad"]);
  });

  // Phase D (§A1.17): productConfig.catalog.businessTemplates narrows the shell's create-business
  // template picker below "every template the SpaceType ships."
  it("exposes an empty business_templates by default and the configured list when set", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const defaultRes = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    expect(((await defaultRes.json()) as { business_templates: string[] }).business_templates).toEqual([]);

    await env.PLATFORM_DB.prepare(
      `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json) VALUES
       ('prod-catalog', 'tenant-1', 'launchpad', 'Catalog Store', 'active', ?)`
    ).bind(JSON.stringify({ productConfig: { catalog: { businessTemplates: ["creator-store", "micro-saas"] } } })).run();
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-catalog/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { business_templates: string[] };
    expect(body.business_templates).toEqual(["creator-store", "micro-saas"]);
  });

  // Phase F (§A1.17): template_catalog is the real, coming_soon-aware catalog the shell's
  // create-business dialog and the dashboard's Templates Catalog config both render from —
  // replacing two hand-maintained, drift-prone hardcoded copies of LAUNCHPAD_TEMPLATES.
  it("returns an empty template_catalog when no AGENTS_WORKER binding is configured", async () => {
    const env = makeEnv({ withAgentsWorker: false });
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { template_catalog: unknown[] };
    expect(body.template_catalog).toEqual([]);
  });

  it("fetches the real catalog (with coming_soon) from the agents worker's GET /templates", async () => {
    const env = makeEnv({ withAgentsWorker: true });
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { template_catalog: Array<{ id: string; name: string; coming_soon: boolean }> };
    expect(body.template_catalog).toHaveLength(3);
    expect(body.template_catalog.find((t) => t.id === "whop-seller")).toMatchObject({ coming_soon: false });
    expect(body.template_catalog.find((t) => t.id === "creator-store")).toMatchObject({ coming_soon: true });
  });

  it("intersects the real catalog with the builder's business_templates narrowing", async () => {
    const calls: number[] = [];
    const env = makeEnv({ withAgentsWorker: true, templateFetchCalls: calls });
    await env.PLATFORM_DB.prepare(
      `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json) VALUES
       ('prod-narrow', 'tenant-1', 'launchpad', 'Narrow Store', 'active', ?)`
    ).bind(JSON.stringify({ productConfig: { catalog: { businessTemplates: ["whop-seller"] } } })).run();
    const res = await spacesWorker.fetch(authedReq("/spaces/prod-narrow/shell/manifest"), env as never, execCtx);
    const body = await res.json() as { template_catalog: Array<{ id: string }> };
    // G-BF08: free_tier_eligible now flows through the catalogue projection so the shell's
    // create-business dialog can grey ineligible templates for free-plan products.
    expect(body.template_catalog).toEqual([{
      id: "whop-seller", name: "Whop Seller", description: "d", coming_soon: false,
      free_tier_eligible: false, connectors: ["whop"], template_mode: "ave",
      vertical: "Digital business", wallet_mode: "business_wallet",
    }]);
  });

  it("KV-caches the catalog fetch — a second call does not re-hit the agents worker", async () => {
    const calls: number[] = [];
    const env = makeEnv({ withAgentsWorker: true, templateFetchCalls: calls });
    await seedSpace(env, "prod-1", "tenant-1");
    await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    await spacesWorker.fetch(authedReq("/spaces/prod-1/shell/manifest"), env as never, execCtx);
    expect(calls).toHaveLength(1);
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
    const body = await res.json() as { email: string; credits_balance: number; end_user_id: string; email_verified: boolean };
    expect(body.email).toBe("jane@acme.com");
    expect(body.end_user_id).toBe(signup.end_user_id);
    // Security audit follow-up: the platform free-tier default (100 credits) no longer grants
    // immediately at signup — it's deferred until the signup verification email is redeemed
    // (closes the free-credit-farming hole; see product-end-user-routes.ts). 0/unverified is the
    // correct, expected state immediately after signup, before that redemption happens.
    expect(body.credits_balance).toBe(0);
    expect(body.email_verified).toBe(false);
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

  it("creates a session from an EMPTY body — the exact request apps/shell's startSession() sends, regression test for the NOT NULL space_id crash", async () => {
    // Unlike this file's own createSession() helper above (which always passes space_id/
    // tenant_id explicitly and so never exercised the bug), the real client
    // (apps/shell/src/lib/api.ts's startSession()) POSTs an empty body ({}) — SpaceDO.
    // createSession() reads space_id/tenant_id FROM the body, so every real end-user session
    // create bound NULL into a NOT NULL column and 500'd with "An unexpected error occurred"
    // on literally the shell's home page, confirmed live via wrangler tail against production.
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        method: "POST",
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" }),
        body: JSON.stringify({}),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; space_id: string };
    expect(body.id).toBeTruthy();
    expect(body.space_id).toBe("prod-1");
  });

  it("a session created from an empty body is readable by its own creator afterwards — regression test for the 'Session not found' bug", async () => {
    // The empty-body fix above stopped the 500 on create by injecting space_id/tenant_id — but a
    // first version of that fix left end_user_id out of the injected fields entirely, so every
    // end-user-created session landed with end_user_id NULL. getSession/getMessages both reject
    // any read whose end_user_id (from verified caller claims, S0.1) doesn't match the session's
    // own end_user_id — NULL never matches a real id, so the creator's own very next read of
    // their own brand-new session 404'd with "Session not found", confirmed live on the shell's
    // home page and new-thread pages. This drives the exact create-then-read sequence the real
    // client does and asserts the read succeeds.
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" });
    const createRes = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const { id: sessionId } = await createRes.json() as { id: string };

    const getRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}`, { headers }),
      env as never, execCtx
    );
    expect(getRes.status).toBe(200);
    const session = await getRes.json() as { end_user_id: string | null };
    expect(session.end_user_id).toBe("user-a");

    const messagesRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}/messages`, { headers }),
      env as never, execCtx
    );
    expect(messagesRes.status).toBe(200);
  });

  it("restricts product end-user message writes to the claim-owned session and ignores spoofed owner ids", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const ownerSession = await createSession(env, "prod-1", "tenant-1", "user-a");
    const otherSession = await createSession(env, "prod-1", "tenant-1", "user-b");
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" });

    const denied = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${otherSession.id}/messages?end_user_id=user-b`, {
        method: "POST", headers, body: JSON.stringify({ role: "user", content: "cross-user write" }),
      }),
      env as never, execCtx
    );
    expect(denied.status).toBe(404);

    const allowed = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${ownerSession.id}/messages?end_user_id=user-b`, {
        method: "POST", headers, body: JSON.stringify({ role: "user", content: "owner write" }),
      }),
      env as never, execCtx
    );
    expect(allowed.status).toBe(201);
    const messages = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${ownerSession.id}/messages`, { headers }),
      env as never, execCtx
    );
    expect((await messages.json() as { data: Array<{ content: string }> }).data.map((message) => message.content)).toEqual(["owner write"]);
  });

  it("a session the ASSISTANT creates on a user's behalf is readable by that user — regression test for thread.create still showing 'Session not found'", async () => {
    // The fix above covers a session the CLIENT creates (role: product_end_user). It did not cover
    // the one `thread.create` creates: the agents worker calls this route internally, proving
    // itself with an internal token and naming the acting user via x-naelao-user-id, but with NO
    // product_end_user role header. end_user_id was only ever derived for a product_end_user
    // caller, so the assistant's session landed owned by NOBODY — and getSession's ownership check
    // then rejected the very person who asked for the thread. The thread existed and was correctly
    // linked to a real session; it was simply unreadable, which surfaced as "Session not found".
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");

    // Exactly what prebuilt/project-coordination.ts's spacesCall sends: tenant + internal token +
    // the acting user, and a body carrying only thread_id.
    const agentHeaders = await internalHeaders("tenant-1", { "x-naelao-user-id": "user-a" });
    const createRes = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ thread_id: "thread-xyz" }),
      }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    // Now the person opens it in the shell, as a real product_end_user — the step that used to
    // 404. Asserted through the real read path rather than the create response, because that read
    // IS the thing that was broken.
    const userHeaders = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" });
    const getRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${created.id}`, { headers: userHeaders }),
      env as never, execCtx
    );
    expect(getRes.status).toBe(200); // was 404 "Session not found"
    const session = await getRes.json() as { end_user_id: string | null };
    expect(session.end_user_id).toBe("user-a"); // was null — the actual defect
  });

  it("still refuses a DIFFERENT end user access to an assistant-created session", async () => {
    // Widening end_user_id derivation must not widen who can read it.
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const createRes = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        method: "POST",
        headers: await internalHeaders("tenant-1", { "x-naelao-user-id": "user-a" }),
        body: JSON.stringify({ thread_id: "thread-xyz" }),
      }),
      env as never, execCtx
    );
    const { id } = await createRes.json() as { id: string };

    const intruder = await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-b" });
    const res = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${id}`, { headers: intruder }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

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

  // Reported bug: the Heartbeats panel showed real "N did work / N failed" counts but an empty
  // sessions list, and the Sessions page's heartbeat tab was empty too. A heartbeat/cron-wake
  // session is created by an INTERNAL caller (createHeartbeatSession — no end-user identity), so it
  // lands with end_user_id NULL, owned by the system. The panel reads as a product_end_user, whose
  // list is scoped `WHERE end_user_id = <them>` — which a NULL owner never matched, filtering every
  // heartbeat session out. Heartbeat sessions are business-level system artifacts, so a heartbeat
  // listing is deliberately NOT scoped by the caller's own id.
  async function createHeartbeatSession(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string): Promise<string> {
    // Exactly what workers/agents/src/index.ts's createHeartbeatSession sends: internal token,
    // tenant only, NO user role/header, and metadata tagging it a heartbeat wake.
    const res = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/${spaceId}/sessions`, {
        method: "POST",
        headers: await internalHeaders(tenantId),
        body: JSON.stringify({ metadata: { session_kind: "heartbeat", title: "Heartbeat — 2026-08-23 12:00" } }),
      }),
      env as never, execCtx
    );
    if (!res.ok) throw new Error(`createHeartbeatSession failed: ${res.status} ${await res.text()}`);
    return (await res.json() as { id: string }).id;
  }

  it("a product end user CAN see the space's heartbeat/cron-wake sessions (kind=heartbeat), even though they're owned by no user", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const hbId = await createHeartbeatSession(env, "prod-1", "tenant-1");
    await createSession(env, "prod-1", "tenant-1", "user-a"); // an ordinary user conversation

    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions?kind=heartbeat", {
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; end_user_id: string | null }[]; count: number };
    expect(body.count).toBe(1); // was 0 — the heartbeat session was filtered out by the end_user_id scope
    expect(body.data[0]!.id).toBe(hbId);
    expect(body.data[0]!.end_user_id).toBeNull(); // owned by the system, not user-a — that's the point
  });

  it("the ordinary (non-heartbeat) list still excludes heartbeat sessions and stays per-user", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    await createHeartbeatSession(env, "prod-1", "tenant-1");
    await createSession(env, "prod-1", "tenant-1", "user-a");

    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/sessions", {
        headers: await internalHeaders("tenant-1", { "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-a" }),
      }),
      env as never, execCtx
    );
    const body = await res.json() as { data: { end_user_id: string | null }[]; count: number };
    // Only user-a's own ordinary conversation — the heartbeat session is NOT in the ordinary list.
    expect(body.count).toBe(1);
    expect(body.data[0]!.end_user_id).toBe("user-a");
  });
});

// item 79 (inline consult cards): messages.metadata round-trips a real JSON object through POST
// and GET, so the client can render a card at the exact turn a consult happened without a second
// mechanism correlating threads to messages.
describe("messages.metadata (item 79)", () => {
  async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await mintInternalToken("test-platform-secret", tenantId);
    return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
  }

  async function createSession(env: ReturnType<typeof makeEnv>, spaceId: string, tenantId: string): Promise<string> {
    const res = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/${spaceId}/sessions`, {
        method: "POST", headers: await internalHeaders(tenantId), body: JSON.stringify({}),
      }),
      env as never, execCtx
    );
    return ((await res.json()) as { id: string }).id;
  }

  it("persists an assistant message's metadata and returns it, already parsed, on GET", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const sessionId = await createSession(env, "prod-1", "tenant-1");
    const metadata = { consulted_threads: [{ thread_id: "thread-9", agent_id: "wallet-agent", title: "Consult: wallet-agent", session_id: "sess-9" }] };

    const postRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: await internalHeaders("tenant-1"),
        body: JSON.stringify({ role: "assistant", content: "checked the wallet for you", agent_id: "naelao-agent", metadata }),
      }),
      env as never, execCtx
    );
    expect(postRes.status).toBe(201);
    expect((await postRes.json()) as { metadata: unknown }).toMatchObject({ metadata });

    const getRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}/messages`, { headers: await internalHeaders("tenant-1") }),
      env as never, execCtx
    );
    const body = (await getRes.json()) as { data: Array<{ content: string; metadata: unknown }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.metadata).toEqual(metadata);
  });

  it("an ordinary message with no metadata gets an empty object, not undefined or a raw string", async () => {
    const env = makeEnv();
    await seedSpace(env, "prod-1", "tenant-1");
    const sessionId = await createSession(env, "prod-1", "tenant-1");

    await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}/messages`, {
        method: "POST", headers: await internalHeaders("tenant-1"), body: JSON.stringify({ role: "user", content: "hi" }),
      }),
      env as never, execCtx
    );
    const getRes = await spacesWorker.fetch(
      new Request(`https://spaces.naelao.com/spaces/prod-1/sessions/${sessionId}/messages`, { headers: await internalHeaders("tenant-1") }),
      env as never, execCtx
    );
    const body = (await getRes.json()) as { data: Array<{ metadata: unknown }> };
    expect(body.data[0]!.metadata).toEqual({});
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
