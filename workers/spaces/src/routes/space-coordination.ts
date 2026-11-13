import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { getDOName } from "@naelao/crypto";
import { readBoundedRequestText, verifyInternalToken } from "@naelao/http";
import { SPACE_COORDINATION_DISCLOSURE_V1, spaceCoordinationDisclosureV2, validateSpaceCoordinationDraft, validateSpaceCoordinationDraftV2 } from "@naelao/agent-sdk";
import { resolveEndUserSpaceRole } from "../space-auth.js";

const basePath = "/spaces/:spaceId/coordination-registry";
const v2Path = `${basePath}/v2`;

export function registerSpaceCoordinationRoutes(app: Hono<{ Bindings: Env }>) {
  const noStoreHeader = async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    c.header("cache-control", "no-store");
    await next();
  };
  app.use(basePath, noStoreHeader);
  app.use(`${basePath}/*`, noStoreHeader);

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
    if (Object.keys(input).some(key => !["schema_version", "capability_key", "label", "description", "audience", "confirm_disclosure"].includes(key)))
      return c.json({ error_code: "invalid_coordination_draft" }, 400);
    const draftInput = { schema_version: input.schema_version, capability_key: input.capability_key, label: input.label,
      ...(input.description === undefined ? {} : { description: input.description }), audience: input.audience };
    const parsed = validateSpaceCoordinationDraftV2(draftInput);
    if (!parsed.ok) return c.json({ error_code: parsed.error }, 400);
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
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, expected_version: expectedVersion }),
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
      body: JSON.stringify({ tenant_id: auth.tenantId, space_id: auth.spaceId, actor_id: auth.userId, schema_version: 2, expected_version: expectedVersion }),
    }));
    return noStore(response);
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
