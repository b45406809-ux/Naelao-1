import { describe, it, expect } from "vitest";
import { HITLApprovalDO } from "../../workers/agents/src/do/HITLApprovalDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// §A1.17 Phase O: the /requests/:id/consume endpoint — single-use redemption of an approved
// request by the router's agent-key HTTP gate (see router-agent-key-gate.test.ts for the
// end-to-end router behavior this backs). Also covers the new ttl_ms override this same pass
// added so an externally-gated approval isn't held to the in-loop reasoning gate's 30s window.

function makeDO(): HITLApprovalDO {
  const ctx = { storage: { sql: createDOSqlStorage(), getAlarm: async () => null, setAlarm: async () => {} } };
  return new HITLApprovalDO(ctx as never, {} as never);
}

async function call(doInstance: HITLApprovalDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://hitl${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("HITLApprovalDO — ttl_ms override", () => {
  it("honors a longer ttl_ms than the 30s in-loop default", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects",
      action_description: "test", ttl_ms: 24 * 60 * 60 * 1000,
    });
    const expiresAt = new Date(created.json.expires_at).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});

describe("HITLApprovalDO — POST /requests/:id/consume", () => {
  it("cannot be consumed while still pending", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects", action_description: "test",
    });
    const consumed = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "POST:projects",
    });
    expect(consumed.json).toEqual({ consumed: false, reason: "not_approved" });
  });

  it("succeeds exactly once for an approved request, then fails on a second attempt", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects", action_description: "test",
    });
    await call(doInstance, `/requests/${created.json.approval_id}/approve`, "PUT");

    const first = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "POST:projects",
    });
    expect(first.json).toEqual({ consumed: true });

    const second = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "POST:projects",
    });
    expect(second.json).toEqual({ consumed: false, reason: "already_consumed" });
  });

  it("rejects a run_id or tool_name mismatch — an approval can't be replayed against a different action", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects", action_description: "test",
    });
    await call(doInstance, `/requests/${created.json.approval_id}/approve`, "PUT");

    const wrongAction = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "DELETE:projects",
    });
    expect(wrongAction.json).toEqual({ consumed: false, reason: "action_mismatch" });

    const wrongAgent = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-2", tool_name: "POST:projects",
    });
    expect(wrongAgent.json).toEqual({ consumed: false, reason: "run_id_mismatch" });
  });

  it("a rejected request can never be consumed", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects", action_description: "test",
    });
    await call(doInstance, `/requests/${created.json.approval_id}/reject`, "PUT", { reason: "no" });
    const consumed = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "POST:projects",
    });
    expect(consumed.json).toEqual({ consumed: false, reason: "not_approved" });
  });

  it("returns not_found for an unknown approval id", async () => {
    const doInstance = makeDO();
    const consumed = await call(doInstance, "/requests/does-not-exist/consume", "POST", {
      run_id: "agent-api:space-1:agent-1", tool_name: "POST:projects",
    });
    expect(consumed.json).toEqual({ consumed: false, reason: "not_found" });
  });

  it("requires both exact action identity fields for redemption", async () => {
    const doInstance = makeDO();
    const created = await call(doInstance, "/requests", "POST", {
      run_id: "agent-api:space-1:agent-1", session_id: "space-1", tool_name: "POST:projects", action_description: "test",
    });
    await call(doInstance, `/requests/${created.json.approval_id}/approve`, "PUT");
    const consumed = await call(doInstance, `/requests/${created.json.approval_id}/consume`, "POST", {});
    expect(consumed.status).toBe(400);
    expect(consumed.json).toEqual({ consumed: false, reason: "bad_request" });
  });
});
