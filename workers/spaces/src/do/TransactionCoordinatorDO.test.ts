import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionCoordinatorDO } from "./TransactionCoordinatorDO.js";

type SagaRow = Record<string, unknown>;

function harness() {
  const rows = new Map<string, SagaRow>();
  const pending: Promise<unknown>[] = [];
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const normalized = query.replace(/\s+/g, " ").trim();
      if (/^(CREATE TABLE|CREATE INDEX)/i.test(normalized)) return { toArray: () => [] };
      if (normalized.startsWith("INSERT INTO sagas")) {
        const [id, name, tenant_id, steps_json] = args as [string, string, string, string];
        rows.set(id, { id, name, tenant_id, status: "pending", steps_json, current_step: 0, completed_at: null, error: null });
      } else if (normalized.startsWith("SELECT * FROM sagas WHERE id")) {
        const row = rows.get(String(args[0]));
        return { toArray: () => row ? [{ ...row }] : [] };
      } else if (normalized.startsWith("UPDATE sagas SET status = ?, steps_json = ?, current_step = ?")) {
        const [status, steps_json, current_step, completedStatus, id] = args as [string, string, number, string, string];
        const row = rows.get(id)!;
        Object.assign(row, { status, steps_json, current_step, completed_at: completedStatus === "completed" ? "now" : null });
      } else if (normalized.startsWith("UPDATE sagas SET status = 'compensating'")) {
        const [steps_json, error, id] = args as [string, string, string];
        Object.assign(rows.get(id)!, { status: "compensating", steps_json, error });
      } else if (normalized.startsWith("UPDATE sagas SET steps_json")) {
        const [steps_json, id] = args as [string, string];
        Object.assign(rows.get(id)!, { steps_json });
      } else if (normalized.startsWith("UPDATE sagas SET status = ?")) {
        const [status, id] = args as [string, string];
        Object.assign(rows.get(id)!, { status });
      } else throw new Error(`Unexpected saga SQL: ${normalized}`);
      return { toArray: () => [] };
    },
  };
  const ctx = { storage: { sql }, waitUntil: (task: Promise<unknown>) => pending.push(task) };
  return { instance: new TransactionCoordinatorDO(ctx as never, {} as never), rows, pending };
}

async function post(instance: TransactionCoordinatorDO, path: string, body?: unknown) {
  return instance.fetch(new Request(`https://saga${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("TransactionCoordinatorDO compensation recovery", () => {
  it("compensates completed side effects in reverse order and persists the terminal state", async () => {
    const h = harness();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("ok", { status: 200 });
    }));
    const created = await post(h.instance, "/sagas", { name: "checkout", tenant_id: "tenant-1", steps: [
      { name: "reserve", action_url: "https://internal/reserve", action_body: {}, compensation_url: "https://internal/release", compensation_body: {} },
      { name: "charge", action_url: "https://internal/charge", action_body: {}, compensation_url: "https://internal/refund", compensation_body: {} },
      { name: "notify", action_url: "https://internal/notify", action_body: {}, compensation_url: "https://internal/undo-notify", compensation_body: {} },
    ] });
    const { saga_id: id } = await created.json() as { saga_id: string };
    await post(h.instance, `/sagas/${id}/steps/0/complete`);
    await post(h.instance, `/sagas/${id}/steps/1/complete`);
    await post(h.instance, `/sagas/${id}/steps/2/fail`, { error: "notification failed" });
    await Promise.all(h.pending);
    const state = await (await h.instance.fetch(new Request(`https://saga/sagas/${id}`))).json() as { status: string; steps: Array<{ status: string }> };
    expect(calls).toEqual(["https://internal/refund", "https://internal/release"]);
    expect(state.status).toBe("compensated");
    expect(state.steps.map(step => step.status)).toEqual(["compensated", "compensated", "failed"]);
  });

  it("records failed compensation as failed rather than claiming rollback succeeded", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider unavailable", { status: 503 })));
    const created = await post(h.instance, "/sagas", { name: "refund", tenant_id: "tenant-1", steps: [
      { name: "charge", action_url: "https://internal/charge", action_body: {}, compensation_url: "https://internal/refund", compensation_body: {} },
      { name: "next", action_url: "https://internal/next", action_body: {}, compensation_url: "https://internal/undo", compensation_body: {} },
    ] });
    const { saga_id: id } = await created.json() as { saga_id: string };
    await post(h.instance, `/sagas/${id}/steps/0/complete`);
    await post(h.instance, `/sagas/${id}/steps/1/fail`, { error: "downstream failed" });
    await Promise.all(h.pending);
    const state = await (await h.instance.fetch(new Request(`https://saga/sagas/${id}`))).json() as { status: string; steps: Array<{ error?: string }> };
    expect(state.status).toBe("failed");
    expect(state.steps[0]?.error).toContain("Compensation failed: 503");
  });
});
