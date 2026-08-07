import { Hono } from "hono";
import { errorResponse, requestId, notFound, requireInternalHmac, mintInternalToken, verifyInternalToken, forbidden, mintLocalTunnelToken } from "@naelao/http";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import type { SpaceDO } from "./do/SpaceDO.js";
import type { SpaceTypeRegistryDO, SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_MANIFEST } from "./launchpad-manifest.js";
import { cfSaasConfig, createCustomHostname, getCustomHostname } from "./cf-saas.js";
import { validateCronExpression } from "@naelao/events";
import { registerBuilderRoutes } from "./builder-routes.js";
import { registerProductEndUserRoutes, FREE_TIER_DEFAULT_SIGNUP_CREDITS } from "./product-end-user-routes.js";
import { createSpaceRecord, SpaceCreationError, provisionBusinessWallet } from "./create-space.js";
import type { ProvisionMessage } from "./create-space.js";
import { requireBusinessMembership, requireBusinessMembershipForWallet, resolveEndUserBusinessRole } from "./business-auth.js";
import { createBusinessForEndUser } from "./business-create.js";
import { loadTemplateCatalog, loadShellCatalog } from "./template-catalog.js";
import { registerBusinessRoutes } from "./business-routes.js";
import { ALLOWED_MODELS, isAllowedModel } from "@naelao/billing-core";

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
  /** F-39: agent workspace bucket (read-only file viewer). Optional so tests/dev without R2 degrade. */
  SCRIPTS_R2?: R2Bucket;
  /** Producer to the provisioning queue — consumed by naelao-provisioner. */
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  /** Cloudflare for SaaS custom-hostname provisioning (deploy-time secrets; optional). */
  CF_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  /** Billing worker — called at publish time to auto-create LS product + variant. */
  BILLING_WORKER?: Fetcher;
  /** Agents worker — SpaceDO fires event_triggers by calling its internal script.run route. */
  AGENTS_WORKER?: Fetcher;
  /** Notifications worker — password-reset emails (product-end-user-routes.ts). */
  NOTIFICATIONS_WORKER?: Fetcher;
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
    // Every business auto-provisions a Whop sub-merchant wallet — no builder action required.
    // Best-effort, wrapped so ANY failure here (missing table/row in an unusual deployment,
    // transient billing-worker error) never turns an otherwise-successful space creation into
    // a 500 — the wallet just stays unprovisioned until a retry, surfaced honestly by the
    // wallet balance read rather than blocking the thing the caller actually asked for.
    if (userId) {
      try {
        const owner = await c.env.PLATFORM_DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
        if (owner?.email) {
          await provisionBusinessWallet(c.env, { tenantId, spaceId: result.id, ownerEmail: owner.email, businessName: body.name });
        }
      } catch (err) {
        console.error(`[spaces] wallet provisioning lookup failed for space ${result.id}:`, (err as Error).message);
      }
    }
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
// A1.16.10 (layer-3 backstop, bucket A) gated this builder-only (confirmed against apps/widget +
// apps/portal — neither ever called this route). Phase B (§A1.17) changed that narrowly: the
// Product Shell's chat/project agent picker needs a READ-ONLY list of agent definitions — a
// product_end_user caller is allowed through for GET only (write methods stay admin-only). Phase
// C closed a cross-business hole in that check: a flat "any product_end_user may GET" would let
// one business's end user read another business's agent roster just by changing :spaceId in the
// URL — resolveEndUserBusinessRole now requires an actual (product-root or business-membership)
// role before the GET is allowed, same as requireBusinessMembership's other routes.
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
  const callerIdentity = getCallerIdentity(c);
  if (callerIdentity.role === "product_end_user") {
    if (c.req.method !== "GET") {
      return errorResponse(forbidden("product_end_user callers may only read agent definitions"), c.get("requestId") ?? "unknown");
    }
    const businessRole = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, callerIdentity.userId);
    if (!businessRole) {
      return errorResponse(forbidden("Not a member of this business"), c.get("requestId") ?? "unknown");
    }
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

// §A1.17 Phase O: GET /internal/spaces/:spaceId/owner-contact — resolves an email address the
// Space Assistant can notify when an agent needs approval (NaelaoAgentDO.notifyApprovalRequested
// / the router's agent-key approval gate). Two round trips because space_members lives in this
// space's own SpaceDO SQLite while the email lives in PLATFORM_DB's users table — no single JOIN
// is possible across that boundary. Internal-only (agents worker is the only caller); never
// end-user or even builder-dashboard reachable.
app.use("/internal/spaces/:spaceId/owner-contact", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/owner-contact", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/members?space_id=${encodeURIComponent(spaceId)}`, "GET");
  if (!res.ok) return c.json({ found: false }, 404);
  const { data } = await res.json<{ data?: Array<{ user_id: string; role: string }> }>();
  const owner = (data ?? []).find((m) => m.role === "owner");
  if (!owner) return c.json({ found: false }, 404);
  const user = await c.env.PLATFORM_DB.prepare("SELECT email FROM users WHERE id = ?").bind(owner.user_id).first<{ email: string }>();
  if (!user?.email) return c.json({ found: false }, 404);
  return c.json({ found: true, email: user.email });
});

