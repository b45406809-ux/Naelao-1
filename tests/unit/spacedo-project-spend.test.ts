import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// F9: the customer-bot daily spend cap was enforced against a `project_spend` table living in
// NaelaoAgentDO's OWN SQLite — but agent DOs are addressed space:project:thread, so every
// thread got an independent, zero-based tally. A project with N concurrent customer threads
// could spend up to N x its configured cap. SpaceDO (one DO per space, shared by every
// thread/project in it) is now the single writer: these tests exercise the real
// GET/POST /projects/:id/spend routes over real in-memory SQLite (node:sqlite), proving spend
// recorded by "one thread" (one debit call) is immediately visible to "another thread's" gate
// check (the next debit call with credits=0).

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  const env = { PLATFORM_SECRET: "test-secret" };
  return new SpaceDO(ctx as never, env as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await doInstance.fetch(
    new Request(`http://space-do${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("SpaceDO — /projects/:id/spend (F9 authoritative per-project daily spend)", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("404s for an unknown project", async () => {
    const res = await call(spaceDO, "/projects/does-not-exist/spend", "GET");
    expect(res.status).toBe(404);
  });

  it("a fresh project (cap=0, no cap configured) is never capped regardless of debits", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Uncapped" });
    const projectId = created.json.id;

    const check = await call(spaceDO, `/projects/${projectId}/spend`, "GET");
    expect(check.json).toMatchObject({ spent_today: 0, cap: 0, capped: false });

    await call(spaceDO, `/projects/${projectId}/spend`, "POST", { credits: 1_000_000 });
    const after = await call(spaceDO, `/projects/${projectId}/spend`, "GET");
    expect(after.json.capped).toBe(false);
  });

  it("two separate 'threads' (independent debit calls) against the same project share ONE authoritative tally", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support Bot" });
    const projectId = created.json.id;
    await call(spaceDO, `/projects/${projectId}`, "PATCH", { kind: "customer_bot", daily_spend_cap_credits: 100 });

    // Thread A debits 60 credits after its run.
    const afterA = await call(spaceDO, `/projects/${projectId}/spend`, "POST", { credits: 60 });
    expect(afterA.json).toMatchObject({ spent_today: 60, cap: 100, capped: false });

    // Thread B (a completely different agent-DO instance in reality) checks the gate BEFORE
    // running — it must see thread A's spend, not a fresh zero-based counter.
    const gateForB = await call(spaceDO, `/projects/${projectId}/spend`, "GET");
    expect(gateForB.json).toMatchObject({ spent_today: 60, cap: 100, capped: false });

    // Thread B debits 45 more — combined 105 now exceeds the 100 cap. This is the F9 fix in
    // action: with the old per-DO local tally, thread A and thread B would each have started
    // from 0 and neither would ever see a combined total over 60 or 45 respectively.
    const afterB = await call(spaceDO, `/projects/${projectId}/spend`, "POST", { credits: 45 });
    expect(afterB.json).toMatchObject({ spent_today: 105, cap: 100, capped: true });

    // Thread C's pre-run gate check now correctly sees the project as capped.
    const gateForC = await call(spaceDO, `/projects/${projectId}/spend`, "GET");
    expect(gateForC.json.capped).toBe(true);
  });

  it("a credits=0 debit call is a pure read — never mutates the tally", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Gate Check" });
    const projectId = created.json.id;
    await call(spaceDO, `/projects/${projectId}`, "PATCH", { daily_spend_cap_credits: 50 });

    await call(spaceDO, `/projects/${projectId}/spend`, "POST", { credits: 0 });
    await call(spaceDO, `/projects/${projectId}/spend`, "POST", { credits: 0 });
    const res = await call(spaceDO, `/projects/${projectId}/spend`, "GET");
    expect(res.json.spent_today).toBe(0);
  });

  it("spend for one project never leaks into another project's tally", async () => {
    const p1 = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "P1" });
    const p2 = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "P2" });
    await call(spaceDO, `/projects/${p1.json.id}`, "PATCH", { daily_spend_cap_credits: 100 });
    await call(spaceDO, `/projects/${p2.json.id}`, "PATCH", { daily_spend_cap_credits: 100 });

    await call(spaceDO, `/projects/${p1.json.id}/spend`, "POST", { credits: 90 });

    const p1Check = await call(spaceDO, `/projects/${p1.json.id}/spend`, "GET");
    const p2Check = await call(spaceDO, `/projects/${p2.json.id}/spend`, "GET");
    expect(p1Check.json.spent_today).toBe(90);
    expect(p2Check.json.spent_today).toBe(0);
  });
});
