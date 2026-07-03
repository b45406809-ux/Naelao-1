import { Hono } from "hono";
import { errorResponse, requestId, notFound, requireInternalHmac, mintInternalToken, verifyInternalToken, forbidden } from "@naelao/http";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import type { SpaceDO } from "./do/SpaceDO.js";
import type { SpaceTypeRegistryDO, SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_MANIFEST } from "./launchpad-manifest.js";
import { cfSaasConfig, createCustomHostname, getCustomHostname } from "./cf-saas.js";
import { validateCronExpression } from "@naelao/events";
import { registerBuilderRoutes } from "./builder-routes.js";
import { registerProductEndUserRoutes } from "./product-end-user-routes.js";
import { createSpaceRecord, SpaceCreationError } from "./create-space.js";
import type { ProvisionMessage } from "./create-space.js";

export { SpaceDO } from "./do/SpaceDO.js";
export { LockDO } from "./do/LockDO.js";
export { FeatureFlagDO } from "./do/FeatureFlagDO.js";
export { TransactionCoordinatorDO } from "./do/TransactionCoordinatorDO.js";
export { SpaceTypeRegistryDO } from "./do/SpaceTypeRegistryDO.js";
export { BuilderAccountDO } from "./do/BuilderAccountDO.js";
export { ProductUserDO } from "./do/ProductUserDO.js";

export interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_DO: DurableObjectNamespace<SpaceDO>;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace<SpaceTypeRegistryDO>;
  /** Three-Tier Platform Model, Phase 1 — one per builder (tenant). */
  BUILDER_ACCOUNT_DO: DurableObjectNamespace;
  /** Three-Tier Platform Model, Phase 2 — one per (productId, endUserId). */
  PRODUCT_USER_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  EXPORTS_BUCKET: R2Bucket;
  /** Producer to the provisioning queue — consumed by naelao-provisioner. */
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  /** Cloudflare for SaaS custom-hostname provisioning (deploy-time secrets; optional). */
  CF_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  /** Billing worker — called at publish time to auto-create LS product + variant. */
  BILLING_WORKER?: Fetcher;
  /** Agents worker — SpaceDO fires event_triggers by calling its internal script.run route. */
  AGENTS_WORKER?: Fetcher;
}

/** Message enqueued on space creation; consumed by the provisioner (installs agents etc.). */

// G-A11: Validate required secrets at startup
function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });

// Extract caller identity from headers (set by router worker after JWT validation)
function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}

// ── GET /spaces — list spaces for tenant ────────────────────────────────────
app.get("/spaces", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE tenant_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 100"
  )
    .bind(tenantId)
    .all();
  return c.json({ data: results, count: results.length });
});

// ── POST /spaces — create a space ───────────────────────────────────────────
app.post("/spaces", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{
    name: string;
    spacetype_id: string;
    /** For Launchpad: the selected product template (e.g. "creator-store"). */
    template_id?: string;
    config_overrides?: Record<string, unknown>;
  }>();

  try {
    const result = await createSpaceRecord(c.env, {
      tenantId,
      ...(userId ? { userId } : {}),
      name: body.name,
      spacetypeId: body.spacetype_id,
      ...(body.template_id ? { templateId: body.template_id } : {}),
      ...(body.config_overrides ? { configOverrides: body.config_overrides } : {}),
    });
    return c.json({ id: result.id, name: body.name, status: result.status, created_at: result.created_at }, 201);
  } catch (err) {
    if (err instanceof SpaceCreationError) {
      return c.json({ error_code: err.error_code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status as 400 | 402 | 409);
    }
    throw err;
  }
});

// ── GET /spaces/:id ─────────────────────────────────────────────────────────
app.get("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first();

  if (!space) throw notFound("Space");
  return c.json(space);
});

// ── PATCH /spaces/:id ───────────────────────────────────────────────────────
app.patch("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    status?: string;
    config_overrides?: Record<string, unknown>;
  }>();
  const now = new Date().toISOString();

  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first();
  if (!existing) throw notFound("Space");

  if (body.name) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.name, now, spaceId)
      .run();
  }
  if (body.status) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.status, now, spaceId)
      .run();
  }
  if (body.config_overrides) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify(body.config_overrides), now, spaceId)
      .run();
  }
  return c.json({ id: spaceId, updated_at: now });
});

// ── DELETE /spaces/:id (soft delete) ────────────────────────────────────────
app.delete("/spaces/:id", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("id");
  const now = new Date().toISOString();

  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?"
  )
    .bind(now, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) throw notFound("Space");
  return c.json({ deleted: true });
});

// ── G-AO30: GDPR Art. 15 — End-user conversation history export ─────────────
// GET /spaces/:spaceId/me/export?end_user_id=xxx
// Fetches all messages for the end_user_id, serializes to JSON, uploads to R2,
// returns a presigned URL valid 24 hours.
app.get("/spaces/:spaceId/me/export", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  if (!endUserId) return c.json({ error_code: "bad_request", message: "end_user_id is required" }, 400);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, c.req.header("x-naelao-tenant-id") ?? "", c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request(`http://space-do/me/messages?user_id=${encodeURIComponent(endUserId)}`, { method: "GET" })
  );
  if (!doRes.ok) {
    return new Response(doRes.body, { status: doRes.status, headers: { "content-type": "application/json" } });
  }

  const exportData = await doRes.json<{ messages: unknown[]; sessions: string[] }>();
  const payload = JSON.stringify({
    export_version: "1",
    space_id: spaceId,
    end_user_id: endUserId,
    exported_at: new Date().toISOString(),
    sessions: exportData.sessions,
    messages: exportData.messages,
  }, null, 2);

  // Upload to R2 with a 24h expiry path
  const exportKey = `exports/${spaceId}/${endUserId}/${crypto.randomUUID()}.json`;
  await c.env.EXPORTS_BUCKET.put(exportKey, payload, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { end_user_id: endUserId, space_id: spaceId },
  });

  // G-AO30: HMAC-signed download URL valid 24 hours (R2 Workers binding has no native presigned URL)
  // URL: /spaces/{spaceId}/me/export/download?key=...&expires=...&sig=...
  const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  const sigInput = `${exportKey}:${expiresAt}`;
  const sig = await signHmac(sigInput, c.env.PLATFORM_SECRET);
  const downloadUrl = `/spaces/${spaceId}/me/export/download?key=${encodeURIComponent(exportKey)}&expires=${expiresAt}&sig=${sig}`;

  console.log(`[gdpr][export] user=${endUserId} space=${spaceId} key=${exportKey}`);
  return c.json({ export_url: downloadUrl, expires_in_seconds: 86400, message_count: exportData.messages.length }, 200);
});

// ── G-AO30: Signed export download ──────────────────────────────────────────
// GET /spaces/:spaceId/me/export/download?key=...&expires=...&sig=...
app.get("/spaces/:spaceId/me/export/download", async (c) => {
  const key = c.req.query("key") ?? "";
  const expiresStr = c.req.query("expires") ?? "0";
  const sig = c.req.query("sig") ?? "";

  const expiresAt = parseInt(expiresStr, 10);
  if (!key || !sig || Date.now() / 1000 > expiresAt) {
    return c.json({ error_code: "forbidden", message: "Export link has expired or is invalid" }, 403);
  }

  const sigInput = `${key}:${expiresAt}`;
  const valid = await verifyHmac(sigInput, sig, c.env.PLATFORM_SECRET);
  if (!valid) {
    return c.json({ error_code: "forbidden", message: "Invalid export link signature" }, 403);
  }

  const obj = await c.env.EXPORTS_BUCKET.get(key);
  if (!obj) return c.json({ error_code: "not_found", message: "Export not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="naelao-export.json"`,
    },
  });
});

// ── G-AO31: GDPR Art. 17 — End-user erasure within a Space ──────────────────
// DELETE /spaces/:spaceId/me/data?end_user_id=xxx
app.delete("/spaces/:spaceId/me/data", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  if (!endUserId) return c.json({ error_code: "bad_request", message: "end_user_id is required" }, 400);

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, c.req.header("x-naelao-tenant-id") ?? "", c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request(`http://space-do/me/data?user_id=${encodeURIComponent(endUserId)}`, { method: "DELETE" })
  );

  const result = await doRes.json<{ sessions_deleted: number; messages_deleted: number; erased_at: string }>();
  console.log(`[gdpr][erasure] user=${endUserId} space=${spaceId} result=${JSON.stringify(result)}`);

  return c.json({ erased: true, space_id: spaceId, sessions_deleted: result.sessions_deleted, messages_deleted: result.messages_deleted, erased_at: result.erased_at }, 200);
});

// ── G-AO17: Runtime injection attempt recording ──────────────────────────────
// POST /spaces/:spaceId/me/injection { end_user_id, space_id }
// Records attempt in SpaceDO and returns rate-limited status.
app.post("/spaces/:spaceId/me/injection", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const doRes = await stub.fetch(
    new Request("http://space-do/me/injection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: c.req.raw.body,
    })
  );
  const result = await doRes.json<unknown>();
  return c.json(result, doRes.status as 200 | 400);
});

