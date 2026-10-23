import { describe, expect, it } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";
import spacesWorker from "./index.js";

function harness() {
  const grants = new Map<string, Record<string, unknown>>();
  const acceptedWorkers = new Map<string, Record<string, unknown>>();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const statement = query.trim().toLowerCase();
      let rows: Record<string, unknown>[] = [];
      if (statement.startsWith("insert into cross_space_grants")) {
        const [id, grantee_space_id, target_space_id, resource_id, granted_by, created_at, expires_at] = args;
        grants.set(String(id), { id, grantee_space_id, target_space_id, resource_id, granted_by, created_at, expires_at, revoked_at: null });
      } else if (statement.startsWith("select id from cross_space_grants where id = ?")) {
        const [id, grantee, target, resource, now] = args; const row = grants.get(String(id));
        if (row && row.grantee_space_id === grantee && row.target_space_id === target && row.resource_id === resource && row.revoked_at === null && String(row.expires_at) > String(now)) rows = [{ id }];
      } else if (statement.startsWith("update cross_space_grants")) {
        const [revoked_at, id, target] = args; const row = grants.get(String(id));
        if (row && row.target_space_id === target && row.revoked_at === null) { row.revoked_at = revoked_at; rows = [{ id }]; }
      } else if (statement.startsWith("insert into accepted_cross_space_workers")) {
        const [id, grantee_space_id, target_space_id, agent_id, accepted_by, capability_token, expires_at, accepted_at] = args;
        const key = [grantee_space_id, target_space_id, agent_id, accepted_by].join(":");
        acceptedWorkers.set(key, { id, grantee_space_id, target_space_id, agent_id, accepted_by, capability_token, expires_at, accepted_at, revoked_at: null });
      } else if (statement.startsWith("select id,capability_token,expires_at from accepted_cross_space_workers")) {
        const [grantee, target, agent, user, now] = args; const row = acceptedWorkers.get([grantee, target, agent, user].join(":"));
        if (row && row.revoked_at === null && String(row.expires_at) > String(now)) rows = [row];
      } else if (statement.startsWith("update accepted_cross_space_workers")) {
        const [revoked_at, grantee, target, agent, user] = args; const key = [grantee, target, agent, user].join(":"); const row = acceptedWorkers.get(key);
        if (row && row.revoked_at === null) { row.revoked_at = revoked_at; rows = [{ id: row.id }]; }
      }
      return { rowsWritten: 1, toArray: () => rows };
    },
  };
  const instance = new SpaceDO({ storage: { sql, transactionSync: (fn: () => unknown) => fn(), setAlarm: async () => undefined, deleteAlarm: async () => undefined } } as never,
    { PLATFORM_SECRET: "test-secret" } as never);
  return { instance, grants, acceptedWorkers };
}

