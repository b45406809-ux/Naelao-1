import { describe, expect, it, vi } from "vitest";
import { SpaceDO } from "./do/SpaceDO.js";
import spacesWorker from "./index.js";
import { mintInternalToken } from "@naelao/http";

function harness() {
  const templates = new Map<string, Record<string, unknown>>();
  const requests = new Map<string, Record<string, unknown>>();
  const grants = new Map<string, Record<string, unknown>>();
  const acceptedWorkers = new Map<string, Record<string, unknown>>();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const statement = query.trim().toLowerCase();
      let rows: Record<string, unknown>[] = [];
      if (statement.startsWith("insert into foundry_templates")) {
        const [id, space_id, created_by, name, description, definition_json, created_at, updated_at] = args;
        const row = { id, space_id, created_by, name, description, definition_json, status: "draft", version: 1, validated_version: 0, validation_json: "{}", reviewed_by: null, review_note: null, created_at, updated_at, published_at: null };
        templates.set(String(id), row);
      } else if (statement.startsWith("select definition_json,version,status from foundry_templates")) {
        const row = templates.get(String(args[0])); if (row) rows = [row];
      } else if (statement.startsWith("select * from foundry_templates where id=?")) {
        const row = templates.get(String(args[0]));
        if (row && row.space_id === args[1] && (!statement.includes("status='published'") || row.status === "published")) rows = [row];
      } else if (statement.startsWith("update foundry_templates")) {
        if (statement.startsWith("update foundry_templates set validated_version=")) {
          const [validated_version, validation_json, updated_at, id, version] = args; const row = templates.get(String(id));
          if (row && row.version === version && ["draft", "rejected"].includes(String(row.status))) { row.validated_version = validated_version; row.validation_json = validation_json; row.updated_at = updated_at; }
        } else {
        const revising = statement.startsWith("update foundry_templates set name=");
        const submitting = !revising && statement.includes("status in ('draft','rejected')");
        const id = String(submitting ? args[1] : revising ? args[4] : args[6]); const row = templates.get(id);
        if (row && (submitting ? ["draft", "rejected"].includes(String(row.status)) && row.validated_version === row.version : revising ? ["draft", "rejected"].includes(String(row.status)) : row.status === "in_review" && row.validated_version === row.version)) {
          if (submitting) { row.status = "in_review"; row.reviewed_by = null; row.review_note = null; row.updated_at = args[0]; rows = [{ status: row.status }]; }
          else if (revising) { row.name = args[0]; row.description = args[1]; row.definition_json = args[2]; row.updated_at = args[3]; row.version = Number(row.version) + 1; row.validated_version = 0; rows = [{ status: row.status, version: row.version }]; }
          else { row.status = args[0]; row.version = Number(row.version) + Number(args[1]); row.reviewed_by = args[2]; row.review_note = args[3]; row.updated_at = args[4]; row.published_at = args[5]; rows = [{ status: row.status, version: row.version }]; }
        }
        }
      } else if (statement.startsWith("insert into foundry_feature_requests")) {
        const [id, space_id, requested_by, title, problem, workflow, evidence_json, created_at, updated_at] = args;
        requests.set(String(id), { id, space_id, requested_by, title, problem, workflow, evidence_json, status: "open", reviewed_by: null, review_note: null, created_at, updated_at });
      } else if (statement.startsWith("update foundry_feature_requests")) {
        const id = String(args[4]); const row = requests.get(id);
        if (row && ["open", "accepted"].includes(String(row.status))) {
          row.status = args[0]; row.reviewed_by = args[1]; row.review_note = args[2]; row.updated_at = args[3]; rows = [{ status: row.status }];
        }
      } else if (statement.startsWith("insert into cross_space_grants")) {
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
  return { instance, templates, requests, grants, acceptedWorkers };
}

describe("reviewed Foundry workflows", () => {
  it("keeps a template draft private until it is submitted and reviewed for publication", async () => {
    const h = harness();
    const definition = { expertise: "customs filing", audience: "FDE", outcome: "prepare a draft", workflow: "collect sources", safetyLimits: "ask a human", instructions: "Use only knowledge from the target Space and always ask before actions.", sourceReferences: ["kb:policy"], toolAllowlist: ["knowledge-base"] };
    const created = await h.instance.fetch(new Request("https://space/foundry/templates", { method: "POST", body: JSON.stringify({ space_id: "s1", created_by: "u1", name: "Trade Desk", description: "Source-backed draft worker", definition }) }));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect(h.templates.get(id)?.status).toBe("draft");
    const revised = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}`, { method: "PUT", body: JSON.stringify({ updated_by: "u1", name: "Trade Desk v2", description: "Revised draft", definition: { ...definition, sourceReferences: ["kb:policy-v2"] } }) }));
    expect(await revised.json()).toMatchObject({ id, status: "draft", version: 2 });
    const tested = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_reference_checks: [{ id: "policy-v2", title: "Policy", resolved: true }], manual_reference_count: 0 }) }));
    expect(await tested.json()).toMatchObject({ passed: true, kind: "deterministic_configuration_checks", tested_version: 2 });
    const invalid = await h.instance.fetch(new Request("https://space/foundry/templates", { method: "POST", body: JSON.stringify({ space_id: "s1", created_by: "u1", name: "Unsafe", description: "x", definition: { ...definition, toolAllowlist: ["wallet"] } }) }));
    expect(invalid.status).toBe(400);
    const submitted = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}/submit`, { method: "POST" }));
    expect(await submitted.json()).toMatchObject({ status: "in_review" });
    const published = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}/review`, { method: "POST", body: JSON.stringify({ decision: "publish", reviewed_by: "owner-1", review_note: "Tested with synthetic examples" }) }));
    expect(await published.json()).toMatchObject({ status: "published", version: 3, reviewed_by: "owner-1" });
    expect((await h.instance.fetch(new Request(`https://space/foundry/templates/${id}?space_id=s1&published_only=true`))).status).toBe(200);
  });

  it("requires deployment approval for declared runtime dependencies before publication", async () => {
    const h = harness();
    const definition = { expertise: "video editing", audience: "FDE", outcome: "extract a clip", workflow: "inspect, then extract", safetyLimits: "no network", instructions: "Use only the staged media.", sourceReferences: [], toolAllowlist: ["knowledge-base"], runtimeDependencies: ["ffmpeg"] };
    const created = await h.instance.fetch(new Request("https://space/foundry/templates", { method: "POST", body: JSON.stringify({ space_id: "s1", created_by: "u1", name: "Media helper", description: "Uses the approved FFmpeg runtime", definition }) }));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect(JSON.parse(String(h.templates.get(id)?.definition_json))).toMatchObject({ runtimeDependencies: ["ffmpeg"] });
    const undeployed = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}/test`, { method: "POST", body: JSON.stringify({}) }));
    expect(await undeployed.json()).toMatchObject({ passed: false, checks: expect.arrayContaining([{ id: "container-runtime-dependencies", passed: false, runtime_ids: ["ffmpeg"] }]) });
    const deployed = await h.instance.fetch(new Request(`https://space/foundry/templates/${id}/test`, { method: "POST", body: JSON.stringify({ approved_runtime_ids: ["ffmpeg"] }) }));
    expect(await deployed.json()).toMatchObject({ passed: true, checks: expect.arrayContaining([{ id: "container-runtime-dependencies", passed: true, runtime_ids: ["ffmpeg"] }]) });
    const invalid = await h.instance.fetch(new Request("https://space/foundry/templates", { method: "POST", body: JSON.stringify({ space_id: "s1", created_by: "u1", name: "Unsafe runtime", description: "bad id", definition: { ...definition, runtimeDependencies: ["../escape"] } }) }));
    expect(invalid.status).toBe(400);
  });

  it("stores assistant-generated feature requests for owner review without applying changes", async () => {
    const h = harness();
    const created = await h.instance.fetch(new Request("https://space/foundry/requests", { method: "POST", body: JSON.stringify({ space_id: "s1", requested_by: "assistant-run-1", title: "Add a customs document checklist", problem: "The current workflow misses origin evidence.", workflow: "Gather required source fields before producing a draft.", evidence: ["project:shipment-7"] }) }));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect(h.requests.get(id)?.status).toBe("open");
    expect(h.requests.get(id)).not.toHaveProperty("code_change");
    const reviewed = await h.instance.fetch(new Request(`https://space/foundry/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted", reviewed_by: "owner-1", review_note: "Add to planning" }) }));
    expect(await reviewed.json()).toMatchObject({ status: "accepted", reviewed_by: "owner-1" });
  });
});

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

describe("Foundry worker invocation route", () => {
  function routeHarness(permitted: boolean) {
    const forwarded: Request[] = [];
    const sourceSpaceStub = {
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/hierarchy-authorize") return Response.json({ authorized: true });
        if (url.pathname === "/cross-space-check") return Response.json({ permitted });
        return Response.json({ error: "unexpected SpaceDO route" }, { status: 404 });
      }),
    };
    const agents = {
      fetch: vi.fn(async (request: Request) => {
        forwarded.push(request);
        return Response.json({ ok: true, run_id: "source-run-1" }, { status: 202 });
      }),
    };
    const env = {
      PLATFORM_SECRET: "test-secret",
      SPACE_DO: { idFromName: (name: string) => name, get: () => sourceSpaceStub },
      AGENTS_WORKER: agents,
    } as never;
    return { env, agents, forwarded };
  }

  const invocation = () => new Request("https://spaces.test/spaces/target-space/foundry/invoke-worker", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-1",
      "x-naelao-user-id": "user-1",
      "x-naelao-role": "owner",
    },
    body: JSON.stringify({ source_space_id: "source-space", agent_id: "worker-7", capability_token: "scoped-grant", goal: "Read the published customs checklist." }),
  });

  it("requires an active exact-resource invoke grant before calling the source worker", async () => {
    const denied = routeHarness(false);
    const deniedResponse = await spacesWorker.fetch(invocation(), denied.env);
    expect(deniedResponse.status).toBe(403);
    expect(denied.agents.fetch).not.toHaveBeenCalled();

    const allowed = routeHarness(true);
    const allowedResponse = await spacesWorker.fetch(invocation(), allowed.env);
    expect(allowedResponse.status).toBe(202);
    expect(allowed.agents.fetch).toHaveBeenCalledOnce();
    const forwardedRequest = allowed.forwarded[0]!;
    expect(new URL(forwardedRequest.url).pathname).toBe("/agents/worker-7/script/run");
    expect(forwardedRequest.headers.get("x-naelao-space-id")).toBe("source-space");
    expect(forwardedRequest.headers.get("x-naelao-role")).toBe("viewer");
    expect(await forwardedRequest.json()).toEqual({ goal: "Read the published customs checklist.", spaceId: "source-space", tenantId: "tenant-1" });
  });

  it("requires the live mapped executive contact, per-user acceptance, and source grant before channel invocation", async () => {
    const forwarded: Request[] = [];
    let linkedUser = "user-1";
    let accepted = true;
    let permitted = true;
    const spaceStub = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/hierarchy-authorize") return Response.json({ authorized: true });
      if (url.pathname === "/internal/executive/verify") return linkedUser
        ? Response.json({ verified: true, member: { user_id: linkedUser, role: "admin" } })
        : Response.json({ verified: false }, { status: 403 });
      if (url.pathname === "/cross-space-grants/accepted-worker") return accepted
        ? Response.json({ accepted: true, capability_token: "stored-capability" })
        : Response.json({ accepted: false }, { status: 404 });
      if (url.pathname === "/cross-space-check") return Response.json({ permitted });
      if (url.pathname === "/cross-space-audit") return Response.json({ audited: true });
      return Response.json({ error: "unexpected route" }, { status: 404 });
    }) };
    const agents = { fetch: vi.fn(async (request: Request) => { forwarded.push(request); return Response.json({ run_id: "run-queued", status: "queued" }, { status: 202 }); }) };
    const env = { PLATFORM_SECRET: "test-secret", SPACE_DO: { idFromName: (name: string) => name, get: () => spaceStub }, AGENTS_WORKER: agents } as never;
    const request = () => new Request("https://spaces.test/internal/spaces/target-space/foundry/channel-invoke", {
      method: "POST", headers: {
        "content-type": "application/json", "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1",
        "x-naelao-channel": "whatsapp", "x-naelao-channel-contact": "+15551234567",
        "x-naelao-internal-token": "",
      }, body: JSON.stringify({ sourceSpaceId: "source-space", agentId: "worker-1", goal: "Summarize the shared policy." }),
    });
    const make = async () => {
      const req = request(); req.headers.set("x-naelao-internal-token", await mintInternalToken("test-secret", "tenant-1"));
      return spacesWorker.fetch(req, env);
    };

    expect((await spacesWorker.fetch(request(), env)).status).toBe(403);
    expect(agents.fetch).not.toHaveBeenCalled();
    expect((await make()).status).toBe(202);
    expect(agents.fetch).toHaveBeenCalledOnce();
    const run = forwarded[0]!;
    expect(new URL(run.url).pathname).toBe("/agents/worker-1/script/run");
    expect(run.headers.get("x-naelao-role")).toBe("viewer");
    expect(run.headers.get("x-naelao-user-id")).toBe("user-1");
    expect(run.headers.get("x-naelao-channel-contact")).toBeNull();
    expect(await run.json()).toEqual({ goal: "Summarize the shared policy.", spaceId: "source-space", tenantId: "tenant-1" });
    expect(new URL(spaceStub.fetch.mock.calls.find(([r]) => new URL(r.url).pathname === "/cross-space-check")![0].url).searchParams.get("resource_id")).toBe("worker:worker-1");

    linkedUser = "someone-else";
    expect((await make()).status).toBe(403);
    linkedUser = "user-1"; accepted = false;
    expect((await make()).status).toBe(403);
    accepted = true; permitted = false;
    expect((await make()).status).toBe(403);
    expect(agents.fetch).toHaveBeenCalledOnce();
  });
});

describe("agent feature request ingress", () => {
  it("requires an internal run identity and derives the request actor on the worker side", async () => {
    const forwarded: Request[] = [];
    const spaceStub = { fetch: vi.fn(async (request: Request) => { forwarded.push(request); return Response.json({ id: "request-1", status: "open" }, { status: 201 }); }) };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "space-a" }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name, get: () => spaceStub },
    } as never;
    const { mintInternalToken } = await import("@naelao/http");
    const unauthenticated = await spacesWorker.fetch(new Request("https://spaces.test/internal/spaces/space-a/foundry/requests", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a" }, body: JSON.stringify({ title: "x", problem: "y", workflow: "z", evidence: [] }),
    }), env);
    expect(unauthenticated.status).toBe(403);
    expect(spaceStub.fetch).not.toHaveBeenCalled();
    const headers = {
      "content-type": "application/json",
      "x-naelao-tenant-id": "tenant-a",
      "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant-a"),
      "x-naelao-agent-id": "assistant-a",
      "x-naelao-run-id": "run-a",
      "x-naelao-user-id": "user-a",
    };
    const response = await spacesWorker.fetch(new Request("https://spaces.test/internal/spaces/space-a/foundry/requests", {
      method: "POST", headers,
      body: JSON.stringify({ requested_by: "forged-human", title: "Improve workflow", problem: "Missing validation.", workflow: "Review first.", evidence: [] }),
    }), env);
    expect(response.status).toBe(201);
    expect(JSON.parse(await forwarded[0]!.clone().text())).toMatchObject({ requested_by: "assistant:assistant-a:run:run-a:invoked-by:user-a", space_id: "space-a" });
    expect(JSON.parse(await forwarded[0]!.text())).not.toHaveProperty("requested_by", "forged-human");
  });
});

describe("Foundry template installation", () => {
  it("carries source reference labels as provenance and enables the review-only inbox tool", async () => {
    let installedBody: Record<string, unknown> | undefined;
    const sourceSpace = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/hierarchy-authorize") return Response.json({ authorized: true });
        if (path === "/cross-space-check") return Response.json({ permitted: true });
        if (path === "/foundry/templates/template-1") return Response.json({ name: "Domain Helper", description: "A published helper", definition: {
          expertise: "customs", audience: "operators", outcome: "prepare a draft", workflow: "review sources",
          safetyLimits: "ask first", instructions: "Use supported sources only.", sourceReferences: ["kb:origin-policy"], toolAllowlist: ["knowledge-base"],
        } });
        return Response.json({ error: "unexpected route" }, { status: 404 });
      }),
    };
    const agents = { fetch: vi.fn(async (request: Request) => { installedBody = await request.json() as Record<string, unknown>; return Response.json({ id: "worker-1" }, { status: 201 }); }) };
    const env = { PLATFORM_SECRET: "test-secret", SPACE_DO: { idFromName: (name: string) => name, get: () => sourceSpace }, AGENTS_WORKER: agents } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/target/foundry/install-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
      body: JSON.stringify({ source_space_id: "source", template_id: "template-1", capability_token: "scoped-token" }),
    }), env);
    expect(response.status).toBe(201);
    expect(installedBody?.prebuilt_scripts).toContain("foundry-inbox");
    expect(installedBody?.instructions).toContain("kb:origin-policy");
    expect(installedBody?.instructions).toContain("provenance only; source content is not shared");
    expect(installedBody?.instructions).toContain("knowledge.shared_document");
    expect(installedBody?.instructions).toContain('document_id:"<identifier>"');
    expect(installedBody?.instructions).toContain('source_space_id:"source"');
  });

  it("does not install a worker until every declared container runtime is deployed and already installed in the target scope", async () => {
    const requests: string[] = [];
    let runtimeInstalled = false;
    let installedBody: Record<string, unknown> | undefined;
    const sourceSpace = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname; requests.push(path);
        if (path === "/hierarchy-authorize") return Response.json({ authorized: true });
        if (path === "/cross-space-check") return Response.json({ permitted: true });
        if (path === "/foundry/templates/template-runtime") return Response.json({ name: "Media helper", description: "A helper", definition: {
          expertise: "media", audience: "operators", outcome: "extract audio", workflow: "inspect first", safetyLimits: "bounded", instructions: "Use the runtime only after approval.", sourceReferences: [], toolAllowlist: ["knowledge-base"], runtimeDependencies: ["ffmpeg"],
        } });
        if (path === "/container-installations") return Response.json({ installations: runtimeInstalled ? [{ manifest: { containers: [{ id: "ffmpeg" }] } }] : [] });
        return Response.json({ error: "unexpected route" }, { status: 404 });
      }),
    };
    const agents = { fetch: vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/container-images") return Response.json({ images: [{ id: "ffmpeg", available: true, install_manifest: { id: "ffmpeg" } }] });
      installedBody = await request.json() as Record<string, unknown>;
      return Response.json({ id: "installed-worker" }, { status: 201 });
    }) };
    const env = { PLATFORM_SECRET: "test-secret", SPACE_DO: { idFromName: (name: string) => name, get: () => sourceSpace }, AGENTS_WORKER: agents } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/target/foundry/install-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
      body: JSON.stringify({ source_space_id: "source", template_id: "template-runtime", capability_token: "scoped-token" }),
    }), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error_code: "template_runtime_dependencies_required", runtime_ids: ["ffmpeg"] });
    expect(agents.fetch).toHaveBeenCalledTimes(1);
    expect(requests).toContain("/container-installations");

    runtimeInstalled = true;
    const installed = await spacesWorker.fetch(new Request("https://spaces.test/spaces/target/foundry/install-template", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-user-id": "owner-a", "x-naelao-role": "owner" },
      body: JSON.stringify({ source_space_id: "source", template_id: "template-runtime", capability_token: "scoped-token" }),
    }), env);
    expect(installed.status).toBe(201);
    expect(installedBody?.instructions).toContain('"ffmpeg"');
    expect(agents.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("accepted Foundry document sharing", () => {
  function sharingHarness(sourcePermitted: boolean) {
    const forwarded: Request[] = [];
    const target = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url); forwarded.push(request);
      if (url.pathname === "/hierarchy-authorize") return Response.json({ authorized: true });
      if (url.pathname === "/cross-space-grants/accepted-document") {
        if (request.method === "DELETE") return Response.json({ revoked: true, document_id: "doc-1" });
        return Response.json({ accepted: true, capability_token: "accepted-capability" });
      }
      if (url.pathname === "/cross-space-grants/accept-document") return Response.json({ accepted: true }, { status: 201 });
      if (url.pathname === "/cross-space-check") return Response.json({ permitted: sourcePermitted });
      if (url.pathname === "/cross-space-audit") return Response.json({ audited: true });
      return Response.json({ error: "unexpected target route" }, { status: 404 });
    }) };
    const source = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url); forwarded.push(request);
      if (url.pathname === "/cross-space-check") return Response.json({ permitted: sourcePermitted });
      if (url.pathname === "/cross-space-audit") return Response.json({ audited: true });
      return Response.json({ error: "unexpected source route" }, { status: 404 });
    }) };
    const knowledge = { fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ document: { id: "doc-1", title: "Policy", content: "Sanitized approved text", chunk_count: 1 } });
    }) };
    const env = { PLATFORM_SECRET: "test-secret", KNOWLEDGE_WORKER: knowledge,
      SPACE_DO: { idFromName: (name: string) => name, get: () => target } } as never;
    const headers = async () => ({ "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "user-1",
      "x-naelao-internal-token": await mintInternalToken("test-secret", "tenant-1"), "content-type": "application/json" });
    return { env, target, source, knowledge, forwarded, headers };
  }

  it("accepts an exact user grant, rechecks source revocation before reading, and audits the read", async () => {
    const h = sharingHarness(true);
    const accept = await spacesWorker.fetch(new Request("https://spaces.test/spaces/target-space/foundry/accept-document", {
      method: "POST", headers: await h.headers(), body: JSON.stringify({ source_space_id: "source-space", document_id: "doc-1", capability_token: "scoped-token" }),
    }), h.env);
    expect(accept.status).toBe(201);
    expect(h.target.fetch).toHaveBeenCalledWith(expect.any(Request));
    const storedAcceptance = h.forwarded.map(request => request.url).find(url => url.endsWith("/cross-space-grants/accept-document"));
    expect(storedAcceptance).toBeTruthy();

    const read = await spacesWorker.fetch(new Request("https://spaces.test/internal/spaces/target-space/foundry/shared-document", {
      method: "POST", headers: { ...(await h.headers()), "x-naelao-agent-id": "worker-1", "x-naelao-run-id": "run-1" },
      body: JSON.stringify({ source_space_id: "source-space", document_id: "doc-1" }),
    }), h.env);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ document: { id: "doc-1", content: "Sanitized approved text" } });
    expect(h.knowledge.fetch).toHaveBeenCalledOnce();
    expect(h.forwarded.some(request => new URL(request.url).pathname === "/cross-space-audit")).toBe(true);
  });

  it("fails closed on revoked source grants and supports per-user acceptance revocation", async () => {
    const h = sharingHarness(false);
    const read = await spacesWorker.fetch(new Request("https://spaces.test/internal/spaces/target-space/foundry/shared-document", {
      method: "POST", headers: { ...(await h.headers()), "x-naelao-agent-id": "worker-1", "x-naelao-run-id": "run-2" },
      body: JSON.stringify({ source_space_id: "source-space", document_id: "doc-1" }),
    }), h.env);
    expect(read.status).toBe(403);
    expect(h.knowledge.fetch).not.toHaveBeenCalled();

    const revoked = await spacesWorker.fetch(new Request("https://spaces.test/spaces/target-space/foundry/accept-document?source_space_id=source-space&document_id=doc-1", {
      method: "DELETE", headers: await h.headers(),
    }), h.env);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ revoked: true, document_id: "doc-1" });
  });
});

describe("Foundry template knowledge-reference checks", () => {
  it("resolves only the template's exact kb references before saving validation evidence", async () => {
    let validationBody: Record<string, unknown> | undefined;
    const sourceSpace = { fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/hierarchy-authorize") return Response.json({ authorized: true });
      if (request.method === "GET" && url.pathname === "/foundry/templates/template-1") return Response.json({ definition: { sourceReferences: ["kb:doc-1", "manual:policy"] } });
      if (request.method === "POST" && url.pathname === "/foundry/templates/template-1/test") { validationBody = await request.json() as Record<string, unknown>; return Response.json({ passed: true }); }
      return Response.json({ error: "unexpected SpaceDO route" }, { status: 404 });
    }) };
    const knowledge = { fetch: vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/internal/spaces/source-space/kb/references/resolve");
      expect(await request.json()).toEqual({ document_ids: ["doc-1"] });
      return Response.json({ documents: [{ id: "doc-1", title: "Published policy", resolved: true }] });
    }) };
    const env = { PLATFORM_SECRET: "test-secret", KNOWLEDGE_WORKER: knowledge,
      SPACE_DO: { idFromName: (name: string) => name, get: () => sourceSpace } } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/source-space/foundry/templates/template-1/test", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "owner-1" },
    }), env);
    expect(response.status).toBe(200);
    expect(validationBody).toEqual({ source_reference_checks: [{ id: "doc-1", title: "Published policy", resolved: true }], manual_reference_count: 1, approved_runtime_ids: [] });
  });

  it("fails closed if a source reference cannot be resolved", async () => {
    const sourceSpace = { fetch: vi.fn(async (request: Request) => new URL(request.url).pathname === "/hierarchy-authorize"
      ? Response.json({ authorized: true })
      : Response.json({ definition: { sourceReferences: ["kb:doc-1"] } })) };
    const env = { PLATFORM_SECRET: "test-secret", SPACE_DO: { idFromName: (name: string) => name, get: () => sourceSpace } } as never;
    const response = await spacesWorker.fetch(new Request("https://spaces.test/spaces/source-space/foundry/templates/template-1/test", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-user-id": "owner-1" },
    }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "knowledge_reference_resolver_unavailable" });
  });
});
