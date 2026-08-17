import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// WS-2: the Space Assistant surface's read-only panels (Memory/Channels/Sub-agents/Files) — a
// product_end_user is allowed through ONLY when they're actually a member of the target business
// (or it's their own product root), verified via a cross-worker call to the spaces worker's
// /internal/business-role. A builder JWT role skips this check entirely (additive-only, matching
// every other end-user floor in this codebase).

const SECRET = "test-platform-secret";

function makeSpacesWorkerStub(businessRoleOk: boolean): Fetcher {
  return {
    fetch: async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(typeof input === "string" ? input : req.url);
      if (url.pathname === "/internal/business-role") {
        return businessRoleOk ? Response.json({ role: "member" }) : Response.json({ error_code: "forbidden" }, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

function makeAgentDoStub() {
  const calls: string[] = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const req = reqInput as Request;
      calls.push(new URL(req.url).pathname + new URL(req.url).search);
      return Response.json({ ok: true });
    },
  };
  return { agentDoStub, calls };
}

function makeEnv(opts: { spacesOk: boolean; withR2?: boolean }): AgentsEnv & { __calls: string[] } {
  const { agentDoStub, calls } = makeAgentDoStub();
  const r2Objects = [
    { key: "spaces/space1/workspace/.keep", size: 0, uploaded: new Date() },
    { key: "spaces/space1/workspace/notes.txt", size: 42, uploaded: new Date() },
  ];
  const r2Store: Record<string, { text: string; size: number }> = {
    "spaces/space1/workspace/notes.txt": { text: "hello from R2", size: 42 },
    "spaces/space1/workspace/big.bin": { text: "x".repeat(3 * 1024 * 1024), size: 3 * 1024 * 1024 },
  };
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    SPACES_WORKER: makeSpacesWorkerStub(opts.spacesOk),
    PLATFORM_DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ channel: "slack", enabled: 1, created_at: "2026-01-01" }] }),
        }),
      }),
    } as unknown as D1Database,
    ...(opts.withR2 ? {
      SCRIPTS_R2: {
        list: async () => ({ objects: r2Objects, truncated: false }),
        get: async (key: string) => {
          const found = r2Store[key];
          if (!found) return null;
          return { size: found.size, text: async () => found.text };
        },
      } as unknown as R2Bucket,
    } : {}),
    ANALYTICS: { writeDataPoint() {} },
    __calls: calls,
  } as unknown as AgentsEnv & { __calls: string[] };
}

// Go-live audit F1: these routes now require the same signed x-naelao-internal-token /agent/run
// has always required (this worker has no workers_dev=false backstop, so a bare spoofed
// x-naelao-tenant-id can no longer be trusted). naelao-router's proxyTo mints exactly this token
// for every real request; the test mirrors that by minting one for the caller's tenant whenever a
// tenant header is present (a tokenless caller still gets 401, as the "no tenant identity" case
// asserts).
async function req(path: string, headers: Record<string, string>, method = "GET"): Promise<Request> {
  const tenantId = headers["x-naelao-tenant-id"];
  const withToken = tenantId
    ? { ...headers, "x-naelao-internal-token": await mintInternalToken(SECRET, tenantId) }
    : headers;
  return new Request(`https://agents.naelao.com${path}`, { method, headers: withToken });
}

