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

function allowPublicDnsThen(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    if (address.includes("cloudflare-dns.com/dns-query")) {
      const type = new URL(address).searchParams.get("type");
      return Response.json({ Status: 0, Answer: type === "A" ? [{ data: "93.184.216.34" }] : [] });
    }
    return response.clone();
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("TransactionCoordinatorDO compensation recovery", () => {
  it("compensates completed side effects in reverse order and persists the terminal state", async () => {
    const h = harness();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const address = url instanceof Request ? url.url : String(url);
      if (address.includes("cloudflare-dns.com/dns-query")) {
        const type = new URL(address).searchParams.get("type");
        return Response.json({ Status: 0, Answer: type === "A" ? [{ data: "93.184.216.34" }] : [] });
      }
      calls.push(address);
      return new Response("ok", { status: 200 });
    }));
    const created = await post(h.instance, "/sagas", { name: "checkout", tenant_id: "tenant-1", steps: [
      { name: "reserve", action_url: "https://example.com/reserve", action_body: {}, compensation_url: "https://example.com/release", compensation_body: {} },
      { name: "charge", action_url: "https://example.com/charge", action_body: {}, compensation_url: "https://example.com/refund", compensation_body: {} },
      { name: "notify", action_url: "https://example.com/notify", action_body: {}, compensation_url: "https://example.com/undo-notify", compensation_body: {} },
    ] });
    const { saga_id: id } = await created.json() as { saga_id: string };
    await post(h.instance, `/sagas/${id}/steps/0/complete`);
    await post(h.instance, `/sagas/${id}/steps/1/complete`);
    await post(h.instance, `/sagas/${id}/steps/2/fail`, { error: "notification failed" });
    await Promise.all(h.pending);
    const state = await (await h.instance.fetch(new Request(`https://saga/sagas/${id}`))).json() as { status: string; steps: Array<{ status: string }> };
    expect(calls).toEqual(["https://example.com/refund", "https://example.com/release"]);
    expect(state.status).toBe("compensated");
    expect(state.steps.map(step => step.status)).toEqual(["compensated", "compensated", "failed"]);
  });

  it("records failed compensation as failed rather than claiming rollback succeeded", async () => {
    const h = harness();
    allowPublicDnsThen(new Response(null, { status: 503 }));
    const created = await post(h.instance, "/sagas", { name: "refund", tenant_id: "tenant-1", steps: [
      { name: "charge", action_url: "https://example.com/charge", action_body: {}, compensation_url: "https://example.com/refund", compensation_body: {} },
      { name: "next", action_url: "https://example.com/next", action_body: {}, compensation_url: "https://example.com/undo", compensation_body: {} },
    ] });
    const { saga_id: id } = await created.json() as { saga_id: string };
    await post(h.instance, `/sagas/${id}/steps/0/complete`);
    await post(h.instance, `/sagas/${id}/steps/1/fail`, { error: "downstream failed" });
    await Promise.all(h.pending);
    const state = await (await h.instance.fetch(new Request(`https://saga/sagas/${id}`))).json() as { status: string; steps: Array<{ error?: string }> };
    expect(state.status).toBe("failed");
    expect(state.steps[0]?.error).toContain("Compensation failed: 503");
  });

  it("rejects malformed, oversized, and unsafe saga definitions", async () => {
    const h = harness();
    expect((await post(h.instance, "/sagas", "not-json")).status).toBe(400);
    const bad = await post(h.instance, "/sagas", { name: "bad", tenant_id: "tenant-1", steps: [
      { name: "private", action_url: "http://127.0.0.1/action", action_body: {}, compensation_url: "https://example.com/undo", compensation_body: {} },
    ] });
    expect(bad.status).toBe(400);
    const tooMany = await post(h.instance, "/sagas", { name: "large", tenant_id: "tenant-1", steps: Array.from({ length: 17 }, (_, i) => ({
      name: `step-${i}`, action_url: "https://example.com/action", action_body: {}, compensation_url: "https://example.com/undo", compensation_body: {},
    })) });
    expect(tooMany.status).toBe(400);
    expect(h.rows.size).toBe(0);
  });

  it("enforces sequential step transitions and makes duplicate completion idempotent", async () => {
    const h = harness();
    const created = await post(h.instance, "/sagas", { name: "ordered", tenant_id: "tenant-1", steps: [
      { name: "one", action_url: "https://example.com/one", action_body: {}, compensation_url: "https://example.com/undo-one", compensation_body: {} },
      { name: "two", action_url: "https://example.com/two", action_body: {}, compensation_url: "https://example.com/undo-two", compensation_body: {} },
    ] });
    const { saga_id: id } = await created.json() as { saga_id: string };
    expect((await post(h.instance, `/sagas/${id}/steps/1/complete`)).status).toBe(409);
    expect((await post(h.instance, `/sagas/${id}/steps/0/complete`)).status).toBe(200);
    const duplicate = await post(h.instance, `/sagas/${id}/steps/0/complete`);
    expect((await duplicate.json()).deduplicated).toBe(true);
    expect((await post(h.instance, `/sagas/${id}/steps/0/fail`, { error: "late failure" })).status).toBe(409);
  });
});
