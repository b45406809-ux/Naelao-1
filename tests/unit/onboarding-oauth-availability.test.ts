// Whether a setup wizard leads with a connect path that actually works on this deployment.
//
// One-click connect needs a registered OAuth app (client id + secret + a public callback origin).
// A deployment without one — self-hosted, or simply not configured yet — could still render a
// "Connect Whop" button whose only possible outcome was
// `503 "Whop OAuth is not configured on this deployment"`: platform-internal language, shown to a
// business owner who cannot act on it, at the one setup step they are not allowed to skip. The
// key-paste fallback existed the whole time, collapsed behind a text link they had no reason to
// click. Reporting configuration up front is what lets the wizard lead with the path that works.

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
    // A whop-seller business mid-setup: the template is recorded, nothing is answered yet.
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
    // No connectors registered, so every connection prompt reads as unsatisfied.
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
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    prompts: Array<{ id: string; type: string; connector?: string; oauth_available?: boolean; connect_method?: string; connection_available?: boolean }>;
  };
}

describe("onboarding reports whether one-click connect actually works here", () => {
  it("says manual when hosted connector credentials are absent", async () => {
    const body = await bootstrap(makeEnv());
    const connection = body.prompts.find((p) => p.type === "connection" && p.connector === "whop");
    expect(connection).toBeDefined();
    expect(connection!.connection_available).toBe(false);
  });

  it("selects Composio once its key AND public callback origin are present", async () => {
    const body = await bootstrap(
      makeEnv({
        COMPOSIO_API_KEY: "composio-test-key",
        PUBLIC_AGENTS_URL: "https://agents.naelao.com",
      })
    );
    const connection = body.prompts.find((p) => p.type === "connection" && p.connector === "whop");
    expect(connection!.connection_available).toBe(true);
    expect(connection!.connect_method).toBe("composio");
  });

  it("stays manual when the callback origin is missing — the flow cannot complete without it", async () => {
    // The redirect target is half the flow: with credentials but no public origin, the authorize
    // URL has nowhere to come back to, so reporting "available" would send someone into a
    // redirect that dead-ends.
    const body = await bootstrap(
      makeEnv({ COMPOSIO_API_KEY: "composio-test-key" })
    );
    const connection = body.prompts.find((p) => p.type === "connection" && p.connector === "whop");
    expect(connection!.connection_available).toBe(false);
  });

  it("is false for a prompt with no connector at all", async () => {
    const body = await bootstrap(makeEnv());
    const nonConnection = body.prompts.find((p) => p.type !== "connection" && p.type !== "credential");
    expect(nonConnection).toBeDefined();
    expect(nonConnection!.connection_available).toBe(false);
  });
});