// ── /internal/business-role ─────────────────────────────────────────────────
// Cross-worker authorization check: KV and other workers call this to verify
// a product_end_user has a real business_memberships row for a target space.
// Returns the caller's role in the business, or 404 if not a member.
// Gated with requireInternalHmac to authenticate the calling worker.
// Query params: spaceId, endUserId
app.use("/internal/business-role", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/business-role", async (c) => {
  const spaceId = c.req.query("spaceId") ?? "";
  const endUserId = c.req.query("endUserId") ?? "";
  if (!spaceId || !endUserId) {
    return c.json({ error_code: "bad_request", message: "spaceId and endUserId are required" }, 400);
  }
  const role = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, endUserId);
  if (!role) {
    return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 404);
  }
  return c.json({ role });
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
  const { tenantId, role, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  // S0.1: For product_end_user callers, verify business membership.
  if (role === "product_end_user" && userId) {
    const memberRole = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, userId);
    if (!memberRole) {
      return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
    }
  }

  // F-4: POST /spaces/:spaceId/sessions/stream-ticket — mint a short-lived (60s) single-use
  // stream ticket so the shell's EventSource carries the ticket instead of the raw nps_ session
  // token in the URL (which lands in CF/proxy access logs + browser history). The caller was
  // already fully verified above (router-minted internal token + business membership), and
  // browser EventSource can't set Authorization headers — this is exactly why the ticket exists.
  // The stream endpoint consumes it via /internal/stream-tickets/consume. Handled here, before the
  // SpaceDO forward, since SpaceDO has no session sub-resource for it.
  {
    const stripped = new URL(c.req.url).pathname.replace(`/spaces/${spaceId}`, "");
    if (c.req.method === "POST" && stripped === "/sessions/stream-ticket") {
      const ticket = crypto.randomUUID();
      const key = `stream-ticket:${spaceId}:${userId}:${ticket}`;
      await c.env.NAELAO_CONFIG_KV.put(key, tenantId, { expirationTtl: 60 });
      return c.json({ ticket, expires_in: 60 });
    }
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
  // sessions. S0.1: Also apply end_user_id filtering for GET /sessions/:id and
  // GET /sessions/:id/messages when the caller is a product_end_user.
  let search = url.search;
  const { role: callerRole, userId: callerId } = getCallerIdentity(c);
  const isProductEndUser = callerRole === "product_end_user" && callerId;

  if (c.req.method === "GET" && doPath === "/sessions") {
    const qs = new URLSearchParams();
    if (isProductEndUser) qs.set("end_user_id", callerId);
    const limit = url.searchParams.get("limit");
    if (limit) qs.set("limit", limit);
    search = `?${qs.toString()}`;
  } else if (c.req.method === "GET" && /^\/sessions\/([^/]+)(\/messages)?$/.test(doPath) && isProductEndUser) {
    // For GET /sessions/:id and GET /sessions/:id/messages, pass end_user_id so SpaceDO can verify
    // the caller owns this session before returning it.
    const qs = new URLSearchParams(url.searchParams);
    qs.set("end_user_id", callerId);
    search = `?${qs.toString()}`;
  }
  const doUrl = new URL(doPath + search, "http://space-do");

  // SpaceDO.createSession() reads space_id/tenant_id from the JSON BODY (not the URL or
  // headers — forwardToSpaceDO-style calls don't forward headers, and this DO instance has no
  // other way to know its own space_id). Every client that calls POST /sessions (apps/shell's
  // startSession()) sends an empty body ({}), so those fields were always undefined, binding
  // NULL into a NOT NULL column and 500ing on every single session-create call — the literal
  // cause of "An unexpected error occurred" on the shell's home page for every end user.
  // Fixed by injecting them here, matching the exact pattern the /threads POST route below
  // already uses for the same reason (SpaceDO needs tenant_id and has no other way to get it).
  let doBody: BodyInit | null = c.req.raw.body;
  let duplexInit: { duplex: "half" } | Record<string, never> = c.req.raw.body ? { duplex: "half" as const } : {};
  if (c.req.method === "POST" && doPath === "/sessions") {
    const parsedBody = await c.req.json().catch(() => ({}));
    // A product_end_user's own real id (never client-supplied — same "identity from verified
    // claims only" rule every other end_user_id use in this route already follows) so the
    // session is actually owned by its creator. Without this, every end-user-created session
    // landed with end_user_id NULL, which made getSession/getMessages' own ownership check
    // ("session.end_user_id !== endUserId") reject EVERY subsequent read as "Session not found"
    // — the space_id/tenant_id fix above stopped the 500 on create, but left every session
    // permanently unreadable by the very user who just created it.
    const endUserId = isProductEndUser ? callerId : (parsedBody as { end_user_id?: string }).end_user_id;
    doBody = JSON.stringify({ ...parsedBody, space_id: spaceId, tenant_id: tenantId, end_user_id: endUserId ?? null });
    duplexInit = {};
  }

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: doBody,
      // Required by spec-compliant fetch implementations (e.g. Node's undici, used by this
      // repo's own test suite) whenever a streaming body is attached to a Request — omitting it
      // throws "duplex option is required" and was silently never hit before this Phase 6 pass
      // because this whole route was unreachable (see the routing-bug comment above).
      ...duplexInit,
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

/** Forward a request to a path on the SpaceDO, preserving method/headers/body. Spec-compliant
 *  fetch implementations (Node's undici, used by this repo's own tests) require `duplex: "half"`
 *  whenever a streaming body is attached — the same fix already applied to the session proxy
 *  (see CLAUDE.md item 30, "Product Shell data layer" pass) for the identical reason. */
async function forwardToSpaceDO(
  stub: ReturnType<Env["SPACE_DO"]["get"]>,
  path: string,
  method: string,
  body?: BodyInit | null,
): Promise<Response> {
  return stub.fetch(new Request(`http://space-do${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && body !== null ? { body, duplex: "half" as const } : {}),
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

// Projects (thread grouping) — real traffic always arrives either via the router (proxyTo
// already mints the token off verified JWT OR product_end_user claims) or a direct internal
// caller (NaelaoAgentDO, agents worker — both updated to mint it too), so requireInternalHmac
// stays the "came through the router" gate for everyone. Phase B (§A1.17): the Product Shell
// needs list/create/read here for a product_end_user caller — requireBusinessMembership adds the
// extra floor ONLY for that role (every other role is unaffected). rules/spend stay OFF the
// router's product_end_user allowlist entirely (server-to-server agent accounting, no-code rule
// config) — requireInternalHmac alone still fully gates them; no product_end_user request can
// ever reach them regardless of what's declared below.
app.use("/spaces/:spaceId/projects", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects", requireBusinessMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/projects/:projectId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/rules", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/spend", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

// Launchpad Wallet (user-directed feature). credit/debit are internal-only (called by the
// billing worker's LS webhook handler after a top-up, and by the wallet script-engine prebuilt
// running inside NaelaoAgentDO) — same posture as /spend, never a direct end-user write surface.
// balance/history ARE end-user-reachable (a business owner checking their OWN business's wallet),
// but the PRODUCT ROOT's wallet project is the builder's own platform-cost ledger, not something
// any product_end_user should ever read — requireBusinessMembershipForWallet (unlike the generic
// requireBusinessMembership) refuses a product_end_user outright on the root instead of applying
// the generic root-implies-"member" shortcut.
app.use("/spaces/:spaceId/projects/:projectId/wallet/balance", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/wallet/balance", requireBusinessMembershipForWallet({ GET: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/wallet/history", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/wallet/history", requireBusinessMembershipForWallet({ GET: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/wallet/credit", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/wallet/debit", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

// GET lists, POST creates — proxied to the SpaceDO. §A1.17 Phase T1: viewer_id/created_by are
// ALWAYS derived from the caller's own verified identity (never a client-supplied field) so
// visibility filtering and project_members ownership can't be spoofed.
app.get("/spaces/:spaceId/projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const viewerParam = identity.userId ? `&viewer_id=${encodeURIComponent(identity.userId)}` : "";
  const res = await forwardToSpaceDO(stub, `/projects?space_id=${encodeURIComponent(spaceId)}${viewerParam}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ name: string; description?: string; visibility?: "public" | "private" }>().catch(() => ({ name: "" }));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // system_caller is computed from the verified absence of an authenticated identity (no
  // x-naelao-user-id) — NOT read from the client's own JSON body — and placed after `...body` so
  // it always overrides anything a caller tried to smuggle in. requireInternalHmac (line ~632)
  // already ensures this route is only reachable via the router (which always sets
  // x-naelao-user-id for a real session) or a genuine internal caller (the provisioner, which
  // never does) — see SpaceDO.createProject's fail-closed feature-kind gate.
  const res = await forwardToSpaceDO(
    stub, "/projects", "POST",
    JSON.stringify({ ...body, space_id: spaceId, tenant_id: tenantId, created_by: identity.userId || undefined, system_caller: !identity.userId })
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// §A1.17 Phase T1: project members (real ACL, not just presence). §A1.17 Phase T3: exclusive-
// mode thread activation.
app.use("/spaces/:spaceId/projects/:projectId/members", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/members", requireBusinessMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/members/:userId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/members/:userId", requireBusinessMembership({ DELETE: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/activate-thread", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/activate-thread", requireBusinessMembership({ POST: "member" }));

app.get("/spaces/:spaceId/projects/:projectId/members", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/members`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/members", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/members`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/projects/:projectId/members/:userId", async (c) => {
  const { spaceId, projectId, userId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── F-39: R2 workspace file viewer ─────────────────────────────────────────────
// A project's agent writes artifacts (generated dashboards, reports, exports) into its R2
// workspace at spaces/{spaceId}/projects/{projectId}/workspace/. These read-only routes let a
// builder or a project member browse and view them — the "AI writes wallet-dashboard.html,
// builder views it" case. Bounds mirror Phase K/R: 300 files listed, 2MB per file read.
const WORKSPACE_MAX_FILES = 300;
const WORKSPACE_MAX_FILE_BYTES = 2 * 1024 * 1024;
function workspaceKeyPrefix(spaceId: string, projectId: string): string {
  return `spaces/${spaceId}/projects/${projectId}/workspace/`;
}
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files", async (c) => {
  const { spaceId, projectId } = c.req.param();
  if (!c.env.SCRIPTS_R2) return c.json({ data: [], count: 0, unavailable: true });
  const prefix = workspaceKeyPrefix(spaceId, projectId);
  const files: Array<{ path: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  do {
    const list = await c.env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const obj of list.objects) {
      if (obj.key.endsWith("/.keep")) continue;
      files.push({ path: obj.key.slice(prefix.length), size: obj.size, uploaded: obj.uploaded.toISOString() });
      if (files.length >= WORKSPACE_MAX_FILES) break;
    }
    cursor = list.truncated && files.length < WORKSPACE_MAX_FILES ? list.cursor : undefined;
  } while (cursor);
  return c.json({ data: files, count: files.length, truncated: files.length >= WORKSPACE_MAX_FILES });
});
// GET one file — path is the rest after /workspace/files/. Text is returned inline; anything over
// the byte cap or non-text is reported as too-large/binary (the UI offers a note, not the bytes).
app.use("/spaces/:spaceId/projects/:projectId/workspace/files/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/files/*", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files/*", async (c) => {
  const { spaceId, projectId } = c.req.param();
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable", message: "Workspace storage not configured" }, 503);
  const prefix = workspaceKeyPrefix(spaceId, projectId);
  const rest = c.req.path.split("/workspace/files/")[1] ?? "";
  // Collapse any .. traversal server-side; the key must stay inside the project's own prefix.
  const relative = decodeURIComponent(rest).split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  if (!relative) return c.json({ error_code: "bad_request", message: "file path required" }, 400);
  const obj = await c.env.SCRIPTS_R2.get(prefix + relative);
  if (!obj) return c.json({ error_code: "not_found", message: "File not found" }, 404);
  if (obj.size > WORKSPACE_MAX_FILE_BYTES) {
    return c.json({ path: relative, size: obj.size, too_large: true, message: "File exceeds the 2MB inline view limit" });
  }
  const content = await obj.text();
  return c.json({ path: relative, size: obj.size, content });
});

// F-36: the effective role an assistant has in a project when acting for a given user (member GET
// gate — anyone who can read the member list can read this derived value).
app.use("/spaces/:spaceId/projects/:projectId/assistant-access", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/assistant-access", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/assistant-access", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const userId = c.req.query("user_id") ?? "";
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/assistant-access?user_id=${encodeURIComponent(userId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/activate-thread", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ thread_id?: string; take_over?: boolean }>().catch(() => ({}) as Record<string, never>);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(
    stub, `/projects/${encodeURIComponent(projectId)}/activate-thread`, "POST",
    JSON.stringify({ ...body, user_id: identity.userId, tenant_id: tenantId })
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// §A1.17 Phase U: project-scoped Memory OS Layers 3/4/6 — internal-only (agents worker is the
// only caller, via project-memory-client.ts's remote MemoryStore), never end-user or builder
// dashboard reachable, matching /rules and /spend's existing internal-only posture.
app.use("/spaces/:spaceId/projects/:projectId/memory/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

app.all("/spaces/:spaceId/projects/:projectId/memory/*", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const url = new URL(c.req.url);
  const marker = `/projects/${projectId}`;
  const suffix = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const res = await forwardToSpaceDO(stub, `${marker}${suffix}${url.search}`, c.req.method, c.req.raw.body ?? undefined);
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
  // §A1.17 Phase V: tenant_id rides the query string (not a header, since forwardToSpaceDO
  // doesn't forward client headers, and the body is streamed through unparsed) so
  // updateProject can live-sync via broadcastSpaceEvent.
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(tenantId)}`, "PATCH", c.req.raw.body);
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

// ── Launchpad Wallet ──────────────────────────────────────────────────────────
app.get("/spaces/:spaceId/projects/:projectId/wallet/balance", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/wallet/balance`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/projects/:projectId/wallet/history", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const url = new URL(c.req.url);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/wallet/history${url.search}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /spaces/:spaceId/wallet — F-WALLET-6/7: the consolidated wallet view for a space, serving
// BOTH the builder dashboard's Wallet tab and the shell's business Wallet section. Combines the
// space's own wallet project (available spendable balance + recent transactions from SpaceDO's
// wallet_ledger) with a lifetime money-in summary from launchpad_orders (gross, Naelao cut,
// builder cut, net settled) so the "two deductions shown explicitly" transparency requirement is
// met. Gated by requireInternalHmac (the request must arrive through naelao-router, which mints
// the token from verified claims — the same direct-worker-ingress backstop every other
// /spaces/:spaceId/* data route carries; without it a direct caller could spoof identity headers)
// PLUS requireBusinessMembershipForWallet (member GET — additive-only for a product_end_user
// business member reading their OWN business's wallet; a builder acting via the router passes
// through unchanged). On the PRODUCT ROOT this is the builder's own platform-cost ledger, so the
// wallet-specific resolver refuses a product_end_user outright there instead of the generic
// root-implies-"member" shortcut requireBusinessMembership uses for every other root resource.
app.use("/spaces/:spaceId/wallet", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/wallet", requireBusinessMembershipForWallet({ GET: "member" }));
app.get("/spaces/:spaceId/wallet", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);

  // Resolve the wallet project + its balance + recent transactions.
  const wpRes = await forwardToSpaceDO(stub, `/wallet-project?space_id=${encodeURIComponent(spaceId)}`, "GET");
  const { project_id } = await wpRes.json<{ project_id: string | null }>();
  let availableBalanceCents = 0;
  let currency = "USD";
  let transactions: unknown[] = [];
  if (project_id) {
    const balRes = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(project_id)}/wallet/balance`, "GET");
    if (balRes.ok) {
      const bal = await balRes.json<{ balance_cents: number; currency?: string }>();
      availableBalanceCents = bal.balance_cents ?? 0;
      currency = bal.currency ?? "USD";
    }
    const histRes = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(project_id)}/wallet/history?limit=20`, "GET");
    if (histRes.ok) transactions = (await histRes.json<{ data: unknown[] }>()).data ?? [];
  }

  // Lifetime money-in summary from launchpad_orders (refunded orders excluded from earned totals).
  const summary = await c.env.PLATFORM_DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status != 'refunded' THEN gross_cents ELSE 0 END), 0)        AS gross_cents,
       COALESCE(SUM(CASE WHEN status != 'refunded' THEN fee_cents ELSE 0 END), 0)          AS naelao_cut_cents,
       COALESCE(SUM(CASE WHEN status != 'refunded' THEN builder_fee_cents ELSE 0 END), 0)  AS builder_cut_cents,
       COALESCE(SUM(CASE WHEN status != 'refunded' THEN net_cents ELSE 0 END), 0)          AS net_settled_cents,
       COUNT(CASE WHEN status != 'refunded' THEN 1 END)                                    AS order_count
     FROM launchpad_orders WHERE space_id = ?`
  ).bind(spaceId).first<{ gross_cents: number; naelao_cut_cents: number; builder_cut_cents: number; net_settled_cents: number; order_count: number }>();

  return c.json({
    space_id: spaceId,
    project_id,
    available_balance_cents: availableBalanceCents,
    currency,
    lifetime: {
      gross_cents: summary?.gross_cents ?? 0,
      naelao_cut_cents: summary?.naelao_cut_cents ?? 0,
      builder_cut_cents: summary?.builder_cut_cents ?? 0,
      net_settled_cents: summary?.net_settled_cents ?? 0,
      order_count: summary?.order_count ?? 0,
    },
    transactions,
  });
});

// tenant_id rides the query string (not a header — forwardToSpaceDO doesn't forward client
// headers, and the body is streamed through unparsed), same shape as PATCH /projects/:id, so
// creditWallet/debitWallet can fire broadcastSpaceEvent/fireMatchingTriggers against the
// verified tenant without requiring the body itself to repeat it.
app.post("/spaces/:spaceId/projects/:projectId/wallet/credit", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(
    stub, `/projects/${encodeURIComponent(projectId)}/wallet/credit?tenant_id=${encodeURIComponent(tenantId)}`, "POST", c.req.raw.body
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/wallet/debit", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(
    stub, `/projects/${encodeURIComponent(projectId)}/wallet/debit?tenant_id=${encodeURIComponent(tenantId)}`, "POST", c.req.raw.body
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /spaces/:spaceId/wallet-project — metering enforcement follow-up: internal-only (the agents
// worker is the only caller, before/after a project-scoped run), never end-user or builder
// dashboard reachable, matching /rules and /spend's existing internal-only posture. Finds the
// space's auto-provisioned wallet project (see the provisioner's seedWallet step) so
// NaelaoAgentDO can gate/debit a project-scoped run's real cost against it.
app.use("/spaces/:spaceId/wallet-project", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/wallet-project", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/wallet-project?space_id=${encodeURIComponent(spaceId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST/GET /spaces/:spaceId/revenue-tracking — external revenue tracker (Whop-native business
// cut): internal-only (the revenue-tracker prebuilt POSTs a period's observed gross revenue; the
// billing worker GETs it to compute a builder-configured cut surcharge). Never end-user or
// builder dashboard reachable directly — same posture as /wallet-project above.
app.use("/spaces/:spaceId/revenue-tracking", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/spaces/:spaceId/revenue-tracking", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/revenue-tracking", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.get("/spaces/:spaceId/revenue-tracking", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams(c.req.query() as Record<string, string>);
  qs.set("space_id", spaceId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/revenue-tracking?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.use("/spaces/:spaceId/revenue-tracking/mark-billed", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/spaces/:spaceId/revenue-tracking/mark-billed", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/revenue-tracking/mark-billed", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.use("/spaces/:spaceId/revenue-tracking/unmark-billed", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/spaces/:spaceId/revenue-tracking/unmark-billed", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/revenue-tracking/unmark-billed", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// F-31: the billing worker marks periods as having an in-flight checkout right after minting a URL.
app.use("/spaces/:spaceId/revenue-tracking/mark-pending", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/spaces/:spaceId/revenue-tracking/mark-pending", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/revenue-tracking/mark-pending", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Container Marketplace slots (§A1.17 Phase L) — builder/operator-only for now (like rules/
// spend above): no catalogue image is live yet, so there is nothing for an end user's day-to-day
// chat to reach here. requireInternalHmac (came-through-the-router gate) stays the only floor;
// revisit end-user exposure once a real image ships and there's something to actually add.
app.use("/spaces/:spaceId/projects/:projectId/container-slots", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/container-slots/:slotId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

app.get("/spaces/:spaceId/projects/:projectId/container-slots", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/container-slots`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST validates image_id against the real catalogue (exists + available) and the product's
// configured slot limit BEFORE ever reaching SpaceDO — SpaceDO's own hard ceiling is a backstop,
// not the primary control (same split as project templates: the worker layer holds business
// rules, the DO is CRUD).
app.post("/spaces/:spaceId/projects/:projectId/container-slots", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const body = await c.req.json<{ image_id: string; slot_name?: string }>().catch(() => ({}) as Record<string, never>);
  if (!body.image_id) return c.json({ error_code: "bad_request", message: "image_id is required" }, 400);

  const catalogue = await loadContainerCatalogue(c.env);
  const image = catalogue.find((i) => i.id === body.image_id);
  if (!image) return c.json({ error_code: "not_found", message: `Unknown container image '${body.image_id}'` }, 404);
  if (!image.available) {
    return c.json({ error_code: "not_available", message: `Container image '${body.image_id}' is not available yet` }, 409);
  }

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ spacetype_id: string; config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);
  const maxSlots = pc?.containerMarketplace?.maxSlotsPerProject ?? 0;

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const listRes = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/container-slots`, "GET");
  const existing = await listRes.json<{ count: number }>().catch(() => ({ count: 0 }));
  if (existing.count >= maxSlots) {
    return c.json({ error_code: "slot_limit_reached", message: `This product allows at most ${maxSlots} container slot(s) per project` }, 409);
  }

  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/container-slots`, "POST", JSON.stringify(body));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/projects/:projectId/container-slots/:slotId", async (c) => {
  const { spaceId, projectId, slotId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/container-slots/${encodeURIComponent(slotId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Local-machine-as-container (spec "Local PC as a Container Target", gap G-3; §A1.17
// Phase M, UI added Phase S) — a builder OR a business's own end-user member opts their OWN
// machine in as a grant-checked Tier-5c target. Gated by requireInternalHmac (the SAME token
// naelao-router's proxyTo mints for every authenticated request it forwards, builder JWT or
// product_end_user alike — not an exclusively service-to-service check) PLUS
// requireBusinessMembership for a product_end_user caller specifically, since tenant-match alone
// would let any end user of ANY business under the same owning tenant reach another business's
// grants. user_id is ALWAYS derived from the verified caller identity, never a client-supplied
// field — a caller can only grant/connect their OWN machine, never name someone else's.
app.use("/spaces/:spaceId/local-grants", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-grants/:grantId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-tunnel/connect-token", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-grants", requireBusinessMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/local-grants/:grantId", requireBusinessMembership({ DELETE: "admin" }));
app.use("/spaces/:spaceId/local-tunnel/connect-token", requireBusinessMembership({ POST: "member" }));

app.get("/spaces/:spaceId/local-grants", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // A business member sees only their OWN grants (directory paths are sensitive); a builder/
  // owner JWT caller keeps seeing the whole space's grants, unchanged from before this pass.
  const userFilter = identity.role === "product_end_user" && identity.userId ? `&user_id=${encodeURIComponent(identity.userId)}` : "";
  const res = await forwardToSpaceDO(stub, `/local-grants?space_id=${encodeURIComponent(spaceId)}${userFilter}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

const VALID_LOCAL_GRANT_TYPES = new Set(["read", "write", "readwrite", "exec"]);

app.post("/spaces/:spaceId/local-grants", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user identity" }, 401);

  const body = await c.req
    .json<{ grant_type?: string; directory?: string; commands?: string[]; project_id?: string }>()
    .catch(() => ({}) as Record<string, never>);
  if (!body.grant_type || !VALID_LOCAL_GRANT_TYPES.has(body.grant_type)) {
    return c.json({ error_code: "bad_request", message: "grant_type must be one of read, write, readwrite, exec" }, 400);
  }
  if (body.grant_type === "exec") {
    if (!Array.isArray(body.commands) || body.commands.length === 0) {
      return c.json({ error_code: "bad_request", message: "exec grants require a non-empty commands list" }, 400);
    }
  } else if (!body.directory) {
    return c.json({ error_code: "bad_request", message: `${body.grant_type} grants require a directory` }, 400);
  }

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(
    stub,
    `/local-grants?space_id=${encodeURIComponent(spaceId)}`,
    "POST",
    JSON.stringify({
      user_id: identity.userId,
      grant_type: body.grant_type,
      directory: body.directory ?? null,
      commands: body.commands ?? [],
      project_id: body.project_id ?? null,
    })
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/local-grants/:grantId", async (c) => {
  const { spaceId, grantId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/local-grants/${encodeURIComponent(grantId)}?space_id=${encodeURIComponent(spaceId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Mints the short-lived (5 min) connect token the Naelao Local Agent client presents to
// LocalTunnelDO's WebSocket upgrade (agents worker). Deliberately does NOT invent or return a
// public hostname/URL for the agents worker — that base URL is an operator/deployment concern
// (same as every other cross-worker public endpoint in this platform), supplied to the Local
// Agent client via its own config, not guessed here.
app.post("/spaces/:spaceId/local-tunnel/connect-token", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user identity" }, 401);
  const token = await mintLocalTunnelToken(c.env.PLATFORM_SECRET, spaceId, identity.userId);
  return c.json({
    token,
    space_id: spaceId,
    user_id: identity.userId,
    connect_path: "/local-tunnel/connect",
    expires_in_seconds: 300,
  });
});

// ── Whop wallet shell wrapper ──────────────────────────────────────────────────────────────────
// Every business gets an auto-provisioned Whop sub-merchant wallet (no builder action). The
// balance/transactions read is member-visible (a business's own bank-account balance is
// operating information the whole team can see, like the wallet_ledger panel); managing payout
// destinations and requesting a payout is admin-only. Same two-gate pattern as local-grants
// above: requireInternalHmac proves the request came through naelao-router;
// requireBusinessMembership does the real per-business authorization (a product session is
// product-scoped, never per-business — Phase C's cross-business fix). The handler proxies to the
// billing worker's /billing/whop-wallet/* routes with the caller's real role — never hardcoded
// to admin, since GET is member-level here (unlike the removed Wallet Connect's admin-only GET).
app.use("/spaces/:spaceId/business-wallet/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use(
  "/spaces/:spaceId/business-wallet/balance",
  requireBusinessMembership({ GET: "member" })
);
app.use(
  "/spaces/:spaceId/business-wallet/transactions",
  requireBusinessMembership({ GET: "member" })
);
app.use(
  "/spaces/:spaceId/business-wallet/destinations",
  requireBusinessMembership({ GET: "admin", POST: "admin" })
);
app.use(
  "/spaces/:spaceId/business-wallet/payouts",
  requireBusinessMembership({ GET: "admin", POST: "admin" })
);

async function proxyWalletToBilling(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
  role = "admin"
): Promise<Response> {
  if (!c.env.BILLING_WORKER) {
    return Response.json({ error_code: "billing_unavailable", message: "Billing worker not configured" }, { status: 503 });
  }
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return Response.json({ error_code: "unauthorized", message: "Missing tenant" }, { status: 401 });
  const resp = await c.env.BILLING_WORKER.fetch(
    new Request(`http://billing-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-user-id": identity.userId ?? "",
        "x-naelao-role": role,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
}

app.get("/spaces/:spaceId/business-wallet/balance", async (c) =>
  proxyWalletToBilling(c, `/billing/whop-wallet/balance?space_id=${encodeURIComponent(c.req.param("spaceId"))}`, "GET", undefined, "member")
);

app.get("/spaces/:spaceId/business-wallet/transactions", async (c) =>
  proxyWalletToBilling(
    c,
    `/billing/whop-wallet/transactions?space_id=${encodeURIComponent(c.req.param("spaceId"))}&limit=${encodeURIComponent(c.req.query("limit") ?? "50")}`,
    "GET",
    undefined,
    "member"
  )
);

app.get("/spaces/:spaceId/business-wallet/destinations", async (c) =>
  proxyWalletToBilling(c, `/billing/whop-wallet/destinations?space_id=${encodeURIComponent(c.req.param("spaceId"))}`, "GET")
);

app.post("/spaces/:spaceId/business-wallet/destinations", async (c) => {
  const body = await c.req.json<{ type?: string; label?: string; details?: Record<string, unknown> }>().catch(() => ({}) as Record<string, never>);
  return proxyWalletToBilling(c, "/billing/whop-wallet/destinations", "POST", {
    space_id: c.req.param("spaceId"),
    type: body.type,
    label: body.label,
    details: body.details,
  });
});

app.get("/spaces/:spaceId/business-wallet/payouts", async (c) =>
  proxyWalletToBilling(c, `/billing/whop-wallet/payouts?space_id=${encodeURIComponent(c.req.param("spaceId"))}`, "GET")
);

// ── Per-business connector connect (BYO Whop account, no Naelao Platforms invite needed) ──────
// Every business's revenue-cut billing runs through the existing revenue-tracker + reseller_ledger
// surcharge mechanism, NOT the invite-only Whop Platforms/business-wallet rail above — a business
// owner connects their OWN Whop account here (a normal Whop API key from their own dashboard,
// generally available, no invite required), the agent reads it read-only via mcp-connector, and
// revenue-tracker bills Naelao's configured cut % on the builder's NEXT platform subscription.
// The existing /connectors/* routes on the agents worker already implement the store-credential +
// register-mcp-server logic (dashboard's Connectors console has used them since that build) but
// only check `requireVerifiedTenant` — no per-space ownership check at all, which is fine for a
// builder (their JWT's tenant owns every one of their own spaces) but NOT safe to open to an end
// user directly, whose session tenant is the PRODUCT's owning tenant spanning every business under
// it. This wrapper adds the missing requireBusinessMembership check, then proxies to the
// already-tested agents-worker logic with the space's own owning tenant (not the caller's raw
// claims), matching the exact pattern proxyWalletToBilling established above.
// F-33-class trap (documented repeatedly in this file): a NEW dynamic path segment shape can
// silently corrupt Hono's RegExpRouter compilation for UNRELATED routes elsewhere in this
// 170+-route file. A `/spaces/:spaceId/connectors/:platform/connect` shape reproduced exactly
// that corruption (members/agent-definitions/sessions routes started 404ing in the full suite,
// not this route itself) — fixed the established way: remove the extra dynamic segment rather
// than add a second `app.use(dynamicPattern, ...)` registration. `platform` moves to the request
// body; only "whop" is supported today anyway.
app.use("/spaces/:spaceId/connectors/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/connectors/status", requireBusinessMembership({ GET: "member" }));
// §A1.18: the floor is now "member", not "admin" — a scope_model='user' connector (a member's
// OWN personal account, see catalogue.ts's own header) should need no more than membership to
// connect. The admin requirement for a scope_model='space' connector is enforced downstream, in
// the agents worker's own connect handler, which is the one place that actually knows a given
// platform's scope_model — see the x-naelao-business-role forwarding below. Only the GATE moved;
// no new route or route-shape changed, so this isn't the class of change that's previously
// triggered this file's documented Hono route-table corruption (items 40/52/60 were all about
// adding a NEW dynamic-segment-then-static-suffix route, not loosening an existing gate).
app.use("/spaces/:spaceId/connectors/connect", requireBusinessMembership({ POST: "member" }));

// Generic authenticated proxy to the agents worker (connectors, and the onboarding wizard's
// bootstrap routes) — mints a real internal token for the space's OWNING tenant.
async function proxyToAgentsWorker(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  if (!c.env.AGENTS_WORKER) {
    return Response.json({ error_code: "connectors_unavailable", message: "Agents worker not configured" }, { status: 503 });
  }
  const identity = getCallerIdentity(c);
  // Same reasoning as proxyWalletToBilling: prefer the already-verified header set by the
  // router/requireBusinessMembership chain (the space's OWNING tenant), never the raw caller
  // identity — an end user's own claims.tid is the product root's tenant, which is what we want
  // here too since a business's connectors are scoped by space_id, not by who's asking.
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return Response.json({ error_code: "unauthorized", message: "Missing tenant" }, { status: 401 });
  const resp = await c.env.AGENTS_WORKER.fetch(
    new Request(`http://agents-worker${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-user-id": identity.userId ?? "",
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
  return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
}

app.get("/spaces/:spaceId/connectors/status", async (c) =>
  proxyToAgentsWorker(c, `/connectors/status?space_id=${encodeURIComponent(c.req.param("spaceId"))}`, "GET")
);

// Everything the platform can reach, not just the curated dozen (connectors/directory.ts).
// Read-only and identical for every tenant, so "member" is the right floor — connecting one is
// still gated by /connectors/provider-connect-start's own admin check. Registered as a static
// sibling of `status`, deliberately NOT as `/directory/:provider` — a dynamic segment followed by
// a static suffix is the shape that has repeatedly corrupted this file's route table.
app.use("/spaces/:spaceId/connectors/directory", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/connectors/directory", async (c) => {
  const params = new URLSearchParams();
  const q = c.req.query("q");
  const cursor = c.req.query("cursor");
  const limit = c.req.query("limit");
  const sort = c.req.query("sort");
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", limit);
  if (sort) params.set("sort", sort);
  const qs = params.toString();
  return proxyToAgentsWorker(c, `/connectors/directory${qs ? `?${qs}` : ""}`, "GET");
});

app.post("/spaces/:spaceId/connectors/connect", async (c) => {
  const body = await c.req.json<{ platform?: string; api_key?: string }>().catch(() => ({}) as Record<string, never>);
  const platform = body.platform ?? "";
  if (!platform) return c.json({ error_code: "bad_request", message: "platform is required" }, 400);
  // §A1.18: the gate above only enforces "member" — the agents worker's own connect handler
  // makes the real admin-vs-any-member decision per the PLATFORM's scope_model, which only it
  // knows. It needs this caller's actual BUSINESS role to do that, which for a product_end_user
  // is a resolved value (owner/admin/editor/member/viewer via business_memberships), not the raw
  // "product_end_user" JWT role — resolved here, once, and forwarded. Absent for every other
  // caller (a builder's own JWT role isn't a business role and never needs to be): the connect
  // handler treats a missing header as "not an end user, apply today's unchanged behavior".
  const identity = getCallerIdentity(c);
  let businessRole: string | undefined;
  if (identity.role === "product_end_user" && identity.userId) {
    businessRole = (await resolveEndUserBusinessRole(c.env.PLATFORM_DB, c.req.param("spaceId"), identity.userId)) ?? undefined;
  }
  return proxyToAgentsWorker(
    c,
    `/connectors/${encodeURIComponent(platform)}/connect`,
    "POST",
    { space_id: c.req.param("spaceId"), api_key: body.api_key },
    businessRole ? { "x-naelao-business-role": businessRole } : undefined
  );
});

// "Connect with X" OAuth flow — same admin-only gate as the manual-key connect above, same
// platform-in-body shape (never a URL param) for the same router-corruption reason. Returns
// {authorize_url}; the frontend does a real browser navigation to it (see oauth.ts's header).
app.use("/spaces/:spaceId/connectors/oauth-start", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/connectors/oauth-start", async (c) => {
  const body = await c.req.json<{ platform?: string; return_url?: string }>().catch(() => ({}) as Record<string, never>);
  const platform = body.platform ?? "";
  if (!platform) return c.json({ error_code: "bad_request", message: "platform is required" }, 400);
  if (!body.return_url) return c.json({ error_code: "bad_request", message: "return_url is required" }, 400);
  return proxyToAgentsWorker(c, `/connectors/${encodeURIComponent(platform)}/oauth/start`, "POST", {
    space_id: c.req.param("spaceId"),
    return_url: body.return_url,
  });
});

// Composio "click Install" hosted-connect flow (G-1/G-3 growth layer) — same admin-only gate and
// platform-in-body shape as oauth-start above (same router-corruption reasoning: never a dynamic
// :platform URL segment on a spaces-worker route). Returns {connect_url}; the frontend does a real
// browser navigation to it (see composio.ts's header).
app.use("/spaces/:spaceId/connectors/provider-connect-start", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/connectors/provider-connect-start", async (c) => {
  const body = await c.req.json<{ platform?: string; return_url?: string }>().catch(() => ({}) as Record<string, never>);
  const platform = body.platform ?? "";
  if (!platform) return c.json({ error_code: "bad_request", message: "platform is required" }, 400);
  if (!body.return_url) return c.json({ error_code: "bad_request", message: "return_url is required" }, 400);
  return proxyToAgentsWorker(c, `/connectors/${encodeURIComponent(platform)}/provider-connect/start`, "POST", {
    space_id: c.req.param("spaceId"),
    return_url: body.return_url,
  });
});

// ── Business setup wizard (first-run onboarding) ─────────────────────────────
// The end user's own path into the bootstrap the builder dashboard has always driven. Same
// two-gate pattern as connectors/local-grants above: identity at the router, real per-business
// authorization here — reading the checklist is member-level, but answering it (connecting the
// business's Whop account, choosing how autonomous the assistant is) changes how the business
// operates and is admin-only.
//
// ONE route, with POST's `action` carrying the operation, instead of the natural
// /onboarding/save + /onboarding/complete pair: a dynamic segment followed by a static suffix is
// the exact shape that has repeatedly triggered this file's documented Hono RegExpRouter
// route-table-scale corruption (silently 404ing UNRELATED routes elsewhere in the app — see the
// record-install and connectors comments above).
app.use("/spaces/:spaceId/onboarding", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/onboarding", requireBusinessMembership({ GET: "member", POST: "admin" }));

app.get("/spaces/:spaceId/onboarding", async (c) =>
  proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/bootstrap`, "GET")
);

app.post("/spaces/:spaceId/onboarding", async (c) => {
  const body = await c.req.json<{ action?: string; answers?: Record<string, unknown> }>().catch(() => ({}) as Record<string, never>);
  const spaceId = encodeURIComponent(c.req.param("spaceId"));
  const action = body.action ?? "save";
  if (action !== "save" && action !== "complete") {
    return c.json({ error_code: "bad_request", message: "action must be 'save' or 'complete'" }, 400);
  }
  const path = action === "complete" ? `/spaces/${spaceId}/bootstrap/complete` : `/spaces/${spaceId}/bootstrap/save`;
  return proxyToAgentsWorker(c, path, "POST", { answers: body.answers ?? {} });
});

app.post("/spaces/:spaceId/business-wallet/payouts", async (c) => {
  const body = await c.req.json<{ destination_id?: string; amount_cents?: number; note?: string }>().catch(() => ({}) as Record<string, never>);
  const identity = getCallerIdentity(c);
  return proxyWalletToBilling(c, "/billing/whop-wallet/payouts", "POST", {
    space_id: c.req.param("spaceId"),
    destination_id: body.destination_id,
    amount_cents: body.amount_cents,
    note: body.note,
    requested_by: identity.userId ?? "unknown",
  });
});

// Presence (space collaboration, A1.8) — heartbeat: "I'm here" (space-level, or scoped to a
// project/thread). Callers poll GET periodically to see who's currently active. Phase B
// (§A1.17): allowlisted for product_end_user callers on the router — the same membership floor
// as projects/threads above (every other role's access is unchanged).
app.use("/spaces/:spaceId/presence", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/presence", requireBusinessMembership({ GET: "member", POST: "member" }));
app.post("/spaces/:spaceId/presence", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  const userId = c.req.header("x-naelao-user-id") ?? getCallerIdentity(c).userId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing user" }, 401);
  const body = await c.req.json<{ project_id?: string; thread_id?: string }>().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/presence", "POST", JSON.stringify({ space_id: spaceId, user_id: userId, tenant_id: tenantId, ...body }));
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
// WS-2 (Space Assistant surface): GET is now reachable by a product_end_user viewing their own
// (or their business's) assistant's Crons panel — loadOwnedSpace is tenant-match-only (no
// per-caller floor), exactly the footgun the router's PRODUCT_END_USER_PATH_PATTERNS comment
// warns about, so this adds the same resolveEndUserBusinessRole floor every other end-user-
// reachable route in this file already has. POST/PATCH/DELETE stay un-allowlisted (never
// reachable by a product_end_user regardless of this check, per the router's allowlist).
app.get("/spaces/:spaceId/scheduled-jobs", async (c) => {
  const owned = await loadOwnedSpace(c, c.req.param("spaceId"));
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const callerIdentity = getCallerIdentity(c);
  if (callerIdentity.role === "product_end_user") {
    const role = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, c.req.param("spaceId"), callerIdentity.userId);
    if (!role) return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
  }
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
  // WS-2: the router allowlist for this path (GET+POST share one path with no jobId segment)
  // only proves a product_end_user's identity, never that write access is safe here — this
  // route creates cron jobs, so (unlike the GET list) a product_end_user must never reach it,
  // mirroring agent-definitions' "GET only for product_end_user" precedent.
  if (getCallerIdentity(c).role === "product_end_user") {
    return c.json({ error_code: "forbidden", message: "product_end_user callers may only read scheduled jobs" }, 403);
  }

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
// user has trusted this action." WS-2: GET is reachable by a product_end_user viewing their own
// Space Assistant's Status panel (which permissions the assistant currently has) — gated by the
// same resolveEndUserBusinessRole floor every other end-user-reachable route uses. PATCH used to
// be blocked outright for every product_end_user, on the theory that only a JWT builder could
// ever be "the owner" — but on a Launchpad business an end user with admin role on their OWN
// business genuinely IS its owner (§A1.18/item 79: an end-user-created business needs the SAME
// guided/autonomous toggle a dashboard-created one already has, or "does everything on the
// user's behalf in yolo mode" has no real control surface for the person who actually runs the
// business). requireBusinessMembership's admin floor is what makes this safe: a plain member
// still cannot change it, and a caller who isn't a member of THIS business at all is refused
// before reaching here — same precedent as local-grants/pricing's own admin-gated writes. A
// builder JWT caller (role !== "product_end_user") is untouched, exactly as before.
app.use("/spaces/:spaceId/assistant-policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/assistant-policy", requireBusinessMembership({ GET: "member", PATCH: "admin" }));
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

// PATCH /spaces/:spaceId/model-config — which model THIS business's assistant/agents run on.
// §A1.28 shipped the switcher only on /builder/products/:id (JWT-builder-only, via the
// dashboard) — a business an end user created and owns had no reachable way to change it, the
// same reachability gap assistant-policy had (see the comment above). Reuses the exact
// member-billing config_json-override pattern: read the space's OWN row (not the product root —
// each business space carries its own productConfig override), merge modelConfig.model in,
// write back. Same curated-allowlist validation as the builder route, so the two paths can never
// let a caller pick a model contextWindowForModel/tokensToCredits don't know how to price.
app.use("/spaces/:spaceId/model-config", requireBusinessMembership({ PATCH: "admin" }));
app.patch("/spaces/:spaceId/model-config", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);

  const body = await c.req.json<{ model?: string }>().catch(() => ({}) as { model?: string });
  if (!body.model || !isAllowedModel(body.model)) {
    return c.json({ error_code: "bad_request", message: `model must be one of ${ALLOWED_MODELS.join(", ")}` }, 400);
  }

  let config: { productConfig?: Partial<SpaceTypeProductConfig> } & Record<string, unknown> = {};
  if (owned.configJson) {
    try { config = JSON.parse(owned.configJson); } catch { /* start clean on malformed */ }
  }
  config.productConfig = { ...(config.productConfig ?? {}), modelConfig: { model: body.model } };
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(JSON.stringify(config), new Date().toISOString(), spaceId, owned.tenantId).run();

  return c.json({ model: body.model });
});

// ── Builder observability surface (security audit follow-up) ────────────────
// A builder had no consolidated view of what their agent has actually been doing — run
// history, cost, why it escalated. NaelaoAgentDO posts one row per run completion/failure and
// per approval request/resolution to POST /internal/spaces/:spaceId/agent-activity (internal
// only — see NaelaoAgentDO.logAgentActivity); GET /spaces/:spaceId/agent-activity is the
// builder-facing read, deliberately builder-only (not requireBusinessMembership like
// assistant-policy's GET) — this can surface other end users' escalation summaries, which is a
// builder's own internal audit view, not something to expose to an end user reading their own
// business.
app.use("/internal/spaces/:spaceId/agent-activity", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/agent-activity", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/agent-activity", "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.use("/spaces/:spaceId/agent-activity", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/agent-activity", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (getCallerIdentity(c).role === "product_end_user") {
    return c.json({ error_code: "forbidden", message: "This is a builder-only view" }, 403);
  }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/agent-activity${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Notifications inbox ──────────────────────────────────────────────────────
// Unlike agent-activity (builder-only technical audit trail), this IS end-user-facing — a
// business admin reading their own business's inbox — so the public route is
// requireBusinessMembership-gated, not builder-only. Internal-only CREATE (NaelaoAgentDO's
// createSpaceNotification) and the heartbeat sweep's undelivered-list/mark_delivered both go
// through /internal/spaces/:spaceId/notifications instead — same path as agent-activity's own
// internal/public split, chosen deliberately so this file gains no NEW dynamic-segment-then-
// static-suffix route shape (the documented Hono RegExpRouter corruption, items 40/52/60).
app.use("/internal/spaces/:spaceId/notifications", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/notifications", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/notifications", "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.get("/internal/spaces/:spaceId/notifications", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/notifications${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.use("/spaces/:spaceId/notifications", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/notifications", requireBusinessMembership({ GET: "member", POST: "member" }));
app.get("/spaces/:spaceId/notifications", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/notifications${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
// POST is restricted to the mark_read shape only — a caller reaching this without an internal
// HMAC token (every real business-member caller) can never fabricate a notification, only mark
// their own space's real ones read.
app.post("/spaces/:spaceId/notifications", async (c) => {
  const body = await c.req.json<{ action?: string; notification_id?: string }>().catch(() => ({}) as Record<string, never>);
  if (body.action !== "mark_read" || !body.notification_id) {
    return c.json({ error_code: "bad_request", message: "action must be 'mark_read' with a notification_id" }, 400);
  }
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/notifications", "POST", JSON.stringify(body));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── §A1 Harness Excellence Phase HX2: signals + session token-budget guard ──────
// Explicit signals (agent-signals) and implicit signals (signal-events) are both builder-only
// reads, same rationale/precedent as agent-activity just above (a cross-user audit/observability
// view, not something to expose to one end user reading their own business). session-spend stays
// entirely internal this pass — NaelaoAgentDO is the only reader/writer (the pre-run gate check
// and the post-run tally increment); a builder/end-user-facing budget meter UI is a real,
// deliberately deferred follow-up, not silently dropped.
app.use("/spaces/:spaceId/agent-signals", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/agent-signals", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (getCallerIdentity(c).role === "product_end_user") {
    return c.json({ error_code: "forbidden", message: "This is a builder-only view" }, 403);
  }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/agent-signals${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /spaces/:spaceId/agent-diagnostics — the whole-business summary an assistant reads on a
// wake-up (see SpaceDO.computeAgentDiagnostics). Gated exactly like agent-activity above: the
// internal-HMAC gate authenticates the calling worker, and a product_end_user caller is refused
// because this spans every thread in the business, including other people's. The Space Assistant
// reaches it through the business-diagnostics prebuilt, whose spacesCall sets no role header —
// same path agent-activity's own writer already uses.
app.use("/spaces/:spaceId/agent-diagnostics", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/agent-diagnostics", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (getCallerIdentity(c).role === "product_end_user") {
    return c.json({ error_code: "forbidden", message: "This is a builder-only view" }, 403);
  }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/agent-diagnostics${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.use("/internal/spaces/:spaceId/signal-events", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/signal-events", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/signal-events", "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.use("/spaces/:spaceId/signal-events", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/spaces/:spaceId/signal-events", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (getCallerIdentity(c).role === "product_end_user") {
    return c.json({ error_code: "forbidden", message: "This is a builder-only view" }, 403);
  }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/signal-events${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// A single dynamic-segment shape (`:spaceId/session-spend/:sessionId`, GET+POST, never a
// further static suffix) — deliberately NOT one route per action (increment/continue/
// mark-warned as separate `/:sessionId/continue` etc. paths). The documented Hono RegExpRouter
// route-table-scale bug (record-install's own comment, item 52's own reproduction) is triggered
// by exactly that shape: a dynamic-segment-then-static-suffix route coexisting with a same-
// method static sibling one segment shallower. POST's `action` field carries the operation
// instead, matching the established remedy every prior instance of this bug converged on.
app.use("/internal/spaces/:spaceId/session-spend/:sessionId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/session-spend/:sessionId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/session-spend/${sessionId}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.post("/internal/spaces/:spaceId/session-spend/:sessionId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const body = await c.req.json<{ action: "increment" | "continue" | "mark_warned"; credits?: number; space_id?: string; project_id?: string | null }>().catch(() => null);
  if (!body?.action) return c.json({ error_code: "bad_request", message: "action is required" }, 400);
  const doPath =
    body.action === "continue" ? `/session-spend/${sessionId}/continue`
    : body.action === "mark_warned" ? `/session-spend/${sessionId}/mark-warned`
    : "/session-spend";
  const doBody = body.action === "increment"
    ? JSON.stringify({ session_id: sessionId, space_id: body.space_id ?? spaceId, project_id: body.project_id ?? null, credits: body.credits ?? 0 })
    : undefined;
  const res = await forwardToSpaceDO(stub, doPath, "POST", doBody);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Agent API keys (§A1.17 Phase O) ──────────────────────────────────────────
// "The same API a human can use, but attributed to the agent itself." Builder-only (owner/admin,
// tenant-match via x-naelao-tenant-id — same authorization depth as member-billing/scheduled-jobs
// above): minting a key for an agent is a builder action, never something the agent or an end
// user can do to itself.
app.post("/spaces/:spaceId/agents/:agentId/api-keys", async (c) => {
  const spaceId = c.req.param("spaceId");
  const agentId = c.req.param("agentId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/agents/${encodeURIComponent(agentId)}/api-keys`, "POST");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/agents/:agentId/api-keys", async (c) => {
  const spaceId = c.req.param("spaceId");
  const agentId = c.req.param("agentId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/agents/${encodeURIComponent(agentId)}/api-keys`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/agents/:agentId/api-keys/:keyId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const agentId = c.req.param("agentId");
  const keyId = c.req.param("keyId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/agents/${encodeURIComponent(agentId)}/api-keys/${encodeURIComponent(keyId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET/PATCH — an agent's own approval-policy override. Same shape/authorization as
// assistant-policy above; falls back to the space-wide row when no override exists (SpaceDO's
// resolveAgentPolicy). Previously builder-JWT-only (tenant-match via getCallerIdentity, no
// requireBusinessMembership floor at all) — a business admin who owns their own Launchpad
// business had no reachable way to configure a project agent's own approvals, same gap
// assistant-policy itself had before item 79 relaxed it. Same fix, same precedent.
app.use("/spaces/:spaceId/agents/:agentId/policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/agents/:agentId/policy", requireBusinessMembership({ GET: "member", PATCH: "admin" }));
app.get("/spaces/:spaceId/agents/:agentId/policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const agentId = c.req.param("agentId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/agents/${encodeURIComponent(agentId)}/policy?space_id=${encodeURIComponent(spaceId)}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.patch("/spaces/:spaceId/agents/:agentId/policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const agentId = c.req.param("agentId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/agents/${encodeURIComponent(agentId)}/policy?space_id=${encodeURIComponent(spaceId)}`, "PATCH", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST /internal/agent-keys/verify — naelao-router calls this to resolve a Bearer nak_...
// agent key into the owning tenant + agentId + effective approval policy BEFORE it can mint the
// router's own claims for that request. Gated by a direct platform-secret check (same
// chicken-and-egg precedent as /internal/product-sessions/verify above), not requireInternalHmac.
app.post("/internal/agent-keys/verify", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const body = await c.req.json<{ spaceId: string; key: string }>().catch(() => ({}) as Record<string, never>);
  if (!body.spaceId || !body.key) return c.json({ valid: false }, 400);

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(body.spaceId).first<{ tenant_id: string }>();
  if (!space) return c.json({ valid: false });

  const stub = await spaceDoStub(c.env, body.spaceId, space.tenant_id);
  const res = await forwardToSpaceDO(
    stub,
    "/internal/agent-keys/verify",
    "POST",
    JSON.stringify({ space_id: body.spaceId, key: body.key })
  );
  const verified = await res.json<{ valid: boolean; agent_id?: string; approval_mode?: string; auto_approved_actions?: string[] }>();
  if (!verified.valid) return c.json({ valid: false });
  return c.json({ ...verified, tenant_id: space.tenant_id });
});

// Threads (spec-canonical). A sub-agent spawn or a channel session mirrors in here as a
// subthread (thread_kind + parent_thread_id) — hidden from the default list unless the
// project's show_sub_threads is on, or the caller passes include_sub_threads=true.
// A1.16.10 (layer-3 backstop, bucket A) gated this builder-only (widget/portal never called it —
// end-user chat transport was /sessions, not /threads). Phase B (§A1.17) changes that: the
// Product Shell's Projects/Threads views need to list/create/read threads directly (distinct
// from the chat transport) — requireBusinessMembership adds the product_end_user floor here the
// same way as the projects routes above; every other role's access is unchanged.
app.use("/spaces/:spaceId/threads", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/threads", requireBusinessMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/threads/:threadId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/threads/:threadId", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/threads", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  const includeSubThreads = c.req.query("include_sub_threads");
  if (includeSubThreads) qs.set("include_sub_threads", includeSubThreads);
  const parentThreadId = c.req.query("parent_thread_id");
  if (parentThreadId) qs.set("parent_thread_id", parentThreadId);
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

// GET /internal/builder-fee-bps?space_id=X — ARCH-REVENUE-6: resolve the builder's configured
// revenue-share (basis points) for a SELLING space, so the billing worker can stamp it into the
// checkout metadata at checkout time (never resolved at webhook time — a config change must not
// retroactively re-price an in-flight order). The fee is configured on the BUILDER's reseller
// product (productConfig.commerce.builderFeeBps), so this walks the space's parent_space_id to
// that product's effective config. Returns 0 for a top-level space (no parent) — a builder selling
// directly has no separate builder to pay.
app.use("/internal/builder-fee-bps", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/builder-fee-bps", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  if (!spaceId) return c.json({ error_code: "bad_request", message: "space_id is required" }, 400);
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ parent_space_id: string | null }>();
  if (!space?.parent_space_id) return c.json({ builder_fee_bps: 0 });
  const parent = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(space.parent_space_id).first<{ spacetype_id: string; config_json: string | null }>();
  if (!parent) return c.json({ builder_fee_bps: 0 });
  const pc = await loadEffectiveProductConfig(c.env, parent.spacetype_id, parent.config_json);
  const bps = pc?.commerce?.builderFeeBps ?? 0;
  return c.json({ builder_fee_bps: Number.isFinite(bps) && bps > 0 ? Math.floor(bps) : 0 });
});

// Phase N (§A1.17): a business owner (product_end_user) operating their OWN Launchpad business
// can view/manage its commerce data through the manifest-driven operator-shell view — any active
// member may view (GET), mutating the catalog needs admin+ (the requireBusinessMembership
// default for unlisted methods). Every other caller (builder JWT) is unaffected.
// requireInternalHmac backstop ("did this come through the router") + the requireBusinessMembership
// floor — both are required per business-auth.ts's design; loadCommerceContext's tenant-ownership
// check trusts x-naelao-tenant-id, which is only trustworthy once the HMAC gate verifies the router
// set it from verified claims.
app.use("/spaces/:spaceId/products", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/products", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/products/:id", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/products/:id", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/orders", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/orders", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/revenue", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/revenue", requireBusinessMembership({ GET: "member" }));

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
    // AgentMail (auto-provisioned inbound-capable mailbox): when the agents worker has actually
    // created a real AgentMail inbox, it passes the allocated address as `handle` (used verbatim
    // instead of the slug-derived placeholder) and the inbox id to persist in config_json so
    // send/status can resolve it later. Absent = the legacy slug-derived placeholder behavior.
    handle?: string;
    agentmail_inbox_id?: string;
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
  // A real AgentMail-allocated address (body.handle) wins over the slug-derived placeholder — the
  // placeholder was never inbound-capable, the AgentMail one is.
  const handle = body.handle
    ? body.handle
    : body.kind === "storefront"
      ? `${slug}-${suffix}.${STOREFRONT_ROOT}`
      : `hi@${slug}-${suffix}.${EMAIL_ROOT}`;
  // Store the AgentMail inbox id in config_json (no schema change — the column already exists),
  // matching this codebase's "config_json override, not a new column/table" convention.
  const configJson = body.agentmail_inbox_id ? JSON.stringify({ agentmail_inbox_id: body.agentmail_inbox_id }) : "{}";

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO business_services (id, space_id, tenant_id, kind, naelao_handle, config_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(space_id, kind) DO UPDATE SET naelao_handle = excluded.naelao_handle, config_json = excluded.config_json, status = 'active', updated_at = excluded.updated_at`
  ).bind(id, body.space_id, tenantId, body.kind, handle, configJson, now, now).run();

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

// ── Phase E (§A1.17) — subscription plans + credit packs ────────────────────────────────────
// A business subscribes to a plan the BUILDER defined on the product root (productConfig.
// pricingConfig.plans/creditPacks) — the catalog is authored once on the product, not per
// business. A business (child space, parent_space_id set) never carries its own catalog, so
// resolving "what can this business buy" always walks up to the product root first, mirroring
// /internal/product-sessions/verify's parent-walk (same one-hop-max invariant, spec §49).

type PlanDef = NonNullable<NonNullable<SpaceTypeProductConfig["pricingConfig"]>["plans"]>[number];
type CreditPackDef = NonNullable<NonNullable<SpaceTypeProductConfig["pricingConfig"]>["creditPacks"]>[number];
type WalletTopupDef = NonNullable<NonNullable<SpaceTypeProductConfig["pricingConfig"]>["walletTopups"]>[number];
type ExternalRevenueCutDef = NonNullable<SpaceTypeProductConfig["pricingConfig"]>["externalRevenueCut"];

/** Resolve the effective plan/credit-pack/wallet-topup catalog for `spaceId` — walks to the
 *  product root if `spaceId` is a business (has a parent_space_id), since the catalog is
 *  authored on the root. */
async function loadPricingCatalog(
  env: Env,
  spaceId: string
): Promise<{ productSpaceId: string; productTenantId: string; plans: PlanDef[]; creditPacks: CreditPackDef[]; walletTopups: WalletTopupDef[]; externalRevenueCut: ExternalRevenueCutDef } | null> {
  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ tenant_id: string; spacetype_id: string; config_json: string | null; parent_space_id: string | null }>();
  if (!space) return null;

  let productSpaceId = spaceId;
  let productTenantId = space.tenant_id;
  let productSpacetypeId = space.spacetype_id;
  let productConfigJson = space.config_json;
  if (space.parent_space_id) {
    const root = await env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(space.parent_space_id).first<{ id: string; tenant_id: string; spacetype_id: string; config_json: string | null }>();
    if (!root) return null;
    productSpaceId = root.id;
    productTenantId = root.tenant_id;
    productSpacetypeId = root.spacetype_id;
    productConfigJson = root.config_json;
  }

  const pc = await loadEffectiveProductConfig(env, productSpacetypeId, productConfigJson);
  return {
    productSpaceId,
    productTenantId,
    plans: pc?.pricingConfig?.plans ?? [],
    creditPacks: pc?.pricingConfig?.creditPacks ?? [],
    walletTopups: pc?.pricingConfig?.walletTopups ?? [],
    externalRevenueCut: pc?.pricingConfig?.externalRevenueCut,
  };
}

// GET /spaces/:spaceId/pricing — the plans + credit packs a business's end users can buy. Safe
// to show any member (same "purchasers should see prices" precedent as a storefront) — never
// leaks lsVariantId internals beyond what's needed to reference the item at checkout.
app.use("/spaces/:spaceId/pricing", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/pricing", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/pricing", async (c) => {
  const catalog = await loadPricingCatalog(c.env, c.req.param("spaceId"));
  if (!catalog) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  return c.json({
    plans: catalog.plans.map((p) => ({ id: p.id, name: p.name, price_cents: p.priceCents, interval: p.interval, credit_allowance: p.creditAllowance ?? null })),
    credit_packs: catalog.creditPacks.map((p) => ({ id: p.id, name: p.name, credits: p.credits, price_cents: p.priceCents })),
    wallet_topups: catalog.walletTopups.map((p) => ({ id: p.id, name: p.name, price_cents: p.priceCents })),
  });
});

// POST /spaces/:spaceId/business-subscription/checkout — an end user (member+) starts a
// checkout for their business to subscribe to one of the product's plans. Proxies to the billing
// worker (only it holds Lemon Squeezy credentials) rather than duplicating checkout-construction
// logic here.
app.use("/spaces/:spaceId/business-subscription/checkout", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/business-subscription/checkout", requireBusinessMembership({ POST: "member" }));
app.post("/spaces/:spaceId/business-subscription/checkout", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId } = getCallerIdentity(c);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "unavailable", message: "Billing is not available" }, 503);
  const body = await c.req.json<{ plan_id: string; customer_email?: string }>();
  if (!body.plan_id) return c.json({ error_code: "bad_request", message: "plan_id is required" }, 400);

  const resp = await c.env.BILLING_WORKER.fetch(
    new Request("http://billing-worker/internal/business-subscriptions/checkout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({ business_space_id: spaceId, plan_id: body.plan_id, ...(body.customer_email ? { customer_email: body.customer_email } : {}) }),
    })
  );
  return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
});

// POST /spaces/:spaceId/credit-packs/checkout — an end user buys a one-time credit pack for
// their OWN balance (not the business's). end_user_id is derived from the caller's OWN verified
// identity, never a client-supplied field.
app.use("/spaces/:spaceId/credit-packs/checkout", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/credit-packs/checkout", requireBusinessMembership({ POST: "member" }));
app.post("/spaces/:spaceId/credit-packs/checkout", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId, userId } = getCallerIdentity(c);
  if (!userId) return c.json({ error_code: "unauthorized", message: "Missing end user identity" }, 401);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "unavailable", message: "Billing is not available" }, 503);
  const body = await c.req.json<{ pack_id: string; customer_email?: string }>();
  if (!body.pack_id) return c.json({ error_code: "bad_request", message: "pack_id is required" }, 400);

  const resp = await c.env.BILLING_WORKER.fetch(
    new Request("http://billing-worker/internal/credit-packs/checkout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": tenantId,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId),
      },
      body: JSON.stringify({
        business_space_id: spaceId,
        pack_id: body.pack_id,
        end_user_id: userId,
        ...(body.customer_email ? { customer_email: body.customer_email } : {}),
      }),
    })
  );
  return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
});

// GET /internal/pricing-catalog?space_id= — the billing worker's checkout routes resolve a
// plan/pack's lsVariantId here (requireInternalHmac, not a builder/end-user-facing shape).
app.use("/internal/pricing-catalog", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/pricing-catalog", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  const catalog = await loadPricingCatalog(c.env, spaceId);
  if (!catalog) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  return c.json({
    product_space_id: catalog.productSpaceId,
    product_tenant_id: catalog.productTenantId,
    plans: catalog.plans,
    credit_packs: catalog.creditPacks,
    wallet_topups: catalog.walletTopups,
    external_revenue_cut: catalog.externalRevenueCut ?? null,
  });
});

// Tier 2 metering follow-up: business_subscriptions (Phase E) was write-only — the Lemon Squeezy
// webhook upserted a row on every subscription_created/updated/cancelled event, but nothing ever
// READ it to actually gate access. A business on a pricingConfig.model === "subscription" product
// could run its agent indefinitely for free, subscribed or not, exactly the "ToS-only enforcement"
// gap checkRevenueReportingLapsed (NaelaoAgentDO) already closed for the revenue-cut case. This is
// the same shape of gate for the subscription case.
interface BusinessSubscriptionGateResult {
  gated: boolean;
  active: boolean;
  reason: "not_a_business" | "not_subscription_model" | "in_trial" | "no_subscription" | "subscription_" | string;
}

async function resolveBusinessSubscriptionGate(env: Env, spaceId: string): Promise<BusinessSubscriptionGateResult> {
  const space = await env.PLATFORM_DB.prepare(
    "SELECT parent_space_id, created_at FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ parent_space_id: string | null; created_at: string }>();
  // Only a BUSINESS (a sub-space of a product) subscribes — the product root itself is the
  // builder's own space, never gated on its own pricing catalog.
  if (!space || !space.parent_space_id) return { gated: false, active: true, reason: "not_a_business" };

  const catalog = await loadPricingCatalog(env, spaceId);
  if (!catalog) return { gated: false, active: true, reason: "not_a_business" };
  const root = await env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(catalog.productSpaceId).first<{ spacetype_id: string; config_json: string | null }>();
  const pc = root ? await loadEffectiveProductConfig(env, root.spacetype_id, root.config_json) : null;
  if (pc?.pricingConfig?.model !== "subscription") return { gated: false, active: true, reason: "not_subscription_model" };

  // Respect a configured trial window — a business just created hasn't had a chance to subscribe.
  const trialDays = pc.pricingConfig.trialDays ?? 0;
  if (trialDays > 0) {
    const ageMs = Date.now() - new Date(space.created_at).getTime();
    if (ageMs < trialDays * 86_400_000) return { gated: true, active: true, reason: "in_trial" };
  }

  const sub = await env.PLATFORM_DB.prepare(
    "SELECT status FROM business_subscriptions WHERE business_space_id = ?"
  ).bind(spaceId).first<{ status: string }>();
  if (!sub) return { gated: true, active: false, reason: "no_subscription" };
  // 'past_due' gets a grace period (payment failed but Lemon Squeezy is still retrying/dunning) —
  // only a definitively non-paying status (paused/cancelled/expired) blocks the run.
  const active = sub.status === "active" || sub.status === "past_due";
  return { gated: true, active, reason: active ? "" : `subscription_${sub.status}` };
}

// GET /internal/business-subscription-status?space_id= — NaelaoAgentDO's pre-run gate for
// subscription-model products (mirrors /internal/pricing-catalog's auth/shape conventions).
app.use("/internal/business-subscription-status", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/business-subscription-status", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  if (!spaceId) return c.json({ error_code: "bad_request", message: "space_id is required" }, 400);
  const result = await resolveBusinessSubscriptionGate(c.env, spaceId);
  return c.json(result);
});

// POST /internal/credit-packs/grant — the billing worker's webhook handler calls this after a
// credit-pack payment.success to credit the buyer's OWN ProductUserDO (never the business's
// balance — credit packs are a per-end-user purchase, spec-distinct from business subscriptions
// above). idempotency_key is REQUIRED here (unlike ProductUserDO's own optional param) since every
// caller of this route is, by construction, a webhook that Lemon Squeezy may redeliver.
app.use("/internal/credit-packs/grant", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/credit-packs/grant", async (c) => {
  const body = await c.req.json<{ product_space_id: string; end_user_id: string; credits: number; idempotency_key: string }>();
  if (!body.product_space_id || !body.end_user_id || !body.credits || !body.idempotency_key) {
    return c.json({ error_code: "bad_request", message: "product_space_id, end_user_id, credits, and idempotency_key are required" }, 400);
  }
  const product = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(body.product_space_id).first<{ tenant_id: string }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const stub = await productUserDoStub(c.env, body.product_space_id, body.end_user_id, product.tenant_id);
  const grantRes = await stub.fetch(new Request("http://do/credits/grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credits: body.credits, reason: "credit_pack_purchase", idempotency_key: body.idempotency_key }),
  }));
  const result = await grantRes.json<{ balance_credits: number; deduplicated?: boolean }>();
  return c.json(result, grantRes.status as 200 | 201);
});

// POST /internal/credit-packs/clawback — F-29: the billing worker calls this when a credit-pack
// purchase is refunded, to reverse the grant on the buyer's ProductUserDO (allows the balance to
// go negative if they already spent it — they were refunded the money). idempotency_key REQUIRED.
app.use("/internal/credit-packs/clawback", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/credit-packs/clawback", async (c) => {
  const body = await c.req.json<{ product_space_id: string; end_user_id: string; credits: number; idempotency_key: string }>();
  if (!body.product_space_id || !body.end_user_id || !body.credits || !body.idempotency_key) {
    return c.json({ error_code: "bad_request", message: "product_space_id, end_user_id, credits, and idempotency_key are required" }, 400);
  }
  const product = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(body.product_space_id).first<{ tenant_id: string }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const stub = await productUserDoStub(c.env, body.product_space_id, body.end_user_id, product.tenant_id);
  const res = await stub.fetch(new Request("http://do/credits/clawback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credits: body.credits, reason: "credit_pack_refund", idempotency_key: body.idempotency_key }),
  }));
  const result = await res.json<{ balance_credits: number; deduplicated?: boolean }>();
  return c.json(result, res.status as 200 | 201);
});

// POST /internal/wallet-topups/grant — the billing worker's webhook handler calls this after a
// wallet-topup payment.success to credit the BUSINESS's own wallet_ledger (a project flagged
// kind='wallet' under that business space) — never an individual end user's balance, unlike
// credit-packs/grant above. idempotency_key is REQUIRED (every caller is, by construction, a
// webhook LS may redeliver).
app.use("/internal/wallet-topups/grant", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/wallet-topups/grant", async (c) => {
  const body = await c.req.json<{ business_space_id: string; project_id: string; cents: number; idempotency_key: string }>();
  if (!body.business_space_id || !body.project_id || !body.cents || !body.idempotency_key) {
    return c.json({ error_code: "bad_request", message: "business_space_id, project_id, cents, and idempotency_key are required" }, 400);
  }
  const space = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(body.business_space_id).first<{ tenant_id: string }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const stub = await spaceDoStub(c.env, body.business_space_id, space.tenant_id);
  const res = await forwardToSpaceDO(
    stub,
    `/projects/${encodeURIComponent(body.project_id)}/wallet/credit?tenant_id=${encodeURIComponent(space.tenant_id)}`,
    "POST",
    JSON.stringify({ cents: body.cents, reason: "wallet_topup", idempotency_key: body.idempotency_key })
  );
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// GET /internal/product-users/:spaceId/:endUserId/credits/balance — metering-enforcement pass:
// the agents worker calls this BEFORE running the reasoning loop for a non-project (Space
// Assistant) run by a signed-in product end user, so a zero/negative balance refuses the run
// instead of the LLM cost already being paid and only THEN discovering the debit 402s (the
// prior state — /credits/deduct itself was always correct, but it only ran post-hoc).
app.use("/internal/product-users/:spaceId/:endUserId/credits/balance", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/product-users/:spaceId/:endUserId/credits/balance", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.param("endUserId");
  const product = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(spaceId).first<{ tenant_id: string }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const stub = await productUserDoStub(c.env, spaceId, endUserId, product.tenant_id);
  const balRes = await stub.fetch(new Request("http://do/credits/balance"));
  const result = await balRes.json<{ balance_credits: number }>();
  return c.json(result);
});

// POST /internal/product-users/:spaceId/:endUserId/credits/deduct — §A1.17 Phase I. The agents
// worker calls this after a script/reasoning-loop run that consumed real LLM tokens, so a signed-
// in product end user's OWN credit balance (not the business's) is what pays for their own chat
// usage. tokensToCredits() is the single conversion (packages/billing-core) — the caller has
// already converted; this route only debits. Fails closed on insufficient balance (402), matching
// ProductUserDO's own posture.
app.use("/internal/product-users/:spaceId/:endUserId/credits/deduct", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/product-users/:spaceId/:endUserId/credits/deduct", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.param("endUserId");
  const body = await c.req.json<{ credits: number; reason?: string; model?: string }>();
  if (!Number.isFinite(body.credits) || body.credits <= 0) {
    return c.json({ error_code: "bad_request", message: "credits must be a positive number" }, 400);
  }
  const product = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(spaceId).first<{ tenant_id: string }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const stub = await productUserDoStub(c.env, spaceId, endUserId, product.tenant_id);
  const deductRes = await stub.fetch(new Request("http://do/credits/deduct", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credits: body.credits, reason: body.reason ?? "agent_run", ...(body.model ? { model: body.model } : {}) }),
  }));
  const result = await deductRes.json<{ balance_credits: number; error?: string }>();
  return c.json(result, deductRes.status as 201 | 402 | 400);
});

// POST /internal/product-users/:spaceId/:endUserId/credits/refresh-monthly — Tier 2 metering
// follow-up: creditsIncludedPerMonth was builder-configurable but only ever granted ONCE, at
// signup, despite the field name implying a recurring monthly allowance. Deliberately NOT a new
// platform-wide cron/sweep (a per-END-USER rather than per-space roster would be a much larger
// enumeration surface than agents' enqueueAgentTicks rosters, at a platform aiming for millions
// of end users) — instead lazy, piggybacking on a request that's already happening: NaelaoAgentDO
// calls this right before every Space-Assistant-scope run by a signed-in end user, so the FIRST
// run of a new calendar month grants the allowance then. Idempotent via a month-scoped key
// (credit_ledger's existing idempotency_key uniqueness does the dedup) — concurrent requests on
// day 1 of the month grant exactly once. Resolves the SAME free-tier default as signup
// (FREE_TIER_DEFAULT_SIGNUP_CREDITS) so a free/unconfigured product keeps refreshing 100/month
// rather than lapsing to 0 after the first grant.
app.use("/internal/product-users/:spaceId/:endUserId/credits/refresh-monthly", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/product-users/:spaceId/:endUserId/credits/refresh-monthly", async (c) => {
  const spaceId = c.req.param("spaceId");
  const endUserId = c.req.param("endUserId");
  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ tenant_id: string; spacetype_id: string; config_json: string | null }>();
  if (!product) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const pc = await loadEffectiveProductConfig(c.env, product.spacetype_id, product.config_json);
  const pricingConfig = pc?.pricingConfig;
  const isFreeOrUnconfigured = !pricingConfig || pricingConfig.model === "free";
  const monthlyCredits = pricingConfig?.creditsIncludedPerMonth
    ?? (isFreeOrUnconfigured ? FREE_TIER_DEFAULT_SIGNUP_CREDITS : 0);
  if (monthlyCredits <= 0) return c.json({ granted: false, reason: "no_monthly_allowance" });

  const monthKey = new Date().toISOString().slice(0, 7); // "2026-07" — one grant per calendar month
  const stub = await productUserDoStub(c.env, spaceId, endUserId, product.tenant_id);
  const grantRes = await stub.fetch(new Request("http://do/credits/grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credits: monthlyCredits, reason: "monthly_refresh", idempotency_key: `monthly-refresh:${monthKey}` }),
  }));
  const result = await grantRes.json<{ balance_credits: number; deduplicated?: boolean }>();
  return c.json({ granted: !result.deduplicated, balance_credits: result.balance_credits });
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
//
// Phase B parent-walk (§A1.17): a reseller-mode end user's OWN business (Phase C) is a real
// child-tenant space with `parent_space_id` set to the product root (spec §49 Scenario C,
// depth ≤ 2 — never more than one hop). Its ProductUserDO does NOT live under the business's own
// id — end users are a PRODUCT-scoped concept (one ProductUserDO per productId×endUserId), not a
// per-business one, so the session lives under the product root regardless of which business the
// URL is for. When `body.productId` (the URL space the caller is actually hitting) has a
// `parent_space_id`, walk to that root FIRST to find the right ProductUserDO, but return the URL
// SPACE's own tenant_id (not the root's) — the router uses this as `claims.tid` for
// requireInternalHmac against the space actually being accessed. No child business spaces exist
// yet (that's Phase C), so this is a no-op for every caller today; it exists so Phase C doesn't
// have to re-open this endpoint's security model under time pressure later.
app.post("/internal/product-sessions/verify", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const body = await c.req.json<{ productId: string; endUserId: string; sessionToken: string }>();
  if (!body.productId || !body.endUserId || !body.sessionToken) {
    return c.json({ valid: false }, 400);
  }

  const urlSpace = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(body.productId).first<{ tenant_id: string; parent_space_id: string | null }>();
  if (!urlSpace) return c.json({ valid: false });

  let productRootId = body.productId;
  let productRootTenantId = urlSpace.tenant_id;
  if (urlSpace.parent_space_id) {
    const root = await c.env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(urlSpace.parent_space_id).first<{ id: string; tenant_id: string }>();
    if (!root) return c.json({ valid: false });
    productRootId = root.id;
    productRootTenantId = root.tenant_id;
  }

  const stub = await productUserDoStub(c.env, productRootId, body.endUserId, productRootTenantId);
  const verifyRes = await stub.fetch(new Request("http://do/sessions/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_token: body.sessionToken }),
  }));
  const verified = await verifyRes.json<{ valid: boolean }>();
  if (!verified.valid) return c.json({ valid: false });

  return c.json({ valid: true, tenant_id: urlSpace.tenant_id, end_user_id: body.endUserId });
});