describe("WS-2 — Space Assistant surface routes require business membership for product_end_user", () => {
  const ROUTES = [
    "/spaces/space1/assistant/memory",
    "/spaces/space1/assistant/channels",
    "/spaces/space1/assistant/sub-agents",
    "/spaces/space1/assistant/files",
  ];

  for (const path of ROUTES) {
    it(`${path}: denies a product_end_user who isn't a member`, async () => {
      const env = makeEnv({ spacesOk: false, withR2: true });
      const res = await app.fetch(await req(path, { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-1" }), env);
      expect(res.status).toBe(403);
    });

    it(`${path}: allows a product_end_user who IS a member`, async () => {
      const env = makeEnv({ spacesOk: true, withR2: true });
      const res = await app.fetch(await req(path, { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-1" }), env);
      expect(res.status).toBe(200);
    });

    it(`${path}: allows a builder JWT role without any business-role check`, async () => {
      const env = makeEnv({ spacesOk: false, withR2: true }); // spacesOk:false proves the check is skipped
      const res = await app.fetch(await req(path, { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner", "x-naelao-user-id": "owner-1" }), env);
      expect(res.status).toBe(200);
    });
  }

  it("rejects any caller with no tenant identity at all", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/memory", {}), env);
    expect(res.status).toBe(401);
  });

  it("files panel lists real R2 objects, hiding the .keep placeholder", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = await res.json() as { data: Array<{ path: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.data[0]!.path).toBe("notes.txt");
  });

  it("files panel degrades honestly (503) when SCRIPTS_R2 isn't bound", async () => {
    const env = makeEnv({ spacesOk: true, withR2: false });
    const res = await app.fetch(await req("/spaces/space1/assistant/files", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(503);
  });
});

// Phase 5: the per-file content route (/assistant/files/*) — previously list-only ("never file
// contents", per the old doc comment); the Files side-panel tab now needs open/preview for the
// space-wide assistant workspace the same way the project-scoped workspace already had it.
describe("GET /spaces/:spaceId/assistant/files/* — per-file content read", () => {
  it("returns real file content for a text file", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/notes.txt", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; size: number; content: string };
    expect(body).toMatchObject({ path: "notes.txt", content: "hello from R2" });
  });

  it("404s for a file that doesn't exist", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/nope.txt", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(404);
  });

  it("reports too_large rather than the raw bytes for a file over the 2MB cap", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/big.bin", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { too_large: boolean; content?: string };
    expect(body.too_large).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it("collapses ../ traversal server-side rather than escaping the space's own workspace prefix", async () => {
    const env = makeEnv({ spacesOk: true, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/..%2F..%2Fnotes.txt", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    // Traversal segments are stripped, so this resolves to the same real notes.txt — not a 4xx
    // that would suggest the raw path was passed through to R2.get() unsanitized.
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path).toBe("notes.txt");
  });

  it("denies a product_end_user who isn't a member of this business", async () => {
    const env = makeEnv({ spacesOk: false, withR2: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/notes.txt", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-1" }), env);
    expect(res.status).toBe(403);
  });

  it("degrades honestly (503) when SCRIPTS_R2 isn't bound", async () => {
    const env = makeEnv({ spacesOk: true, withR2: false });
    const res = await app.fetch(await req("/spaces/space1/assistant/files/notes.txt", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(503);
  });
});

// Phase 5: the Artifacts panel — proxies to the (now-hardened) artifact worker via a direct
// service binding, minting the exact internal token that worker's own requireInternalHmac gate
// requires. Business-membership gating is identical to every other assistant surface route above.
describe("GET/DELETE /spaces/:spaceId/assistant/artifacts[/*] — artifact worker proxy", () => {
  function makeArtifactEnv(opts: { spacesOk: boolean; withArtifactWorker?: boolean }): AgentsEnv {
    const { agentDoStub } = makeAgentDoStub();
    const store = new Map<string, { filename: string; content: string; content_type: string }>();
    store.set("art-1", { filename: "report.html", content: "<h1>hi</h1>", content_type: "text/html" });
    const artifactFetcher: Fetcher = {
      fetch: async (input: RequestInfo) => {
        const r = input as Request;
        const url = new URL(r.url);
        if (r.method === "GET" && url.pathname === "/spaces/space1/artifacts") {
          return Response.json({
            data: [...store.entries()].map(([id, v]) => ({ artifact_id: id, filename: v.filename, content_type: v.content_type, size: v.content.length, uploaded: "2026-01-01" })),
            count: store.size,
          });
        }
        if (r.method === "GET" && url.pathname.startsWith("/spaces/space1/artifacts/")) {
          const id = url.pathname.split("/").pop()!;
          const found = store.get(id);
          if (!found) return new Response(JSON.stringify({ error_code: "not_found" }), { status: 404 });
          return new Response(found.content, { headers: { "content-type": found.content_type, "x-artifact-filename": found.filename } });
        }
        if (r.method === "DELETE" && url.pathname.startsWith("/spaces/space1/artifacts/")) {
          const id = url.pathname.split("/").pop()!;
          if (!store.has(id)) return new Response(JSON.stringify({ error_code: "not_found" }), { status: 404 });
          store.delete(id);
          return Response.json({ deleted: true, count: 1 });
        }
        return new Response("not found", { status: 404 });
      },
    } as unknown as Fetcher;
    return {
      PLATFORM_SECRET: SECRET,
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
      SPACES_WORKER: makeSpacesWorkerStub(opts.spacesOk),
      ...(opts.withArtifactWorker !== false ? { ARTIFACT_WORKER: artifactFetcher } : {}),
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as AgentsEnv;
  }

  it("lists real artifacts from the artifact worker", async () => {
    const env = makeArtifactEnv({ spacesOk: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/artifacts", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ artifact_id: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.data[0]!.artifact_id).toBe("art-1");
  });

  it("fetches real artifact content, JSON-wrapped (matching the Files viewer's own contract)", async () => {
    const env = makeArtifactEnv({ spacesOk: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/artifacts/art-1", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_id: string; filename: string; content_type: string; content: string };
    expect(body).toMatchObject({ artifact_id: "art-1", filename: "report.html", content_type: "text/html", content: "<h1>hi</h1>" });
  });

  it("404s for an artifact that doesn't exist", async () => {
    const env = makeArtifactEnv({ spacesOk: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/artifacts/nope", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(404);
  });

  it("deletes an artifact — a following list no longer has it", async () => {
    const env = makeArtifactEnv({ spacesOk: true });
    const delRes = await app.fetch(await req("/spaces/space1/assistant/artifacts/art-1", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }, "DELETE"), env);
    expect(delRes.status).toBe(200);
    const listRes = await app.fetch(await req("/spaces/space1/assistant/artifacts", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = (await listRes.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  it("denies a product_end_user who isn't a member of this business", async () => {
    const env = makeArtifactEnv({ spacesOk: false });
    const res = await app.fetch(await req("/spaces/space1/assistant/artifacts", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "product_end_user", "x-naelao-user-id": "user-1" }), env);
    expect(res.status).toBe(403);
  });

  it("degrades honestly (503) when ARTIFACT_WORKER isn't bound", async () => {
    const env = makeArtifactEnv({ spacesOk: true, withArtifactWorker: false });
    const res = await app.fetch(await req("/spaces/space1/assistant/artifacts", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(res.status).toBe(503);
  });
});

describe("WS-2 — other assistant surface panels", () => {
  it("channels panel reads real channel_links rows", async () => {
    const env = makeEnv({ spacesOk: true });
    const res = await app.fetch(await req("/spaces/space1/assistant/channels", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = await res.json() as { data: Array<{ channel: string; enabled: number }> };
    expect(body.data[0]).toMatchObject({ channel: "slack", enabled: 1 });
  });

  it("sub-agents panel forwards parent_run_id to the agent DO", async () => {
    const env = makeEnv({ spacesOk: true });
    await app.fetch(await req("/spaces/space1/assistant/sub-agents?parent_run_id=run-42", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    expect(env.__calls.some((c) => c.includes("parent_run_id=run-42"))).toBe(true);
  });
});

// Channels side-panel scoping: ?project_id=X scopes to that project's own channel link,
// ?scope=assistant scopes to the space-wide ones (project_id IS NULL), neither stays unfiltered
// (Dashboard overview / dedicated Assistant page, which predate this scoping and want everything).
describe("assistant/channels — project scoping", () => {
  function makeScopedEnv(): AgentsEnv & { __sql: Array<{ sql: string; args: unknown[] }> } {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const rows = [
      { channel: "slack", enabled: 1, created_at: "2026-01-01", project_id: null },
      { channel: "discord", enabled: 1, created_at: "2026-01-01", project_id: "proj-1" },
    ];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => {
            calls.push({ sql, args });
            if (/project_id = \?/.test(sql)) return { results: rows.filter((r) => r.project_id === args[1]) };
            if (/project_id IS NULL/.test(sql)) return { results: rows.filter((r) => r.project_id === null) };
            return { results: rows };
          },
        }),
      }),
    };
    return {
      PLATFORM_SECRET: SECRET,
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => ({ async fetch() { return Response.json({ ok: true }); } }) },
      SPACES_WORKER: makeSpacesWorkerStub(true),
      PLATFORM_DB: db as unknown as D1Database,
      ANALYTICS: { writeDataPoint() {} },
      __sql: calls,
    } as unknown as AgentsEnv & { __sql: typeof calls };
  }

  it("?scope=assistant returns only project_id IS NULL rows", async () => {
    const env = makeScopedEnv();
    const res = await app.fetch(await req("/spaces/space1/assistant/channels?scope=assistant", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = await res.json() as { data: Array<{ channel: string; project_id: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.channel).toBe("slack");
  });

  it("?project_id=proj-1 returns only that project's own channel", async () => {
    const env = makeScopedEnv();
    const res = await app.fetch(await req("/spaces/space1/assistant/channels?project_id=proj-1", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = await res.json() as { data: Array<{ channel: string; project_id: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.channel).toBe("discord");
  });

  it("no param returns everything (Dashboard overview / dedicated Assistant page compat)", async () => {
    const env = makeScopedEnv();
    const res = await app.fetch(await req("/spaces/space1/assistant/channels", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "owner" }), env);
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });
});

// Sanity: mintInternalToken importable in this test's dependency graph (mirrors the pattern used
// by requireEndUserBusinessMembership itself).
describe("sanity", () => {
  it("mintInternalToken is importable", async () => {
    const token = await mintInternalToken(SECRET, "tenant1");
    expect(typeof token).toBe("string");
  });
});
