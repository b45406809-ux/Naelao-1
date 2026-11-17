import { describe, expect, it, vi } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

function fixture(authority: "current" | "stale" | "unavailable") {
  const statusUpdates: string[] = [];
  const row = {
    approval_id: "approval-a", run_id: "run-a", space_id: "space-a", tenant_id: "tenant-a", agent_id: "naelao-agent",
    session_id: "poll-shopify", project_id: null, user_id: null, caller_role: null, model: null,
    goal: "poll connector", action_name: "mcp.call", action_input_json: "{}", approval_policy_fingerprint: "policy-a",
    steps_json: "[]", deliberation_round: "0", status: "suspended", delegation_json: null,
    context_json: JSON.stringify({ trigger: "connector_poll", connector_id: "connector-a", connector_name: "shopify",
      authorization_revision: "2026-11-17T12:00:00.000Z" }),
  };
  const sql = {
    exec(query: string) {
      if (query.includes("SELECT * FROM suspended_runs")) return { toArray: () => [row] };
      if (query.includes("RETURNING approval_id")) return { toArray: () => [{ approval_id: "approval-a" }] };
      if (query.includes("UPDATE suspended_runs SET status")) {
        statusUpdates.push(query.match(/SET status\s*=\s*'([^']+)'/)?.[1] ?? "unknown");
      }
      return { toArray: () => [] };
    },
  };
  const storage = { sql, get: async () => undefined, put: async () => undefined };
  const platformDb = {
    prepare: vi.fn((query: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => {
          if (authority === "unavailable") throw new Error("D1 unavailable");
          if (query.includes("FROM mcp_servers")) return authority === "current" ? { current: 1 } : null;
          return null;
        },
      }),
    })),
  };
  const env = {
    PLATFORM_DB: platformDb,
    HITL_APPROVAL_DO: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ status: "approved", kind: "approval", run_id: "run-a",
        tool_name: "mcp.call", tool_input: "{}" }) }),
    },
  };
  const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent-do" } } as never, env as never);
  const resume = (agent as unknown as { handleResumeRun(request: Request): Promise<Response> }).handleResumeRun.bind(agent);
  return { resume, statusUpdates, platformDb };
}

describe("connector-poll approval resume fence", () => {
  it("marks an approved checkpoint stale when the connector was edited or disabled", async () => {
    const f = fixture("stale");
    const response = await f.resume(new Request("http://agent/script/resume", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: "approval-a" }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ resumed: false });
    expect(f.statusUpdates).toEqual(["stale"]);
    expect(f.platformDb.prepare).toHaveBeenCalledOnce();
  });

  it("keeps approval retryable when current connector authority cannot be read", async () => {
    const f = fixture("unavailable");
    const response = await f.resume(new Request("http://agent/script/resume", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: "approval-a" }) }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ resumed: false });
    expect(f.statusUpdates).toEqual(["suspended"]);
  });
});
