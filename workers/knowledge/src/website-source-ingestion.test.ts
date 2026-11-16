import { mintInternalToken } from "@naelao/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkSsrf } = vi.hoisted(() => ({
  checkSsrf: vi.fn(async () => ({ blocked: false as const })),
}));
vi.mock("@naelao/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naelao/security")>();
  return { ...actual, checkSsrf };
});

import worker from "./index.js";

const connection = {
  id: "connection-1", tenant_id: "tenant-1", space_id: "space-1", owner_user_id: "owner-1",
  project_id: "project-1", origins_json: '["https://docs.example"]', status: "active",
};

function fixture(options: { connection?: typeof connection | null; projectRank?: number } = {}) {
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("JOIN orgs")) return { id: "space-1" };
          if (sql === "SELECT config_json FROM spaces WHERE id = ? AND status != 'deleted'") return { config_json: "{}" };
          if (sql.includes("FROM project_access")) return { visibility: "private", role_rank: options.projectRank ?? 50 };
          if (sql.includes("FROM website_connections")) {
            const grant = options.connection === null ? null : options.connection ?? connection;
            if (!grant || grant.id !== args[0] || grant.tenant_id !== args[1] || grant.space_id !== args[2]
              || grant.owner_user_id !== args[3] || grant.project_id !== args[4] || grant.status !== "active") return null;
            return grant;
          }
          return null;
        },
      }),
    })),
  };
  return { env: { ENVIRONMENT: "test", PLATFORM_SECRET: "secret", PLATFORM_DB: db } as unknown as Parameters<NonNullable<typeof worker.fetch>>[1], db };
}

async function request(body: unknown, role = "owner") {
  const token = await mintInternalToken("secret", "tenant-1");
  return new Request("https://knowledge/spaces/space-1/kb/projects/project-1/sources/website/preview", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "owner-1",
      "x-naelao-role": role, "x-naelao-internal-token": token },
    body: JSON.stringify(body),
  });
}

describe("scoped website Knowledge preview", () => {
  beforeEach(() => checkSsrf.mockReset().mockResolvedValue({ blocked: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("fetches only an approved page, strips markup, and returns an owner-bound receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://docs.example/guide");
      expect(init?.redirect).toBe("manual");
      return new Response("<h1>Guide</h1><script>bad()</script><p>Approved text</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }));
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ preview: {
      content: "Guide  Approved text", requested_url: "https://docs.example/guide", final_url: "https://docs.example/guide",
      content_type: "text/html", preview_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), preview_token: expect.any(String),
    } });
  });

  it("rejects non-owner Project roles before making a network request", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "member"), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("resolves the product-user owner role from the exact Project ACL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Project guide", { headers: { "content-type": "text/markdown" } })));
    const owner = fixture({ projectRank: 50 });
    const allowed = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "product_end_user"), owner.env, {} as ExecutionContext);
    expect(allowed.status).toBe(200);

    const member = fixture({ projectRank: 20 });
    const denied = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }, "product_end_user"), member.env, {} as ExecutionContext);
    expect(denied.status).toBe(403);
  });

  it("rejects a connection from another owner or Project", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture({ connection: { ...connection, owner_user_id: "someone-else" } });
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects a URL outside the owner-approved connection origins", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://attacker.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("revalidates origin allowlists on every redirect before fetching the destination", async () => {
    const outbound = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example/secret" } }));
    vi.stubGlobal("fetch", outbound);
    const f = fixture();
    const response = await worker.fetch!(await request({ connection_id: "connection-1", url: "https://docs.example/guide" }), f.env, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(checkSsrf).toHaveBeenCalledTimes(1);
  });
});
