import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";

/**
 * Root cause of the Stop button being a complete no-op on the default async dispatch path.
 *
 * `/internal/tasks/:taskId/run` — the route AgentTaskWorkflow calls for every ordinary chat
 * message (apps/shell never sends `Prefer: respond-sync`) — forwards a body to the agent DO's
 * own `/script/run` handler. That handler resolves its runId as `body.runId ?? crypto.randomUUID()`
 * — so without `runId` explicitly forwarded, EVERY async-dispatched run got a fresh, random,
 * internal-only id, completely disconnected from `taskId`, which is the id the client actually
 * receives as `run_id`/`id` and sends back to `POST /runs/:runId/cancel`. The cancel request
 * landed on the correct DO instance but for an id nothing inside it was tracking, so the
 * cancellation flag could never be seen by the loop's own `shouldCancel` check.
 *
 * This drives the REAL route (not a reimplementation of its logic) and captures the exact body
 * the agent DO stub receives, proving `runId === taskId`.
 */

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";

function makeEnv(): { env: AgentsEnv; capturedBody: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  const agentDoStub = {
    async fetch(input: Request) {
      captured = (await input.json()) as Record<string, unknown>;
      return Response.json({ result: { ok: true, output: "done", tier: 1, duration_ms: 1, tokens_used: 0 }, notes: [] });
    },
  };
  const env = {
    PLATFORM_SECRET: SECRET,
    NAELAO_AGENT_DO: { idFromName: (n: string) => ({ toString: () => n }), get: () => agentDoStub },
  } as unknown as AgentsEnv;
  return { env, capturedBody: () => captured };
}

describe("POST /internal/tasks/:taskId/run forwards runId to /script/run", () => {
  it("sets body.runId to the taskId from the URL, not a fresh random id", async () => {
    const { env, capturedBody } = makeEnv();
    const token = await mintInternalToken(SECRET, TENANT);
    const taskId = "task-abc-123";

    const res = await app.fetch(
      new Request(`https://agents.naelao.com/internal/tasks/${taskId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": TENANT, "x-naelao-internal-token": token },
        body: JSON.stringify({
          taskId, spaceId: "space-1", sessionId: "sess-1", tenantId: TENANT,
          goal: "reply OK", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        }),
      }),
      env
    );

    expect(res.status).toBe(200);
    const forwarded = capturedBody();
    expect(forwarded).toBeDefined();
    // This is the exact fix: without it, forwarded.runId is undefined and handleScriptRun mints
    // its own random id, which is what made cancellation target nothing.
    expect(forwarded!["runId"]).toBe(taskId);
  });
});
