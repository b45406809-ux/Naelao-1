import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Step 21: the customer-bot Automation dashboard needs a business ADMIN to manage no-code rules
// on their own project — the routes used to be requireInternalHmac-only (assistant/builder), so
// an end-user-created business had no self-serve way to wire its bot. Same admin-floor precedent
// as scheduled-jobs/model-config: GET is member (see how it's wired), POST/DELETE are admin.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const BUSINESS_MEMBERSHIPS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0047_business_memberships.sql"), "utf8");

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT, parent_space_id TEXT
  );
`;
const SPACE_MEMBERS_SQL = `
  CREATE TABLE space_members (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', suspended_at TEXT
  );
`;

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_MIGRATION, SPACE_MEMBERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice', 'admin', 'active')");
  fakeDb.db.exec("INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('biz-alice', 'prod-root', 'alice-member', 'member', 'active')");
  return { PLATFORM_SECRET, ENVIRONMENT: "test", PLATFORM_DB: fakeDb, SPACE_DO: makeStatefulDoNamespace(SpaceDO) };
}

async function endUserHeaders(endUserId: string): Promise<Record<string, string>> {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant-1",
    "x-naelao-internal-token": token,
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
}

async function createBotProject(env: ReturnType<typeof makeEnv>): Promise<string> {
  const headers = await endUserHeaders("alice");
  const res = await spacesWorker.fetch(
    req("/spaces/biz-alice/projects", headers, { method: "POST", body: JSON.stringify({ name: "Support Bot" }) }),
    env as never, execCtx
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("customer-bot rules — business-membership gating (step 21)", () => {
  it("lets a business admin create, list, and delete a rule", async () => {
    const env = makeEnv();
    const projectId = await createBotProject(env);
    const admin = await endUserHeaders("alice");

    const create = await spacesWorker.fetch(
      req(`/spaces/biz-alice/projects/${projectId}/rules`, admin, {
        method: "POST",
        body: JSON.stringify({ trigger_pattern: "refund", action: "reply", reply_text: "We refund within 30 days." }),
      }),
      env as never, execCtx
    );
    expect(create.status).toBe(201);
    const rule = (await create.json()) as { id: string };

    const list = await spacesWorker.fetch(req(`/spaces/biz-alice/projects/${projectId}/rules`, admin), env as never, execCtx);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ trigger_pattern: string }> };
    expect(listBody.data.some((r) => r.trigger_pattern === "refund")).toBe(true);

    const del = await spacesWorker.fetch(
      req(`/spaces/biz-alice/projects/${projectId}/rules/${rule.id}`, admin, { method: "DELETE" }),
      env as never, execCtx
    );
    expect(del.status).toBe(200);
  });

  it("lets a business member SEE rules but not create one (403)", async () => {
    const env = makeEnv();
    const projectId = await createBotProject(env);
    const member = await endUserHeaders("alice-member");

    const list = await spacesWorker.fetch(req(`/spaces/biz-alice/projects/${projectId}/rules`, member), env as never, execCtx);
    expect(list.status).toBe(200);

    const create = await spacesWorker.fetch(
      req(`/spaces/biz-alice/projects/${projectId}/rules`, member, {
        method: "POST",
        body: JSON.stringify({ trigger_pattern: "x", action: "human_takeover" }),
      }),
      env as never, execCtx
    );
    expect(create.status).toBe(403);
  });

  it("refuses a non-member of the business entirely (403)", async () => {
    const env = makeEnv();
    const projectId = await createBotProject(env);
    const stranger = await endUserHeaders("mallory");

    const list = await spacesWorker.fetch(req(`/spaces/biz-alice/projects/${projectId}/rules`, stranger), env as never, execCtx);
    expect(list.status).toBe(403);
  });
});