// ── SpaceDO agent_definitions proxy ─────────────────────────────────────────
// Forward /spaces/:spaceId/agent-definitions* to the SpaceDO.
// Per spec §11 and CLAUDE.md: SpaceDO owns agent_definitions.
// A1.16.10 (layer-3 backstop, bucket A): builder-authored config, never end-user-facing
// (confirmed against apps/widget + apps/portal — neither ever calls this route) — safe to gate.
// Gated inline (not via a separate app.use(...)) — see the /internal/space-types-record-install/
// :id route's comment for the full root-cause writeup: a separate app.use(...) on an overlapping
// wildcard pattern was found, at this app's route-table scale, to be silently bypassable (a
// genuine Hono RegExpRouter/TrieRouter limitation, not application logic) — this route's own
// "no token" test started failing OPEN (500 reaching the handler instead of 403) once an
// unrelated part of the same corruption elsewhere in this file was fixed, proving the risk is
// real, not theoretical.
app.all("/spaces/:spaceId/agent-definitions*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");
  const doUrl = new URL(doPath + url.search, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      ...(c.req.raw.body ? { duplex: "half" as const } : {}),
    })
  );
});

// ── SpaceDO members proxy ────────────────────────────────────────────────────
// A1.16.10 (layer-3 backstop, bucket A): SpaceDO team members (spec A1.8's "team" population —
// people invited into the space with a role) are never product/portal customers (the hard
// rule: "never make product customers into SpaceDO members") — confirmed neither widget nor
// portal ever calls this route. Safe to gate. Gated inline for the same reason as
// agent-definitions above.
app.all("/spaces/:spaceId/members*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");
  const doUrl = new URL(`${doPath}?space_id=${spaceId}${url.search ? "&" + url.search.slice(1) : ""}`, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      ...(c.req.raw.body ? { duplex: "half" as const } : {}),
    })
  );
});

// ── SpaceDO session proxy ────────────────────────────────────────────────────
// Forward /spaces/:spaceId/sessions/* to the SpaceDO for that space
// A1.16.10 (layer-3 backstop, bucket B): investigated before gating — the router mounts this
// path on its JWT-gated `api` sub-app (api.use("*", jwtAuth(...)) with no exceptions), so a
// Bearer token is ALREADY mandatory to reach here via the router. Neither apps/widget nor
// apps/portal ever sends one (they only send x-naelao-end-user-id) — end-user chat through
// the router is presently non-functional (a separate, real bug: no customer-auth JWT flow
// exists yet — see appendix). This means gating with requireInternalHmac cannot break
// currently-working end-user traffic, because none currently reaches this route successfully.
// The one direct (non-router) caller, NaelaoAgentDO.writeConversationToSession, already mints
// the token (see A1.16.9).
// Three-Tier Platform Model Phase 6 finding: POST /sessions (session CREATE — the mechanism
// every end-user chat surface depends on) was UNREACHABLE before this pass touched anything,
// confirmed against git HEAD. Root cause was elsewhere in this file, not in this route itself —
// see the /internal/space-types-record-install/:id route's comment for the full root-cause
// writeup (a genuine Hono RegExpRouter limitation at this app's route-table scale, silently
// corrupting POST matching platform-wide). Gated inline here too, consistent with that fix.
app.all("/spaces/:spaceId/sessions*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  // G-BA01: HMAC-derived DO name prevents enumeration by compromised workers
  const doId = c.env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET)
  );
  const stub = c.env.SPACE_DO.get(doId);

  const url = new URL(c.req.url);
  // Strip the /spaces/:spaceId prefix, keep /sessions/*
  const doPath = url.pathname.replace(`/spaces/${spaceId}`, "");

  // Three-Tier Platform Model Phase 6: GET /sessions (bare, no :id) is the list route — a
  // signed-in end user's own "recent conversations." The end_user_id filter MUST be derived
  // from this caller's own verified claims, never forwarded from the client's query string —
  // otherwise any end user could pass ?end_user_id=<someone-else> and list a stranger's
  // sessions. Every other sub-path (create/get/messages/state) is untouched passthrough.
  let search = url.search;
  if (c.req.method === "GET" && doPath === "/sessions") {
    const { role, userId } = getCallerIdentity(c);
    const qs = new URLSearchParams();
    if (role === "product_end_user" && userId) qs.set("end_user_id", userId);
    const limit = url.searchParams.get("limit");
    if (limit) qs.set("limit", limit);
    search = `?${qs.toString()}`;
  }
  const doUrl = new URL(doPath + search, "http://space-do");

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // Required by spec-compliant fetch implementations (e.g. Node's undici, used by this
      // repo's own test suite) whenever a streaming body is attached to a Request — omitting it
      // throws "duplex option is required" and was silently never hit before this Phase 6 pass
      // because this whole route was unreachable (see the routing-bug comment above).
      ...(c.req.raw.body ? { duplex: "half" as const } : {}),
    })
  );
});

// ── Space hierarchy: registry, sub-spaces (departments), cross-space grants ──
// (spec §10 SpaceDO registry, §49 Sub-Space Architecture, G-Y15/G-Y16).
//
// Two distinct creation flows, deliberately kept separate:
//  • Departments (in-DO sub-spaces) — POST /spaces/:id/sub-spaces. Rows in the parent's
//    SpaceDO `spaces` registry, isolated by space_id. depth 1-2. Used by team tenancy and
//    by departments WITHIN a saas business. Generic across every space type.
//  • New isolated businesses (saas per-end-user) — POST /reseller/spaces (below). Each gets
//    its OWN child tenant + OWN SpaceDO (structural isolation, G-Y16). That is how a
//    wholesaler's customer "starts a business": their own space, never a row in the
//    wholesaler's DB — so the parent is never over-populated.

/** Get the SpaceDO stub for a (spaceId, tenantId), HMAC-named to prevent enumeration. */
async function spaceDoStub(env: Env, spaceId: string, tenantId: string) {
  const doId = env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET));
  return env.SPACE_DO.get(doId);
}

/** Get the BuilderAccountDO stub for a builder (== tenant), HMAC-named like every other DO. */
async function builderAccountDoStub(env: Env, tenantId: string) {
  const doId = env.BUILDER_ACCOUNT_DO.idFromName(
    await getDOName("builder", tenantId, tenantId, env.PLATFORM_SECRET)
  );
  return env.BUILDER_ACCOUNT_DO.get(doId);
}

/** Get the ProductUserDO stub for a (product, end-user) pair, HMAC-named to prevent enumeration.
 *  productId is a space id; the tenant that owns it scopes the HMAC so two builders can't collide
 *  on the same end_user_id namespace. */
async function productUserDoStub(env: Env, productId: string, endUserId: string, tenantId: string) {
  const doId = env.PRODUCT_USER_DO.idFromName(
    await getDOName("produser", `${productId}:${endUserId}`, tenantId, env.PLATFORM_SECRET)
  );
  return env.PRODUCT_USER_DO.get(doId);
}