// POST /internal/stream-tickets/issue — mint a short-lived (60s), single-use stream ticket
// so an EventSource client can authenticate the SSE stream without putting the long-lived
// nps_ session token in the URL (where it lands in CF logs, proxy logs, and browser history).
// Called by apps/shell after it has the session token (via Bearer header POST), exchanged for
// a stream_ticket that it then passes as ?stream_ticket= on the SSE GET request.
// POST /internal/stream-tickets/consume — verify and single-use-burn a stream ticket; called
// by the router's SSE auth path instead of verifying the raw session token.
// Tickets are stored in KV (NAELAO_CONFIG_KV) with a 60s TTL so they self-expire and cannot
// be replayed even if the consumer crashes before consuming.
app.post("/internal/stream-tickets/issue", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const { productId, endUserId, sessionToken } = await c.req.json<{ productId: string; endUserId: string; sessionToken: string }>();
  if (!productId || !endUserId || !sessionToken) return c.json({ error: "bad_request" }, 400);
  // Verify the session inline — this IS the spaces worker, so there is no separate worker to call
  // out to (a prior version referenced a non-existent SPACES_WORKER self-binding). Same logic as
  // /internal/product-sessions/verify above: resolve the product's root space (walking a
  // parent_space_id for child business spaces), verify the token against that ProductUserDO.
  let tenantId: string | undefined;
  {
    const urlSpace = await c.env.PLATFORM_DB.prepare(
      "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
    ).bind(productId).first<{ tenant_id: string; parent_space_id: string | null }>();
    if (!urlSpace) return c.json({ error: "invalid_session" }, 401);
    let rootId = productId;
    let rootTenantId = urlSpace.tenant_id;
    if (urlSpace.parent_space_id) {
      const root = await c.env.PLATFORM_DB.prepare(
        "SELECT id, tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
      ).bind(urlSpace.parent_space_id).first<{ id: string; tenant_id: string }>();
      if (!root) return c.json({ error: "invalid_session" }, 401);
      rootId = root.id; rootTenantId = root.tenant_id;
    }
    const stub = await productUserDoStub(c.env, rootId, endUserId, rootTenantId);
    const sv = await stub.fetch(new Request("http://do/sessions/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_token: sessionToken }),
    }));
    const verified = await sv.json<{ valid: boolean }>();
    if (!verified.valid) return c.json({ error: "invalid_session" }, 401);
    tenantId = urlSpace.tenant_id;
  }
  const ticket = crypto.randomUUID();
  const key = `stream-ticket:${productId}:${endUserId}:${ticket}`;
  await c.env.NAELAO_CONFIG_KV.put(key, tenantId ?? "", { expirationTtl: 60 });
  return c.json({ ticket, expires_in: 60 });
});

