import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { SPACE_COORDINATION_DISCLOSURE_V1, spaceCoordinationDisclosureV2, validateSpaceCoordinationDraft, validateSpaceCoordinationDraftV2 } from "@naelao/agent-sdk";
import { resolveEndUserSpaceRole } from "../space-auth.js";

const basePath = "/spaces/:spaceId/coordination-registry";
const v2Path = `${basePath}/v2`;
const policyPath = `${v2Path}/policy`;
const proposalsPath = "/spaces/:spaceId/coordination-proposals";

export function registerSpaceCoordinationRoutes(app: Hono<{ Bindings: Env }>) {
  const noStoreHeader = async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    c.header("cache-control", "no-store");
    await next();
  };
  app.use(basePath, noStoreHeader);
  app.use(`${basePath}/*`, noStoreHeader);
  app.use(proposalsPath, noStoreHeader);
  app.use(`${proposalsPath}/*`, noStoreHeader);
  app.use("/spaces/:spaceId/projects/:projectId/coordination-proposals", noStoreHeader);
  app.use("/spaces/:spaceId/projects/:projectId/coordination-proposals/*", noStoreHeader);

  app.get(basePath, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-registry?${params}`)));
  });

  app.get(v2Path, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, limit: "50", schema_version: "2", viewer_role: auth.role, ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-registry?${params}`)));
  });

  app.get(policyPath, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-policy?${params}`)));
  });

  app.get(`${policyPath}/history`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const after = c.req.query("after");
    if (after !== undefined && (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isSafeInteger(Number(after))))
      return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-policy/history?${params}`)));
  });

  app.get(`${v2Path}/requests`, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, viewer_id: auth.userId,
      viewer_role: auth.role, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-use-requests?${params}`)));
  });

  app.post(`${v2Path}/:entryId/requests`, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const entryId = c.req.param("entryId");
    if (!entryId || !/^[A-Za-z0-9_-]{1,128}$/.test(entryId)) return c.json({ error_code: "coordination_entry_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => key !== "confirm_identity_sharing") || input.confirm_identity_sharing !== true)
      return c.json({ error_code: "coordination_identity_sharing_confirmation_required" }, 400);
    const response = await auth.stub.fetch(new Request("http://space/space-coordination-use-requests", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, entry_id: entryId, request_id: crypto.randomUUID(),
        requester_id: auth.userId, requester_role: auth.role, confirm_identity_sharing: true }),
    }));
    return noStore(response);
  });

  app.patch(`${v2Path}/requests/:requestId`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const requestId = c.req.param("requestId");
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return c.json({ error_code: "coordination_request_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => !["expected_revision", "resolution"].includes(key))
      || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 1
      || (input.resolution !== "contacted" && input.resolution !== "unavailable"))
      return c.json({ error_code: "coordination_request_invalid" }, 400);
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-use-requests/${encodeURIComponent(requestId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, actor_role: auth.role,
        expected_revision: input.expected_revision, resolution: input.resolution }),
    }));
    return noStore(response);
  });

  app.get(proposalsPath, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, viewer_id: auth.userId,
      viewer_role: auth.role, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-proposals?${params}`)));
  });

  app.get("/spaces/:spaceId/projects/:projectId/coordination-proposals", async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const projectId = c.req.param("projectId");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)) return c.json({ error_code: "project_not_found" }, 404);
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, project_id: projectId,
      viewer_id: auth.userId, viewer_role: auth.role, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-proposals?${params}`)));
  });

  app.post("/spaces/:spaceId/projects/:projectId/coordination-proposals", async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const projectId = c.req.param("projectId");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)) return c.json({ error_code: "project_not_found" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => !["request_id", "schema_version", "capability_key", "label", "description", "audience", "expires_at", "confirm_disclosure"].includes(key))
      || typeof input.request_id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.request_id) || input.confirm_disclosure !== true)
      return c.json({ error_code: "coordination_proposal_invalid" }, 400);
    const draftInput = { schema_version: input.schema_version, capability_key: input.capability_key, label: input.label,
      ...(input.description === undefined ? {} : { description: input.description }), audience: input.audience,
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }) };
    const parsed = validateSpaceCoordinationDraftV2(draftInput);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    if (isExpired(parsed.value.expires_at)) return c.json({ error_code: "coordination_expiry_must_be_future" }, 400);
    const requesterRole = auth.role === "owner" || auth.role === "admin" ? auth.role : "project_manager";
    const response = await auth.stub.fetch(new Request("http://space/space-coordination-proposals", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, proposal_id: input.request_id, project_id: projectId,
        requester_id: auth.userId, requester_role: requesterRole, confirm_disclosure: true, draft: parsed.value }),
    }));
    return noStore(response);
  });

  app.delete("/spaces/:spaceId/projects/:projectId/coordination-proposals/:proposalId", async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const projectId = c.req.param("projectId"), proposalId = c.req.param("proposalId");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(projectId) || !/^[0-9a-f-]{36}$/i.test(proposalId))
      return c.json({ error_code: "coordination_proposal_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => key !== "expected_revision")
      || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 1)
      return c.json({ error_code: "coordination_proposal_invalid" }, 400);
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-proposals/${encodeURIComponent(proposalId)}`, {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, project_id: projectId,
        requester_id: auth.userId, expected_revision: input.expected_revision }),
    }));
    return noStore(response);
  });

  app.patch(`${proposalsPath}/:proposalId`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const proposalId = c.req.param("proposalId");
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return c.json({ error_code: "coordination_proposal_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => !["expected_revision", "action", "confirm_disclosure", "draft"].includes(key))
      || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 1
      || (input.action !== "approve" && input.action !== "reject")) return c.json({ error_code: "coordination_proposal_invalid" }, 400);
    let draft: unknown;
    if (input.action === "approve") {
      const draftInput = input.draft as Record<string, unknown> | null;
      if (!draftInput || typeof draftInput !== "object" || Array.isArray(draftInput)) return c.json({ error_code: "invalid_coordination_draft" }, 400);
      const normalized = { schema_version: draftInput.schema_version, capability_key: draftInput.capability_key, label: draftInput.label,
        ...(draftInput.description === undefined ? {} : { description: draftInput.description }), audience: draftInput.audience,
        ...(draftInput.expires_at === undefined ? {} : { expires_at: draftInput.expires_at }) };
      const parsed = validateSpaceCoordinationDraftV2(normalized);
      if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
      if (isExpired(parsed.value.expires_at)) return c.json({ error_code: "coordination_expiry_must_be_future" }, 400);
      if (input.confirm_disclosure !== true) return c.json({ error_code: "coordination_disclosure_confirmation_required",
        disclosure: spaceCoordinationDisclosureV2(parsed.value.audience) }, 400);
      draft = parsed.value;
    } else if (input.draft !== undefined || input.confirm_disclosure !== undefined) {
      return c.json({ error_code: "coordination_proposal_invalid" }, 400);
    }
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-proposals/${encodeURIComponent(proposalId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, actor_role: auth.role,
        expected_revision: input.expected_revision, action: input.action, ...(input.action === "approve" ? { confirm_disclosure: true, draft } : {}) }),
    }));
    if (!response.ok) return noStore(response);
    const result = await response.json<Record<string, unknown>>();
    return c.json({ ...result, ...(input.action === "approve" ? { disclosure: spaceCoordinationDisclosureV2((draft as { audience: "space_members" | "space_admins" }).audience) } : {}) });
  });

  app.put(policyPath, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error_code: "coordination_policy_invalid" }, 400);
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !["member_facts_enabled", "expected_revision", "confirm"].includes(key))
      || typeof input.member_facts_enabled !== "boolean" || !Number.isSafeInteger(input.expected_revision)
      || Number(input.expected_revision) < 0 || input.confirm !== true) {
      return c.json({ error_code: "coordination_policy_invalid" }, 400);
    }
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-policy?${new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId })}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ member_facts_enabled: input.member_facts_enabled, expected_revision: input.expected_revision,
        actor_id: auth.userId, actor_role: auth.role, confirmed: true }),
    }));
    return noStore(response);
  });

  app.post(`${basePath}/preview`, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const parsed = validateSpaceCoordinationDraft(raw);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    return c.json({ schema_version: 1, draft: parsed.value, disclosure: SPACE_COORDINATION_DISCLOSURE_V1, no_project_source: true });
  });

  app.post(`${v2Path}/preview`, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const parsed = validateSpaceCoordinationDraftV2(raw);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    if (isExpired(parsed.value.expires_at)) return c.json({ error_code: "coordination_expiry_must_be_future" }, 400);
    return c.json({ schema_version: 2, draft: parsed.value, disclosure: spaceCoordinationDisclosureV2(parsed.value.audience), no_project_source: true });
  });

  app.post(basePath, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error_code: "invalid_coordination_draft" }, 400);
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !["capability_key", "label", "description", "confirm_disclosure"].includes(key))) {
      return c.json({ error_code: "invalid_coordination_draft" }, 400);
    }
    const parsed = validateSpaceCoordinationDraft({ capability_key: input?.capability_key, label: input?.label, ...(input?.description === undefined ? {} : { description: input.description }) });
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    if (input?.confirm_disclosure !== true) return c.json({ error_code: "coordination_disclosure_confirmation_required", disclosure: SPACE_COORDINATION_DISCLOSURE_V1 }, 400);
    const entryId = crypto.randomUUID();
    const response = await auth.stub.fetch(new Request("http://space/space-coordination-registry", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, entry_id: entryId, actor_id: auth.userId,
        approved_role: auth.role, confirmed: true, draft: parsed.value }),
    }));
    return response.ok ? c.json({ ...(await response.json<Record<string, unknown>>()), disclosure: SPACE_COORDINATION_DISCLOSURE_V1 }, response.status as 200 | 201) : noStore(response);
  });

  app.post(v2Path, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error_code: "invalid_coordination_draft" }, 400);
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !["schema_version", "capability_key", "label", "description", "audience", "expires_at", "confirm_disclosure"].includes(key)))
      return c.json({ error_code: "invalid_coordination_draft" }, 400);
    const draftInput = { schema_version: input.schema_version, capability_key: input.capability_key, label: input.label,
      ...(input.description === undefined ? {} : { description: input.description }), audience: input.audience,
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }) };
    const parsed = validateSpaceCoordinationDraftV2(draftInput);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    if (isExpired(parsed.value.expires_at)) return c.json({ error_code: "coordination_expiry_must_be_future" }, 400);
    const disclosure = spaceCoordinationDisclosureV2(parsed.value.audience);
    if (input.confirm_disclosure !== true) return c.json({ error_code: "coordination_disclosure_confirmation_required", disclosure }, 400);
    const entryId = crypto.randomUUID();
    const response = await auth.stub.fetch(new Request("http://space/space-coordination-registry", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, entry_id: entryId, schema_version: 2, actor_id: auth.userId,
        approved_role: auth.role, confirmed: true, draft: parsed.value }),
    }));
    return response.ok ? c.json({ ...(await response.json<Record<string, unknown>>()), disclosure }, response.status as 200 | 201) : noStore(response);
  });

  app.delete(`${basePath}/:entryId`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const entryId = c.req.param("entryId");
    if (!entryId || entryId.length > 128) return c.json({ error_code: "coordination_entry_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const expectedVersion = (raw as Record<string, unknown>)?.expected_version;
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) return c.json({ error_code: "invalid_expected_version" }, 400);
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-registry/${encodeURIComponent(entryId)}`, {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, approved_role: auth.role, expected_version: expectedVersion }),
    }));
    return noStore(response);
  });

  app.delete(`${v2Path}/:entryId`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const entryId = c.req.param("entryId");
    if (!entryId || entryId.length > 128) return c.json({ error_code: "coordination_entry_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (input?.schema_version !== 2 || Object.keys(input ?? {}).some(key => !["schema_version", "expected_version"].includes(key)))
      return c.json({ error_code: "invalid_coordination_draft" }, 400);
    const expectedVersion = input?.expected_version;
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) return c.json({ error_code: "invalid_expected_version" }, 400);
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-registry/${encodeURIComponent(entryId)}`, {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, approved_role: auth.role, schema_version: 2, expected_version: expectedVersion }),
    }));
    return noStore(response);
  });

  app.patch(`${v2Path}/:entryId`, async c => {
    const auth = await authorize(c, true);
    if (auth instanceof Response) return auth;
    const entryId = c.req.param("entryId");
    if (!entryId || entryId.length > 128) return c.json({ error_code: "coordination_entry_unavailable" }, 404);
    const raw = await readJson(c.req.raw);
    if (raw instanceof Response) return raw;
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(key => !["schema_version", "expected_version", "capability_key", "label", "description", "audience", "expires_at", "confirm_disclosure"].includes(key)))
      return c.json({ error_code: "invalid_coordination_draft" }, 400);
    if (input.schema_version !== 2 || !Number.isInteger(input.expected_version) || (input.expected_version as number) < 1)
      return c.json({ error_code: "invalid_expected_version" }, 400);
    const draft = { schema_version: input.schema_version, capability_key: input.capability_key, label: input.label,
      ...(input.description === undefined ? {} : { description: input.description }), audience: input.audience,
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }) };
    const parsed = validateSpaceCoordinationDraftV2(draft);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
    if (isExpired(parsed.value.expires_at)) return c.json({ error_code: "coordination_expiry_must_be_future" }, 400);
    const disclosure = spaceCoordinationDisclosureV2(parsed.value.audience);
    if (input.confirm_disclosure !== true) return c.json({ error_code: "coordination_disclosure_confirmation_required", disclosure }, 400);
    const response = await auth.stub.fetch(new Request(`http://space/space-coordination-registry/${encodeURIComponent(entryId)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, approved_role: auth.role,
        schema_version: 2, expected_version: input.expected_version, confirmed: true, draft: parsed.value }),
    }));
    if (!response.ok) return noStore(response);
    return c.json({ ...(await response.json<Record<string, unknown>>()), disclosure });
  });

  app.get(`${v2Path}/:entryId/history`, async c => {
    const auth = await authorize(c, false);
    if (auth instanceof Response) return auth;
    if (auth.role !== "owner" && auth.role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const entryId = c.req.param("entryId");
    if (!entryId || entryId.length > 128) return c.json({ error_code: "coordination_entry_unavailable" }, 404);
    const after = c.req.query("after");
    if (after !== undefined && (!after || after.length > 256)) return c.json({ error_code: "invalid_cursor" }, 400);
    const params = new URLSearchParams({ tenant_id: auth.tenantId, space_id: auth.spaceId, limit: "50", ...(after ? { after } : {}) });
    return noStore(await auth.stub.fetch(new Request(`http://space/space-coordination-registry/${encodeURIComponent(entryId)}/history?${params}`)));
  });
}

async function authorize(c: Context<{ Bindings: Env }>, write: boolean) {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const spaceId = c.req.param("spaceId") ?? "";
  const identityRole = c.req.header("x-naelao-role") ?? "";
  if (!tenantId || !userId || !spaceId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) {
    return c.json({ error_code: "forbidden" }, 403);
  }
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first<{ id: string }>();
  if (!owned) return c.json({ error_code: "not_found" }, 404);
  const role = identityRole === "product_end_user"
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId, tenantId)
    : identityRole;
  if (!role || !["owner", "admin", "member", "viewer", "editor", "operator", "moderator"].includes(role)) {
    return c.json({ error_code: "forbidden" }, 403);
  }
  if (write && role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
  const stub = c.env.SPACE_DO.get(c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)));
  return { tenantId, userId, spaceId, role, stub };
}

async function readJson(request: Request): Promise<unknown | Response> {
  try {
    const text = await readBoundedRequestText(request, 2048);
    return JSON.parse(text) as unknown;
  } catch {
    return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
  }
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

function isExpired(value: string | null | undefined): boolean {
  return Boolean(value && Date.parse(value) <= Date.now());
}
