import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { mintInternalToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

// item 79: closes two reachability gaps in the exact spirit of "the assistant can do everything
// on the user's behalf, if given approval or yolo mode" — the CONTROL for that (the guided/yolo
// toggle, and which model runs) previously existed only behind a JWT-builder-only route, so an
// end user who genuinely owns their own Launchpad business (business-admin role, not a platform
// builder account) had no way to reach either. Mirrors local-grants-business-membership.test.ts's
// harness — same requireBusinessMembership pattern, same fake D1 + stateful SpaceDO.

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
const BUSINESS_MEMBERSHIPS_SQL = `
  CREATE TABLE business_memberships (
    business_space_id TEXT NOT NULL, product_space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (business_space_id, end_user_id)
  );
`;
const SPACE_MEMBERS_SQL = `
  CREATE TABLE space_members (
    space_id TEXT NOT NULL, end_user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    suspended_at TEXT, PRIMARY KEY (space_id, end_user_id)
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, SPACE_MEMBERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'admin', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice-member', 'member', 'active')");
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
  };
}

async function endUserHeaders(tenantId: string, endUserId: string): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, tenantId);
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-internal-token": token,
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

describe("assistant-policy PATCH — business membership gate", () => {
  it("a business admin end user CAN toggle their own business's approval policy to yolo", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/assistant-policy", headers, {
        method: "PATCH",
        body: JSON.stringify({ approval_mode: "yolo", auto_approved_actions: [] }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });

  it("a plain member (not admin) cannot change the policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/assistant-policy", headers, { method: "PATCH", body: JSON.stringify({ approval_mode: "yolo" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("a non-member of this business cannot change its policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "someone-else");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/assistant-policy", headers, { method: "PATCH", body: JSON.stringify({ approval_mode: "yolo" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("a builder JWT-style caller (no x-naelao-role) is unaffected", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/assistant-policy", builderHeaders, { method: "PATCH", body: JSON.stringify({ approval_mode: "always_ask" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });
});

describe("model-config PATCH — business membership gate + model validation", () => {
  it("a business admin end user can set an allowed model", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/model-config", headers, {
        method: "PATCH",
        body: JSON.stringify({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ model: string }>();
    expect(body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("rejects a model not on the curated allowlist", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/model-config", headers, { method: "PATCH", body: JSON.stringify({ model: "gpt-9000" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("a plain member (not admin) cannot change the model", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/model-config", headers, {
        method: "PATCH",
        body: JSON.stringify({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("persists into config_json.productConfig.modelConfig.model without clobbering other overrides", async () => {
    const env = makeEnv();
    env.PLATFORM_DB.db.exec(
      "UPDATE spaces SET config_json = '{\"productConfig\":{\"assistantMode\":\"per-user\"}}' WHERE id = 'biz-alice'"
    );
    const headers = await endUserHeaders("tenant-1", "alice");
    await spacesWorker.fetch(
      req("/spaces/biz-alice/model-config", headers, {
        method: "PATCH",
        body: JSON.stringify({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
      }),
      env as never, execCtx
    );
    const row = env.PLATFORM_DB.db.prepare("SELECT config_json FROM spaces WHERE id = 'biz-alice'").get() as { config_json: string };
    const parsed = JSON.parse(row.config_json);
    expect(parsed.productConfig.assistantMode).toBe("per-user");
    expect(parsed.productConfig.modelConfig.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});

// A project agent's own approval-policy override (GET/PATCH /spaces/:spaceId/agents/:agentId/
// policy) was builder-JWT-only (tenant-match only, no requireBusinessMembership floor at all) —
// the exact gap assistant-policy itself had before this same fix was applied to it. A business
// admin end user had no reachable way to configure a project agent's own approvals at all.
describe("agent policy GET/PATCH — business membership gate", () => {
  it("a business admin end user CAN read an agent's policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", headers),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });

  it("a business admin end user CAN update an agent's policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", headers, {
        method: "PATCH",
        body: JSON.stringify({ approval_mode: "yolo", auto_approved_actions: ["web-search.search"] }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ approval_mode: string; auto_approved_actions: string[] }>();
    expect(body.approval_mode).toBe("yolo");
    expect(body.auto_approved_actions).toEqual(["web-search.search"]);
  });

  it("a plain member (not admin) can read but cannot update an agent's policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "alice-member");
    const getRes = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", headers),
      env as never, execCtx
    );
    expect(getRes.status).toBe(200);
    const patchRes = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", headers, { method: "PATCH", body: JSON.stringify({ approval_mode: "yolo" }) }),
      env as never, execCtx
    );
    expect(patchRes.status).toBe(403);
  });

  it("a non-member of this business cannot read or update its agent policy", async () => {
    const env = makeEnv();
    const headers = await endUserHeaders("tenant-1", "someone-else");
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", headers, { method: "PATCH", body: JSON.stringify({ approval_mode: "yolo" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });

  it("a builder JWT-style caller (no x-naelao-role) is unaffected", async () => {
    const env = makeEnv();
    const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
    const builderHeaders = { "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token };
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/agents/agent-1/policy", builderHeaders, { method: "PATCH", body: JSON.stringify({ approval_mode: "always_ask" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });
});
