import { describe, expect, it, vi } from "vitest";
import { HITLApprovalDO } from "./HITLApprovalDO.js";
import { createDOSqlStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

function createApprovalDO(): HITLApprovalDO {
  const storage = {
    sql: createDOSqlStorage(),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const ctx = { storage };
  return new HITLApprovalDO(ctx as never, {} as never);
}

async function call(
  instance: HITLApprovalDO,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; json: any }> {
  const response = await instance.fetch(new Request(`http://hitl${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { response, json: await response.json() };
}

function request(session_id: string, extra: Record<string, unknown> = {}) {
  return {
    run_id: `run-${session_id}`,
    session_id,
    tool_name: "write_file",
    tool_input: { path: "notes.txt" },
    action_description: "Write a note",
    ...extra,
  };
}

describe("HITLApprovalDO request boundaries", () => {
  it("filters a real session while preserving the space-wide inbox contract", async () => {
    const instance = createApprovalDO();
    await call(instance, "/requests", "POST", request("session-a"));
    await call(instance, "/requests", "POST", request("session-b"));

    const scoped = await call(instance, "/requests?session_id=session-a");
    expect(scoped.json.approvals).toHaveLength(1);
    expect(scoped.json.approvals[0].session_id).toBe("session-a");

    const inbox = await call(instance, "/requests?session_id=inbox");
    expect(inbox.json.approvals).toHaveLength(2);
  });

  it("paginates approval lists with a bounded page size and rejects invalid offsets", async () => {
    const instance = createApprovalDO();
    for (let i = 0; i < 51; i++) await call(instance, "/requests", "POST", request("busy"));
    const first = await call(instance, "/requests?session_id=busy");
    expect(first.json.approvals).toHaveLength(50);
    expect(first.json).toMatchObject({ has_more: true, next_offset: 50 });
    const second = await call(instance, "/requests?session_id=busy&offset=50");
    expect(second.json.approvals).toHaveLength(1);
    expect(second.json).toMatchObject({ has_more: false, next_offset: null });
    expect((await call(instance, "/requests?session_id=busy&offset=-1")).response.status).toBe(400);
  });

  it("rejects malformed or oversized approval fields before inserting a row", async () => {
    const instance = createApprovalDO();
    expect((await call(instance, "/requests", "POST", null)).response.status).toBe(400);
    expect((await call(instance, "/requests", "POST", request("s", { ttl_ms: 8 * 24 * 60 * 60 * 1000 }))).response.status).toBe(400);
    expect((await call(instance, "/requests", "POST", request("s", { tool_input: { text: "x".repeat(70_000) } }))).response.status).toBe(400);
    expect((await call(instance, "/requests", "POST", request("s", { options: [1] }))).response.status).toBe(400);
    expect((await call(instance, "/requests", "POST", request("s", { resume_do_id: 42 }))).response.status).toBe(400);
    expect((await call(instance, "/requests")).json.approvals).toHaveLength(0);
  });

  it("times out a pending approval at expiry instead of allowing a late approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const instance = createApprovalDO();
    const created = await call(instance, "/requests", "POST", request("s", { ttl_ms: 1000 }));
    const id = created.json.approval_id as string;
    vi.advanceTimersByTime(1000);
    const approved = await call(instance, `/requests/${id}/approve`, "PUT");
    expect(approved.response.status).toBe(409);
    expect(approved.json).toMatchObject({ error: "approval_expired", current_status: "timeout" });
    expect((await call(instance, `/requests/${id}`)).json.status).toBe("timeout");
    vi.useRealTimers();
  });

  it("redeems an approved request once and requires its exact run and action", async () => {
    const instance = createApprovalDO();
    const created = await call(instance, "/requests", "POST", request("s"));
    const id = created.json.approval_id as string;
    await call(instance, `/requests/${id}/approve`, "PUT");
    expect((await call(instance, `/requests/${id}/consume`, "POST", { run_id: "wrong", tool_name: "write_file" })).json.reason).toBe("run_id_mismatch");
    expect((await call(instance, `/requests/${id}/consume`, "POST", { run_id: "run-s", tool_name: "delete_file" })).json.reason).toBe("action_mismatch");
    expect((await call(instance, `/requests/${id}/consume`, "POST", { run_id: "run-s", tool_name: "write_file" })).json).toEqual({ consumed: true });
    expect((await call(instance, `/requests/${id}/consume`, "POST", { run_id: "run-s", tool_name: "write_file" })).json.reason).toBe("already_consumed");
  });

  it("handles null approval action bodies and expires questions before accepting an answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const instance = createApprovalDO();
    const created = await call(instance, "/requests", "POST", request("s", { kind: "question", question: "Continue?", ttl_ms: 1000 }));
    const id = created.json.approval_id as string;
    expect((await call(instance, `/requests/${id}/reject`, "PUT", null)).response.status).toBe(400);
    expect((await call(instance, `/requests/${id}/consume`, "POST", null)).json.reason).toBe("bad_request");
    vi.advanceTimersByTime(1000);
    const answered = await call(instance, `/requests/${id}/answer`, "PUT", { answer: "yes" });
    expect(answered.response.status).toBe(409);
    expect(answered.json.error).toBe("approval_expired");
    vi.useRealTimers();
  });
});
