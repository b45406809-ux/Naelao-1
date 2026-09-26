import { describe, it, expect } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// POST /internal/events/fire (new: A1.16.13's scheduled_job.disabled event) — lets a caller
// OUTSIDE this DO (the agents worker's scheduled-jobs auto-disable) run an arbitrary event
// through the same event_triggers matching every structural mutation (thread.created,
// project.created, ...) already uses, so a builder can wire a no-code trigger to it.

function makeSpaceDO(agentsWorkerFetch?: (req: Request) => Promise<Response>): { doInstance: SpaceDO; calls: Request[] } {
  const calls: Request[] = [];
  const AGENTS_WORKER = {
    async fetch(reqInput: Request | string, init?: RequestInit) {
      const req = typeof reqInput === "string" ? new Request(reqInput, init) : reqInput;
      calls.push(req);
      return agentsWorkerFetch ? agentsWorkerFetch(req) : new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    },
  };
  const ctx = { storage: createDOStorage() };
  const doInstance = new SpaceDO(ctx as never, { PLATFORM_SECRET: "test-secret", AGENTS_WORKER } as never);
  return { doInstance, calls };
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("POST /internal/events/fire", () => {
  it("fires a matching event_trigger for the given event type", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const project = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Automation" });

    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-1",
      project_id: project.json.id,
      event_type: "scheduled_job.disabled",
      script_name: "notifications.notify_builder",
    });

    const res = await call(
      doInstance,
      "/internal/events/fire",
      "POST",
      { type: "scheduled_job.disabled", space_id: "space-1", project_id: project.json.id, payload: { scheduled_job_id: "job-1" } },
      { "x-naelao-tenant-id": "tenant-1" }
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ fired: true });
    expect(calls).toHaveLength(1);
    const firedBody = await calls[0]!.clone().json() as { scriptName: string };
    expect(firedBody.scriptName).toBe("notifications.notify_builder");
  });

  it("does not fire anything when no trigger is configured for that event type", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const res = await call(
      doInstance,
      "/internal/events/fire",
      "POST",
      { type: "scheduled_job.disabled", space_id: "space-1" },
      { "x-naelao-tenant-id": "tenant-1" }
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("rejects when x-naelao-tenant-id is missing on BOTH the header and the query string (fireMatchingTriggers requires it)", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-1", event_type: "scheduled_job.disabled", script_name: "s",
    });
    const res = await call(doInstance, "/internal/events/fire", "POST", { type: "scheduled_job.disabled", space_id: "space-1" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  // Phase 3 item 27/28's own investigation found the REAL bug this whole file's harness had been
  // masking: forwardToSpaceDO (workers/spaces/src/index.ts) never forwards client headers, so the
  // real /internal/spaces/:spaceId/events/fire HTTP route — the only real caller, e.g. the agents
  // worker's scheduled_job.disabled auto-disable — could NEVER have actually reached this 200 path
  // in production; it always 400'd, because x-naelao-tenant-id never reached this DO as a header.
  // Fixed by reading tenant_id off the query string too (the same convention this file's own
  // /projects/:projectId PATCH route already established), which is how the real route now calls
  // this. This test proves the fix directly against the DO, independent of the worker's own
  // full-HTTP-round-trip coverage (see scheduled-jobs-business-membership.test.ts for that).
  it("also accepts tenant_id via the query string (what the real forwarding route actually sends)", async () => {
    const { doInstance, calls } = makeSpaceDO();
    const project = await call(doInstance, "/projects", "POST", { space_id: "space-1", name: "Automation" });
    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-1", project_id: project.json.id, event_type: "scheduled_job.disabled", script_name: "s",
    });
    const res = await doInstance.fetch(
      new Request("http://space-do/internal/events/fire?tenant_id=tenant-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "scheduled_job.disabled", space_id: "space-1", project_id: project.json.id, payload: { scheduled_job_id: "job-1" } }),
      })
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects a body missing type or space_id", async () => {
    const { doInstance } = makeSpaceDO();
    const res = await call(doInstance, "/internal/events/fire", "POST", { space_id: "space-1" }, { "x-naelao-tenant-id": "tenant-1" });
    expect(res.status).toBe(400);
  });

  it("only fires triggers scoped to the space in the event, not other spaces in the same DO", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-other", event_type: "scheduled_job.disabled", script_name: "s",
    });
    const res = await call(
      doInstance, "/internal/events/fire", "POST",
      { type: "scheduled_job.disabled", space_id: "space-1" },
      { "x-naelao-tenant-id": "tenant-1" }
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