/** Forward a request to a path on the SpaceDO, preserving method/headers/body. */
async function forwardToSpaceDO(
  stub: ReturnType<Env["SPACE_DO"]["get"]>,
  path: string,
  method: string,
  body?: BodyInit | null,
): Promise<Response> {
  return stub.fetch(new Request(`http://space-do${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && body !== null ? { body } : {}),
  }));
}

// POST /spaces/:spaceId/registry — internal: seed/refresh the root space row.
// Called by the provisioner (step 5b) with the manifest tenancy + agency_shell.
// A1.16.9 (layer-3 backstop): the old check was a static "x-naelao-internal === 'provisioner'"
// string, forgeable by anyone reaching this worker directly. requireInternalHmac replaces it.
app.use("/spaces/:spaceId/registry", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/spaces/:spaceId/registry", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/spaces", "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST /internal/spaces/:spaceId/events/fire — internal: let a caller outside this space's
// SpaceDO (e.g. the agents worker's scheduled-jobs auto-disable, A1.16.13) run an arbitrary
// event through the same event_triggers matching every structural mutation already uses, so a
// builder can wire a no-code trigger to react to it the same way as thread.created etc.
app.use("/internal/spaces/:spaceId/events/fire", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/events/fire", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/internal/events/fire", "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Projects (thread grouping) — builder-only surface (never end-user-facing), so safe to gate
// broadly: real traffic always arrives either via the router (proxyTo already mints the token
// off verified JWT claims) or a direct internal caller (NaelaoAgentDO, agents worker — both
// updated to mint it too).
app.use("/spaces/:spaceId/projects", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/rules", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/spend", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

// GET lists, POST creates — proxied to the SpaceDO.
app.get("/spaces/:spaceId/projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects?space_id=${encodeURIComponent(spaceId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ name: string; description?: string }>().catch(() => ({ name: "" }));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/projects", "POST", JSON.stringify({ ...body, space_id: spaceId, tenant_id: tenantId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET/PATCH a single project — config surface for customer-bot projects (kind,
// execution_ceiling, channel_config, daily_spend_cap_credits). No-code: the dashboard
// renders these as form fields, never as a code editor.
app.get("/spaces/:spaceId/projects/:projectId", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.patch("/spaces/:spaceId/projects/:projectId", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}`, "PATCH", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Project rules — no-code "after the customer says X, this happens" triggers.
app.get("/spaces/:spaceId/projects/:projectId/rules", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/rules`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/rules", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/rules`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/projects/:projectId/rules/:ruleId", async (c) => {
  const { spaceId, projectId, ruleId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(ruleId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// F9: authoritative per-project daily spend, single writer (SpaceDO — one DO per space, so
// every thread's agent DO debits through the SAME instance regardless of how many concurrent
// threads a customer-bot project has). GET is a pure gate check (credits=0 semantics via
// query-less POST); POST records an actual debit. Called only by NaelaoAgentDO.
app.get("/spaces/:spaceId/projects/:projectId/spend", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/spend`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/spend", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/spend`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Presence (space collaboration, A1.8) — heartbeat: "I'm here" (space-level, or scoped to a
// project/thread). Callers poll GET periodically to see who's currently active.
app.post("/spaces/:spaceId/presence", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  const userId = c.req.header("x-naelao-user-id") ?? getCallerIdentity(c).userId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);
  const body = await c.req.json<{ project_id?: string; thread_id?: string }>().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/presence", "POST", JSON.stringify({ space_id: spaceId, user_id: userId, ...body }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/presence", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/presence?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Event triggers (@naelao/events) — no-code "after X happens (thread created, project
// created, ...), run script Y." project_id absent = space-wide.
app.get("/spaces/:spaceId/event-triggers", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/event-triggers?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/event-triggers", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/event-triggers", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/event-triggers/:triggerId", async (c) => {
  const { spaceId, triggerId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/event-triggers/${encodeURIComponent(triggerId)}?space_id=${encodeURIComponent(spaceId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Scheduled jobs (@naelao/events, spec §05 "cron-jobs.json") — the no-code, TIME-driven
// counterpart to event-triggers: "every day at 9am, run this script." Unlike event-triggers
// (per-space rows in SpaceDO, evaluated inline when the triggering action already touches that
// DO), scheduled jobs live directly in PLATFORM_DB — the hourly dispatcher (enqueueAgentTicks,
// agents worker) needs one cheap cross-space query to find everything due, the same reason
// channel_links is a platform table rather than per-space state.
app.get("/spaces/:spaceId/scheduled-jobs", async (c) => {
  const owned = await loadOwnedSpace(c, c.req.param("spaceId"));
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, name, cron_expression, script_name, params, project_id, agent_id, goal, enabled, last_run_at,
            consecutive_failures, last_error, created_at, updated_at
       FROM scheduled_jobs WHERE space_id = ? ORDER BY created_at DESC`
  ).bind(c.req.param("spaceId")).all();
  return c.json({ data: results, count: results.length });
});

app.post("/spaces/:spaceId/scheduled-jobs", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);

  const body = await c.req.json<{
    name: string;
    cron_expression: string;
    script_name?: string;
    params?: Record<string, unknown>;
    project_id?: string;
    /** Which agent's own R2 config (system prompt, approval gates) to wake. Omitted = the
     *  Space Assistant ("naelao-agent"), same as before this field existed. */
    agent_id?: string;
    /** When set, the dispatcher wakes the full reasoning loop with this goal instead of
     *  firing script_name directly (see infra/migrations/0043). */
    goal?: string;
  }>().catch(() => ({}) as Record<string, never>);
  if (!body.name || !body.cron_expression || (!body.script_name && !body.goal)) {
    return c.json({ error_code: "bad_request", message: "name, cron_expression, and either script_name or goal are required" }, 400);
  }
  const cronError = validateCronExpression(body.cron_expression);
  if (cronError) return c.json({ error_code: "bad_request", message: `Invalid cron_expression: ${cronError}` }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO scheduled_jobs (id, space_id, tenant_id, project_id, name, cron_expression, script_name, params, agent_id, goal, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(
    id, spaceId, owned.tenantId, body.project_id ?? null, body.name, body.cron_expression,
    body.script_name ?? "", JSON.stringify(body.params ?? {}), body.agent_id ?? null, body.goal ?? null, now, now
  ).run();

  return c.json({
    id, name: body.name, cron_expression: body.cron_expression, script_name: body.script_name ?? "",
    project_id: body.project_id ?? null, agent_id: body.agent_id ?? null, goal: body.goal ?? null,
    enabled: true, last_run_at: null, created_at: now,
  }, 201);
});

app.patch("/spaces/:spaceId/scheduled-jobs/:jobId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const jobId = c.req.param("jobId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);

  const body = await c.req.json<{
    name?: string;
    cron_expression?: string;
    script_name?: string;
    params?: Record<string, unknown>;
    agent_id?: string;
    goal?: string;
    enabled?: boolean;
  }>().catch(() => ({}) as Record<string, never>);

  if (body.cron_expression !== undefined) {
    const cronError = validateCronExpression(body.cron_expression);
    if (cronError) return c.json({ error_code: "bad_request", message: `Invalid cron_expression: ${cronError}` }, 400);
  }

  const now = new Date().toISOString();
  const res = await c.env.PLATFORM_DB.prepare(
    `UPDATE scheduled_jobs SET
       name = COALESCE(?, name),
       cron_expression = COALESCE(?, cron_expression),
       script_name = COALESCE(?, script_name),
       params = COALESCE(?, params),
       agent_id = COALESCE(?, agent_id),
       goal = COALESCE(?, goal),
       enabled = COALESCE(?, enabled),
       updated_at = ?
     WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(
    body.name ?? null, body.cron_expression ?? null, body.script_name ?? null,
    body.params !== undefined ? JSON.stringify(body.params) : null,
    body.agent_id ?? null, body.goal ?? null,
    body.enabled === undefined ? null : (body.enabled ? 1 : 0),
    now, jobId, spaceId, owned.tenantId
  ).run();

  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Scheduled job not found" }, 404);
  return c.json({ id: jobId, updated_at: now });
});

app.delete("/spaces/:spaceId/scheduled-jobs/:jobId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const jobId = c.req.param("jobId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const res = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM scheduled_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(jobId, spaceId, owned.tenantId).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Scheduled job not found" }, 404);
  return c.json({ deleted: true, id: jobId });
});

// Space Assistant approval policy — "same access as the owning user, ask first unless the
// user has trusted this action." Owner-authenticated only; the assistant can never set its
// own policy. Also fetched directly by NaelaoAgentDO (fetchAssistantPolicy) — internal,
// builder-only, never end-user-facing, so safe to gate broadly.
app.use("/spaces/:spaceId/assistant-policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/assistant-policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/assistant-policy?space_id=${encodeURIComponent(spaceId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.patch("/spaces/:spaceId/assistant-policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/assistant-policy?space_id=${encodeURIComponent(spaceId)}`, "PATCH", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Threads (spec-canonical). A sub-agent spawn or a channel session mirrors in here as a
// subthread (thread_kind + parent_thread_id) — hidden from the default list unless the
// project's show_sub_threads is on, or the caller passes include_sub_threads=true.
// A1.16.10 (layer-3 backstop, bucket A): the dashboard's structural browse view (builder-only —
// confirmed widget/portal never call this; end-user chat transport is /sessions, not /threads).
app.use("/spaces/:spaceId/threads", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/threads/:threadId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/threads", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  const includeSubThreads = c.req.query("include_sub_threads");
  if (includeSubThreads) qs.set("include_sub_threads", includeSubThreads);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/threads?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/threads", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // tenant_id travels in the body — forwardToSpaceDO doesn't forward headers, and SpaceDO
  // needs it to fire event_triggers (thread.created) via the agents worker.
  const res = await forwardToSpaceDO(stub, "/threads", "POST", JSON.stringify({ ...body, space_id: spaceId, tenant_id: tenantId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/threads/:threadId", async (c) => {
  const { spaceId, threadId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/threads/${encodeURIComponent(threadId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /spaces/:spaceId/sub-spaces — list the product's space registry (root + departments).
app.get("/spaces/:spaceId/sub-spaces", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/spaces", "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST /spaces/:spaceId/sub-spaces — create a department (in-DO sub-space).
// Gated by the product's userPermissions.canCreateSubSpaces. End-user (non-builder)
// callers always inherit the parent space_type (force_parent_type) and can never pick a type.
app.post("/spaces/:spaceId/sub-spaces", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId, role } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  // Resolve the product (D1) to gate on productConfig + know the parent space_type.
  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json, tenancy_mode FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ spacetype_id: string; config_json: string | null; tenancy_mode: string }>();
  if (!product) throw notFound("Space");

  const pc = await loadEffectiveProductConfig(c.env, product.spacetype_id, product.config_json);
  if (pc?.userPermissions?.canCreateSubSpaces === false) {
    return c.json({ error_code: "not_allowed", message: "Sub-spaces are disabled for this product" }, 403);
  }

  const body = await c.req.json<{
    parent_id?: string;
    name: string;
    space_type?: string;
    settings?: Record<string, unknown>;
  }>();
  if (!body.name) return c.json({ error_code: "bad_request", message: "name is required" }, 400);

  // Builders (owner/admin) may select a type (subject to agency_shell rules in the DO);
  // end-user roles are forced to the parent's type.
  const isBuilder = role === "owner" || role === "admin";
  const payload = {
    parent_id: body.parent_id ?? spaceId,
    name: body.name,
    scenario_type: "organizational" as const,
    ...(isBuilder && body.space_type ? { space_type: body.space_type } : { force_parent_type: true }),
    ...(body.settings ? { settings: body.settings } : {}),
  };

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/sub-spaces", "POST", JSON.stringify(payload));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// PATCH /spaces/:spaceId/sub-spaces/:subId — update a department (status/name/settings).
app.patch("/spaces/:spaceId/sub-spaces/:subId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const subId = c.req.param("subId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/spaces/${subId}`, "PATCH", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Cross-space access grants (spec §49 checkPermission) ─────────────────────
app.all("/spaces/:spaceId/cross-space-grants/:grantId?", async (c) => {
  const spaceId = c.req.param("spaceId");
  const grantId = c.req.param("grantId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);

  const url = new URL(c.req.url);
  const doPath = grantId
    ? `/cross-space-grants/${grantId}`
    : `/cross-space-grants${url.search}`;
  const res = await forwardToSpaceDO(
    stub,
    doPath,
    c.req.method,
    c.req.method === "POST" ? c.req.raw.body : undefined
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /spaces/:spaceId/cross-space-check?user_id=&requesting_space_id=&target_space_id=&grant_type=
app.get("/spaces/:spaceId/cross-space-check", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const url = new URL(c.req.url);
  const res = await forwardToSpaceDO(stub, `/cross-space-check${url.search}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Commerce: products / orders / revenue (spec §11; manifest-gated) ─────────
// Reachable via the /spaces/* router proxy. Every route gates on the effective
// productConfig.commerce.enabled so a SpaceType that did not opt in returns 403.

/** Load the space (validating tenant ownership) + its effective commerce config. */
async function loadCommerceContext(
  c: { env: Env; req: { header: (h: string) => string | undefined } },
  spaceId: string
): Promise<
  | { ok: true; tenantId: string; commerce: NonNullable<SpaceTypeProductConfig["commerce"]> }
  | { ok: false; status: 401 | 403 | 404; error_code: string; message: string }
> {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return { ok: false, status: 401, error_code: "unauthorized", message: "Missing tenant" };
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ spacetype_id: string; config_json: string | null }>();
  if (!space) return { ok: false, status: 404, error_code: "not_found", message: "Space not found" };
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);
  if (!pc?.commerce?.enabled) {
    return { ok: false, status: 403, error_code: "commerce_disabled", message: "Commerce is not enabled for this SpaceType" };
  }
  return { ok: true, tenantId, commerce: pc.commerce };
}

// GET /spaces/:spaceId/products
app.get("/spaces/:spaceId/products", async (c) => {
  const spaceId = c.req.param("spaceId");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM launchpad_products WHERE space_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 200"
  ).bind(spaceId).all();
  return c.json({ data: results, count: results.length, currency: ctx.commerce.defaultCurrency ?? "USD" });
});

// POST /spaces/:spaceId/products
app.post("/spaces/:spaceId/products", async (c) => {
  const spaceId = c.req.param("spaceId");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const body = await c.req.json<{
    name: string;
    description?: string;
    price_cents?: number;
    currency?: string;
    kind?: "one_time" | "subscription";
    fulfillment_r2_key?: string;
  }>();
  if (!body.name) return c.json({ error_code: "bad_request", message: "name is required" }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO launchpad_products (id, space_id, tenant_id, name, description, price_cents, currency, kind, fulfillment_r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).bind(
    id, spaceId, ctx.tenantId, body.name, body.description ?? "",
    Math.max(0, Math.round(body.price_cents ?? 0)),
    body.currency ?? ctx.commerce.defaultCurrency ?? "USD",
    body.kind ?? "one_time", body.fulfillment_r2_key ?? null, now, now
  ).run();
  return c.json({ id, name: body.name, status: "draft", created_at: now }, 201);
});

// PATCH /spaces/:spaceId/products/:id  (edit / publish / archive)
app.patch("/spaces/:spaceId/products/:id", async (c) => {
  const spaceId = c.req.param("spaceId");
  const productId = c.req.param("id");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const body = await c.req.json<{
    name?: string; description?: string; price_cents?: number;
    status?: "draft" | "published" | "archived"; fulfillment_r2_key?: string; ls_variant_id?: string;
  }>();
  const now = new Date().toISOString();
  const res = await c.env.PLATFORM_DB.prepare(
    `UPDATE launchpad_products SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       price_cents = COALESCE(?, price_cents),
       status = COALESCE(?, status),
       fulfillment_r2_key = COALESCE(?, fulfillment_r2_key),
       ls_variant_id = COALESCE(?, ls_variant_id),
       updated_at = ?
     WHERE id = ? AND space_id = ?`
  ).bind(
    body.name ?? null, body.description ?? null,
    body.price_cents !== undefined ? Math.max(0, Math.round(body.price_cents)) : null,
    body.status ?? null, body.fulfillment_r2_key ?? null, body.ls_variant_id ?? null,
    now, productId, spaceId
  ).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  // Auto-create LS product + variant when publishing for the first time (no ls_variant_id yet).
  // Gated: only when status is being set to "published" and BILLING_WORKER is bound.
  if (body.status === "published" && !body.ls_variant_id && c.env.BILLING_WORKER) {
    const product = await c.env.PLATFORM_DB.prepare(
      "SELECT name, description, price_cents, currency, kind, ls_variant_id FROM launchpad_products WHERE id = ? AND space_id = ?"
    ).bind(productId, spaceId).first<{
      name: string; description: string; price_cents: number; currency: string;
      kind: "one_time" | "subscription"; ls_variant_id: string | null;
    }>();

    if (product && !product.ls_variant_id) {
      try {
        // F20 / A1.16.8: billing's /internal/products/ls-variant now requires a verified
        // requireInternalHmac token instead of a forgeable static x-naelao-internal header.
        const lsResp = await c.env.BILLING_WORKER.fetch(
          new Request("http://billing-worker/internal/products/ls-variant", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-naelao-tenant-id": ctx.tenantId,
              "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, ctx.tenantId),
            },
            body: JSON.stringify({
              name: product.name,
              description: product.description || undefined,
              price_cents: product.price_cents,
              currency: product.currency,
              kind: product.kind,
            }),
          })
        );
        if (lsResp.ok) {
          const ls = await lsResp.json<{ ls_product_id: string; ls_variant_id: string }>();
          await c.env.PLATFORM_DB.prepare(
            "UPDATE launchpad_products SET ls_variant_id = ?, ls_product_id = ?, updated_at = ? WHERE id = ?"
          ).bind(ls.ls_variant_id, ls.ls_product_id, new Date().toISOString(), productId).run();
          return c.json({ id: productId, updated_at: now, ls_variant_id: ls.ls_variant_id, ls_product_id: ls.ls_product_id });
        } else {
          const err = await lsResp.json<{ error_code: string; message: string }>().catch(() => ({ error_code: "unknown", message: "LS variant creation failed" }));
          console.error(`[spaces/publish] LS variant auto-create failed for product=${productId}: ${err.message}`);
          // Non-fatal: product is published but variant creation failed — builder can retry or supply manually.
        }
      } catch (err) {
        console.error(`[spaces/publish] LS variant auto-create error product=${productId}:`, (err as Error).message);
      }
    }
  }

  return c.json({ id: productId, updated_at: now });
});

// DELETE /spaces/:spaceId/products/:id  (soft archive)
app.delete("/spaces/:spaceId/products/:id", async (c) => {
  const spaceId = c.req.param("spaceId");
  const productId = c.req.param("id");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const res = await c.env.PLATFORM_DB.prepare(
    "UPDATE launchpad_products SET status = 'archived', updated_at = ? WHERE id = ? AND space_id = ?"
  ).bind(new Date().toISOString(), productId, spaceId).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
  return c.json({ archived: true, id: productId });
});

// GET /spaces/:spaceId/orders
app.get("/spaces/:spaceId/orders", async (c) => {
  const spaceId = c.req.param("spaceId");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT o.*, p.name AS product_name FROM launchpad_orders o
       LEFT JOIN launchpad_products p ON p.id = o.product_id
      WHERE o.space_id = ? ORDER BY o.created_at DESC LIMIT 200`
  ).bind(spaceId).all();
  return c.json({ data: results, count: results.length });
});

// GET /spaces/:spaceId/revenue — current-month rollup for the dashboard.
app.get("/spaces/:spaceId/revenue", async (c) => {
  const spaceId = c.req.param("spaceId");
  const ctx = await loadCommerceContext(c, spaceId);
  if (!ctx.ok) return c.json({ error_code: ctx.error_code, message: ctx.message }, ctx.status);
  const period = new Date().toISOString().slice(0, 7);
  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fees,
            COALESCE(SUM(net_cents),0) AS net, COUNT(*) AS orders
       FROM launchpad_orders
      WHERE space_id = ? AND status IN ('paid','fulfilling','fulfilled') AND substr(created_at,1,7) = ?`
  ).bind(spaceId, period).first<{ gross: number; fees: number; net: number; orders: number }>();
  return c.json({
    period,
    currency: ctx.commerce.defaultCurrency ?? "USD",
    gross_cents: row?.gross ?? 0,
    fee_cents: row?.fees ?? 0,
    net_cents: row?.net ?? 0,
    order_count: row?.orders ?? 0,
  });
});

// ── Internal: business services (storefront / business email / custom domain) ─
// Called by the storefront + business-email prebuilt scripts (x-naelao-internal). Allocates
// the Naelao-hosted handle ({slug}.naelao.com / hi@{slug}.naelao-mail.com), upserts a
// business_services row, and (for custom_domain) records the Cloudflare-for-SaaS hostname.
// Storefronts are one multitenant surface (CF Pages + portal Worker fallback origin); this
// only registers the Host→space route, it does not deploy anything per tenant.

const STOREFRONT_ROOT = "naelao.com";
const EMAIL_ROOT = "naelao-mail.com";

// A1.16.9 (layer-3 backstop): the old check accepted ANY truthy x-naelao-internal value —
// weaker than even a static string. Covers both the POST and GET handlers below (Hono's
// app.use is method-agnostic for a given path).
app.use("/internal/business-services", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/business-services", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{
    space_id: string;
    kind: "storefront" | "business_email" | "custom_domain";
    slug?: string;
    custom_domain?: string;
  }>();
  if (!body.space_id || !body.kind) {
    return c.json({ error_code: "bad_request", message: "space_id and kind are required" }, 400);
  }

  // Custom domain: opt-in. Records the hostname as pending DNS validation. The actual
  // Cloudflare-for-SaaS custom_hostnames API call happens in the SaaS provisioner with the
  // zone-scoped token; here we persist intent + the DNS target the owner must CNAME to.
  if (body.kind === "custom_domain") {
    if (!body.custom_domain) return c.json({ error_code: "bad_request", message: "custom_domain is required" }, 400);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Apply step: when the deploy-time CF token + SaaS zone are configured, add the domain as
    // a Cloudflare-for-SaaS custom hostname (TXT DCV) so CF issues a cert. Otherwise record
    // the intent + CNAME instructions (dev path) — the apply runs later when secrets land.
    const cf = cfSaasConfig(c.env);
    let cfHostnameId: string | null = null;
    let validationRecords: unknown[] = [];
    if (cf) {
      try {
        const result = await createCustomHostname(cf, body.custom_domain);
        cfHostnameId = result.id;
        validationRecords = result.validation_records;
      } catch (err) {
        console.error(`[cf-saas] custom hostname create failed for ${body.custom_domain}:`, (err as Error).message);
        return c.json({ error_code: "cf_saas_failed", message: (err as Error).message }, 502);
      }
    }

    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO business_services (id, space_id, tenant_id, kind, custom_domain, cf_hostname_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'custom_domain', ?, ?, 'pending_dns', ?, ?)
       ON CONFLICT(space_id, kind) DO UPDATE SET custom_domain = excluded.custom_domain, cf_hostname_id = excluded.cf_hostname_id, status = 'pending_dns', updated_at = excluded.updated_at`
    ).bind(id, body.space_id, tenantId, body.custom_domain, cfHostnameId, now, now).run();

    return c.json({
      kind: "custom_domain",
      custom_domain: body.custom_domain,
      status: "pending_dns",
      cf_hostname_id: cfHostnameId,
      // Route record (CNAME to the fallback origin) + any DCV validation records from CF.
      dns: { type: "CNAME", name: body.custom_domain, value: `fallback.${STOREFRONT_ROOT}` },
      validation_records: validationRecords,
    }, 201);
  }

  // Storefront / business email: allocate a Naelao handle from the slug (dedupe with a short
  // suffix from the space id so two spaces can both want "shop").
  const slug = (body.slug ?? "shop").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "shop";
  const suffix = body.space_id.slice(0, 6);
  const handle = body.kind === "storefront"
    ? `${slug}-${suffix}.${STOREFRONT_ROOT}`
    : `hi@${slug}-${suffix}.${EMAIL_ROOT}`;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO business_services (id, space_id, tenant_id, kind, naelao_handle, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(space_id, kind) DO UPDATE SET naelao_handle = excluded.naelao_handle, status = 'active', updated_at = excluded.updated_at`
  ).bind(id, body.space_id, tenantId, body.kind, handle, now, now).run();

  // For a storefront, register the Host→space route the portal Worker resolves.
  if (body.kind === "storefront") {
    await c.env.NAELAO_CONFIG_KV.put(`portal-host:${handle}`, body.space_id);
  }

  return c.json({ kind: body.kind, naelao_handle: handle, status: "active" }, 201);
});

// GET /internal/member-billing?space_id= — resolve a space's seat pricing (for the billing
// worker's seat checkout). Returns 404 when member billing is not enabled.
app.use("/internal/member-billing", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/member-billing", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ spacetype_id: string; config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);
  const mb = pc?.memberBilling;
  if (!mb?.enabled) return c.json({ error_code: "not_configured", message: "Member billing not enabled" }, 409);
  return c.json({
    seatPriceCents: mb.seatPriceCents,
    currency: mb.currency ?? "USD",
    ...(mb.lsVariantId ? { lsVariantId: mb.lsVariantId } : {}),
    interval: mb.interval ?? "subscription",
  });
});

app.get("/internal/business-services", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  const kind = c.req.query("kind") ?? "";
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM business_services WHERE space_id = ? AND kind = ?"
  ).bind(spaceId, kind).first();
  return c.json(row ?? null);
});

// GET /internal/business-services/custom-domain-status?space_id= — poll CF for cert/DCV
// status and flip the record to 'active' once Cloudflare reports the hostname active.
app.use("/internal/business-services/custom-domain-status", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/business-services/custom-domain-status", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT cf_hostname_id, custom_domain, status FROM business_services WHERE space_id = ? AND kind = 'custom_domain'"
  ).bind(spaceId).first<{ cf_hostname_id: string | null; custom_domain: string | null; status: string }>();
  if (!row) return c.json({ error_code: "not_found", message: "No custom domain for this space" }, 404);

  const cf = cfSaasConfig(c.env);
  if (!cf || !row.cf_hostname_id) {
    // Dev path: nothing to poll — report what we have.
    return c.json({ custom_domain: row.custom_domain, status: row.status, ssl_status: "unknown", validation_records: [] });
  }

  try {
    const result = await getCustomHostname(cf, row.cf_hostname_id);
    const active = result.status === "active" && result.ssl_status === "active";
    if (active && row.status !== "active") {
      await c.env.PLATFORM_DB.prepare(
        "UPDATE business_services SET status = 'active', updated_at = ? WHERE space_id = ? AND kind = 'custom_domain'"
      ).bind(new Date().toISOString(), spaceId).run();
    }
    return c.json({
      custom_domain: result.hostname,
      status: active ? "active" : "pending_dns",
      ssl_status: result.ssl_status,
      validation_records: result.validation_records,
    });
  } catch (err) {
    return c.json({ error_code: "cf_saas_failed", message: (err as Error).message }, 502);
  }
});

// ── Member/seat billing — builder-facing configuration (the third payer class) ─
// The checkout + activation paths already exist (billing worker /internal/seats/checkout →
// LS webhook recordSeatActivation). What was missing: a way for a builder to ENABLE and price
// seats without hand-editing a manifest, and to provision the seat's Lemon Squeezy variant the
// same way product publish does. Config is stored as a per-space productConfig override in
// config_json (loadEffectiveProductConfig merges it over the manifest), so it never forks the
// SpaceType. Money-in stays reserved: seats always check out through Naelao's LS store.

type MemberBillingConfig = NonNullable<SpaceTypeProductConfig["memberBilling"]>;

/** Load a space owned by the calling tenant (ownership gate, no commerce requirement). */
async function loadOwnedSpace(
  c: { env: Env; req: { header: (h: string) => string | undefined } },
  spaceId: string
): Promise<
  | { ok: true; tenantId: string; name: string; spacetypeId: string; configJson: string | null }
  | { ok: false; status: 401 | 404; error_code: string; message: string }
> {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return { ok: false, status: 401, error_code: "unauthorized", message: "Missing tenant" };
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT name, spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ name: string; spacetype_id: string; config_json: string | null }>();
  if (!space) return { ok: false, status: 404, error_code: "not_found", message: "Space not found" };
  return { ok: true, tenantId, name: space.name, spacetypeId: space.spacetype_id, configJson: space.config_json };
}

// GET /spaces/:spaceId/member-billing — the space's effective member-billing config.
app.get("/spaces/:spaceId/member-billing", async (c) => {
  const owned = await loadOwnedSpace(c, c.req.param("spaceId"));
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const pc = await loadEffectiveProductConfig(c.env, owned.spacetypeId, owned.configJson);
  const mb = pc?.memberBilling ?? { enabled: false, seatPriceCents: 0 };
  return c.json({ member_billing: mb });
});

// PATCH /spaces/:spaceId/member-billing — enable/price seats. On enable, provisions the seat's
// Lemon Squeezy variant (once) exactly like product publish, then persists the override.
app.patch("/spaces/:spaceId/member-billing", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);

  const body = await c.req.json<{
    enabled: boolean;
    seatPriceCents?: number;
    currency?: string;
    interval?: "subscription" | "one_time";
  }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error_code: "bad_request", message: "enabled (boolean) is required" }, 400);
  }

  // Merge over the current effective config so unspecified fields keep their value.
  const pc = await loadEffectiveProductConfig(c.env, owned.spacetypeId, owned.configJson);
  const current: Partial<MemberBillingConfig> = pc?.memberBilling ?? {};
  const seatPriceCents = body.seatPriceCents ?? current.seatPriceCents ?? 0;
  const currency = (body.currency ?? current.currency ?? "USD").toUpperCase();
  const interval = body.interval ?? current.interval ?? "subscription";

  if (body.enabled) {
    if (!Number.isInteger(seatPriceCents) || seatPriceCents <= 0) {
      return c.json({ error_code: "bad_request", message: "seatPriceCents must be a positive integer to enable seats" }, 400);
    }
  }

  // Provision the seat LS variant once (only when enabling, priced, not yet provisioned).
  let lsVariantId = current.lsVariantId;
  if (body.enabled && !lsVariantId && c.env.BILLING_WORKER) {
    try {
      // F20 / A1.16.8: same requireInternalHmac gate as the product-publish caller above.
      const lsResp = await c.env.BILLING_WORKER.fetch(
        new Request("http://billing-worker/internal/products/ls-variant", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-naelao-tenant-id": owned.tenantId,
            "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId),
          },
          body: JSON.stringify({
            name: `${owned.name} — Membership seat`,
            price_cents: seatPriceCents,
            currency,
            kind: interval === "one_time" ? "one_time" : "subscription",
          }),
        })
      );
      if (lsResp.ok) {
        lsVariantId = (await lsResp.json<{ ls_variant_id: string }>()).ls_variant_id;
      } else {
        console.error(`[spaces/member-billing] seat variant create failed space=${spaceId}: ${await lsResp.text()}`);
        // Non-fatal: seats are enabled but the dev/placeholder path in seat checkout applies
        // until a variant exists. Builder can PATCH again to retry provisioning.
      }
    } catch (err) {
      console.error(`[spaces/member-billing] seat variant create error space=${spaceId}:`, (err as Error).message);
    }
  }

  const memberBilling: MemberBillingConfig = {
    enabled: body.enabled,
    seatPriceCents,
    currency,
    interval,
    ...(lsVariantId ? { lsVariantId } : {}),
  };

  // Persist as a config_json.productConfig override, preserving all other config + override keys.
  let config: { productConfig?: Partial<SpaceTypeProductConfig> } & Record<string, unknown> = {};
  if (owned.configJson) {
    try { config = JSON.parse(owned.configJson); } catch { /* start clean on malformed */ }
  }
  config.productConfig = { ...(config.productConfig ?? {}), memberBilling };
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(JSON.stringify(config), new Date().toISOString(), spaceId, owned.tenantId).run();

  return c.json({ member_billing: memberBilling });
});

// ── Internal: SpaceType manifest registry (spec §62) ────────────────────────
// These routes are called by the provisioner via SPACES_WORKER service binding.
// They are NOT exposed to end-users — caller identity is validated by the internal header.

function getRegistryDO(env: Env): ReturnType<typeof env.SPACE_TYPE_REGISTRY_DO.get> {
  return env.SPACE_TYPE_REGISTRY_DO.get(
    env.SPACE_TYPE_REGISTRY_DO.idFromName("global-space-type-registry")
  );
}

// GET /internal/space-types/:id — load manifest (KV-cached 1h for fast provisioning)
// Gated inline for consistency with the record-install route below, whose comment has the full
// root-cause writeup for a real, pre-existing routing bug this Phase 6 pass found and fixed.
app.get("/internal/space-types/:id", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }
  const typeId = c.req.param("id");
  const cacheKey = `space-type-manifest:${typeId}`;

  const cached = await c.env.NAELAO_CONFIG_KV.get(cacheKey, "json");
  if (cached) return c.json(cached);

  const registry = getRegistryDO(c.env);
  const resp = await registry.fetch(new Request(`http://registry/type/${typeId}`));
  if (!resp.ok) return c.json({ error: "not_found" }, 404);

  const manifest = await resp.json<unknown>();
  await c.env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
  return c.json(manifest);
});

// POST /internal/space-types-record-install/:id — called at end of provisioning (step 10).
// Path deliberately shaped with the static segment BEFORE the dynamic :id (not
// /internal/space-types/:id/record-install) — root-caused via a reduced reproduction: Hono's
// RegExpRouter throws "buildMatcherFromPreprocessedRoutes" (silently caught by SmartRouter,
// which then falls back to a TrieRouter that ALSO mismatches) when a multi-segment dynamic route
// ending in a static suffix (.../:id/record-install) coexists, at this app's route-table scale,
// with an unrelated static sibling for the same method one segment shallower
// (/internal/space-types/seed, POST) — this is a genuine Hono limitation, not an application
// bug, and it silently broke ALL POST routing app-wide (including POST /spaces/:id/sessions,
// i.e. session creation — a pre-existing bug, confirmed present before this Phase 6 pass touched
// anything). Renaming this one low-traffic internal route (provisioner-only caller, updated
// alongside this) around the conflict was the actual fix; gate inline rather than via a separate
// app.use(...) as belt-and-suspenders since that combination was verified to work together.
app.post("/internal/space-types-record-install/:id", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }
  const typeId = c.req.param("id");
  const body = await c.req.json<{ spaceId: string; version: string }>();
  const registry = getRegistryDO(c.env);
  await registry.fetch(new Request("http://registry/record-install", {
    method: "POST",
    body: JSON.stringify({ typeId, spaceId: body.spaceId, version: body.version }),
  }));
  return c.json({ ok: true });
});

// POST /internal/space-types/seed — Naelao platform use only: seed built-in manifests
// Called once at deploy/bootstrap time to seed the Launchpad manifest.
app.post("/internal/space-types/seed", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const registry = getRegistryDO(c.env);
  const results = [];
  for (const manifest of [LAUNCHPAD_MANIFEST]) {
    const resp = await registry.fetch(new Request("http://registry/register", {
      method: "POST",
      body: JSON.stringify({ manifest, authorId: "naelao" }),
    }));
    results.push({ id: manifest.id, ...(await resp.json<object>()) });
    // Bust KV cache so next provisioner call sees the new manifest
    await c.env.NAELAO_CONFIG_KV.delete(`space-type-manifest:${manifest.id}`);
  }
  return c.json({ seeded: results });
});

// POST /internal/product-sessions/verify — the missing link for Three-Tier Platform Model end
// users (Phase 6): naelao-router calls this to resolve a Bearer nps_... ProductUserDO session
// token into the owning tenant BEFORE it can mint the router's own claims for that request.
// Gated by a direct platform-secret check (same pattern as /internal/space-types/seed just
// above), not requireInternalHmac — that gate needs to already know the caller's tenantId, but
// resolving the tenantId is exactly what this endpoint is FOR (a real chicken-and-egg the seed
// route's precedent already solved the same way).
app.post("/internal/product-sessions/verify", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const body = await c.req.json<{ productId: string; endUserId: string; sessionToken: string }>();
  if (!body.productId || !body.endUserId || !body.sessionToken) {
    return c.json({ valid: false }, 400);
  }

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(body.productId).first<{ tenant_id: string }>();
  if (!space) return c.json({ valid: false });

  const stub = await productUserDoStub(c.env, body.productId, body.endUserId, space.tenant_id);
  const verifyRes = await stub.fetch(new Request("http://do/sessions/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_token: body.sessionToken }),
  }));
  const verified = await verifyRes.json<{ valid: boolean }>();
  if (!verified.valid) return c.json({ valid: false });

  return c.json({ valid: true, tenant_id: space.tenant_id, end_user_id: body.endUserId });
});

// ── Reseller / tenant membership (spec G-AS34/G-AS35; productConfig.membershipModel) ──
// When a builder's product has membershipModel "tenant"|"hybrid", a customer who signs up
// through that product creates their OWN business (a space under their own child tenant,
// parented to the reseller). See docs/spec-appendix A1.8.

/**
 * Load a SpaceType's full manifest, KV-cached 1h (same cache key/TTL as
 * /internal/space-types/:id — shared, not a second cache). Returns null if the type doesn't
 * exist. Callers that only need productConfig should keep using loadEffectiveProductConfig
 * below; this is for callers (like the shell manifest projection) that need ui.* too.
 */
async function loadManifest(env: Env, spaceTypeId: string): Promise<NaelaoSpaceTypeManifestV2 | null> {
  const cacheKey = `space-type-manifest:${spaceTypeId}`;
  const cached = await env.NAELAO_CONFIG_KV.get(cacheKey, "json") as NaelaoSpaceTypeManifestV2 | null;
  if (cached) return cached;
  const registry = getRegistryDO(env);
  const resp = await registry.fetch(new Request(`http://registry/type/${spaceTypeId}`));
  if (!resp.ok) return null;
  const manifest = await resp.json<NaelaoSpaceTypeManifestV2>();
  await env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(manifest), { expirationTtl: 3600 });
  return manifest;
}

/**
 * Resolve the effective productConfig for a product space: the SpaceType manifest's
 * productConfig, overlaid with any per-space override in spaces.config_json.productConfig.
 */
async function loadEffectiveProductConfig(
  env: Env,
  spaceTypeId: string,
  spaceConfigJson: string | null
): Promise<SpaceTypeProductConfig | null> {
  const manifest = await loadManifest(env, spaceTypeId);
  const base = manifest?.productConfig ?? null;
  // Per-space override (builders tune membership per product without forking the manifest).
  let override: Partial<SpaceTypeProductConfig> | undefined;
  if (spaceConfigJson) {
    try {
      const cfg = JSON.parse(spaceConfigJson) as { productConfig?: Partial<SpaceTypeProductConfig> };
      override = cfg.productConfig;
    } catch { /* ignore malformed */ }
  }
  if (!base && !override) return null;
  return { ...(base ?? {}), ...(override ?? {}) } as SpaceTypeProductConfig;
}

// ── Three-Tier Platform Model, Phase 6: Product Shell data layer ────────────────────────────
// GET /spaces/:spaceId/shell/manifest — a SAFE PROJECTION of the SpaceType manifest for a
// browser client (the manifest-driven Product Shell in apps/portal). Deliberately excludes
// agentEnvironment/backend/lifecycle/marketplace and every builder-only productConfig field
// (commerce, businessServices, memberBilling, pricingConfig, billingRelationship,
// userPermissions, adminFeatures, featureFlags, authProvider.ssoConfig) — those are either
// platform-internal runtime config or govern a different actor (the builder), never needed by
// the shell chrome itself. Works for BOTH an authenticated caller (builder JWT or product
// end-user session) AND a pre-login visitor (the login page needs branding before any token
// exists) — when there's no resolvable tenant, falls back to a tenant-less lookup by space id
// alone, which is safe because the response is already a fully public-safe projection.
app.get("/spaces/:spaceId/shell/manifest", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);

  const space = tenantId
    ? await c.env.PLATFORM_DB.prepare(
        "SELECT id, name, spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
      ).bind(spaceId, tenantId).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>()
    : await c.env.PLATFORM_DB.prepare(
        "SELECT id, name, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
      ).bind(spaceId).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const manifest = await loadManifest(c.env, space.spacetype_id);
  if (!manifest) return c.json({ error_code: "not_found", message: "SpaceType manifest not found" }, 404);
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);

  return c.json({
    space_id: space.id,
    space_type_id: space.spacetype_id,
    space_name: space.name,
    manifest_name: manifest.name,
    manifest_version: manifest.version,
    icon: manifest.icon,
    ui: {
      sidebar_items: manifest.ui.operatorShell.sidebarItems,
      hidden_core_items: manifest.ui.operatorShell.hiddenCoreItems,
      default_view: manifest.ui.operatorShell.defaultView,
    },
    branding: {
      brand_color: pc?.branding?.brandColor ?? null,
      logo_url: pc?.branding?.logoUrl ?? null,
      favicon_url: pc?.branding?.faviconUrl ?? null,
      product_description: pc?.branding?.productDescription ?? null,
      suppress_naelao_branding: pc?.branding?.suppressNaelaoBranding ?? false,
    },
    assistant_mode: pc?.assistantMode ?? "per-user",
    sub_space_display: pc?.subSpaceDisplay ?? null,
    allow_public_signup: pc?.allowPublicSignup ?? false,
    auth_provider: pc?.authProvider?.provider ?? "naelao-native",
  });
});

// GET/PATCH /spaces/:spaceId/product-users/me — a signed-in product end user's own profile +
// credit balance (topbar meter, Settings' General/Billing tabs). Resolves identity from the
// caller's OWN claims only (role must be product_end_user; userId is that end user's own
// end_user_id, set by the router's resolveProductEndUserClaims) — there is deliberately no way
// to pass a different end_user_id and read someone else's profile through this route.
app.get("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT email, display_name, first_seen_at, last_seen_at, suspended_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(spaceId, userId).first<{ email: string | null; display_name: string | null; first_seen_at: string; last_seen_at: string | null; suspended_at: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "End user not found" }, 404);

  const stub = await productUserDoStub(c.env, spaceId, userId, tenantId);
  const balanceRes = await stub.fetch(new Request("http://do/credits/balance"));
  const balance = await balanceRes.json<{ balance_credits: number }>();

  return c.json({
    end_user_id: userId,
    email: row.email,
    display_name: row.display_name,
    joined_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    suspended: row.suspended_at !== null,
    credits_balance: balance.balance_credits,
  });
});

app.patch("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const body = await c.req.json<{ display_name?: string }>().catch(() => ({}) as { display_name?: string });
  if (body.display_name === undefined) {
    return c.json({ error_code: "bad_request", message: "Nothing to update" }, 400);
  }
  const res = await c.env.PLATFORM_DB.prepare(
    "UPDATE product_end_users SET display_name = ? WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(body.display_name, spaceId, userId).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  return c.json({ ok: true, display_name: body.display_name });
});

// GET /spaces/:spaceId/sessions (list) is handled by the generic SpaceDO session proxy above
// (app.all("/spaces/:spaceId/sessions*", ...)) — see that handler's own comment for why the
// end_user_id filter is derived from verified caller claims there, never a client-supplied
// query param.

// POST /reseller/spaces — a customer creates their own business under a reseller's product.
app.post("/reseller/spaces", async (c) => {
  const { userId } = getCallerIdentity(c);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);

  const body = await c.req.json<{
    reseller_product_space_id: string;
    name: string;
    spacetype_id: string;
    template_id?: string;
    config_overrides?: Record<string, unknown>;
  }>();
  if (!body.reseller_product_space_id || !body.name || !body.spacetype_id) {
    return c.json(
      { error_code: "bad_request", message: "reseller_product_space_id, name, spacetype_id are required" },
      400
    );
  }

  // 1. Resolve the reseller (parent tenant) from the product space.
  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status = 'active'"
  ).bind(body.reseller_product_space_id).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
  if (!product) return c.json({ error_code: "not_found", message: "Reseller product not found" }, 404);
  const parentTenantId = product.tenant_id;

  // 2. Load effective productConfig and gate the request.
  const pc = await loadEffectiveProductConfig(c.env, product.spacetype_id, product.config_json);
  if (!pc || (pc.membershipModel !== "tenant" && pc.membershipModel !== "hybrid")) {
    return c.json({ error_code: "not_allowed", message: "This product does not allow customers to create their own businesses" }, 403);
  }
  if (!pc.allowPublicSignup) {
    return c.json({ error_code: "signup_closed", message: "Public signup is disabled for this product" }, 403);
  }
  const allowed = pc.allowedChildSpaceTypes ?? [];
  if (!allowed.includes(body.spacetype_id)) {
    return c.json({ error_code: "spacetype_not_allowed", message: `SpaceType '${body.spacetype_id}' is not offered by this product` }, 403);
  }

  // 3. Find or mint the customer's child tenant (one per customer per reseller).
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT child_tenant_id FROM tenant_hierarchy WHERE parent_tenant_id = ? AND child_owner_user_id = ? LIMIT 1"
  ).bind(parentTenantId, userId).first<{ child_tenant_id: string }>();
  const childTenantId = existing?.child_tenant_id ?? `ten_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();

  // Ensure a reseller_accounts row exists for the parent (lazily, from productConfig).
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO reseller_accounts (tenant_id, product_space_id, billing_relationship, wholesale_cents, referral_share_pct, updated_at)
     VALUES (?, ?, ?, NULL, 0.0, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET product_space_id = excluded.product_space_id, updated_at = excluded.updated_at`
  ).bind(parentTenantId, body.reseller_product_space_id, pc.billingRelationship ?? "platform", now).run();

  // 4. Create the child business (space) under the child tenant.
  const spaceId = crypto.randomUUID();
  const initialStatus = c.env.PROVISION_QUEUE ? "provisioning" : "active";
  const configJson = JSON.stringify({
    ...(body.config_overrides ?? {}),
    ...(body.template_id ? { template_id: body.template_id } : {}),
  });
  // The child business is its OWN top-level space under its OWN tenant (saas per-end-user
  // isolation, G-Y16): own SpaceDO, own SQLite. parent_space_id links it to the reseller's
  // product for portfolio/promotion queries; scenario_type marks it a user-created business.
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO spaces (id, tenant_id, spacetype_id, name, status, config_json, parent_space_id, depth, tenancy_mode, scenario_type, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'saas', 'user-workspace', ?, ?, ?)`
  ).bind(spaceId, childTenantId, body.spacetype_id, body.name, initialStatus, configJson, body.reseller_product_space_id, now, now, userId).run();

  // 5. Record the hierarchy on first business for this child tenant.
  if (!existing) {
    await c.env.PLATFORM_DB.prepare(
      `INSERT INTO tenant_hierarchy (child_tenant_id, parent_tenant_id, reseller_product_space_id, child_space_id, child_owner_user_id)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(childTenantId, parentTenantId, body.reseller_product_space_id, spaceId, userId).run();
  }

  // 6. Provision under the CHILD tenant (reuses the 10-step provisioner unchanged).
  if (c.env.PROVISION_QUEUE) {
    await c.env.PROVISION_QUEUE.send({
      type: "space_provision",
      spaceId,
      tenantId: childTenantId,
      spaceTypeId: body.spacetype_id,
      spaceName: body.name,
      ...(body.template_id ? { templateId: body.template_id } : {}),
      userId,
      requestedAt: now,
    });
  }

  return c.json({ tenant_id: childTenantId, space_id: spaceId, status: initialStatus, parent_tenant_id: parentTenantId }, 201);
});

