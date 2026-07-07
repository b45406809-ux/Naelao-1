import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SpaceTypeRegistryDO } from "../../workers/spaces/src/do/SpaceTypeRegistryDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";

// Tier 2 metering follow-up: business_subscriptions (Phase E) was write-only — a Lemon Squeezy
// webhook upserted a row on every subscription_created/updated/cancelled event, but nothing ever
// read it to gate access. GET /internal/business-subscription-status is NaelaoAgentDO's pre-run
// lookup (see business-subscription-gate.test.ts for the DO-level integration).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', parent_space_id TEXT, product_slug TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT
  );
`;
const BUSINESS_SUBSCRIPTIONS_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0049_business_subscriptions.sql"), "utf8");

function makeEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, BUSINESS_SUBSCRIPTIONS_MIGRATION]);
  return {
    PLATFORM_SECRET,
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    SPACE_TYPE_REGISTRY_DO: makeStatefulDoNamespace(SpaceTypeRegistryDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`https://spaces.naelao.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function seedProduct(env: ReturnType<typeof makeEnv>, opts: { model?: string; trialDays?: number; createdAt?: string } = {}) {
  const pricingConfig = opts.model ? { model: opts.model, trialDays: opts.trialDays, plans: [{ id: "pro", name: "Pro", priceCents: 2900, interval: "month" }] } : undefined;
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, config_json) VALUES ('prod-root', 'tenant-1', 'active', 'Product', 'launchpad', ?)"
  ).bind(JSON.stringify(pricingConfig ? { productConfig: { pricingConfig } } : {})).run();
  await env.PLATFORM_DB.prepare(
    "INSERT INTO spaces (id, tenant_id, status, name, spacetype_id, parent_space_id, created_at) VALUES ('biz-alice', 'tenant-1', 'active', 'Alice Biz', 'launchpad', 'prod-root', ?)"
  ).bind(opts.createdAt ?? new Date(0).toISOString()).run();
}

async function callStatus(env: ReturnType<typeof makeEnv>, spaceId: string) {
  const token = await mintInternalToken(PLATFORM_SECRET, "tenant-1");
  return spacesWorker.fetch(
    req(`/internal/business-subscription-status?space_id=${spaceId}`, {
      headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": token },
    }),
    env as never,
    execCtx
  );
}

describe("GET /internal/business-subscription-status", () => {
  it("requires a verified internal token", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    const res = await spacesWorker.fetch(req("/internal/business-subscription-status?space_id=biz-alice"), env as never, execCtx);
    expect(res.status).toBe(403);
  });

  it("not gated: the product root itself is never subject to its own subscription gate", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    const res = await callStatus(env, "prod-root");
    expect(res.status).toBe(200);
    const body = await res.json() as { gated: boolean; reason: string };
    expect(body.gated).toBe(false);
    expect(body.reason).toBe("not_a_business");
  });

  it("not gated: a non-subscription-model product (e.g. credits)", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "credits" });
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; reason: string };
    expect(body.gated).toBe(false);
    expect(body.reason).toBe("not_subscription_model");
  });

  it("gated + inactive: a subscription-model business with no subscription row at all", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean; reason: string };
    expect(body.gated).toBe(true);
    expect(body.active).toBe(false);
    expect(body.reason).toBe("no_subscription");
  });

  it("gated + active: an active subscription row", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_subscriptions (id, business_space_id, product_space_id, plan_id, status) VALUES ('sub1', 'biz-alice', 'prod-root', 'pro', 'active')"
    ).run();
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean };
    expect(body.gated).toBe(true);
    expect(body.active).toBe(true);
  });

  it("gated + active: past_due gets a grace period, not an immediate block", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_subscriptions (id, business_space_id, product_space_id, plan_id, status) VALUES ('sub1', 'biz-alice', 'prod-root', 'pro', 'past_due')"
    ).run();
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean };
    expect(body.active).toBe(true);
  });

  it("gated + inactive: a cancelled subscription blocks, with a reason identifying the status", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_subscriptions (id, business_space_id, product_space_id, plan_id, status) VALUES ('sub1', 'biz-alice', 'prod-root', 'pro', 'cancelled')"
    ).run();
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean; reason: string };
    expect(body.gated).toBe(true);
    expect(body.active).toBe(false);
    expect(body.reason).toBe("subscription_cancelled");
  });

  it("gated + inactive: a paused subscription blocks", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription" });
    await env.PLATFORM_DB.prepare(
      "INSERT INTO business_subscriptions (id, business_space_id, product_space_id, plan_id, status) VALUES ('sub1', 'biz-alice', 'prod-root', 'pro', 'paused')"
    ).run();
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { active: boolean; reason: string };
    expect(body.active).toBe(false);
    expect(body.reason).toBe("subscription_paused");
  });

  it("respects a configured trial window — a freshly-created business isn't gated yet", async () => {
    const env = makeEnv();
    await seedProduct(env, { model: "subscription", trialDays: 14, createdAt: new Date().toISOString() });
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean; reason: string };
    expect(body.active).toBe(true);
    expect(body.reason).toBe("in_trial");
  });

  it("blocks once the trial window has elapsed with no subscription", async () => {
    const env = makeEnv();
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await seedProduct(env, { model: "subscription", trialDays: 14, createdAt: longAgo });
    const res = await callStatus(env, "biz-alice");
    const body = await res.json() as { gated: boolean; active: boolean; reason: string };
    expect(body.active).toBe(false);
    expect(body.reason).toBe("no_subscription");
  });

  it("404-shaped: an unknown space is treated as not-a-business (no crash)", async () => {
    const env = makeEnv();
    const res = await callStatus(env, "no-such-space");
    expect(res.status).toBe(200);
    const body = await res.json() as { gated: boolean };
    expect(body.gated).toBe(false);
  });
});
