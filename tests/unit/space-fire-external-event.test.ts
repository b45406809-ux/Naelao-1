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

    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-1",
      event_type: "scheduled_job.disabled",
      script_name: "notifications.notify_builder",
    });

    const res = await call(
      doInstance,
      "/internal/events/fire",
      "POST",
      { type: "scheduled_job.disabled", space_id: "space-1", payload: { scheduled_job_id: "job-1" } },
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

  it("rejects when x-naelao-tenant-id is missing (fireMatchingTriggers requires it)", async () => {
    const { doInstance, calls } = makeSpaceDO();
    await call(doInstance, "/event-triggers", "POST", {
      space_id: "space-1", event_type: "scheduled_job.disabled", script_name: "s",
    });
    const res = await call(doInstance, "/internal/events/fire", "POST", { type: "scheduled_job.disabled", space_id: "space-1" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
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
