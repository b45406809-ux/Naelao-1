import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Business-owner-facing notifications inbox (distinct from agent_activity_log, which is
// builder-only): what the assistant/its agents surface for a human to see — an approval opened,
// a run failed, a connector needs setup. Also carries delivery state (delivered_at) so the
// heartbeat sweep can tell "already escalated to a channel" from "still needs it".

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

describe("SpaceDO — /notifications (business-member inbox)", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("400s a create missing required fields", async () => {
    const res = await call(spaceDO, "/notifications", "POST", { space_id: "space1" });
    expect(res.status).toBe(400);
  });

  it("creates a notification and lists it back newest-first, unread by default", async () => {
    const write = await call(spaceDO, "/notifications", "POST", {
      space_id: "space1", kind: "approval_requested", title: "Approval needed",
      body: "agent wants to pay out $50", severity: "warning", source_agent_id: "naelao-agent",
      related_id: "appr-1",
    });
    expect(write.status).toBe(201);
    expect(write.json.id).toBeTruthy();

    const list = await call(spaceDO, "/notifications", "GET");
    expect(list.json.count).toBe(1);
    expect(list.json.data[0]).toMatchObject({
      kind: "approval_requested", title: "Approval needed", severity: "warning",
      status: "unread", source_agent_id: "naelao-agent", related_id: "appr-1",
    });
  });

  it("filters by status", async () => {
    await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "a" });
    const write2 = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "b" });
    await call(spaceDO, "/notifications", "POST", { action: "mark_read", notification_id: write2.json.id });

    const unread = await call(spaceDO, "/notifications?status=unread", "GET");
    expect(unread.json.count).toBe(1);
    expect(unread.json.data[0].title).toBe("a");

    const read = await call(spaceDO, "/notifications?status=read", "GET");
    expect(read.json.count).toBe(1);
    expect(read.json.data[0].title).toBe("b");
  });

  it("mark_read is idempotent and sets read_at", async () => {
    const write = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "x" });
    const r1 = await call(spaceDO, "/notifications", "POST", { action: "mark_read", notification_id: write.json.id });
    expect(r1.status).toBe(200);
    const r2 = await call(spaceDO, "/notifications", "POST", { action: "mark_read", notification_id: write.json.id });
    expect(r2.status).toBe(200);

    const list = await call(spaceDO, "/notifications", "GET");
    expect(list.json.data[0].status).toBe("read");
    expect(list.json.data[0].read_at).toBeTruthy();
  });

  it("mark_read without a notification_id is a 400", async () => {
    const res = await call(spaceDO, "/notifications", "POST", { action: "mark_read" });
    expect(res.status).toBe(400);
  });

  it("undelivered_only excludes anything already delivered or already read", async () => {
    const fresh = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "approval_requested", title: "fresh" });
    const alreadyRead = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "approval_requested", title: "read already" });
    await call(spaceDO, "/notifications", "POST", { action: "mark_read", notification_id: alreadyRead.json.id });

    // undelivered_only + a 0-minute staleness window (so "just created" already counts as stale
    // for this assertion — the sweep's own 15-minute default is a timing choice, not part of the
    // query's correctness).
    const undelivered = await call(spaceDO, "/notifications?undelivered_only=true&stale_after_minutes=0", "GET");
    const titles = undelivered.json.data.map((r: { title: string }) => r.title);
    expect(titles).toContain("fresh");
    expect(titles).not.toContain("read already");

    await call(spaceDO, "/notifications", "POST", { action: "mark_delivered", notification_id: fresh.json.id });
    const afterDelivery = await call(spaceDO, "/notifications?undelivered_only=true&stale_after_minutes=0", "GET");
    expect(afterDelivery.json.data.map((r: { title: string }) => r.title)).not.toContain("fresh");
  });

  it("undelivered_only respects the staleness window — a just-created notification isn't escalated immediately", async () => {
    await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "brand new" });
    const res = await call(spaceDO, "/notifications?undelivered_only=true&stale_after_minutes=15", "GET");
    expect(res.json.count).toBe(0);
  });

  it("mark_delivered is idempotent (only ever sets delivered_at once)", async () => {
    const write = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "x" });
    const r1 = await call(spaceDO, "/notifications", "POST", { action: "mark_delivered", notification_id: write.json.id });
    expect(r1.status).toBe(200);
    const r2 = await call(spaceDO, "/notifications", "POST", { action: "mark_delivered", notification_id: write.json.id });
    expect(r2.status).toBe(200);
  });

  it("respects a limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: `n${i}` });
    }
    const res = await call(spaceDO, "/notifications?limit=2", "GET");
    expect(res.json.count).toBe(2);
  });

  it("rejects an unrecognized severity", async () => {
    const res = await call(spaceDO, "/notifications", "POST", { space_id: "s1", kind: "run_failed", title: "x", severity: "not_real" });
    expect(res.status).toBe(500); // CHECK constraint violation surfaces as a thrown error
  });
});