// GET /reseller/clients — the calling reseller's client portfolio (G-AS34 dashboard data).
app.get("/reseller/clients", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results: clients } = await c.env.PLATFORM_DB.prepare(
    `SELECT h.child_tenant_id, h.child_owner_user_id, h.status, h.created_at,
            COUNT(s.id) AS space_count
       FROM tenant_hierarchy h
       LEFT JOIN spaces s ON s.tenant_id = h.child_tenant_id AND s.status != 'deleted'
      WHERE h.parent_tenant_id = ?
      GROUP BY h.child_tenant_id
      ORDER BY h.created_at DESC
      LIMIT 200`
  ).bind(tenantId).all();

  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const rollup = await c.env.PLATFORM_DB.prepare(
    `SELECT COALESCE(SUM(retail_cents),0) AS retail, COALESCE(SUM(wholesale_cents),0) AS wholesale,
            COALESCE(SUM(margin_cents),0) AS margin, COUNT(*) AS events
       FROM reseller_ledger WHERE parent_tenant_id = ? AND period = ?`
  ).bind(tenantId, period).first<{ retail: number; wholesale: number; margin: number; events: number }>();

  return c.json({
    clients,
    client_count: clients.length,
    current_period: period,
    billing: rollup ?? { retail: 0, wholesale: 0, margin: 0, events: 0 },
  });
});

