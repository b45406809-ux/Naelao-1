// Domain connection setup belongs to the installed Space Template/extension. The kernel's
// generic bootstrap must not reintroduce the retired hardcoded Whop and business questionnaires.
import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";
const SPACE = "space-1";

function makeEnv(overrides: Record<string, string | undefined> = {}): AgentsEnv {
  const space = {
    id: SPACE,
    tenant_id: TENANT,
    config_json: JSON.stringify({
      template_id: "whop-seller",
      onboarding: { template_id: "whop-seller", template_ids: ["whop-seller"], status: "awaiting_setup" },
    }),
    status: "active",
  };
  const stmt = {
    bind() { return stmt; },
    async first() { return space; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 1 } }; },
  };
  return {
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare: () => stmt } as unknown as D1Database,
    MCP_HUB: { fetch: async () => Response.json({ servers: [] }) },
    ANALYTICS: { writeDataPoint() {} },
    ...overrides,
  } as unknown as AgentsEnv;
}

async function bootstrap(env: AgentsEnv) {
  const res = await app.fetch(
    new Request(`https://agents.naelao.com/spaces/${SPACE}/bootstrap`, {
      headers: {
        "x-naelao-tenant-id": TENANT,
        "x-naelao-internal-token": await mintInternalToken(SECRET, TENANT),
      },
    }),
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { template_ids: string[]; templates: Array<{ id: string; connectors: string[] }>; prompts: unknown[] };
}

describe("generic space bootstrap", () => {
  it("does not revive a removed built-in business template", async () => {
    const body = await bootstrap(makeEnv());
    expect(body.template_ids).toEqual(["whop-seller"]); // preserved for migration visibility
    expect(body.templates).toEqual([{ id: "whop-seller", name: "whop-seller", description: null, connectors: [] }]);
    expect(body.prompts).toEqual([]);
  });

  it("does not inject domain onboarding prompts based on environment credentials", async () => {
    const body = await bootstrap(makeEnv({ COMPOSIO_API_KEY: "configured", PUBLIC_AGENTS_URL: "https://agents.naelao.com" }));
    expect(body.prompts).toEqual([]);
  });
});