describe("revocable cross-Space capabilities", () => {
  it("issues an exact resource token and immediately denies it after its grant is revoked", async () => {
    const h = harness();
    const created = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({ grantee_space_id: "user-space", target_space_id: "doctor-space", resource_id: "worker-template:template-1", granted_by: "doctor-owner", expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: ["read"] }) }));
    expect(created.status).toBe(201);
    const grant = await created.json() as { id: string; capability_token: string };
    const check = (resourceId = "worker-template:template-1") => h.instance.fetch(new Request(`https://space/cross-space-check?${new URLSearchParams({ user_id: "user-1", requesting_space_id: "user-space", target_space_id: "doctor-space", resource_id: resourceId, permission: "read", capability_token: grant.capability_token })}`));
    expect(await (await check()).json()).toMatchObject({ permitted: true });
    expect(await (await check("worker-template:other")).json()).toMatchObject({ permitted: false });
    const revoked = await h.instance.fetch(new Request(`https://space/cross-space-grants/${grant.id}?space_id=doctor-space`, { method: "DELETE" }));
    expect(await revoked.json()).toMatchObject({ revoked: true });
    expect(await (await check()).json()).toMatchObject({ permitted: false, reason: "Capability grant was revoked or expired." });
  });

  it("rejects wildcard resource grants", async () => {
    const h = harness();
    const response = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({ grantee_space_id: "user-space", target_space_id: "doctor-space", resource_id: "*", granted_by: "owner", expires_at: new Date(Date.now() + 60_000).toISOString() }) }));
    expect(response.status).toBe(400);
  });
  it("does not report revocation when the active Space is only the grantee", async () => {
    const h = harness();
    const created = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({ grantee_space_id: "destination", target_space_id: "source", resource_id: "worker:agent-1", granted_by: "source-owner", expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: ["invoke"] }) }));
    const grant = await created.json() as { id: string; capability_token: string };
    const wrongOwner = await h.instance.fetch(new Request(`https://space/cross-space-grants/${grant.id}?space_id=destination`, { method: "DELETE" }));
    expect(wrongOwner.status).toBe(404);
    expect(await wrongOwner.json()).toMatchObject({ revoked: false });
    const permittedBefore = await h.instance.fetch(new Request(`https://space/cross-space-check?${new URLSearchParams({ user_id: "u", requesting_space_id: "destination", target_space_id: "source", resource_id: "worker:agent-1", permission: "invoke", capability_token: grant.capability_token })}`));
    expect(await permittedBefore.json()).toMatchObject({ permitted: true });
  });
  it("limits permissions and grant lifetime", async () => {
    const h = harness();
    const base = { grantee_space_id: "user-space", target_space_id: "doctor-space", resource_id: "worker:agent-1", granted_by: "owner" };
    const broadPermission = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({ ...base, expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: ["admin"] }) }));
    expect(broadPermission.status).toBe(400);
    const longGrant = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({ ...base, expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(), permissions: ["invoke"] }) }));
    expect(longGrant.status).toBe(400);
  });

  it("stores an exact worker acceptance per user and makes revocation immediate", async () => {
    const h = harness();
    const created = await h.instance.fetch(new Request("https://space/cross-space-grants", { method: "POST", body: JSON.stringify({
      grantee_space_id: "target-space", target_space_id: "source-space", resource_id: "worker:worker-1", granted_by: "source-owner",
      expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: ["invoke"],
    }) }));
    const grant = await created.json() as { capability_token: string };
    const accepted = await h.instance.fetch(new Request("https://space/cross-space-grants/accept-worker", { method: "POST", body: JSON.stringify({
      grantee_space_id: "target-space", target_space_id: "source-space", agent_id: "worker-1", accepted_by: "member-1", capability_token: grant.capability_token,
    }) }));
    expect(accepted.status).toBe(201);
    const acceptedUrl = "https://space/cross-space-grants/accepted-worker?" + new URLSearchParams({ grantee_space_id: "target-space", target_space_id: "source-space", agent_id: "worker-1", accepted_by: "member-1" });
    expect(await (await h.instance.fetch(new Request(acceptedUrl))).json()).toMatchObject({ accepted: true, capability_token: grant.capability_token });
    expect((await h.instance.fetch(new Request(acceptedUrl, { method: "DELETE" }))).status).toBe(200);
    expect(await (await h.instance.fetch(new Request(acceptedUrl))).json()).toMatchObject({ accepted: false });
    expect(h.acceptedWorkers.values().next().value).toMatchObject({ accepted_by: "member-1", revoked_at: expect.any(String) });
  });
});

describe("retired Foundry-specific routes", () => {
  it("does not expose the former bespoke template or worker APIs", async () => {
    const env = { PLATFORM_SECRET: "test-secret" } as never;
    const template = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/foundry/templates"), env);
    const invoke = await spacesWorker.fetch(new Request("https://spaces.test/spaces/space-a/foundry/invoke-worker", { method: "POST" }), env);
    expect(template.status).toBe(404);
    expect(invoke.status).toBe(404);
    const h = harness();
    expect((await h.instance.fetch(new Request("https://space/foundry/templates"))).status).toBe(404);
    expect((await h.instance.fetch(new Request("https://space/foundry/requests"))).status).toBe(404);
  });
});