// GET /reseller/statement?period=YYYY-MM — the reseller's consolidated wholesale statement for a
// period (G-AS34/G-AS35 wholesale invoicing). recordResellerAttribution writes one reseller_ledger
// row per billable child event; this sums them into the invoice the reseller settles with Naelao
// (wholesale) and can bill their own clients from (retail/margin), with a per-client breakdown.
// Defaults to the current month. Grouped by currency so mixed-currency portfolios stay correct.
app.get("/reseller/statement", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const period = c.req.query("period") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return c.json({ error_code: "bad_request", message: "period must be YYYY-MM" }, 400);
  }

  const { results: totals } = await c.env.PLATFORM_DB.prepare(
    `SELECT currency,
            COALESCE(SUM(retail_cents),0)    AS retail_cents,
            COALESCE(SUM(wholesale_cents),0) AS wholesale_cents,
            COALESCE(SUM(margin_cents),0)    AS margin_cents,
            COUNT(*)                         AS events
       FROM reseller_ledger
      WHERE parent_tenant_id = ? AND period = ?
      GROUP BY currency
      ORDER BY wholesale_cents DESC`
  ).bind(tenantId, period).all();

  const { results: byClient } = await c.env.PLATFORM_DB.prepare(
    `SELECT child_tenant_id, currency,
            COALESCE(SUM(retail_cents),0)    AS retail_cents,
            COALESCE(SUM(wholesale_cents),0) AS wholesale_cents,
            COALESCE(SUM(margin_cents),0)    AS margin_cents,
            COUNT(*)                         AS events
       FROM reseller_ledger
      WHERE parent_tenant_id = ? AND period = ?
      GROUP BY child_tenant_id, currency
      ORDER BY wholesale_cents DESC
      LIMIT 500`
  ).bind(tenantId, period).all();

  return c.json({
    parent_tenant_id: tenantId,
    period,
    totals,
    by_client: byClient,
    client_count: new Set(byClient.map((r) => (r as { child_tenant_id: string }).child_tenant_id)).size,
  });
});

