import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

// §A1.17 Phase J: POST /internal/scripts/run-durable is ScriptRunWorkflow's one durable step's
// call target — same HMAC-verified-token gate as /internal/triggers/fire (a different caller
// population — a Workflow instance rather than SpaceDO's trigger dispatch — kept as its own
// route rather than reusing that one, per the route's own comment).

const SECRET = "test-platform-secret";

function makeEnv(): AgentsEnv & { __fireCalls: Array<{ body: unknown }> } {
  const fireCalls: Array<{ body: unknown }> = [];
  const agentDoStub = {
    async fetch(reqInput: Request) {
      const body = await reqInput.json().catch(() => null);
      fireCalls.push({ body });
      return new Response(JSON.stringify({ result: { ok: true, output: { done: true } } }), { status: 200 });
    },
  };
  return {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PLATFORM_SECRET: SECRET,
    WHOP_API_KEY: "test-whop-key",
    NAELAO_WHOP_COMPANY_ID: "test-company",
    NAELAO_AGENT_DO: { idFromName: (name: string) => ({ toString: () => name }), get: () => agentDoStub },
    ANALYTICS: { writeDataPoint() {} },
    __fireCalls: fireCalls,
  } as unknown as AgentsEnv & { __fireCalls: typeof fireCalls };
}

function req(body: unknown, headers: Record<string, string>): Request {
  return new Request("https://agents.naelao.com/internal/scripts/run-durable", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /internal/scripts/run-durable — auth boundary", () => {
  it("rejects with no internal token", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      req({ spaceId: "space-1", tenantId: "tenant-1", scriptName: "revenue-review" }, {}),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const env = makeEnv();
    const forged = await mintInternalToken("wrong-secret", "tenant-1");
    const res = await app.fetch(
      req(
        { spaceId: "space-1", tenantId: "tenant-1", scriptName: "revenue-review" },
        { "x-naelao-tenant-id": "tenant-1", "x-naelao-internal-token": forged }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects when body.tenantId does not match the verified header tenant", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      req(
        { spaceId: "space-1", tenantId: "tenant-b", scriptName: "revenue-review" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(403);
  });

  it("rejects a missing scriptName", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      req(
        { spaceId: "space-1", tenantId: "tenant-a" },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(400);
  });

  it("accepts a properly minted token and forwards to the space's agent DO directly (no reasoner)", async () => {
    const env = makeEnv();
    const validToken = await mintInternalToken(SECRET, "tenant-a");
    const res = await app.fetch(
      req(
        { spaceId: "space-1", tenantId: "tenant-a", agentId: "naelao-agent", scriptName: "revenue-review", params: { since: "yesterday" } },
        { "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": validToken }
      ),
      env
    );
    expect(res.status).toBe(200);
    expect(env.__fireCalls).toHaveLength(1);
    const body = env.__fireCalls[0]!.body as { scriptName: string; params: Record<string, unknown> };
    expect(body.scriptName).toBe("revenue-review");
    expect(body.params).toEqual({ since: "yesterday" });
  });
});
