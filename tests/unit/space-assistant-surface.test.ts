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
async function req(path: string, headers: Record<string, string>): Promise<Request> {
  const tenantId = headers["x-naelao-tenant-id"];
  const withToken = tenantId
    ? { ...headers, "x-naelao-internal-token": await mintInternalToken(SECRET, tenantId) }
    : headers;
  return new Request(`https://agents.naelao.com${path}`, { headers: withToken });
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

// Sanity: mintInternalToken importable in this test's dependency graph (mirrors the pattern used
// by requireEndUserBusinessMembership itself).
describe("sanity", () => {
  it("mintInternalToken is importable", async () => {
    const token = await mintInternalToken(SECRET, "tenant1");
    expect(typeof token).toBe("string");
  });
});