/** Assert the caller's tenant is the parent reseller of childTenantId; returns the row or null. */
async function assertResellerParent(
  env: Env,
  parentTenantId: string,
  childTenantId: string
): Promise<{ child_tenant_id: string; parent_tenant_id: string; child_space_id: string; status: string } | null> {
  return env.PLATFORM_DB.prepare(
    "SELECT child_tenant_id, parent_tenant_id, child_space_id, status FROM tenant_hierarchy WHERE child_tenant_id = ? AND parent_tenant_id = ?"
  ).bind(childTenantId, parentTenantId).first();
}

// GET /reseller/clients/:childTenantId — one client's businesses + lineage (drill-down).
app.get("/reseller/clients/:childTenantId", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const childTenantId = c.req.param("childTenantId");

  const hierarchy = await assertResellerParent(c.env, tenantId, childTenantId);
  if (!hierarchy) return c.json({ error_code: "not_found", message: "Client not found in your portfolio" }, 404);

  const { results: spaces } = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, spacetype_id, status, tenancy_mode, created_at FROM spaces WHERE tenant_id = ? AND status != 'deleted' ORDER BY created_at DESC"
  ).bind(childTenantId).all();

  return c.json({
    child_tenant_id: childTenantId,
    parent_tenant_id: hierarchy.parent_tenant_id,
    status: hierarchy.status,
    spaces,
    space_count: spaces.length,
  });
});

