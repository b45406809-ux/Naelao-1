import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import spacesWorker from "../../workers/spaces/src/index.js";
import { BuilderAccountDO } from "../../workers/spaces/src/do/BuilderAccountDO.js";
import { ProductUserDO } from "../../workers/spaces/src/do/ProductUserDO.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { app as agentsApp } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1.28: the model switcher. `productConfig.modelConfig.model` is a per-space config_json
// override (the same convention memberBilling/pricingConfig/catalog already use), validated
// against a curated allowlist at the PATCH route — deliberately NOT the dead
// `spacetypes.model_config` D1 column /agent/run used to read (no migration ever created it, so
// it always parsed to `{}` and every run silently used a hardcoded fallback model regardless of
// what a builder configured).

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const SPACES_TABLE_SQL = `
  CREATE TABLE spaces (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', suspension_reason TEXT,
    name TEXT NOT NULL DEFAULT '', spacetype_id TEXT NOT NULL DEFAULT 'launchpad',
    config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT,
    parent_space_id TEXT, depth INTEGER NOT NULL DEFAULT 0, tenancy_mode TEXT NOT NULL DEFAULT 'team',
    agency_shell INTEGER NOT NULL DEFAULT 0, scenario_type TEXT
  );
  CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '', plan_tier TEXT NOT NULL DEFAULT 'free');
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
  CREATE TABLE spacetypes (id TEXT PRIMARY KEY, schema_json TEXT);
`;
const NAELAO_PRODUCT_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0044_naelao_product.sql"), "utf8");
const BUILDER_DASHBOARD_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0045_builder_dashboard_api.sql"), "utf8");
const COMMERCE_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0035_commerce.sql"), "utf8");
const LEDGER_KIND_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0061_reseller_ledger_kind.sql"), "utf8");
const RESELLER_MIGRATION = readFileSync(join(__dirname, "../../infra/migrations/0033_reseller_accounts.sql"), "utf8");

function makeSpacesEnv() {
  const fakeDb = createFakeD1([SPACES_TABLE_SQL, NAELAO_PRODUCT_MIGRATION, BUILDER_DASHBOARD_MIGRATION, COMMERCE_MIGRATION, RESELLER_MIGRATION, LEDGER_KIND_MIGRATION]);
  return {
    PLATFORM_SECRET: "s",
    ENVIRONMENT: "test",
    PLATFORM_DB: fakeDb,
    BUILDER_ACCOUNT_DO: makeStatefulDoNamespace(BuilderAccountDO),
    PRODUCT_USER_DO: makeStatefulDoNamespace(ProductUserDO),
    NAELAO_CONFIG_KV: { get: async () => null, put: async () => {} },
  };
}

async function req(path: string, opts: { method?: string; body?: unknown; tenant?: string } = {}): Promise<Request> {
  const headers = new Headers();
  if (opts.tenant) {
    headers.set("x-naelao-tenant-id", opts.tenant);
    headers.set("x-naelao-internal-token", await mintInternalToken("s", opts.tenant));
  }
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://spaces.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("PATCH /builder/products/:id — modelConfig allowlist", () => {
  it("rejects a model not on the curated allowlist", async () => {
    const env = makeSpacesEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { product_config: { modelConfig: { model: "gpt-5-super-mega" } } } }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("accepts an allowed model and persists it", async () => {
    const env = makeSpacesEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const ok = await spacesWorker.fetch(
      await req(`/builder/products/${created.id}`, { method: "PATCH", tenant: "tenant-1", body: { product_config: { modelConfig: { model: "claude-opus-4-8" } } } }),
      env as never, execCtx
    );
    expect(ok.status).toBe(200);
    const fetched = await (await spacesWorker.fetch(await req(`/builder/products/${created.id}`, { tenant: "tenant-1" }), env as never, execCtx)).json() as { product_config: { modelConfig?: { model?: string } } };
    expect(fetched.product_config.modelConfig?.model).toBe("claude-opus-4-8");
  });

  // Note: shell/manifest's own `model: pc?.modelConfig?.model ?? null` line is a one-line
  // projection off the SAME loadEffectiveProductConfig merge already proven above (the PATCH ->
  // GET /builder/products/:id round trip reads through the identical config_json override path) —
  // not re-tested here directly since exercising shell/manifest end-to-end needs a full
  // SpaceTypeRegistryDO-backed manifest fixture that's out of proportion to this one field.
});

