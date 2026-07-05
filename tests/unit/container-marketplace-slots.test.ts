import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { app as agentsApp } from "../../workers/agents/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { mintInternalToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.17 Phase L: Container Marketplace slot registry. Every catalogue image ships
// `available:false` this pass (see container-catalogue.ts's own header for why) — these tests
// verify the REAL, tested parts: the catalogue endpoint, the slot CRUD + limit enforcement, and
// that creating a slot for an unavailable/unknown image is honestly rejected rather than silently
// "succeeding" into a registry row nothing will ever actually run against.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

function makeAgentsEnv() {
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
  };
}

describe("GET /container-images (agents worker catalogue)", () => {
  it("returns the catalogue with every entry currently unavailable", async () => {
    const res = await agentsApp.fetch(new Request("https://agents.naelao.com/container-images"), makeAgentsEnv() as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { images: Array<{ id: string; available: boolean }> };
    expect(body.images.length).toBeGreaterThan(0);
    expect(body.images.every((i) => i.available === false)).toBe(true);
    expect(body.images.map((i) => i.id)).toContain("postgres-16");
  });
});

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;

function makeConfigKv(catalogueImages: Array<{ id: string; name: string; available: boolean; billing_tier: string }>) {
  return {
    async get(key: string) {
      if (key === "container-image-catalogue") return catalogueImages;
      // Short-circuits loadManifest's cache-miss path (which would otherwise reach a
      // SPACE_TYPE_REGISTRY_DO binding this test env doesn't provide) with an empty base
      // manifest — loadEffectiveProductConfig still returns the space's own config_json
      // override (containerMarketplace.maxSlotsPerProject) on top of it.
      if (key === "space-type-manifest:launchpad") return { productConfig: {} };
      return null;
    },
    async put() {},
  };
}

function namedFetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: async (req: Request) => handler(req) } as unknown as Fetcher;
}

function makeEnv(opts: { maxSlots?: number; catalogueImages?: Array<{ id: string; name: string; available: boolean; billing_tier: string }> } = {}) {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  const configJson = JSON.stringify({ productConfig: { containerMarketplace: { maxSlotsPerProject: opts.maxSlots ?? 2 } } });
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, name, config_json) VALUES ('prod-1', 'tenant-1', 'active', 'Product Root', '${configJson.replace(/'/g, "''")}')`);
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
    NAELAO_CONFIG_KV: makeConfigKv(opts.catalogueImages ?? [
      { id: "postgres-16", name: "PostgreSQL 16", available: false, billing_tier: "pro" },
      { id: "ffmpeg", name: "FFmpeg", available: true, billing_tier: "free" },
    ]),
    AGENTS_WORKER: namedFetcher(() => Response.json({ images: [] })), // KV hit above short-circuits this
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

async function createProject(env: ReturnType<typeof makeEnv>, headers: Record<string, string>): Promise<string> {
  const res = await spacesWorker.fetch(
    req("/spaces/prod-1/projects", headers, { method: "POST", body: JSON.stringify({ name: "P" }) }),
    env as never, execCtx
  );
  const body = await res.json() as { id: string };
  return body.id;
}

describe("container-slots CRUD (SpaceDO + spaces-worker validation)", () => {
  it("rejects creating a slot for an image that doesn't exist in the catalogue", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const projectId = await createProject(env, headers);

    const res = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "nonexistent" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a slot for a real but UNAVAILABLE (coming_soon) image", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const projectId = await createProject(env, headers);

    const res = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "postgres-16" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("not_available");
  });

  it("creates a slot for an available image, lists it, and deletes it", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const projectId = await createProject(env, headers);

    const createRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "ffmpeg", slot_name: "transcoder" }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const { id: slotId } = await createRes.json() as { id: string };

    const listRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers), env as never, execCtx);
    const list = await listRes.json() as { data: Array<{ id: string; image_id: string }>; count: number };
    expect(list.count).toBe(1);
    expect(list.data[0]!.image_id).toBe("ffmpeg");

    const deleteRes = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots/${slotId}`, headers, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(deleteRes.status).toBe(200);

    const afterRes = await spacesWorker.fetch(req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers), env as never, execCtx);
    const after = await afterRes.json() as { count: number };
    expect(after.count).toBe(0);
  });

  it("enforces the product's configured slot-per-project limit", async () => {
    const env = makeEnv({ maxSlots: 1 });
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const projectId = await createProject(env, headers);

    const first = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "ffmpeg" }) }),
      env as never, execCtx
    );
    expect(first.status).toBe(201);

    const second = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "ffmpeg" }) }),
      env as never, execCtx
    );
    expect(second.status).toBe(409);
    const body = await second.json() as { error_code: string };
    expect(body.error_code).toBe("slot_limit_reached");
  });

  it("a default product (no containerMarketplace override) allows zero slots", async () => {
    const env = makeEnv({ maxSlots: 0 });
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const projectId = await createProject(env, headers);

    const res = await spacesWorker.fetch(
      req(`/spaces/prod-1/projects/${projectId}/container-slots`, headers, { method: "POST", body: JSON.stringify({ image_id: "ffmpeg" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(409);
  });

  it("rejects a request with no internal token entirely (requireInternalHmac floor)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/prod-1/projects/proj-x/container-slots"),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});