// POST /reseller/clients/:childTenantId/status — suspend / reactivate a client.
// The reseller (parent) controls their customers' access: suspending cascades to the
// child's spaces so no agent runs while suspended. Child data is untouched (reversible).
app.post("/reseller/clients/:childTenantId/status", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const childTenantId = c.req.param("childTenantId");
  const body = await c.req.json<{ status: "active" | "suspended" }>();
  if (body.status !== "active" && body.status !== "suspended") {
    return c.json({ error_code: "bad_request", message: "status must be 'active' or 'suspended'" }, 400);
  }

  const hierarchy = await assertResellerParent(c.env, tenantId, childTenantId);
  if (!hierarchy) return c.json({ error_code: "not_found", message: "Client not found in your portfolio" }, 404);

  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE tenant_hierarchy SET status = ? WHERE child_tenant_id = ? AND parent_tenant_id = ?"
  ).bind(body.status, childTenantId, tenantId).run();

  // Cascade to the child's spaces (suspend → 'suspended', reactivate → 'active').
  const spaceStatus = body.status === "suspended" ? "suspended" : "active";
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET status = ?, updated_at = ? WHERE tenant_id = ? AND status NOT IN ('deleted')"
  ).bind(spaceStatus, now, childTenantId).run();

  return c.json({ child_tenant_id: childTenantId, status: body.status, updated_at: now });
});

