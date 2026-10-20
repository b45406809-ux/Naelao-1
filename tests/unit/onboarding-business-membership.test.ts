// The spaces-worker wrapper that gives a product end user a path into their own business's
// first-run setup, and keeps them out of everyone else's.
//
// requireInternalHmac alone is NOT this gate: naelao-router mints that same token for EVERY
// authenticated request it proxies, builder JWT or product_end_user alike. And an end user's
// verified claims carry the PRODUCT ROOT's tenant (that's what makes internal proxying work), so
// a tenant-match-only check would happily let a member of one business run setup on another's.
// Answering this wizard connects the business's payment account and sets how autonomous its
// assistant is — squarely admin-level, while merely reading the checklist is not.

import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { mintInternalToken } from "@naelao/http";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

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
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, end_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', suspended_at TEXT
  );
`;

/** Records what the wrapper actually forwards to the agents worker, so the action→path mapping
 *  is asserted against the real request rather than inferred from a status code. */
interface Forwarded {
  path: string;
  method: string;
  body: unknown;
  tenantId: string | null;
  hasInternalToken: boolean;
}

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_MEMBERSHIPS_SQL, SPACE_MEMBERS_SQL]);
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name) VALUES ('prod-root', 'tenant-1', 'active', 'Product')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'prod-root')");
  fakeDb.db.exec("INSERT INTO spaces (id, tenant_id, status, name, parent_space_id) VALUES ('biz-bob', 'tenant-1', 'active', 'Bob Biz', 'prod-root')");
  for (const [biz, user, role] of [
    ["biz-alice", "alice", "admin"],
    ["biz-alice", "alice-member", "member"],
    ["biz-bob", "bob", "admin"],
  ]) {
    fakeDb.db.exec(
      `INSERT INTO business_memberships (business_space_id, product_space_id, end_user_id, role, status) VALUES ('${biz}', 'prod-root', '${user}', '${role}', 'active')`
    );
  }

  const forwarded: Forwarded[] = [];
  const env = {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    SPACE_DO: makeStatefulDoNamespace(SpaceDO),
    PLATFORM_DB: fakeDb,
    AGENTS_WORKER: {
      async fetch(req: Request) {
        forwarded.push({
          path: new URL(req.url).pathname,
          method: req.method,
          body: await req.json().catch(() => null),
          tenantId: req.headers.get("x-naelao-tenant-id"),
          hasInternalToken: Boolean(req.headers.get("x-naelao-internal-token")),
        });
        return Response.json({ ok: true, status: "awaiting_setup", prompts: [] });
      },
    },
  };
  return { env, forwarded };
}

async function endUserHeaders(endUserId: string): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": "tenant-1",
    "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, "tenant-1"),
    "x-naelao-role": "product_end_user",
    "x-naelao-user-id": endUserId,
  };
}

function req(path: string, headers: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers });
}

describe("GET /spaces/:spaceId/onboarding — reading the checklist is member-level", () => {
  it("a member of the business can read it", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/onboarding", await endUserHeaders("alice-member")), env as never, execCtx);
    expect(res.status).toBe(200);
    // Proxied to the agents worker's real bootstrap route, with a freshly minted internal token
    // for the space's OWNING tenant — never the raw caller headers.
    expect(forwarded[0]).toMatchObject({ path: "/spaces/biz-alice/bootstrap", method: "GET", tenantId: "tenant-1", hasInternalToken: true });
  });

  it("CRITICAL: a member of a DIFFERENT business cannot read it", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(req("/spaces/biz-alice/onboarding", await endUserHeaders("bob")), env as never, execCtx);
    expect(res.status).toBe(403);
    // Rejected before the agents worker is ever reached.
    expect(forwarded).toHaveLength(0);
  });

  it("rejects a request with no internal token at all", async () => {
    const { env } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", { "x-naelao-tenant-id": "tenant-1", "x-naelao-role": "product_end_user", "x-naelao-user-id": "alice" }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /spaces/:spaceId/onboarding — answering it is admin-level", () => {
  it("an admin can save answers, and 'save' maps to the save route", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("alice"), {
        method: "POST",
        body: JSON.stringify({ action: "save", answers: { owner_channel: "email" } }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(forwarded[0]).toMatchObject({ path: "/spaces/biz-alice/bootstrap/save", method: "POST" });
    expect((forwarded[0]!.body as any).answers).toEqual({ owner_channel: "email" });
  });

  it("'complete' maps to the complete route, carrying the answers through", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("alice"), {
        method: "POST",
        body: JSON.stringify({ action: "complete", answers: { autonomy: "Full autonomy — only ask when genuinely stuck" } }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
    expect(forwarded[0]!.path).toBe("/spaces/biz-alice/bootstrap/complete");
    expect((forwarded[0]!.body as any).answers.autonomy).toContain("Full autonomy");
  });

  it("defaults to the non-destructive 'save' when no action is given", async () => {
    const { env, forwarded } = makeEnv();
    await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("alice"), { method: "POST", body: JSON.stringify({ answers: {} }) }),
      env as never, execCtx
    );
    expect(forwarded[0]!.path).toBe("/spaces/biz-alice/bootstrap/save");
  });

  it("rejects an unknown action rather than guessing", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("alice"), { method: "POST", body: JSON.stringify({ action: "delete_everything" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it("a plain member cannot answer it — reading and configuring are different privileges", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("alice-member"), {
        method: "POST",
        body: JSON.stringify({ action: "complete" }),
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("CRITICAL: an admin of another business cannot complete this one's setup", async () => {
    const { env, forwarded } = makeEnv();
    const res = await spacesWorker.fetch(
      req("/spaces/biz-alice/onboarding", await endUserHeaders("bob"), { method: "POST", body: JSON.stringify({ action: "complete" }) }),
      env as never, execCtx
    );
    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });
});
