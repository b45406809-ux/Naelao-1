import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { verifyLocalTunnelToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// §A1.17 Phase M: local-machine-as-container permission model. A grant is an explicit,
// revocable opt-in — these tests verify the CRUD, the business-rule validation (grant shape),
// the hard per-space ceiling, that user_id is ALWAYS derived from verified caller identity (never
// a client-supplied field — a builder can only grant their OWN machine), and the connect-token
// mint endpoint.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL]);
  fakeDb.db.exec(`INSERT INTO spaces (id, tenant_id, status, name) VALUES ('space-1', 'tenant-1', 'active', 'Space One')`);
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
  };
}

async function internalHeaders(tenantId: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const { mintInternalToken } = await import("@naelao/http");
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token, ...extra };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("local-grants CRUD (SpaceDO + spaces-worker validation)", () => {
  it("rejects an unknown grant_type", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "delete-everything" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects a read/write/readwrite grant with no directory", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "read" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("rejects an exec grant with an empty commands list", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const res = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "exec", commands: [] }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("creates a readwrite grant, lists it, and the user_id is derived from caller identity — never a client-supplied field", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const createRes = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, {
        method: "POST",
        // Attacker/bug attempt: try to name a DIFFERENT user's machine via the body.
        body: JSON.stringify({ grant_type: "readwrite", directory: "/home/builder-1/project", user_id: "someone-elses-account" }),
      }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; user_id: string };
    expect(created.user_id).toBe("builder-1"); // NOT "someone-elses-account"

    const listRes = await spacesWorker.fetch(req("/spaces/space-1/local-grants", headers), env as never, execCtx);
    const list = await listRes.json() as { data: Array<{ id: string; directory: string; grant_type: string }>; count: number };
    expect(list.count).toBe(1);
    expect(list.data[0]!.directory).toBe("/home/builder-1/project");
    expect(list.data[0]!.grant_type).toBe("readwrite");
  });

  it("creates an exec grant and deletes it", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const createRes = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "exec", commands: ["npm test", "npm run build"] }) }),
      env as never, execCtx
    );
    expect(createRes.status).toBe(201);
    const { id: grantId } = await createRes.json() as { id: string };

    const deleteRes = await spacesWorker.fetch(req(`/spaces/space-1/local-grants/${grantId}`, headers, { method: "DELETE" }), env as never, execCtx);
    expect(deleteRes.status).toBe(200);

    const afterRes = await spacesWorker.fetch(req("/spaces/space-1/local-grants", headers), env as never, execCtx);
    const after = await afterRes.json() as { count: number };
    expect(after.count).toBe(0);
  });

  it("enforces the hard per-space ceiling (25 grants)", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    for (let i = 0; i < 25; i++) {
      const res = await spacesWorker.fetch(
        req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "exec", commands: [`cmd-${i}`] }) }),
        env as never, execCtx
      );
      expect(res.status).toBe(201);
    }
    const overflow = await spacesWorker.fetch(
      req("/spaces/space-1/local-grants", headers, { method: "POST", body: JSON.stringify({ grant_type: "exec", commands: ["one-too-many"] }) }),
      env as never, execCtx
    );
    expect(overflow.status).toBe(409);
    const body = await overflow.json() as { error_code: string };
    expect(body.error_code).toBe("grant_limit_reached");
  });

  it("rejects local-grants requests with no internal token entirely (requireInternalHmac floor)", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(new Request("https://spaces.naelao.com/spaces/space-1/local-grants"), env as never, execCtx);
    expect(res.status).toBe(403);
  });
});

describe("POST /spaces/:spaceId/local-tunnel/connect-token", () => {
  it("mints a token scoped to the caller's own (space, user) pair, verifiable with the platform secret", async () => {
    const env = makeEnv();
    const headers = await internalHeaders("tenant-1", { "x-naelao-role": "owner", "x-naelao-user-id": "builder-1" });
    const res = await spacesWorker.fetch(req("/spaces/space-1/local-tunnel/connect-token", headers, { method: "POST" }), env as never, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; space_id: string; user_id: string; expires_in_seconds: number };
    expect(body.space_id).toBe("space-1");
    expect(body.user_id).toBe("builder-1");
    expect(await verifyLocalTunnelToken(body.token, "space-1", "builder-1", PLATFORM_SECRET)).toBe(true);
    // Cannot be replayed for a different user.
    expect(await verifyLocalTunnelToken(body.token, "space-1", "builder-2", PLATFORM_SECRET)).toBe(false);
  });

  it("rejects connect-token minting with no internal token entirely", async () => {
    const env = makeEnv();
    const res = await spacesWorker.fetch(
      new Request("https://spaces.naelao.com/spaces/space-1/local-tunnel/connect-token", { method: "POST" }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});
