import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";

// Docs/env drift cleanup: the /channels/:channel/inbound/:spaceId route used to read
// `c.env.ANTHROPIC_API_KEY` and thread it into the forward-to-DO body as `apiKey`, with a
// comment claiming this was "the only call site with ANTHROPIC_API_KEY in scope for the
// channel-ingress path". After the vendor cutover (CLAUDE.md item 45) no worker holds
// ANTHROPIC_API_KEY at all — the DO's own NAELAO_AIG_TOKEN (read directly from its env at
// NaelaoAgentDO.ts, independent of anything forwarded in this request body) is what
// authenticates against the CF AI Gateway. This test proves a channel-driven run no longer
// depends on ANTHROPIC_API_KEY being present anywhere in the agents worker's env, and that the
// forwarded body's apiKey is the empty string rather than a stale env read.

const SECRET = "test-platform-secret";
const SPACE_ID = "space-1";
const TENANT_ID = "tenant-1";

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeEnv(capturedBodies: Array<Record<string, unknown>>): AgentsEnv {
  const okStmt = {
    bind() { return okStmt; },
    async first() { return { id: SPACE_ID, tenant_id: TENANT_ID, status: "active", project_id: null }; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 1 } }; },
  };
  const agentDoStub = {
    async fetch(req: Request) {
      capturedBodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
      return Response.json({ ok: true });
    },
  };
  return {
    // Deliberately NO ANTHROPIC_API_KEY on this env at all — proves the route doesn't need it.
    PLATFORM_SECRET: SECRET,
    PLATFORM_DB: { prepare: () => okStmt } as unknown as D1Database,
    NAELAO_AGENT_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => agentDoStub },
    CREDENTIALS_WORKER: {
      fetch: async () => Response.json({ value: "whatsapp-app-secret" }),
    },
  } as unknown as AgentsEnv;
}

describe("channel-inbound forward no longer depends on ANTHROPIC_API_KEY", () => {
  it("forwards apiKey: \"\" to the DO with no ANTHROPIC_API_KEY configured anywhere in env", async () => {
    const secret = "whatsapp-app-secret";
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "165", id: "wamid.1", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: "hi" } }] } }] }],
    });
    const signature = `sha256=${await hmacSha256Hex(secret, rawBody)}`;

    const capturedBodies: Array<Record<string, unknown>> = [];
    const res = await app.fetch(
      new Request(`https://agents.naelao.com/channels/whatsapp/inbound/${SPACE_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body: rawBody,
      }),
      makeEnv(capturedBodies)
    );

    expect(res.status).toBe(200);
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]!["apiKey"]).toBe("");
  });
});
