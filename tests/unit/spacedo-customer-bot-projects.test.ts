import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

// Customer-bot project config (migration v12) — drives the REAL SpaceDO over a real
// in-memory SQLite engine (node:sqlite), exercising the actual migration + route code
// rather than a hand-rolled fake.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: createDOStorage() };
  const env = { PLATFORM_SECRET: "test-secret" };
  // The DurableObject base is stubbed for tests (tests/stubs/cloudflare-workers.ts) — its
  // constructor just assigns ctx/env, so direct construction is safe and exercises the
  // real fetch() routing without going through the worker's HTTP/binding layer.
  return new SpaceDO(ctx as never, env as never);
}

async function call(doInstance: SpaceDO, path: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const routedPath = method === "GET" && /^\/projects\/[^/?]+$/.test(path)
    ? `${path}?space_manager=1`
    : path;
  const resp = await doInstance.fetch(
    new Request(`http://space-do${routedPath}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json };
}

describe("SpaceDO — customer-bot project config", () => {
  let spaceDO: SpaceDO;

  beforeEach(() => {
    spaceDO = makeSpaceDO();
  });

  it("a freshly created project defaults to kind=workspace, execution_ceiling=5 (unrestricted)", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support" });
    expect(created.status).toBe(201);

    const got = await call(spaceDO, `/projects/${created.json.id}`, "GET");
    expect(got.json.kind).toBe("workspace");
    expect(got.json.execution_ceiling).toBe(5);
    expect(got.json.external_daily_message_cap).toBe(0);
    expect(got.json.channel_config).toEqual({});
  });

  it("PATCH configures a project as a restricted customer-facing bot", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "WhatsApp Bot" });
    const patched = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", {
      kind: "customer_bot",
      execution_ceiling: 2,
      daily_spend_cap_credits: 500,
      external_daily_message_cap: 25,
      channel_config: { whatsapp: { connected: true } },
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      kind: "customer_bot",
      execution_ceiling: 2,
      daily_spend_cap_credits: 500,
      external_daily_message_cap: 25,
      channel_config: { whatsapp: { connected: true } },
    });
  });

  it("rejects an execution_ceiling outside 1-5 (no escape hatch to an invalid tier)", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "X" });
    const bad = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", { execution_ceiling: 9 });
    expect(bad.status).toBe(400);
  });

  it("validates and returns the configurable per-sender external channel cap", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Support" });
    const updated = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", { external_daily_message_cap: 10000 });
    expect(updated.status).toBe(200);
    expect(updated.json.external_daily_message_cap).toBe(10000);
    const invalid = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", { external_daily_message_cap: 10001 });
    expect(invalid.status).toBe(400);
  });

  it("enforces external sender usage in the shared SpaceDO across conversations and installations", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "WhatsApp" });
    const projectId = created.json.id;
    await call(spaceDO, `/projects/${projectId}`, "PATCH", { external_daily_message_cap: 1 });
    const path = `/projects/${projectId}/external-message-usage?space_id=space1`;
    const body = { event_id: "event-a", installation_id: "install-a", provider: "whatsapp", subject_hash: "a".repeat(64) };
    const first = await call(spaceDO, path, "POST", body);
    const replay = await call(spaceDO, path, "POST", body);
    const second = await call(spaceDO, path, "POST", { ...body, event_id: "event-b" });
    expect(first).toMatchObject({ status: 200, json: { allowed: true, daily_cap: 1 } });
    expect(replay.json).toMatchObject({ allowed: true, deduplicated: true, count: 1 });
    expect(second).toMatchObject({ status: 200, json: { allowed: false, daily_cap: 1, count: 1 } });
    const otherConversationOtherPerson = await call(spaceDO, path, "POST", { ...body, event_id: "event-c", subject_hash: "b".repeat(64) });
    expect(otherConversationOtherPerson.json.allowed).toBe(true);
    const otherInstallation = await call(spaceDO, path, "POST", { ...body, event_id: "event-d", installation_id: "install-b" });
    expect(otherInstallation.json).toMatchObject({ allowed: false, count: 1 });
  });

  it("exposes only compact task and active-install counts to the Steward facts grant", async () => {
    const project = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Care queue" });
    await call(spaceDO, "/tasks", "POST", { space_id: "space1", project_id: project.json.id, title: "Blocked", status: "blocked" });
    await call(spaceDO, "/tasks", "POST", { space_id: "space1", project_id: project.json.id, title: "Pending", status: "pending" });
    const facts = await call(spaceDO, "/project-steward-facts?space_id=space1", "GET");
    expect(facts.status).toBe(200);
    expect(facts.json.data).toEqual([expect.objectContaining({
      project_id: project.json.id, project_name: "Care queue", pending_task_count: 1,
      in_progress_task_count: 0, blocked_task_count: 1, active_extension_count: 0,
    })]);
    expect(JSON.stringify(facts.json)).not.toContain("Blocked");
    expect(JSON.stringify(facts.json)).not.toContain("Pending");
  });

  it("reports the authoritative project lifecycle state for scheduler fences", async () => {
    const project = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "Lifecycle" });
    const path = `/project-lifecycle?space_id=space1&project_id=${project.json.id}`;
    expect(await call(spaceDO, path, "GET")).toMatchObject({ status: 200, json: { active: true, status: "active" } });
    await call(spaceDO, `/projects/${project.json.id}`, "PATCH", { status: "archived" });
    expect(await call(spaceDO, path, "GET")).toMatchObject({ status: 200, json: { active: false, status: "archived" } });
  });

  it("rejects an unknown project kind", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "X" });
    const bad = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", { kind: "evil_kind" });
    expect(bad.status).toBe(400);
  });

  it("404s when patching/getting a project that doesn't exist", async () => {
    const got = await call(spaceDO, "/projects/does-not-exist", "GET");
    expect(got.status).toBe(404);
    const patched = await call(spaceDO, "/projects/does-not-exist", "PATCH", { kind: "customer_bot" });
    expect(patched.status).toBe(404);
  });
});

describe("SpaceDO — project_rules (no-code 'after customer says X' triggers)", () => {
  let spaceDO: SpaceDO;
  let projectId: string;

  beforeEach(async () => {
    spaceDO = makeSpaceDO();
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "WhatsApp Bot" });
    projectId = created.json.id;
  });

  it("creates a 'reply' rule and lists it back", async () => {
    const created = await call(spaceDO, `/projects/${projectId}/rules`, "POST", {
      trigger_pattern: "STOP",
      action: "reply",
      reply_text: "You have been unsubscribed.",
      priority: 100,
    });
    expect(created.status).toBe(201);

    const list = await call(spaceDO, `/projects/${projectId}/rules`, "GET");
    expect(list.json.count).toBe(1);
    expect(list.json.data[0]).toMatchObject({ trigger_pattern: "STOP", action: "reply", reply_text: "You have been unsubscribed." });
  });

  it("higher-priority rules are listed first (checked first by the heartbeat)", async () => {
    await call(spaceDO, `/projects/${projectId}/rules`, "POST", { trigger_pattern: "hours", action: "reply", reply_text: "We're open 9-5.", priority: 1 });
    await call(spaceDO, `/projects/${projectId}/rules`, "POST", { trigger_pattern: "STOP", action: "human_takeover", priority: 100 });
    const list = await call(spaceDO, `/projects/${projectId}/rules`, "GET");
    expect(list.json.data[0].trigger_pattern).toBe("STOP");
  });

  it("rejects a 'reply' rule with no reply_text, and a 'run_script' rule with no script_name", async () => {
    const noReply = await call(spaceDO, `/projects/${projectId}/rules`, "POST", { trigger_pattern: "hi", action: "reply" });
    expect(noReply.status).toBe(400);
    const noScript = await call(spaceDO, `/projects/${projectId}/rules`, "POST", { trigger_pattern: "hi", action: "run_script" });
    expect(noScript.status).toBe(400);
  });

  it("404s creating a rule under a non-existent project", async () => {
    const result = await call(spaceDO, "/projects/nope/rules", "POST", { trigger_pattern: "x", action: "human_takeover" });
    expect(result.status).toBe(404);
  });

  it("deletes a rule", async () => {
    const created = await call(spaceDO, `/projects/${projectId}/rules`, "POST", { trigger_pattern: "x", action: "human_takeover" });
    const del = await call(spaceDO, `/projects/${projectId}/rules/${created.json.id}`, "DELETE");
    expect(del.status).toBe(200);
    const list = await call(spaceDO, `/projects/${projectId}/rules`, "GET");
    expect(list.json.count).toBe(0);
  });
});