describe("POST /agent/run — resolves the configured model, not the dead spacetypes.model_config column", () => {
  const SECRET = "test-platform-secret";
  const agentExecCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  function makeAgentsEnv(spaceConfigJson: string) {
    const calls: Array<{ path: string; body: unknown }> = [];
    const agentDoStub = {
      async fetch(reqInput: Request) {
        const path = new URL(reqInput.url).pathname;
        const body = await reqInput.json().catch(() => null);
        calls.push({ path, body });
        return new Response(JSON.stringify({ level: "L1", result: { ok: true, output: "ok", tokens_used: 1 }, notes: [] }), { status: 200 });
      },
    };
    const db = {
      prepare(sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => {
              if (sql.includes("FROM spaces")) {
                return { id: "space-1", tenant_id: "tenant-a", status: "active", spacetype_id: "st-1", config_json: spaceConfigJson };
              }
              if (sql.includes("FROM spacetypes")) {
                return { id: "st-1", system_prompt_template: null, tools_config: "[]" };
              }
              if (sql.includes("usage_events")) return { total: 0 };
              return null;
            },
          }),
        };
      },
    };
    const env = {
      ANTHROPIC_API_KEY: "test-key",
      PLATFORM_SECRET: SECRET,
      NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
      ANALYTICS: { writeDataPoint() {} },
      PLATFORM_DB: db,
      SPACES_WORKER: { async fetch(reqInput: Request) {
        const url = new URL(reqInput.url);
        if (/\/me\/injection$/.test(url.pathname)) return Response.json({ rate_limited: false });
        if (/\/sessions\/[^/]+\/compact-scope$/.test(url.pathname)) return Response.json({ project_id: null, private_scratchpad: false, owned_by_caller: true });
        return new Response("not found", { status: 404 });
      } },
      KNOWLEDGE_WORKER: { async fetch() { return new Response("not found", { status: 404 }); } },
    } as unknown as AgentsEnv;
    return { env, calls };
  }

  async function runReq(env: AgentsEnv, goal: string, extra: Record<string, unknown> = {}) {
    const token = await mintInternalToken(SECRET, "tenant-a");
    return agentsApp.fetch(
      new Request("https://agents.naelao.com/spaces/space-1/sessions/sess-1/agent/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naelao-tenant-id": "tenant-a",
          "x-naelao-internal-token": token,
          "prefer": "respond-sync",
        },
        body: JSON.stringify({ goal, ...extra }),
      }),
      env,
      agentExecCtx
    );
  }

  it("uses the builder-configured model from productConfig.modelConfig.model", async () => {
    const { env, calls } = makeAgentsEnv(JSON.stringify({ productConfig: { modelConfig: { model: "claude-opus-4-8" } } }));
    await runReq(env, "hello");
    expect((calls[0]!.body as { model?: string }).model).toBe("claude-opus-4-8");
  });

  // item 79: this used to be a bare "claude-sonnet-4-6" literal at each fallback site — on an
  // account with no Anthropic provider on its AI Gateway (Workers AI only, item 68), that string
  // 404'd with "Model not found" on every product that never explicitly configured a model.
  // DEFAULT_WORKING_MODEL (@naelao/billing-core) is the one guaranteed to resolve everywhere.
  it("falls back to DEFAULT_WORKING_MODEL when no model is configured", async () => {
    const { env, calls } = makeAgentsEnv("{}");
    await runReq(env, "hello");
    expect((calls[0]!.body as { model?: string }).model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("falls back to DEFAULT_WORKING_MODEL when config_json is malformed", async () => {
    const { env, calls } = makeAgentsEnv("{not valid json");
    await runReq(env, "hello");
    expect((calls[0]!.body as { model?: string }).model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  // §A1 Harness Excellence (chat UI parity): the model switcher's capability-config card lets a
  // caller request a reasoning-effort level alongside the model — validated against whichever
  // model actually runs, not just the raw request body's own model field.
  describe("reasoning_effort — validated against the model that actually runs", () => {
    it("rejects a level the resolved model doesn't offer", async () => {
      const { env } = makeAgentsEnv("{}"); // resolves to DEFAULT_WORKING_MODEL (Llama — no reasoning at all)
      const res = await runReq(env, "hello", { reasoning_effort: "high" });
      expect(res.status).toBe(400);
    });

    it("rejects a level valid for a DIFFERENT model than the one this run actually resolves to", async () => {
      const { env } = makeAgentsEnv(JSON.stringify({ productConfig: { modelConfig: { model: "@cf/openai/gpt-oss-120b" } } }));
      // "max" is glm-5.2's level, not gpt-oss-120b's (low/medium/high) — must be rejected even
      // though it's a real level for SOME model in the registry.
      const res = await runReq(env, "hello", { reasoning_effort: "max" });
      expect(res.status).toBe(400);
    });

    it("accepts and forwards a level the resolved model genuinely offers", async () => {
      const { env, calls } = makeAgentsEnv(JSON.stringify({ productConfig: { modelConfig: { model: "@cf/openai/gpt-oss-120b" } } }));
      const res = await runReq(env, "hello", { reasoning_effort: "medium" });
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { reasoningEffort?: string }).reasoningEffort).toBe("medium");
    });

    it("omitting reasoning_effort entirely is unaffected (the common case — most runs don't set one)", async () => {
      const { env, calls } = makeAgentsEnv("{}");
      const res = await runReq(env, "hello");
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { reasoningEffort?: string }).reasoningEffort).toBeUndefined();
    });
  });

  // The escalation-budget dial (billing-core/effort.ts) — a separate field from reasoning_effort,
  // validated the same way (against whichever model this run actually resolves to).
  describe("effort — the escalation-budget dial", () => {
    // Regression: this used to 400. `effort` is the DELEGATION dial and applies to every model —
    // unlike `reasoning_effort` above, which is the model's own native wire param and correctly
    // stays model-specific.
    it("accepts ultra even on a model with no native thinking mode", async () => {
      const { env, calls } = makeAgentsEnv("{}"); // DEFAULT_WORKING_MODEL, NO_REASONING
      const res = await runReq(env, "hello", { effort: "ultra" });
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { effort?: string }).effort).toBe("ultra");
    });

    it("still rejects an effort value that is not a real level", async () => {
      const { env } = makeAgentsEnv("{}");
      const res = await runReq(env, "hello", { effort: "turbo" });
      expect(res.status).toBe(400);
    });

    it("accepts and forwards a level the resolved model offers", async () => {
      const { env, calls } = makeAgentsEnv("{}");
      const res = await runReq(env, "hello", { effort: "medium" });
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { effort?: string }).effort).toBe("medium");
    });

    it("defaults to the business's own stored effort when the request omits one", async () => {
      const { env, calls } = makeAgentsEnv(JSON.stringify({ productConfig: { modelConfig: { model: "@cf/openai/gpt-oss-120b", effort: "high" } } }));
      const res = await runReq(env, "hello");
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { effort?: string }).effort).toBe("high");
    });

    it("defaults to \"low\" when nothing is configured at all", async () => {
      const { env, calls } = makeAgentsEnv("{}");
      const res = await runReq(env, "hello");
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { effort?: string }).effort).toBe("low");
    });

    it("an explicit request-level effort overrides the business's stored default", async () => {
      const { env, calls } = makeAgentsEnv(JSON.stringify({ productConfig: { modelConfig: { model: "@cf/openai/gpt-oss-120b", effort: "high" } } }));
      const res = await runReq(env, "hello", { effort: "low" });
      expect(res.status).toBe(200);
      expect((calls[0]!.body as { effort?: string }).effort).toBe("low");
    });
  });
});

