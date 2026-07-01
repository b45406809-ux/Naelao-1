import { describe, it, expect, beforeEach } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Customer-bot project config (migration v12) — drives the REAL SpaceDO over a real
// in-memory SQLite engine (node:sqlite), exercising the actual migration + route code
// rather than a hand-rolled fake.

function makeSpaceDO(): SpaceDO {
  const ctx = { storage: { sql: createDOSqlStorage() } };
  const env = { PLATFORM_SECRET: "test-secret" };
  // The DurableObject base is stubbed for tests (tests/stubs/cloudflare-workers.ts) — its
  // constructor just assigns ctx/env, so direct construction is safe and exercises the
  // real fetch() routing without going through the worker's HTTP/binding layer.
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
    expect(got.json.channel_config).toEqual({});
  });

  it("PATCH configures a project as a restricted customer-facing bot", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "WhatsApp Bot" });
    const patched = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", {
      kind: "customer_bot",
      execution_ceiling: 2,
      daily_spend_cap_credits: 500,
      channel_config: { whatsapp: { connected: true } },
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      kind: "customer_bot",
      execution_ceiling: 2,
      daily_spend_cap_credits: 500,
      channel_config: { whatsapp: { connected: true } },
    });
  });

  it("rejects an execution_ceiling outside 1-5 (no escape hatch to an invalid tier)", async () => {
    const created = await call(spaceDO, "/projects", "POST", { space_id: "space1", name: "X" });
    const bad = await call(spaceDO, `/projects/${created.json.id}`, "PATCH", { execution_ceiling: 9 });
    expect(bad.status).toBe(400);
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