// POST /reseller/clients/:childTenantId/promote — detach a client business to a standalone
// product (spec §49 promote-to-product). In our per-tenant-DO model there is NO data
// migration: the business is already its own SpaceDO under its own tenant, so promotion
// just severs the reseller lineage. One-way; requires explicit acknowledgement.
app.post("/reseller/clients/:childTenantId/promote", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const childTenantId = c.req.param("childTenantId");
  const body = await c.req.json<{ acknowledge_irreversible: boolean }>();
  if (body.acknowledge_irreversible !== true) {
    return c.json({ error_code: "acknowledgement_required", message: "acknowledge_irreversible must be true" }, 400);
  }

  const hierarchy = await assertResellerParent(c.env, tenantId, childTenantId);
  if (!hierarchy) return c.json({ error_code: "not_found", message: "Client not found in your portfolio" }, 404);

  const now = new Date().toISOString();
  // Sever lineage: mark hierarchy terminated + clear parent_space_id on the child's spaces.
  await c.env.PLATFORM_DB.prepare(
    "UPDATE tenant_hierarchy SET status = 'terminated' WHERE child_tenant_id = ? AND parent_tenant_id = ?"
  ).bind(childTenantId, tenantId).run();
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET parent_space_id = NULL, scenario_type = NULL, depth = 0, updated_at = ? WHERE tenant_id = ?"
  ).bind(now, childTenantId).run();

  console.log(`[reseller][promote] child=${childTenantId} detached from parent=${tenantId} at=${now}`);
  return c.json({ promoted: true, child_tenant_id: childTenantId, promoted_at: now, note: "Business detached from reseller; now an independent product." });
});

// Three-Tier Platform Model, Phase 3 (docs/spec-appendix A1.17) — /builder/* routes.
registerBuilderRoutes(app);
// Three-Tier Platform Model, Phase 6 — public, unauthenticated end-user signup/login.
registerProductEndUserRoutes(app);

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