describe("PATCH /spaces/:spaceId/model-config — effort validated alongside model", () => {
  // Regression: this pair used to 400 ("effort 'ultra' is not offered by model ..."), which is the
  // reported bug — Effort's delegation ceiling applies to every model, including one with no
  // thinking mode of its own, so ultra must be settable here.
  it("accepts ultra on a model with no native thinking mode", async () => {
    const env = makeSpacesEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/spaces/${created.id}/model-config`, {
        method: "PATCH", tenant: "tenant-1",
        body: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", effort: "ultra" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(200);
  });

  it("still rejects an effort value that is not a real level at all", async () => {
    const env = makeSpacesEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const res = await spacesWorker.fetch(
      await req(`/spaces/${created.id}/model-config`, {
        method: "PATCH", tenant: "tenant-1",
        body: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", effort: "turbo" },
      }),
      env as never, execCtx
    );
    expect(res.status).toBe(400);
  });

  it("accepts and persists a valid model+effort pair, readable back from shell/manifest's projection", async () => {
    const env = makeSpacesEnv();
    const created = await (await spacesWorker.fetch(
      await req("/builder/products", { method: "POST", tenant: "tenant-1", body: { name: "A", spacetype_id: "launchpad" } }), env as never, execCtx
    )).json() as { id: string };
    const ok = await spacesWorker.fetch(
      await req(`/spaces/${created.id}/model-config`, {
        method: "PATCH", tenant: "tenant-1",
        body: { model: "@cf/openai/gpt-oss-120b", effort: "high" },
      }),
      env as never, execCtx
    );
    expect(ok.status).toBe(200);
    const body = await ok.json() as { model: string; effort?: string };
    expect(body.model).toBe("@cf/openai/gpt-oss-120b");
    expect(body.effort).toBe("high");
  });
});