app.post("/internal/stream-tickets/consume", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const { productId, endUserId, ticket } = await c.req.json<{ productId: string; endUserId: string; ticket: string }>();
  if (!productId || !endUserId || !ticket) return c.json({ valid: false }, 400);
  const key = `stream-ticket:${productId}:${endUserId}:${ticket}`;
  const tenantId = await c.env.NAELAO_CONFIG_KV.get(key);
  if (tenantId === null) return c.json({ valid: false }); // expired or already consumed
  // Single-use: delete immediately after reading.
  await c.env.NAELAO_CONFIG_KV.delete(key);
  // Resolve true tenant for this space (may be parent if spaceId is a business).
  const urlSpace = await c.env.PLATFORM_DB.prepare(
    "SELECT tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(productId).first<{ tenant_id: string }>();
  return c.json({ valid: true, tenant_id: urlSpace?.tenant_id ?? tenantId });
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

// loadTemplateCatalog (Phase F's single source of truth for template data in this worker — a
// KV-cached call to the agents worker's real GET /templates, never a hand-maintained copy) moved
// to template-catalog.ts so business-create.ts / create-space.ts can reuse it for the G-BF08
// free-tier eligibility gate without importing index.ts. The projection now also carries
// free_tier_eligible, which flows through shell/manifest's template_catalog untouched.

/**
 * §A1.17 Phase L: load the Container Marketplace catalogue from the agents worker's real
 * GET /container-images, KV-cached 1h like loadTemplateCatalog above — this worker never
 * hand-maintains its own copy of image availability/billing-tier data.
 */
async function loadContainerCatalogue(env: Env): Promise<Array<{ id: string; name: string; available: boolean; billing_tier: string }>> {
  const cacheKey = "container-image-catalogue";
  const cached = await env.NAELAO_CONFIG_KV.get(cacheKey, "json") as Array<{ id: string; name: string; available: boolean; billing_tier: string }> | null;
  if (cached) return cached;
  if (!env.AGENTS_WORKER) return [];
  const resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/container-images"));
  if (!resp.ok) return [];
  const body = await resp.json<{ images: Array<{ id: string; name: string; available: boolean; billing_tier: string }> }>();
  await env.NAELAO_CONFIG_KV.put(cacheKey, JSON.stringify(body.images), { expirationTtl: 3600 });
  return body.images;
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

// ── Three-Tier Platform Model, Phase A (apps/shell): public slug→space lookup ───────────────
// GET /products/by-slug/:slug — the shell resolves a product by its subdomain-style slug
// (product_slug, unique) before an end user has any credential at all: the login/signup page
// needs the product's name/branding/auth_provider to render before a session exists. Same
// "fully public-safe projection" precedent as shell/manifest below — deliberately returns only
// what a pre-login visitor needs, nothing from productConfig that would leak builder-internal
// config (pricing, commerce, adminFeatures, etc).
app.get("/products/by-slug/:slug", async (c) => {
  const slug = c.req.param("slug");
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, spacetype_id, config_json FROM spaces WHERE product_slug = ? AND status = 'active'"
  ).bind(slug).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);
  return c.json({
    space_id: space.id,
    product_name: space.name,
    brand_color: pc?.branding?.brandColor ?? null,
    logo_url: pc?.branding?.logoUrl ?? null,
    auth_provider: pc?.authProvider?.provider ?? "naelao-native",
  });
});

// GET /spaces/:productSpaceId/template-activity — Discover's "what other businesses are doing"
// showcase (CLAUDE.md appendix BF.4's Business Network, scoped down: no opt-in feed, no
// skill-sharing, no buying or selling — just an honest signal that a template is a real, chosen
// thing, not a stat this pass invented). The QUERY itself is deliberately cross-tenant (other
// tenants' activity is the whole point) and deliberately an AGGREGATE COUNT ONLY: no business
// name, no owner, no revenue, no PII of any kind crosses the tenant boundary, matching this
// codebase's own standing rule that a business-network-style feature never leaks individual
// figures regardless of plan. `:productSpaceId` in the path carries no filtering weight in the
// SQL below — it exists only so a product_end_user's nps_ session (which is verified per-product,
// via naelao-router's PRODUCT_END_USER_PATH_PATTERNS) has a product to verify against, the same
// reason /spaces/:productSpaceId/my-businesses is namespaced the same way for an account-wide
// list.
app.get("/spaces/:productSpaceId/template-activity", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT json_extract(config_json, '$.template_id') AS template_id,
            COUNT(*) AS active_count,
            SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS created_last_30d
       FROM spaces
      WHERE status = 'active'
        AND parent_space_id IS NOT NULL
        AND json_extract(config_json, '$.template_id') IS NOT NULL
      GROUP BY template_id
      ORDER BY active_count DESC`
  ).all<{ template_id: string; active_count: number; created_last_30d: number }>();

  return c.json({ data: results });
});

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

  const businessTemplates = pc?.catalog?.businessTemplates ?? [];
  const fullCatalog = await loadTemplateCatalog(c.env);
  // Phase F (CLAUDE.md): intersect the real coming_soon-aware catalog with the builder's
  // narrowing — empty/unset businessTemplates means "every template the SpaceType ships,"
  // matching business_templates' existing "not configured yet" semantics below.
  const templateCatalog =
    businessTemplates.length > 0 ? fullCatalog.filter((t) => businessTemplates.includes(t.id)) : fullCatalog;
  // Browse-only: what a business comes preconfigured with and who runs it. Same "render from the
  // real catalogue, never a client-side copy" rule as template_catalog above.
  const shellCatalog = await loadShellCatalog(c.env);

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
    // §A1.28 (model switcher): null means "unset" — the dispatch layer's own DEFAULT_WORKING_MODEL
    // fallback (@naelao/billing-core, a Workers AI id — see CLAUDE.md item 68/79: a Claude default
    // 404s on an account with no Anthropic provider on its gateway) applies, same meaning as every
    // other unset productConfig field in this projection.
    model: pc?.modelConfig?.model ?? null,
    sub_space_display: pc?.subSpaceDisplay ?? null,
    allow_public_signup: pc?.allowPublicSignup ?? false,
    auth_provider: pc?.authProvider?.provider ?? "naelao-native",
    // Phase C (§A1.17): whether an end user may create their own business at all (membershipModel
    // "team" never shows a create-business entry point) and, if so, which SpaceTypes it may be.
    // Both are safe to expose pre-authorization — they gate a UI affordance, not data access; the
    // actual creation route re-derives and re-checks both server-side regardless of what this says.
    membership_model: pc?.membershipModel ?? "team",
    allowed_child_space_types: pc?.allowedChildSpaceTypes ?? [],
    // Phase D (§A1.17): which business templates a builder actually offers — empty means "every
    // template the SpaceType ships," so the shell's create-business dialog treats [] the same as
    // "not configured yet" rather than "none allowed."
    business_templates: businessTemplates,
    // Phase F (§A1.17): the real, coming_soon-aware template catalog (id/name only) — the shell's
    // create-business dialog renders straight from this instead of a hardcoded duplicate list.
    template_catalog: templateCatalog,
    // The Discover page's informational catalogues — the project presets a business is set up
    // with, and the core agents that run it. Static product data (an agent's system_prompt is
    // never included), safe pre-login exactly like template_catalog.
    project_template_catalog: shellCatalog.project_templates,
    agent_catalog: shellCatalog.agents,
    // Legal & support — safe to surface pre-login (ToS/Privacy must be readable before signup).
    // cookiePolicy drives the consent banner; supportContact gives stuck users a path to a human.
    // Unset fields: shell falls back to Naelao's own platform links (naelao.com/legal/*).
    legal: {
      tos_url: pc?.legal?.tosUrl ?? null,
      privacy_policy_url: pc?.legal?.privacyPolicyUrl ?? null,
      dpa_url: pc?.legal?.dpaUrl ?? null,
      cookie_policy: pc?.legal?.cookiePolicy ?? "none",
      support_contact: pc?.legal?.supportContact ?? null,
    },
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
    "SELECT email, display_name, first_seen_at, last_seen_at, suspended_at, email_verified_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(spaceId, userId).first<{ email: string | null; display_name: string | null; first_seen_at: string; last_seen_at: string | null; suspended_at: string | null; email_verified_at: string | null }>();
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
    // Shell follow-up: a signed-up-but-unverified end user previously had no visible signal at
    // all that a free-credit grant was waiting on email verification — this is what the shell's
    // persistent banner (and the verify-email page) key off.
    email_verified: row.email_verified_at !== null,
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

// DELETE /spaces/:spaceId/product-users/me — GDPR Art. 17, the direct inverse of GET (export)
// above: erasing exactly what /export reports. Tier 2/3 follow-up — export existed, deletion
// didn't. Self-service only: end_user_id is derived from the caller's OWN verified claims, never
// a client-supplied field (same precedent as GET/PATCH above) — there is no builder-initiated
// erasure path here, matching the fact this route lives under /product-users/me, not an
// admin-facing /product-users/:endUserId. Erases ProductUserDO's session/conversation/preference
// state, then anonymizes (never hard-deletes — see migration 0058's own comment on why) the D1
// roster row's PII. Deliberately does NOT cascade into business_memberships or SpaceDO's own
// thread/message history (a separate, older GDPR erasure mechanism — see G-AO31 above) — a real,
// documented boundary for a future pass, not silently dropped.
app.delete("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT deleted_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(spaceId, userId).first<{ deleted_at: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "End user not found" }, 404);

  const stub = await productUserDoStub(c.env, spaceId, userId, tenantId);
  const eraseRes = await stub.fetch(new Request("http://do/erase", { method: "DELETE" }));
  const erased = await eraseRes.json<{ erased_at: string; sessions_deleted: number; conversations_deleted: number }>();

  if (!row.deleted_at) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET email = NULL, display_name = NULL, password_hash = NULL, deleted_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(spaceId, userId).run();
  }

  return c.json({ erased: true, erased_at: erased.erased_at, sessions_deleted: erased.sessions_deleted, conversations_deleted: erased.conversations_deleted });
});

// GET /spaces/:spaceId/sessions (list) is handled by the generic SpaceDO session proxy above
// (app.all("/spaces/:spaceId/sessions*", ...)) — see that handler's own comment for why the
// end_user_id filter is derived from verified caller claims there, never a client-supplied
// query param.

// POST /reseller/spaces — a customer creates their own business under a reseller's product.
// Thin wrapper over createBusinessForEndUser (business-create.ts) — the actual gating/tenant-
// hierarchy/provisioning logic is shared with the Phase C product-scoped wrapper
// (POST /spaces/:productSpaceId/businesses, business-routes.ts) so there is exactly one copy of
// this security-sensitive path, not two that could drift.
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

  const result = await createBusinessForEndUser(c.env, {
    resellerProductSpaceId: body.reseller_product_space_id,
    userId,
    name: body.name,
    spacetypeId: body.spacetype_id,
    ...(body.template_id ? { templateId: body.template_id } : {}),
    ...(body.config_overrides ? { configOverrides: body.config_overrides } : {}),
  });
  if (!result.ok) {
    return c.json({ error_code: result.error_code, message: result.message }, result.status);
  }
  return c.json({ tenant_id: result.tenantId, space_id: result.spaceId, status: result.status, parent_tenant_id: result.parentTenantId }, 201);
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
    // kind='attribution' only — the WHOLESALE/referral relationship. builder_revenue_share rows
    // (ARCH-REVENUE-6, a builder's cut of child storefront sales) live in the same table but are a
    // different revenue stream shown in the product wallet/payout views, not the wholesale statement.
    `SELECT COALESCE(SUM(retail_cents),0) AS retail, COALESCE(SUM(wholesale_cents),0) AS wholesale,
            COALESCE(SUM(margin_cents),0) AS margin, COUNT(*) AS events
       FROM reseller_ledger WHERE parent_tenant_id = ? AND period = ? AND kind = 'attribution'`
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
      WHERE parent_tenant_id = ? AND period = ? AND kind = 'attribution'
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
      WHERE parent_tenant_id = ? AND period = ? AND kind = 'attribution'
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

// POST /internal/payout-requests/:id/fulfill — v1 manual fulfillment: an ops action (real bank
// transfer done outside this system) marks a pending payout_requests row paid or rejected.
// Deliberately NOT a builder-facing route — see migration 0053's header for why this is manual by
// design rather than an automated payout API. Internal-HMAC-gated like every other ops-only route
// in this file; no admin dashboard UI yet (same "backend built, UI is next" precedent as every
// other manual-fulfillment step in this build).
app.use("/internal/payout-requests/:id/fulfill", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/payout-requests/:id/fulfill", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: "paid" | "rejected"; fulfilled_by?: string; notes?: string }>().catch(() => ({}) as Record<string, never>);
  if (body.status !== "paid" && body.status !== "rejected") {
    return c.json({ error_code: "bad_request", message: "status must be 'paid' or 'rejected'" }, 400);
  }
  const result = await c.env.PLATFORM_DB.prepare(
    "UPDATE payout_requests SET status = ?, fulfilled_at = datetime('now'), fulfilled_by = ?, notes = ? WHERE id = ? AND status = 'pending'"
  ).bind(body.status, body.fulfilled_by ?? null, body.notes ?? null, id).run();
  if (result.meta.changes === 0) {
    return c.json({ error_code: "not_found", message: "No pending payout request with that id" }, 404);
  }
  return c.json({ id, status: body.status });
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
// Three-Tier Platform Model, Phase C (docs/spec-appendix A1.17) — businesses, space switcher, invites.
registerBusinessRoutes(app);

app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
