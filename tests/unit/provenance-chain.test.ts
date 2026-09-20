import { describe, expect, it } from "vitest";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { createDOStorage } from "./helpers/sqlite-do-shim.js";

function fixture(withKey = true) {
  const storage = createDOStorage();
  const instance = new SpaceDO({ storage } as never, {
    PLATFORM_SECRET: "test", ...(withKey ? { PROVENANCE_SIGNING_KEY: "rotated-key", PROVENANCE_SIGNING_KEY_ID: "key-2026-09" } : {}),
  } as never);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await instance.fetch(new Request(`http://space-do${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { storage, call };
}

const base = { tenant_id: "tenant", space_id: "space", actor_id: "human", human_trigger_id: "message-1", assistant_actor_id: "assistant", executor_id: "workflow" };

describe("append-only project provenance", () => {
  it("chains canonical events and verifies the complete history", async () => {
    const { call } = fixture();
    const project = await call("/projects", "POST", { space_id: "space", tenant_id: "tenant", name: "P", created_by: "human" });
    const first = await call(`/projects/${project.body.id}/provenance`, "POST", { ...base, event_type: "tool.before", payload: { z: 1, a: 2 } });
    const second = await call(`/projects/${project.body.id}/provenance`, "POST", { ...base, event_type: "tool.after", payload: { ok: true } });
    expect(first.status).toBe(201);
    expect(second.body.previous_hash).toBe(first.body.event_hash);
    expect((await call(`/projects/${project.body.id}/provenance/verify?tenant_id=tenant&space_id=space`)).body).toMatchObject({ valid: true, events: 2 });
  });

  it("exposes no mutation/deletion operation, detects storage tampering, and fails closed without a signing policy", async () => {
    const { call, storage } = fixture();
    const project = await call("/projects", "POST", { space_id: "space", tenant_id: "tenant", name: "P", created_by: "human" });
    await call(`/projects/${project.body.id}/provenance`, "POST", { ...base, event_type: "commit", payload: { oid: "abc" } });
    expect((await call(`/projects/${project.body.id}/provenance`, "PUT", {})).status).toBe(404);
    expect((await call(`/projects/${project.body.id}/provenance`, "DELETE")).status).toBe(404);
    storage.sql.exec("UPDATE provenance_events SET canonical_payload='{}'");
    expect((await call(`/projects/${project.body.id}/provenance/verify?tenant_id=tenant&space_id=space`)).body.valid).toBe(false);

    const unavailable = fixture(false);
    const p2 = await unavailable.call("/projects", "POST", { space_id: "space", tenant_id: "tenant", name: "P", created_by: "human" });
    expect((await unavailable.call(`/projects/${p2.body.id}/provenance`, "POST", { ...base, event_type: "commit" })).status).toBe(503);
  });
});
