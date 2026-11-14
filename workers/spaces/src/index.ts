import { registerAssistantVoiceRoutes } from "./routes/assistant-voice.js";
import { registerSpaceCoordinationRoutes } from "./routes/space-coordination.js";
import { standingBlackboardPeer } from "./blackboard-sharing.js";
import { persistBlackboardWakePolicy } from "./blackboard-wake-policy.js";
import { createBlackboardRequestIfPublished, retireProjectCoordination, unpublishBlackboardProject } from "./project-coordination-retirement.js";
import { Hono, type Context } from "hono";
import { errorResponse, requestId, notFound, requireInternalHmac, mintInternalToken, verifyInternalToken, forbidden, mintLocalTunnelToken, readBoundedRequestBytes, readBoundedRequestText, readBoundedResponseJson, readBoundedResponseText, RequestBodyTooLargeError } from "@naelao/http";
import { readWorkspaceCompat } from "./workspace-compat.js";
import { verifyWorkspaceDualRead } from "./workspace-dual-read.js";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import { normalizePreferredLanguage, resolveFileContentType, validateScheduledQuietHours } from "@naelao/types";
import { encodeWorkspaceFileContent } from "./workspace-file-response.js";
import { compileWorkflowPlan } from "@naelao/sdk/workflow";
import type { SpaceModelPolicy } from "@naelao/agent-sdk";
import type { SpaceDO } from "./do/SpaceDO.js";
import type { SpaceTypeRegistryDO, SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_MANIFEST, WORKSPACE_MANIFEST } from "./workspace-manifest.js";
import { cfSaasConfig, createCustomHostname, deleteCustomHostname, getCustomHostname, normalizeCustomHostname } from "./cf-saas.js";
import { validateCronExpression, computeNextRun } from "@naelao/events";
import { registerBuilderRoutes } from "./builder-routes.js";
import { registerProductEndUserRoutes } from "./product-end-user-routes.js";
import { createSpaceRecord, SpaceCreationError } from "./create-space.js";
import { ensureLaunchpad } from "./launchpad-bootstrap.js";
import { dispatchPendingProvisioningOutbox } from "./provisioning-outbox.js";
import { dispatchPendingProductAccountSecurityOutbox } from "./product-account-security-outbox.js";
import { dispatchPendingProductAuthEmails } from "./product-auth-email-outbox.js";
import type { ProvisionMessage } from "./create-space.js";
import { requireSpaceMembership, resolveEndUserSpaceRole } from "./space-auth.js";
import { ALLOWED_MODELS, isAllowedModel, isValidEffortLevel } from "@naelao/billing-core";
import { registerProjectMcpRoutes } from "./routes/mcp.js";
import { extensionRuntimeWork, registerGadgetMcpRoutes } from "./routes/gadget-mcp.js";
import { registerExtensionGadgetRoutes } from "./routes/extension-gadget.js";
import { gadgetActorId } from "./do/MicroAppDO.js";
import { registerDynamicPageRoutes } from "./routes/dynamic-pages.js";
import { registerAssistantChannelRoutes } from "./routes/assistant-channels.js";
import { registerWebsiteConnectionRoutes } from "./routes/website-connections.js";
import { registerRecipeRoutes } from "./routes/recipes.js";
import { registerMarketplaceRoutes } from "./routes/marketplace.js";
import { registerDeskDropRoutes } from "./routes/desk-drop.js";
import { conformanceDigest, type BlueprintConformanceParams } from "./BlueprintConformanceWorkflow.js";
import { loadCertifiedBlueprint } from "./certified-blueprint.js";
import { runStateDeltaFixture, validateStateDeltaSuite, type StateDeltaSuite, type StateDeltaFixture } from "./state-delta-conformance.js";
import type { WorkerLoaderBinding } from "../../agents/src/script-engine/code-runner.js";
import { registerGraduationRoutes } from "./routes/graduation.js";
import { airGappedOnlyFromConfig, applyDurableObjectJurisdiction, certifyArtifact, evaluateBlueprintSecurity, sanitizeAndScrubBlueprint, verifyArtifactCertificate, type ConformanceSuite, type ConformanceCertificate } from "@naelao/security";
import { decodeExtensionPublisherPublicKey, extensionPublisherKeyId, extensionPublisherSigningPayload, verifyExtensionPublisherRelease,
  DOGFOOD_EXTENSION_BY_ID, DOGFOOD_EXTENSION_CANVASES, digestExtensionManifest, instantiateBlueprint, validateBlueprintSetupMigrationCompatibility,
  validateBlueprintSetupMigrations, validateBlueprintSetupSchema, validateBlueprintSetupValues, validateExtensionManifest, resolveExtensionDependencyClosure,
  type BlueprintSetupMigration, type BlueprintSetupValues, type SpaceBlueprint } from "@naelao/agent-sdk";
import { rankProjectStewardReviews, type ProjectStewardFact, type ProjectStewardReview } from "./project-steward.js";
import { isProjectStewardDecisionAction, projectStewardReviewKey } from "./project-steward-decisions.js";
import { PROJECT_STEWARD_EXTENSION_MANIFEST } from "./project-steward-extension.js";
import { reportExtensionArtifactWrite } from "./extension-storage-usage.js";
import { eraseAssistantCommunications } from "./assistant-communication-erasure.js";
import { eraseWebsiteConnections } from "./website-connection-erasure.js";
import { eraseProductUsersForSpace } from "./product-user-erasure.js";
import { eraseSpaceDomainProviders } from "./space-domain-erasure.js";
import { cancelPendingErasure, createPendingErasureRequest, dispatchPendingErasureOutbox } from "./erasure-request-state.js";
import { previewBlueprintActivation } from "./blueprint-activation.js";
import { loadTemplateCostEstimate, selectedTemplateListingId, validateTemplateExpectedUsage } from "./template-cost-estimate.js";
import { assertExecutionPlanResources, EntitlementsChecker, getExecutionLimits, isPlanTierAtLeast } from "@naelao/entitlements";
import { findUnsafeProjectExtensionUpgrade } from "./extension-upgrade-guard.js";
import { summarizeExtensionForActivation, type ExtensionActivationSummary } from "./extension-activation-summary.js";
import { applyPublisherKeyRegistry, extensionReleaseAccessExpansion, isTrustedPublisherRelease, retainActivePublisherInstallations, type PublisherTaggedRelease } from "./extension-release-trust.js";
import { SPACE_SHARED_PACKAGE_CAPABILITIES, SPACE_SHARED_PACKAGE_PERMISSIONS } from "./shared-extension-package-policy.js";
import { supportsVersionOnlySpaceSharedCodeUpdate } from "./extension-update-contract.js";
import { attachBlueprintSetupFields } from "./template-setup-authoring.js";

export { SpaceDO } from "./do/SpaceDO.js";
export { ConformanceSandboxDO, ConformanceState } from "./conformance-state.js";
export { BlueprintConformanceWorkflow } from "./BlueprintConformanceWorkflow.js";
export { LockDO } from "./do/LockDO.js";
export { FeatureFlagDO } from "./do/FeatureFlagDO.js";
export { TransactionCoordinatorDO } from "./do/TransactionCoordinatorDO.js";
export { SpaceTypeRegistryDO } from "./do/SpaceTypeRegistryDO.js";
export { BuilderAccountDO } from "./do/BuilderAccountDO.js";
export { ProductUserDO } from "./do/ProductUserDO.js";
export { MicroAppDO } from "./do/MicroAppDO.js";
export { gadgetActorId, gadgetStorageKey } from "./do/MicroAppDO.js";

export interface Env {
  LOADER?: WorkerLoaderBinding;
  CONFORMANCE_SANDBOX_DO?: DurableObjectNamespace;
  CONFORMANCE_EXECUTOR?: Fetcher;
  BLUEPRINT_CONFORMANCE_WORKFLOW?: Workflow<BlueprintConformanceParams>;
  ENVIRONMENT: string;
  NAELAO_DASHBOARD_TENANT_ID?: string;
  DATA_JURISDICTION?: "eu";
  UNIFIED_WORKSPACE_ENABLED?: string;
  /** Opt-in bounded hash-only verification; does not change the read source. */
  WORKSPACE_DUAL_READ_ENABLED?: string;
  PLATFORM_SECRET: string;
  PLATFORM_DB: D1Database;
  SPACE_DO: DurableObjectNamespace<SpaceDO>;
  SPACE_TYPE_REGISTRY_DO: DurableObjectNamespace<SpaceTypeRegistryDO>;
  /** Three-Tier Platform Model, Phase 1 — one per builder (tenant). */
  BUILDER_ACCOUNT_DO: DurableObjectNamespace;
  /** Three-Tier Platform Model, Phase 2 — one per (productId, endUserId). */
  PRODUCT_USER_DO: DurableObjectNamespace;
  /** Per-product/user lease for serialized customer business creation. */
  LOCK_DO?: DurableObjectNamespace;
  MICRO_APP_DO: DurableObjectNamespace;
  /** Registrable application-domain suffix used to reject cookie-sharing preview subdomains. */
  APPLICATION_HOST_SUFFIX?: string;
  /** Dedicated wildcard suffix for tenant-isolated public dynamic pages; unset disables publishing. */
  DYNAMIC_PAGE_HOST_SUFFIX?: string;
  NAELAO_CONFIG_KV: KVNamespace;
  EXPORTS_BUCKET: R2Bucket;
  /** F-39: agent workspace bucket (read-only file viewer). Optional so tests/dev without R2 degrade. */
  SCRIPTS_R2?: R2Bucket;
  /** Producer to the provisioning queue — consumed by naelao-provisioner. */
  PROVISION_QUEUE?: Queue<ProvisionMessage>;
  /** Producer for workflow events such as organization data erasure. */
  EVENTS_QUEUE?: Queue;
  /** Cloudflare for SaaS custom-hostname provisioning (deploy-time secrets; optional). */
  CF_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  /** Billing worker — called at publish time to auto-create LS product + variant. */
  BILLING_WORKER?: Fetcher;
  /** Agents worker — SpaceDO fires event_triggers by calling its internal script.run route. */
  AGENTS_WORKER?: Fetcher;
  BROWSER_WORKER?: Fetcher;
  /** Notifications worker — password-reset emails (product-end-user-routes.ts). */
  NOTIFICATIONS_WORKER?: Fetcher;
  /** Knowledge Worker — Foundry source-reference checks and grant-authorized document reads. */
  KNOWLEDGE_WORKER?: Fetcher;
  PRODUCT_SHELL_URL?: string;
  TELEGRAM_BOT_USERNAME?: string;
  WHATSAPP_PHONE_NUMBER?: string;
  /** Either Meta Cloud API or Twilio may deliver passwordless WhatsApp challenges. */
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_NUMBER?: string;
  OPENROUTER_API_KEY?: string;
  SYSTEM_ONE_MODEL?: string;
  SYSTEM_ONE_PROVIDER?: "jev" | "laya" | "clef" | "openrouter";
  ANALYTICS?: AnalyticsEngineDataset;
}

/** Message enqueued on space creation; consumed by the provisioner (installs agents etc.). */

// G-A11: Validate required secrets at startup
function validateEnv(env: Env): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  applyDurableObjectJurisdiction(env as unknown as Record<string, unknown>, env.DATA_JURISDICTION, [
    "SPACE_DO", "SPACE_TYPE_REGISTRY_DO", "BUILDER_ACCOUNT_DO", "PRODUCT_USER_DO", "MICRO_APP_DO", "CONFORMANCE_SANDBOX_DO",
  ]);
}

const app = new Hono<{ Bindings: Env }>();

app.use("/internal/spaces/:spaceId/workspace-projects", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/workspace-projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(spaceId)) return c.json({ error_code: "invalid_workspace_scope" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const after = c.req.query("after") ?? "";
  if (after && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(after)) return c.json({ error_code: "invalid_workspace_cursor" }, 400);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "100") || 100));
  const path = `/projects?space_id=${encodeURIComponent(spaceId)}&space_manager=1&include_archived=1`;
  const response = await forwardToSpaceDO(stub, path, "GET");
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  const result = await response.json<{ data?: Array<{ id?: string }> }>().catch(() => ({} as { data?: Array<{ id?: string }> }));
  const projectIds = (result.data ?? []).map(project => project.id).filter((id): id is string => typeof id === "string");
  const installations = await forwardToSpaceDO(stub, `/extension-installations?extension_id=__all__&tenant_id=${encodeURIComponent(tenantId)}&space_id=${encodeURIComponent(spaceId)}`, "GET");
  if (!installations.ok) return new Response(installations.body, { status: installations.status, headers: { "content-type": "application/json" } });
  const installed = await installations.json<{ installations?: Array<{ instance_id?: string; project_id?: string | null }> }>().catch(() => ({} as { installations?: Array<{ instance_id?: string; project_id?: string | null }> }));
  const spaceInstallationIds = (installed.installations ?? []).filter(item => item.project_id == null).map(item => item.instance_id).filter((id): id is string => typeof id === "string");
  const allIds = new Set(projectIds);
  allIds.add(`space-assistant-${spaceId}`);
  for (const installationId of spaceInstallationIds) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(installationId));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    allIds.add(`extension-${hash.slice(0, 48)}`);
  }
  const sorted = [...allIds].sort();
  const remaining = sorted.filter(id => id > after);
  const page = remaining.slice(0, limit);
  return c.json({ projectIds: page, nextCursor: page.at(-1) ?? (after || null), hasMore: remaining.length > page.length });
});
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });
app.get("/health", (c) => c.json({ status: "ok", ok: true, service: "spaces", env: c.env.ENVIRONMENT }));
app.post("/builder/erasure", async (c) => {
  const identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.EVENTS_QUEUE) return c.json({ error_code: "erasure_unavailable" }, 503);
  const owner = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM orgs WHERE id = ? AND owner_id = ? AND status = 'active' AND suspension_reason IS NULL",
  ).bind(identity.tenantId, identity.userId).first<{ id: string }>();
  if (!owner) return c.json({ error_code: "owner_or_active_tenant_required" }, 403);
  const bytes = await readBoundedRequestBytes(c.req.raw, 8 * 1024).catch(() => null);
  if (!bytes) return c.json({ error_code: "invalid_request_body" }, 400);
  let body: { reason?: unknown };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return c.json({ error_code: "invalid_request_body" }, 400);
    body = parsed as { reason?: unknown };
  } catch { return c.json({ error_code: "invalid_request_body" }, 400); }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 2000)) {
    return c.json({ error_code: "invalid_reason" }, 400);
  }
  const openRequest = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM gdpr_requests WHERE tenant_id = ? AND request_type = 'erasure' AND status IN ('pending', 'processing') LIMIT 1",
  ).bind(identity.tenantId).first<{ id: string }>();
  if (openRequest) return c.json({ error_code: "erasure_already_pending", request_id: openRequest.id }, 409);
  const requestId = crypto.randomUUID();
  const reason = body.reason ?? "Organization owner requested account erasure";
  try {
    const created = await createPendingErasureRequest(c.env.PLATFORM_DB, c.env.EVENTS_QUEUE, {
      id: requestId, tenantId: identity.tenantId, userId: identity.userId, reason,
    });
    if (!created) return c.json({ error_code: "erasure_already_pending" }, 409);
  } catch {
    return c.json({ error_code: "erasure_persistence_unavailable" }, 503);
  }
  return c.json({ request_id: requestId, status: "pending", cooling_off_hours: 24 }, 202);
});
app.delete("/builder/erasure/:requestId", async (c) => {
  const identity = getCallerIdentity(c);
  const requestId = c.req.param("requestId");
  if (!identity.tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const owner = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM orgs WHERE id = ? AND owner_id = ?",
  ).bind(identity.tenantId, identity.userId).first<{ id: string }>();
  if (!owner) return c.json({ error_code: "owner_required" }, 403);
  if (!await cancelPendingErasure(c.env.PLATFORM_DB, identity.tenantId, identity.userId, requestId)) {
    return c.json({ error_code: "erasure_not_cancellable" }, 409);
  }
  return c.json({ request_id: requestId, status: "cancelled" });
});
app.get("/builder/erasure/:requestId", async (c) => {
  const identity = getCallerIdentity(c);
  const requestId = c.req.param("requestId");
  if (!identity.tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const owner = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM orgs WHERE id = ? AND owner_id = ?",
  ).bind(identity.tenantId, identity.userId).first<{ id: string }>();
  if (!owner) return c.json({ error_code: "owner_required" }, 403);
  const request = await c.env.PLATFORM_DB.prepare(
    "SELECT id, status, cache_cleanup_status, created_at, updated_at, completed_at FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND requested_by = ? AND request_type = 'erasure'",
  ).bind(requestId, identity.tenantId, identity.userId)
    .first<{ id: string; status: string; cache_cleanup_status: "not_started" | "pending" | "complete"; created_at: string; updated_at: string; completed_at: string | null }>();
  if (!request) return c.json({ error_code: "not_found" }, 404);
  return c.json({ request_id: request.id, status: request.status, cache_cleanup_status: request.cache_cleanup_status,
    created_at: request.created_at, updated_at: request.updated_at, completed_at: request.completed_at });
});
app.use("/internal/tenant/:tenantId/spaces/:spaceId/product-users/erase", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.delete("/internal/tenant/:tenantId/spaces/:spaceId/product-users/erase", async (c) => {
  const tenantId = c.req.param("tenantId");
  const spaceId = c.req.param("spaceId");
  if (c.req.header("x-naelao-tenant-id") !== tenantId) return c.json({ error_code: "tenant_scope_mismatch" }, 403);
  await eraseAssistantCommunications(c.env,tenantId,spaceId);
  await eraseWebsiteConnections(c.env, tenantId, { spaceId });
  const usersErased = await eraseProductUsersForSpace(c.env.PLATFORM_DB, tenantId, spaceId, async (productSpaceId, userId) => {
    const stub = await productUserDoStub(c.env, productSpaceId, userId, tenantId);
    const response = await stub.fetch(new Request("http://product-user/erase", { method: "DELETE" }));
    if (!response.ok) throw new Error(`ProductUserDO erasure failed with status ${response.status}`);
  });
  return c.json({ erased: true, space_id: spaceId, users_erased: usersErased });
});
app.use("/internal/tenant/:tenantId/spaces/:spaceId/domains/erase", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.delete("/internal/tenant/:tenantId/spaces/:spaceId/domains/erase", async (c) => {
  const tenantId = c.req.param("tenantId");
  const spaceId = c.req.param("spaceId");
  if (c.req.header("x-naelao-tenant-id") !== tenantId) return c.json({ error_code: "tenant_scope_mismatch" }, 403);
  const config = cfSaasConfig(c.env);
  const deleted = await eraseSpaceDomainProviders(c.env.PLATFORM_DB, tenantId, spaceId, async (hostnameId) => {
    if (!config) throw new Error("Cloudflare hostname credentials are unavailable during Space erasure");
    await deleteCustomHostname(config, hostnameId);
  });
  return c.json({ erased: true, space_id: spaceId, provider_domains_deleted: deleted });
});
app.use("/internal/tenant/:tenantId/spaces/:spaceId/data-erasure", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.delete("/internal/tenant/:tenantId/spaces/:spaceId/data-erasure", async (c) => {
  const tenantId = c.req.param("tenantId");
  const spaceId = c.req.param("spaceId");
  if (c.req.header("x-naelao-tenant-id") !== tenantId) return c.json({ error_code: "tenant_scope_mismatch" }, 403);
  const body = await c.req.json<{ request_id?: unknown }>().catch(() => null);
  if (typeof body?.request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.request_id)) {
    return c.json({ error_code: "invalid_erasure_request" }, 400);
  }
  const request = await c.env.PLATFORM_DB.prepare(
    `SELECT id FROM gdpr_requests WHERE id=? AND tenant_id=? AND request_type='erasure' AND status='processing' LIMIT 1`,
  ).bind(body.request_id, tenantId).first<{ id: string }>();
  const org = await c.env.PLATFORM_DB.prepare(
    "SELECT id FROM orgs WHERE id=? AND status='suspended' AND suspension_reason='erasure'",
  ).bind(tenantId).first<{ id: string }>();
  if (!request || !org) return c.json({ error_code: "erasure_request_not_claimed" }, 409);

  // Fence all public Space callers before the local Durable Object purge. A failed purge is
  // retried by the claimed erasure Workflow; the suspended tenant cannot resume normal access.
  const marked = await c.env.PLATFORM_DB.prepare(
    `UPDATE spaces SET status='deleted',suspension_reason='erasure',updated_at=datetime('now')
      WHERE id=? AND tenant_id=? AND status!='deleted'`,
  ).bind(spaceId, tenantId).run();
  const existing = marked.meta.changes === 0
    ? await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='deleted' AND suspension_reason='erasure'")
      .bind(spaceId, tenantId).first<{ id: string }>()
    : { id: spaceId };
  if (!existing) return c.json({ error_code: "space_not_found" }, 404);

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const token = await mintInternalToken(c.env.PLATFORM_SECRET, tenantId);
  const response = await stub.fetch(new Request("http://space-do/internal/data-erasure", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
    body: JSON.stringify({ tenant_id: tenantId, space_id: spaceId, request_id: body.request_id }),
  }));
  if (!response.ok) return response;
  const result = await response.json<{ erased?: unknown; tenant_id?: unknown; space_id?: unknown; request_id?: unknown; replayed?: unknown }>()
    .catch(() => ({} as { erased?: unknown; tenant_id?: unknown; space_id?: unknown; request_id?: unknown; replayed?: unknown }));
  if (result.erased !== true || result.tenant_id !== tenantId || result.space_id !== spaceId || result.request_id !== body.request_id) {
    return c.json({ error_code: "space_erasure_receipt_invalid" }, 503);
  }
  return c.json({ erased: true, tenant_id: tenantId, space_id: spaceId, request_id: body.request_id, replayed: result.replayed === true });
});

registerGadgetMcpRoutes(app);
registerExtensionGadgetRoutes(app);
registerDynamicPageRoutes(app);
registerRecipeRoutes(app);
registerMarketplaceRoutes(app);
registerDeskDropRoutes(app, {
  async verifyContact(rawEnv, spaceId, tenantId, channel, contact) {
    const env = rawEnv as Env;
    const owned = await env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status = 'active'").bind(spaceId, tenantId).first();
    if (!owned) return null;
    const res = await forwardToSpaceDO(await spaceDoStub(env, spaceId, tenantId), "/internal/executive/verify", "POST", JSON.stringify({ space_id: spaceId, channel, contact_id: contact }));
    const result = await res.json<{ verified?: boolean; member?: { user_id: string } }>();
    return result.verified ? result.member?.user_id ?? null : null;
  },
  async openSession(rawEnv, spaceId, userId) {
    const env = rawEnv as Env;
    // Contact verification never substitutes for fresh business authorization at redemption.
    const role = await resolveEndUserSpaceRole(env.PLATFORM_DB, spaceId, userId);
    if (role !== "owner" && role !== "admin") return null;
    const root = await resolveProductIdentity(env, spaceId);
    if (!root) return null;
    const product = await env.PLATFORM_DB.prepare("SELECT product_slug FROM products WHERE id = ? AND status = 'active'").bind(root.id).first<{ product_slug: string | null }>();
    if (!product?.product_slug) return null;
    const account = await env.PLATFORM_DB.prepare(
      "SELECT security_generation FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
    ).bind(root.id, userId).first<{ security_generation: number }>();
    const securityGeneration = account?.security_generation ?? 0;
    const response = await (await productUserDoStub(env, root.id, userId, root.tenant_id)).fetch(new Request("http://do/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_provider: "verified-mobile-desk-drop", security_generation: securityGeneration }),
    }));
    if (!response.ok) return null;
    const session = await response.json<{ session_token: string; expires_at: string }>();
    return { token: session.session_token, expiresAt: session.expires_at, productId: root.id, slug: product.product_slug };
  },
  async verifySession(rawEnv, session) {
    const env = rawEnv as Env;
    if (!await resolveEndUserSpaceRole(env.PLATFORM_DB, session.spaceId, session.userId)) return false;
    const root = await resolveProductIdentity(env, session.spaceId);
    if (!root || root.id !== session.productId) return false;
    const account = await env.PLATFORM_DB.prepare(
      "SELECT security_generation FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
    ).bind(root.id, session.userId).first<{ security_generation: number }>();
    const securityGeneration = account?.security_generation ?? 0;
    const response = await (await productUserDoStub(env, root.id, session.userId, root.tenant_id)).fetch(new Request("http://do/sessions/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_token: session.token, security_generation: securityGeneration }),
    }));
    return response.ok && (await response.json<{ valid: boolean }>()).valid;
  },
  async revokeSession(rawEnv, session) {
    const env = rawEnv as Env;
    const root = await resolveProductIdentity(env, session.spaceId);
    if (!root || root.id !== session.productId) return;
    const account = await env.PLATFORM_DB.prepare(
      "SELECT security_generation FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(root.id, session.userId).first<{ security_generation: number }>();
    const securityGeneration = account?.security_generation ?? 0;
    const stub = await productUserDoStub(env, root.id, session.userId, root.tenant_id);
    const verify = await stub.fetch(new Request("http://do/sessions/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_token: session.token, security_generation: securityGeneration }) }));
    const verified = await verify.json<{ valid: boolean; session_id?: string }>();
    if (!verified.valid || !verified.session_id) return;
    if (account) {
      // Cookie-backed product logout advances the account epoch, so a lost DO response cannot
      // leave a copied cookie bearer usable. The D1 trigger journals cleanup atomically.
      await env.PLATFORM_DB.prepare(
        `UPDATE product_end_users SET security_generation = security_generation + 1
          WHERE product_space_id = ? AND end_user_id = ? AND security_generation = ?`
      ).bind(root.id, session.userId, securityGeneration).run();
      return;
    }
    const revoked = await stub.fetch(new Request("http://do/sessions/revoke", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: verified.session_id }),
    }));
    if (!revoked.ok) throw new Error("desk_drop_session_revoke_failed");
  },
});
registerGraduationRoutes(app);
registerWebsiteConnectionRoutes(app);
registerAssistantChannelRoutes(app);
registerAssistantVoiceRoutes(app);
registerSpaceCoordinationRoutes(app);

// Extract caller identity from headers (set by router worker after JWT validation)
function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}
type ExtensionReleasePin = { version: string | null; digest: string | null; status?: string };
type ExtensionReleasePinWithSummary = ExtensionReleasePin & { instanceId?: string; summary?: ExtensionActivationSummary };
function installedSpaceExtensionPins(rows: Array<{ instance_id?: string; extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null; activation_summary?: ExtensionActivationSummary }>): Map<string, ExtensionReleasePinWithSummary> {
  const pins = new Map<string, ExtensionReleasePinWithSummary>();
  for (const row of rows) {
    if (row.scope !== "SPACE_SHARED" || typeof row.extension_id !== "string") continue;
    const previous = pins.get(row.extension_id);
    if (previous?.status === "active" || (previous && row.status !== "active")) continue;
    pins.set(row.extension_id, { version: row.release_version ?? null, digest: row.manifest_sha256 ?? null, ...(row.status ? { status: row.status } : {}),
      ...(row.instance_id ? { instanceId: row.instance_id } : {}), ...(row.activation_summary ? { summary: row.activation_summary } : {}) });
  }
  return pins;
}
interface RuntimeCatalogueRecord { id: string; name: string; available: boolean; image?: string; exported_binaries?: string[]; billing_tier?: string; install_manifest?: unknown; plan_available: boolean; plan_reason?: string }
async function getPlanAwareRuntimeCatalogue(env: Env, tenantId: string): Promise<{ plan: string; images: RuntimeCatalogueRecord[] } | null> {
  if (!env.AGENTS_WORKER) return null;
  const response = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/container-images"));
  if (!response.ok) return null;
  const catalogue = await response.json<{ images: Array<Omit<RuntimeCatalogueRecord, "plan_available" | "plan_reason">> }>();
  const plan = await new EntitlementsChecker(env.PLATFORM_DB).getTenantTier(tenantId);
  const images = catalogue.images.map(image => {
    const requirements = (image.install_manifest as { containers?: Array<{ resources?: { cpuCores?: number; memoryMb?: number } }> } | undefined)?.containers ?? [];
    let planAvailable = image.available;
    let planReason = image.available ? undefined : "runtime_not_deployed";
    if (image.available && image.billing_tier && !isPlanTierAtLeast(plan, image.billing_tier)) {
      planAvailable = false;
      planReason = "subscription_plan_required";
    }
    try {
      for (const container of requirements) {
        if (!container.resources || typeof container.resources.cpuCores !== "number" || typeof container.resources.memoryMb !== "number") throw new Error("runtime_requirements_invalid");
        assertExecutionPlanResources(plan, { cpuCores: container.resources.cpuCores, memoryMb: container.resources.memoryMb });
      }
    } catch (error) {
      planAvailable = false;
      planReason = (error as Error).message === "container_subscription_resource_limit" ? "subscription_resource_limit" : (error as Error).message;
    }
    return { ...image, plan_available: planAvailable, ...(planReason ? { plan_reason: planReason } : {}) };
  });
  return { plan, images };
}
type RuntimeReadinessReason = "runtime_provisioning_unavailable" | "runtime_not_deployed" | "runtime_capability_mismatch" | "subscription_plan_required" | "subscription_resource_limit" | "subscription_slot_limit" | "project_execution_ceiling_required";
export function blueprintRuntimeInstallability(blueprint: SpaceBlueprint, images: readonly RuntimeCatalogueRecord[], plan = "free"): Map<string, { installable: boolean; reason?: RuntimeReadinessReason; projectSlotsRequired: number; projectSlotsLimit: number; resources?: { cpuCores: number; memoryMb: number } }> {
  const result = new Map<string, { installable: boolean; reason?: RuntimeReadinessReason; projectSlotsRequired: number; projectSlotsLimit: number; resources?: { cpuCores: number; memoryMb: number } }>();
  for (const project of blueprint.projects) for (const requirement of project.runtimeRequirements ?? []) {
    const requiredReleases = new Map<string, number>();
    for (const needed of project.runtimeRequirements ?? []) {
      if (!needed.required) continue;
      const release = images.find(item => item.id === needed.id);
      const manifest = release?.install_manifest as { id?: string; containers?: unknown[] } | undefined;
      requiredReleases.set(manifest?.id ?? needed.id, manifest?.containers?.length ?? 1);
    }
    const requiredSlots = [...requiredReleases.values()].reduce((sum, count) => sum + count, 0);
    const resourcesByRelease = new Map<string, Array<{ cpuCores?: number; memoryMb?: number }>>();
    for (const item of project.runtimeRequirements ?? []) {
      if (!item.required) continue;
      const release = images.find(candidate => candidate.id === item.id);
      const manifest = release?.install_manifest as { id?: string; containers?: Array<{ resources?: { cpuCores?: number; memoryMb?: number } }> } | undefined;
      resourcesByRelease.set(manifest?.id ?? item.id, (manifest?.containers ?? []).map(container => container.resources ?? {}));
    }
    const requestedResources = [...resourcesByRelease.values()].flat().filter((value): value is { cpuCores: number; memoryMb: number } =>
      typeof value.cpuCores === "number" && typeof value.memoryMb === "number")
      .reduce((total, resources) => ({ cpuCores: total.cpuCores + resources.cpuCores, memoryMb: total.memoryMb + resources.memoryMb }), { cpuCores: 0, memoryMb: 0 });
    const key = `${project.id ?? project.name}:${requirement.id}`, image = images.find(item => item.id === requirement.id);
    let reason: RuntimeReadinessReason | undefined;
    if (!image?.available) reason = "runtime_not_deployed";
    else if (!requirement.capabilities.every(capability => capability === "bash" || image.exported_binaries?.includes(capability))) reason = "runtime_capability_mismatch";
    else if (!image.plan_available) reason = image.plan_reason === "subscription_resource_limit" ? "subscription_resource_limit" : "subscription_plan_required";
    else if (requirement.required && requiredSlots > getExecutionLimits(plan).installedContainersPerWorkspace) reason = "subscription_slot_limit";
    else if ((typeof project.configuration?.executionCeiling === "number" ? project.configuration.executionCeiling : 5) < 6) reason = "project_execution_ceiling_required";
    result.set(key, { installable: !reason, ...(reason ? { reason } : {}), projectSlotsRequired: requiredSlots,
      projectSlotsLimit: getExecutionLimits(plan).installedContainersPerWorkspace,
      ...(requirement.required && requestedResources.cpuCores > 0 ? { resources: requestedResources } : {}) });
  }
  return result;
}
async function installableSpaceExtensionPins(): Promise<Map<string, { version: string; digest: string; summary?: ExtensionActivationSummary }>> {
  const entries: Array<readonly [string, { version: string; digest: string; summary: ExtensionActivationSummary }] | null> = await Promise.all(Object.entries(DOGFOOD_EXTENSION_BY_ID).filter(([, manifest]) => manifest.gadgets.some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3)).map(async ([id, raw]) => {
    const manifest = validateExtensionManifest(raw, { gatekeeperCapabilities: raw.capabilityRequirements });
    const version = manifest.releaseVersion ?? manifest.bundle?.version;
    return version ? [id, { version, digest: await digestExtensionManifest(manifest), summary: summarizeExtensionForActivation(manifest) }] as const : null;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, { version: string; digest: string; summary: ExtensionActivationSummary }] => entry !== null));
}
async function authorizeProductEndUserSpace(
  c: { env: Env; req: { header: (h: string) => string | undefined } },
  spaceId: string,
  requestedUserId: string,
): Promise<string | null> {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const token = c.req.header("x-naelao-internal-token");
  const identity = getCallerIdentity(c);
  if (!tenantId || !await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET) ||
      identity.role !== "product_end_user" || !identity.userId || identity.userId !== requestedUserId) return null;
  const space = await c.env.PLATFORM_DB.prepare("SELECT tenant_id, product_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(spaceId).first<{ tenant_id: string; product_id: string | null }>();
  if (!space || space.tenant_id !== tenantId) return null;
  if (!space.product_id || !await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId)) return null;
  return identity.userId;
}
async function canExportBlueprint(c: { env: Env; req: { header(h: string): string | undefined } }, spaceId: string): Promise<boolean> {
  const { role, userId } = getCallerIdentity(c);
  if (role === "product_end_user") {
    const membership = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId);
    return membership === "owner" || membership === "admin";
  }
  return role === "owner" || role === "admin";
}

// ── GET /spaces — list spaces for tenant ────────────────────────────────────
app.get("/spaces", async (c) => {
  const identity = getCallerIdentity(c);
  const tenantId = identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);

  const { results } = await c.env.PLATFORM_DB.prepare(
    "SELECT * FROM spaces WHERE tenant_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 100"
  )
    .bind(tenantId)
    .all();
  return c.json({ data: results, count: results.length });
});

// Root product creation has moved to the configured Launchpad bootstrap. Users create
// their own Spaces through /spaces/:spaceId/spaces using their product session.
app.post("/spaces", (c) => c.json({ error_code: "product_creation_retired", message: "Create Spaces inside Launchpad" }, 410));

// Product-session users create isolated, generic Spaces under the authenticated root. A
// Space Template is optional; when selected it arrives as a tenant-owned marketplace fork and
// remains pending until the owner reviews its activation requirements.
app.use("/spaces/:spaceId/my-spaces", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/spaces", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
async function getProductSpaceOwner(c: Context<{ Bindings: Env }>, rootSpaceId: string) {
  const identity = getCallerIdentity(c);
  if (identity.role !== "product_end_user" || !identity.userId || !identity.tenantId) return null;
  const root = await c.env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id, spacetype_id FROM products WHERE id = ? AND tenant_id = ? AND status = 'active'"
  ).bind(rootSpaceId, identity.tenantId).first<{ id: string; tenant_id: string; spacetype_id: string }>();
  if (!root) return null;
  const user = await c.env.PLATFORM_DB.prepare(
    "SELECT 1 FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
  ).bind(root.id, identity.userId).first();
  return user ? { ...identity, root } : null;
}

app.get("/spaces/:spaceId/my-spaces", async (c) => {
  const owner = await getProductSpaceOwner(c, c.req.param("spaceId"));
  if (!owner) return c.json({ error_code: "forbidden", message: "A verified Space account is required" }, 403);
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT s.id, s.name, s.status AS space_status, s.created_at,
            m.role AS role, m.created_at AS joined_at,
            s.config_json
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.end_user_id = ? AND m.suspended_at IS NULL
      WHERE s.tenant_id = ? AND s.product_id = ? AND s.status != 'deleted'
      ORDER BY s.created_at DESC LIMIT 100`
  ).bind(owner.userId, owner.tenantId, owner.root.id)
    .all<{ id: string; name: string; space_status: string; created_at: string; role: string; joined_at: string; config_json: string | null }>();
  const data = results.map(row => {
    let config: Record<string, unknown> = {};
    try { const value: unknown = JSON.parse(row.config_json ?? "{}"); if (value && typeof value === "object" && !Array.isArray(value)) config = value as Record<string, unknown>; } catch { /* legacy malformed config is omitted */ }
    return {
      id: row.id, name: row.name,
      role: row.role === "moderator" ? "admin" : row.role,
      membership_status: "active", space_status: row.space_status, joined_at: row.joined_at,
      pending_blueprint_id: typeof config.pending_blueprint_id === "string" ? config.pending_blueprint_id : null,
    };
  });
  return c.json({ data, count: data.length });
});

app.post("/spaces/:spaceId/customer-checkout", async (c) => {
  const owner = await getProductSpaceOwner(c, c.req.param("spaceId"));
  if (!owner) return c.json({ error_code: "forbidden" }, 403);
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "customer_billing_unavailable" }, 503);
  const body = await c.req.json<{ plan?: string; success_url?: string }>().catch(() => ({} as { plan?: string; success_url?: string }));
  if (!body.success_url || !["growth", "business"].includes(body.plan ?? "")) return c.json({ error_code: "bad_request" }, 400);
  let success: URL;
  try { success = new URL(body.success_url); } catch { return c.json({ error_code: "bad_request" }, 400); }
  let shellOrigin: string | undefined;
  try { shellOrigin = c.env.PRODUCT_SHELL_URL ? new URL(c.env.PRODUCT_SHELL_URL).origin : undefined; } catch { /* invalid config fails closed */ }
  const local = c.env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1"].includes(success.hostname);
  if (success.protocol !== "https:" && !local) return c.json({ error_code: "bad_request" }, 400);
  if (!shellOrigin && !local) return c.json({ error_code: "customer_billing_unavailable" }, 503);
  if (shellOrigin && success.origin !== shellOrigin && !local) return c.json({ error_code: "bad_request" }, 400);
  const response = await c.env.BILLING_WORKER.fetch(new Request("http://billing/internal/product-user-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": owner.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owner.tenantId) },
    body: JSON.stringify({ product_id: owner.root.id, end_user_id: owner.userId, plan: body.plan, success_url: success.href }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.post("/spaces/:spaceId/spaces", async (c) => {
  const owner = await getProductSpaceOwner(c, c.req.param("spaceId"));
  if (!owner) return c.json({ error_code: "forbidden", message: "A verified Space account is required" }, 403);
  let value: unknown;
  try { value = JSON.parse(await readBoundedRequestText(c.req.raw, 16 * 1024)); }
  catch (error) {
    return c.json({ error_code: error instanceof RequestBodyTooLargeError ? "payload_too_large" : "invalid_request_body" }, error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return c.json({ error_code: "invalid_request_body" }, 400);
  const body = value as { name?: unknown; blueprint_id?: unknown; template_listing_id?: unknown; assistant_email_mode?: unknown };
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return c.json({ error_code: "invalid_space_name" }, 400);
  if (body.blueprint_id !== undefined && (typeof body.blueprint_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.blueprint_id))) return c.json({ error_code: "invalid_blueprint_id" }, 400);
  if (body.template_listing_id !== undefined && (typeof body.template_listing_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.template_listing_id))) return c.json({ error_code: "invalid_template_listing_id" }, 400);
  if (body.template_listing_id && !body.blueprint_id) return c.json({ error_code: "template_fork_required" }, 400);
  if(body.assistant_email_mode!==undefined&&(!body.blueprint_id||!['none','naelao_managed','user_connected'].includes(String(body.assistant_email_mode))))return c.json({error_code:"invalid_assistant_email_mode"},400);
  if (body.blueprint_id) {
    const fork = await c.env.PLATFORM_DB.prepare(
      `SELECT 1 FROM marketplace_forks f JOIN marketplace_listings l ON l.id = f.listing_id
        WHERE f.tenant_id = ? AND f.blueprint_id = ? AND l.status = 'published'
          AND (? IS NULL OR l.id = ?) LIMIT 1`
    ).bind(owner.tenantId, body.blueprint_id, body.template_listing_id ?? null, body.template_listing_id ?? null).first();
    if (!fork) return c.json({ error_code: "space_template_fork_required" }, 402);
  }
  try {
    const created = await createSpaceRecord(c.env, {
      tenantId: owner.tenantId,
      userId: owner.userId,
      name: body.name,
      spacetypeId: owner.root.spacetype_id,
      ...(typeof body.blueprint_id === "string" ? { blueprintId: body.blueprint_id } : {}),
      ...(typeof body.template_listing_id === "string" ? { templateListingId: body.template_listing_id } : {}),
      ...(typeof body.assistant_email_mode==="string"?{configOverrides:{assistantEmailProvisioning:{provider:"agentmail",defaultMode:body.assistant_email_mode,provisionOnCreate:body.assistant_email_mode==="naelao_managed"}}}:{}),
      initialMembership: { productSpaceId: owner.root.id, endUserId: owner.userId, role: "owner" },
    });
    return c.json({ id: created.id, name: body.name, status: created.status,
      ...(body.blueprint_id ? { pending_blueprint_id: body.blueprint_id } : {}) }, 201);
  } catch (error) {
    if (error instanceof SpaceCreationError) return c.json({ error_code: error.error_code, message: error.message }, error.status as 400 | 402 | 404 | 409 | 429 | 503);
    throw error;
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

// ── Blueprint export and activation ─────────────────────────────────────────
app.post("/spaces/:spaceId/export-template", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("spaceId");
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable", message: "Blueprint storage not configured" }, 503);
  const exportOptions = await c.req.json<{ projectId?: string; requiredExtensions?: string[]; requiredExtensionVersions?: Record<string, string>; name?: string; description?: string; templateCategory?: string; setupSchemaVersion?: unknown; setupFields?: unknown; stateDeltaSuite?: StateDeltaSuite; entries?: Record<string, string> }>().catch(() => ({} as { projectId?: string; requiredExtensions?: string[]; requiredExtensionVersions?: Record<string, string>; name?: string; description?: string; templateCategory?: string; setupSchemaVersion?: unknown; setupFields?: unknown; stateDeltaSuite?: StateDeltaSuite; entries?: Record<string, string> }));
  if (exportOptions.projectId !== undefined && (typeof exportOptions.projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(exportOptions.projectId))) return c.json({ error_code: "invalid_project_id" }, 400);
  if (exportOptions.requiredExtensions !== undefined && (!Array.isArray(exportOptions.requiredExtensions) || exportOptions.requiredExtensions.length > 128 || exportOptions.requiredExtensions.some(id => typeof id !== "string" || !/^ext_[a-z0-9_-]{2,62}$/.test(id)))) return c.json({ error_code: "invalid_required_extensions" }, 400);
  if (exportOptions.requiredExtensionVersions !== undefined && (!exportOptions.requiredExtensionVersions || typeof exportOptions.requiredExtensionVersions !== "object" || Array.isArray(exportOptions.requiredExtensionVersions) || Object.keys(exportOptions.requiredExtensionVersions).length > 128 || Object.entries(exportOptions.requiredExtensionVersions).some(([id, version]) => !/^ext_[a-z0-9_-]{2,62}$/.test(id) || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)))) return c.json({ error_code: "invalid_required_extension_versions" }, 400);
  const sourceId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
  const rawResponse = await c.env.SPACE_DO.get(sourceId).fetch(new Request("http://space-do/blueprints/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: spaceId,
      ...(exportOptions.projectId ? { project_id: exportOptions.projectId } : {}), ...(exportOptions.requiredExtensions ? { required_extensions: exportOptions.requiredExtensions } : {}),
      ...(exportOptions.requiredExtensionVersions ? { required_extension_versions: exportOptions.requiredExtensionVersions } : {}),
      ...(exportOptions.name ? { name: exportOptions.name } : {}), ...(exportOptions.description ? { description: exportOptions.description } : {}),
      ...(exportOptions.templateCategory ? { template_category: exportOptions.templateCategory } : {}) }),
  }));
  if (!rawResponse.ok) return new Response(rawResponse.body, { status: rawResponse.status });
  let rawBlueprint = await rawResponse.json<SpaceBlueprint>();
  const publisherTrust = await blueprintPublisherTrust(c.env, c.env.SPACE_DO.get(sourceId), tenantId, spaceId, rawBlueprint);
  if (publisherTrust === "unavailable") return c.json({ error_code: "extension_release_trust_unavailable" }, 503);
  if (publisherTrust !== "trusted") return c.json({ error_code: "extension_release_publisher_untrusted" }, 409);
  if (exportOptions.setupSchemaVersion !== undefined || exportOptions.setupFields !== undefined) {
    try {
      rawBlueprint = attachBlueprintSetupFields(rawBlueprint, {
        projectId: exportOptions.projectId,
        schemaVersion: exportOptions.setupSchemaVersion,
        fields: exportOptions.setupFields,
      });
    } catch {
      return c.json({ error_code: "blueprint_setup_schema_invalid" }, 422);
    }
  }
  if (exportOptions.stateDeltaSuite) rawBlueprint.metadata.stateDeltaSuite = exportOptions.stateDeltaSuite;
  for (const project of rawBlueprint.projects) {
    const entry = project.id ? exportOptions.entries?.[project.id] : undefined;
    if (entry) project.configuration = { ...project.configuration, conformance_entry: entry };
  }
  const blueprint = sanitizeAndScrubBlueprint(rawBlueprint) as unknown as SpaceBlueprint;
  try { validateBlueprintSetupSchema(blueprint); }
  catch { return c.json({ error_code: "blueprint_setup_schema_invalid" }, 422); }
  const security = evaluateBlueprintSecurity(blueprint);
  if (!security.publishable) return c.json({ error_code: "blueprint_rejected", security }, 422);

  const suite = blueprint.metadata.stateDeltaSuite as StateDeltaSuite | undefined;
  if (!suite || !validateStateDeltaSuite(suite, blueprint)) return c.json({ error_code: "conformance_gate_failed", message: "At least 50 state-delta fixtures covering every installed worker entry are required" }, 422);
  if (!c.env.BLUEPRINT_CONFORMANCE_WORKFLOW || !c.env.LOADER || !c.env.CONFORMANCE_SANDBOX_DO || !c.env.CONFORMANCE_EXECUTOR) return c.json({ error_code: "conformance_runtime_unavailable" }, 503);
  const jobId = crypto.randomUUID(); const key = `conformance-jobs/${tenantId}/${jobId}.json`;
  const payload = JSON.stringify({ blueprint, suite, security });
  if (payload.length > 5 * 1024 * 1024) return c.json({ error_code: "conformance_artifact_size_limit" }, 413);
  await c.env.SCRIPTS_R2.put(key, payload, { httpMetadata: { contentType: "application/json" } });
  await c.env.PLATFORM_DB.prepare("INSERT INTO blueprint_export_jobs (id, tenant_id, space_id, artifact_key) VALUES (?, ?, ?, ?)").bind(jobId, tenantId, spaceId, key).run();
  await c.env.BLUEPRINT_CONFORMANCE_WORKFLOW.create({ id: jobId, params: { tenantId, jobId, key, digest: await conformanceDigest(payload) } });
  return c.json({ jobId, status: "testing", statusUrl: `/spaces/${spaceId}/export-template/${jobId}`, artifactUrl: `/spaces/${spaceId}/export-template-artifact/${jobId}` }, 202);
});

app.get("/spaces/:spaceId/export-template-artifact/:jobId", async c => {
  const { tenantId } = getCallerIdentity(c);
  if (!await canExportBlueprint(c, c.req.param("spaceId"))) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const job = await c.env.PLATFORM_DB.prepare("SELECT artifact_key FROM blueprint_export_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?").bind(c.req.param("jobId"), c.req.param("spaceId"), tenantId).first<{ artifact_key: string }>();
  if (!job) throw notFound("Blueprint export");
  const object = await c.env.SCRIPTS_R2?.get(job.artifact_key);
  if (!object) throw notFound("Blueprint export artifact");
  const { blueprint } = await object.json<{ blueprint: SpaceBlueprint }>();
  return c.json({ artifact: blueprint });
});

app.get("/spaces/:spaceId/export-template/:jobId", async c => {
  const { tenantId } = getCallerIdentity(c);
  if (!await canExportBlueprint(c, c.req.param("spaceId"))) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const job = await c.env.PLATFORM_DB.prepare("SELECT id FROM blueprint_export_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?").bind(c.req.param("jobId"), c.req.param("spaceId"), tenantId).first();
  if (!job) throw notFound("Blueprint export");
  if (!c.env.BLUEPRINT_CONFORMANCE_WORKFLOW) return c.json({ error_code: "conformance_runtime_unavailable" }, 503);
  const instance = await c.env.BLUEPRINT_CONFORMANCE_WORKFLOW.get(c.req.param("jobId"));
  return c.json(await instance.status());
});

app.post("/internal/conformance/fixture", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const stateFactory = (c.executionCtx as unknown as { exports?: { ConformanceState?: (options: { props: { sandboxId: string } }) => Fetcher } }).exports?.ConformanceState;
  if (!stateFactory || !c.env.LOADER || !c.env.CONFORMANCE_SANDBOX_DO) return c.json({ error_code: "conformance_runtime_unavailable" }, 503);
  const { blueprint, fixture } = await c.req.json<{ blueprint: SpaceBlueprint; fixture: StateDeltaFixture }>();
  try { await runStateDeltaFixture(c.env, stateFactory, blueprint, fixture); return c.json({ passed: true }); }
  catch (error) { return c.json({ passed: false, error: (error as Error).message.slice(0, 500) }); }
});

app.post("/internal/spaces/:spaceId/artifact-validation/:action", async c => {
  const tenantId=c.req.header("x-naelao-tenant-id")??"";const spaceId=c.req.param("spaceId");
  if(!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"),tenantId,c.env.PLATFORM_SECRET)) return c.json({error_code:"forbidden"},403);
  const owned=await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId,tenantId).first();
  if(!owned) throw notFound("Space");
  const action=c.req.param("action");if(!["check","approval","resume","diagnostic"].includes(action)) return c.json({error_code:"not_found"},404);
  const body=await c.req.json<Record<string,unknown>>();
  const stub=await spaceDoStub(c.env,spaceId,tenantId);
  if(action==="diagnostic") return forwardToSpaceDO(stub,`/artifact-validation/diagnostic?${new URLSearchParams({space_id:spaceId,id:String(body.id??"")})}`,"GET");
  return forwardToSpaceDO(stub,`/artifact-validation/${action}`,"POST",JSON.stringify({...body,space_id:spaceId}));
});

app.get("/spaces/:spaceId/blueprints/installations", async c => {
  const identity = getCallerIdentity(c), tenantId = identity.tenantId ?? "", spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "forbidden" }, 403);
  if (!identity.userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'")
    .bind(spaceId, tenantId).first<{ id: string }>();
  if (!owned) throw notFound("Space");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId });
  const response = await stub.fetch(new Request(`http://space-do/blueprint-installations?${query}`, {
    headers: { "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
  }));
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  const status = await response.json() as { installations?: unknown };
  const installations = Array.isArray(status.installations) ? status.installations as Array<{
    blueprint_id: string; artifact_sha256: string; listing_id: string | null;
    setup_schema_version: 1 | 2 | null; required_extension_ids: string[];
  }> : [];
  const sourceChecks = await checkTemplateSourceUpdates(c.env, tenantId, installations);
  return c.json({ installations: installations.map(installation => ({
    ...installation,
    source_update: sourceChecks.get(installation.listing_id ?? "") ?? {
      status: installation.listing_id ? "source_unavailable" : "unknown_legacy",
      checked_at: new Date().toISOString(),
      source_listing_id: null,
      source_artifact_sha256: null,
      terms_changed: null,
      setup_schema_changed: null,
      setup_migration_available: false,
      added_required_extensions: [],
      removed_required_extensions: [],
      changed_required_extension_versions: [],
    },
  })) }, 200, { "cache-control": "private, no-store" });
});

type TemplateSourceUpdateStatus = "current" | "update_available" | "source_unavailable" | "unknown_legacy";
interface TemplateSourceUpdateCheck {
  status: TemplateSourceUpdateStatus;
  checked_at: string;
  source_listing_id: string | null;
  source_artifact_sha256: string | null;
  terms_changed: boolean | null;
  setup_schema_changed: boolean | null;
  setup_migration_available: boolean;
  added_required_extensions: string[];
  removed_required_extensions: string[];
  changed_required_extension_versions: Array<{ extension_id: string; installed_version: string | null; source_version: string | null }>;
}
interface TemplateSourceCandidateRow {
  source_listing_id: string;
  publisher_tenant_id: string;
  blueprint_id: string;
  installed_price_model: string;
  installed_price_cents: number;
  installed_artifact_json: string;
  installed_certificate_json: string;
  candidate_listing_id: string | null;
  candidate_artifact_json: string | null;
  candidate_certificate_json: string | null;
  candidate_price_model: string | null;
  candidate_price_cents: number | null;
}

async function templateArtifactDigest(value: unknown): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

function templateRequiredExtensions(artifact: Record<string, unknown>): { ids: string[]; versions: Record<string, string> } {
  const ids = Array.isArray(artifact.requiredExtensions)
    ? [...new Set(artifact.requiredExtensions.filter((value): value is string => typeof value === "string" && /^ext_[a-z0-9_-]{2,62}$/.test(value)))]
    : [];
  const rawVersions = artifact.requiredExtensionVersions;
  const versions: Record<string, string> = {};
  if (rawVersions && typeof rawVersions === "object" && !Array.isArray(rawVersions)) {
    for (const [id, version] of Object.entries(rawVersions)) {
      if (ids.includes(id) && typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) versions[id] = version;
    }
  }
  return { ids, versions };
}

function templateSetupSchemaProjection(artifact: Record<string, unknown>): string | null {
  if (!Array.isArray(artifact.projects)) return null;
  const projects = artifact.projects.flatMap(project => {
    if (!project || typeof project !== "object" || Array.isArray(project)) return [];
    const row = project as Record<string, unknown>;
    return [{ id: typeof row.id === "string" ? row.id : null, setupFields: row.setupFields ?? [] }];
  });
  return JSON.stringify({ setupSchemaVersion: artifact.setupSchemaVersion ?? null, projects });
}

/** A setup-only update cannot alter executable project content, dependencies, or package grants. */
function templateSetupUpdateRuntimeProjection(artifact: Record<string, unknown>): string | null {
  try {
    const copy = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    delete copy.setupSchemaVersion;
    delete copy.setupMigrations;
    if (copy.metadata && typeof copy.metadata === "object" && !Array.isArray(copy.metadata)) {
      const metadata = copy.metadata as Record<string, unknown>;
      delete metadata.exportedAt; delete metadata.sourceSpaceId; delete metadata.name; delete metadata.description;
    }
    if (!Array.isArray(copy.projects)) return null;
    copy.projects = copy.projects.map(project => {
      if (!project || typeof project !== "object" || Array.isArray(project)) return project;
      const row = { ...(project as Record<string, unknown>) };
      delete row.setupFields;
      return row;
    });
    return JSON.stringify(copy);
  } catch { return null; }
}

/**
 * Compare installed records with the newest published, host-certified listing from the same
 * publisher for the same blueprint. This is a read-only availability check; it never installs,
 * migrates configuration, changes a license, or applies a price/permission change.
 */
async function checkTemplateSourceUpdates(
  env: Env,
  tenantId: string,
  installations: Array<{ blueprint_id: string; artifact_sha256: string; listing_id: string | null;
    setup_schema_version: 1 | 2 | null; required_extension_ids: string[] }>,
): Promise<Map<string, TemplateSourceUpdateCheck>> {
  const checkedAt = new Date().toISOString();
  const listingIds = [...new Set(installations.flatMap(item =>
    typeof item.listing_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.listing_id) ? [item.listing_id] : []))].slice(0, 100);
  const checks = new Map<string, TemplateSourceUpdateCheck>();
  for (const item of installations) {
    if (!item.listing_id) checks.set("", { status: "unknown_legacy", checked_at: checkedAt,
      source_listing_id: null, source_artifact_sha256: null, terms_changed: null, setup_schema_changed: null,
      setup_migration_available: false,
      added_required_extensions: [], removed_required_extensions: [], changed_required_extension_versions: [] });
    else checks.set(item.listing_id, { status: "source_unavailable", checked_at: checkedAt,
      source_listing_id: null, source_artifact_sha256: null, terms_changed: null, setup_schema_changed: null,
      setup_migration_available: false,
      added_required_extensions: [], removed_required_extensions: [], changed_required_extension_versions: [] });
  }
  if (!listingIds.length) return checks;

  const placeholders = listingIds.map(() => "?").join(",");
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT source.id AS source_listing_id, source.tenant_id AS publisher_tenant_id,
      source.space_type_id AS blueprint_id, source.pricing_model AS installed_price_model,
      source.price_cents AS installed_price_cents,
      fork.artifact_json AS installed_artifact_json, fork.certificate_json AS installed_certificate_json,
      latest.id AS candidate_listing_id,
      latest.conformance_artifact_json AS candidate_artifact_json,
      latest.conformance_certificate_json AS candidate_certificate_json,
      latest.pricing_model AS candidate_price_model, latest.price_cents AS candidate_price_cents
    FROM marketplace_listings source
    JOIN marketplace_forks fork ON fork.listing_id=source.id AND fork.tenant_id=?
      AND fork.blueprint_id=source.space_type_id
    LEFT JOIN marketplace_listings latest ON latest.id=(
      SELECT candidate.id FROM marketplace_listings candidate
      WHERE candidate.tenant_id=source.tenant_id AND candidate.space_type_id=source.space_type_id
        AND candidate.status='published'
      ORDER BY COALESCE(candidate.published_at,candidate.created_at) DESC,candidate.id DESC LIMIT 1
    )
    WHERE source.id IN (${placeholders})
  `).bind(tenantId, ...listingIds).all<TemplateSourceCandidateRow>();

  const bySourceId = new Map((rows.results ?? []).map(row => [row.source_listing_id, row]));
  for (const installation of installations) {
    const listingId = installation.listing_id;
    if (!listingId || !listingIds.includes(listingId)) continue;
    const row = bySourceId.get(listingId);
    if (!row || row.blueprint_id !== installation.blueprint_id || !row.candidate_listing_id ||
        !row.installed_artifact_json || !row.installed_certificate_json ||
        !row.candidate_artifact_json || !row.candidate_certificate_json) continue;
    try {
      const installedArtifact = JSON.parse(row.installed_artifact_json) as Record<string, unknown>;
      const installedCertificate = JSON.parse(row.installed_certificate_json) as ConformanceCertificate;
      const artifact = JSON.parse(row.candidate_artifact_json) as Record<string, unknown>;
      const certificate = JSON.parse(row.candidate_certificate_json) as ConformanceCertificate;
      if (!installedArtifact || typeof installedArtifact !== "object" || Array.isArray(installedArtifact) ||
          installedArtifact.id !== installation.blueprint_id || installedCertificate?.issuerTenantId !== row.publisher_tenant_id ||
          !await verifyArtifactCertificate(installedArtifact, installedCertificate, env.PLATFORM_SECRET, "state-delta") ||
          await templateArtifactDigest(installedArtifact) !== installation.artifact_sha256 ||
          !artifact || typeof artifact !== "object" || Array.isArray(artifact) || artifact.id !== installation.blueprint_id ||
          certificate?.issuerTenantId !== row.publisher_tenant_id ||
          !await verifyArtifactCertificate(artifact, certificate, env.PLATFORM_SECRET, "state-delta")) continue;
      const sourceDigest = await templateArtifactDigest(artifact);
      if (!sourceDigest) continue;
      const termsChanged = row.installed_price_model !== row.candidate_price_model || row.installed_price_cents !== row.candidate_price_cents;
      const installedDependencies = templateRequiredExtensions(installedArtifact);
      const sourceDependencies = templateRequiredExtensions(artifact);
      const installedSchemaVersion = installedArtifact.setupSchemaVersion === 1 || installedArtifact.setupSchemaVersion === 2
        ? installedArtifact.setupSchemaVersion : null;
      if (installation.setup_schema_version !== installedSchemaVersion) continue;
      const recordedDependencyIds = [...new Set((installation.required_extension_ids ?? [])
        .filter((id): id is string => typeof id === "string" && /^ext_[a-z0-9_-]{2,62}$/.test(id)))].sort();
      if (JSON.stringify(recordedDependencyIds) !== JSON.stringify([...installedDependencies.ids].sort())) continue;
      const installedExtensionIds = new Set(installedDependencies.ids);
      const sourceExtensionIds = new Set(sourceDependencies.ids);
      const addedRequiredExtensions = sourceDependencies.ids.filter(id => !installedExtensionIds.has(id)).slice(0, 128);
      const removedRequiredExtensions = installedDependencies.ids.filter(id => !sourceExtensionIds.has(id)).slice(0, 128);
      const changedRequiredExtensionVersions = sourceDependencies.ids.flatMap(id => {
        if (!installedExtensionIds.has(id) || installedDependencies.versions[id] === sourceDependencies.versions[id]) return [];
        return [{ extension_id: id, installed_version: installedDependencies.versions[id] ?? null,
          source_version: sourceDependencies.versions[id] ?? null }];
      }).slice(0, 128);
      const installedSchema = templateSetupSchemaProjection(installedArtifact);
      const sourceSchema = templateSetupSchemaProjection(artifact);
      const setupSchemaChanged = installedSchema === null || sourceSchema === null ? null : installedSchema !== sourceSchema;
      let setupMigrationAvailable = false;
      if (setupSchemaChanged === true && !termsChanged && addedRequiredExtensions.length === 0
        && removedRequiredExtensions.length === 0 && changedRequiredExtensionVersions.length === 0
        && templateSetupUpdateRuntimeProjection(installedArtifact) === templateSetupUpdateRuntimeProjection(artifact)) {
        try {
          const oldGroups = validateBlueprintSetupSchema(installedArtifact as unknown as SpaceBlueprint);
          const newGroups = validateBlueprintSetupSchema(artifact as unknown as SpaceBlueprint);
          const oldSchemaSha256 = await templateArtifactDigest(oldGroups);
          const migrations = validateBlueprintSetupMigrations(artifact.setupMigrations, newGroups);
          const migration = migrations.find(value => value.fromArtifactSha256 === installation.artifact_sha256
            && value.fromSchemaSha256 === oldSchemaSha256);
          if (migration) {
            validateBlueprintSetupMigrationCompatibility(oldGroups, newGroups, migration);
            setupMigrationAvailable = true;
          }
        } catch { /* An invalid or incompatible migration is shown as unavailable. */ }
      }
      checks.set(listingId, {
        status: sourceDigest === installation.artifact_sha256 ? "current" : "update_available",
        checked_at: checkedAt,
        source_listing_id: row.candidate_listing_id,
        source_artifact_sha256: sourceDigest,
        terms_changed: termsChanged,
        setup_schema_changed: setupSchemaChanged,
        setup_migration_available: setupMigrationAvailable,
        added_required_extensions: addedRequiredExtensions,
        removed_required_extensions: removedRequiredExtensions,
        changed_required_extension_versions: changedRequiredExtensionVersions,
      });
    } catch { /* Invalid source bytes remain unavailable; never treat them as an update. */ }
  }
  return checks;
}

interface ResolvedTemplateSetupUpdate {
  sourceListingId: string;
  sourceArtifactSha256: string;
  setupSchemaVersion: 1 | 2 | null;
  setupSchemaGroups: ReturnType<typeof validateBlueprintSetupSchema>;
  setupMigrations: BlueprintSetupMigration[];
}

/** Resolve a fresh, same-publisher signed candidate and permit only setup-only changes. */
async function resolveTemplateSetupUpdate(
  env: Env,
  tenantId: string,
  blueprintId: string,
  installedListingId: string,
  installedArtifactSha256: string,
  installedSetupSchemaVersion: 1 | 2 | null,
  expectedSourceListingId: string,
  expectedSourceArtifactSha256: string,
): Promise<ResolvedTemplateSetupUpdate | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT source.id AS source_listing_id, source.tenant_id AS publisher_tenant_id,
      source.space_type_id AS blueprint_id, source.pricing_model AS installed_price_model,
      source.price_cents AS installed_price_cents,
      fork.artifact_json AS installed_artifact_json, fork.certificate_json AS installed_certificate_json,
      latest.id AS candidate_listing_id, latest.conformance_artifact_json AS candidate_artifact_json,
      latest.conformance_certificate_json AS candidate_certificate_json,
      latest.pricing_model AS candidate_price_model, latest.price_cents AS candidate_price_cents
    FROM marketplace_listings source
    JOIN marketplace_forks fork ON fork.listing_id=source.id AND fork.tenant_id=?
      AND fork.blueprint_id=source.space_type_id
    LEFT JOIN marketplace_listings latest ON latest.id=(
      SELECT candidate.id FROM marketplace_listings candidate
      WHERE candidate.tenant_id=source.tenant_id AND candidate.space_type_id=source.space_type_id
        AND candidate.status='published'
      ORDER BY COALESCE(candidate.published_at,candidate.created_at) DESC,candidate.id DESC LIMIT 1
    )
    WHERE source.id=? AND source.space_type_id=?
  `).bind(tenantId, installedListingId, blueprintId).first<TemplateSourceCandidateRow>();
  if (!row || row.source_listing_id !== installedListingId || row.blueprint_id !== blueprintId
    || row.candidate_listing_id !== expectedSourceListingId || !row.candidate_artifact_json || !row.candidate_certificate_json
    || !row.installed_artifact_json || !row.installed_certificate_json
    || row.installed_price_model !== row.candidate_price_model || row.installed_price_cents !== row.candidate_price_cents)
    return null;
  try {
    const installed = JSON.parse(row.installed_artifact_json) as Record<string, unknown>;
    const installedCertificate = JSON.parse(row.installed_certificate_json) as ConformanceCertificate;
    const candidate = JSON.parse(row.candidate_artifact_json) as Record<string, unknown>;
    const candidateCertificate = JSON.parse(row.candidate_certificate_json) as ConformanceCertificate;
    if (!installed || typeof installed !== "object" || Array.isArray(installed) || installed.id !== blueprintId
      || (installed.setupSchemaVersion === 1 || installed.setupSchemaVersion === 2 ? installed.setupSchemaVersion : null) !== installedSetupSchemaVersion
      || installedCertificate?.issuerTenantId !== row.publisher_tenant_id
      || !await verifyArtifactCertificate(installed, installedCertificate, env.PLATFORM_SECRET, "state-delta")
      || await templateArtifactDigest(installed) !== installedArtifactSha256
      || !candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate.id !== blueprintId
      || candidateCertificate?.issuerTenantId !== row.publisher_tenant_id
      || !await verifyArtifactCertificate(candidate, candidateCertificate, env.PLATFORM_SECRET, "state-delta")) return null;
    const candidateDigest = await templateArtifactDigest(candidate);
    if (!candidateDigest || candidateDigest !== expectedSourceArtifactSha256
      || templateSetupUpdateRuntimeProjection(installed) !== templateSetupUpdateRuntimeProjection(candidate)) return null;
    const oldSchemaJson = templateSetupSchemaProjection(installed), newSchemaJson = templateSetupSchemaProjection(candidate);
    if (!oldSchemaJson || !newSchemaJson || oldSchemaJson === newSchemaJson) return null;
    const oldGroups = validateBlueprintSetupSchema(installed as unknown as SpaceBlueprint);
    const newGroups = validateBlueprintSetupSchema(candidate as unknown as SpaceBlueprint);
    const oldSchemaSha256 = await templateArtifactDigest(oldGroups);
    const migrations = validateBlueprintSetupMigrations(candidate.setupMigrations, newGroups);
    const migration = migrations.find(value => value.fromArtifactSha256 === installedArtifactSha256
      && value.fromSchemaSha256 === oldSchemaSha256);
    if (!migration) return null;
    validateBlueprintSetupMigrationCompatibility(oldGroups, newGroups, migration);
    const version = candidate.setupSchemaVersion;
    if (version !== 1 && version !== 2 && newGroups.length > 0) return null;
    return { sourceListingId: row.candidate_listing_id, sourceArtifactSha256: candidateDigest,
      setupSchemaVersion: version === 1 || version === 2 ? version : null,
      setupSchemaGroups: newGroups, setupMigrations: [migration] };
  } catch { return null; }
}

async function handleTemplateSetupUpdate(c: Context<{ Bindings: Env }>, apply: boolean): Promise<Response> {
  const identity = getCallerIdentity(c), tenantId = identity.tenantId ?? "", userId = identity.userId ?? "";
  const spaceId = c.req.param("spaceId") ?? "", blueprintId = c.req.param("blueprintId") ?? "";
  if (!tenantId || !userId || !spaceId || !blueprintId
    || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "forbidden" }, 403);
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId) : identity.role;
  if ((role !== "owner" && role !== "admin") || !await canExportBlueprint(c, spaceId))
    return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'")
    .bind(spaceId, tenantId).first<{ id: string }>();
  if (!owned) throw notFound("Space");
  let body: { source_listing_id?: unknown; source_artifact_sha256?: unknown; expected_artifact_sha256?: unknown;
    expected_setup_revision?: unknown; owner_values?: unknown; setup_values?: unknown; clear_fields?: unknown;
    confirmed?: unknown; confirm_data_loss?: unknown };
  try {
    body = JSON.parse(await readBoundedRequestText(c.req.raw, 32 * 1024)) as typeof body;
    if (!body || Object.keys(body).some(key => !["source_listing_id", "source_artifact_sha256", "expected_artifact_sha256",
      "expected_setup_revision", "owner_values", "setup_values", "clear_fields", "confirmed", "confirm_data_loss"].includes(key))) throw new Error("invalid_request");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return c.json({ error_code: "request_body_too_large" }, 413);
    return c.json({ error_code: "template_setup_update_invalid" }, 400);
  }
  if (typeof body.source_listing_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.source_listing_id)
    || typeof body.source_artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.source_artifact_sha256)
    || typeof body.expected_artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expected_artifact_sha256)
    || !Number.isSafeInteger(body.expected_setup_revision) || Number(body.expected_setup_revision) < 0)
    return c.json({ error_code: "template_setup_update_invalid" }, 400);
  if (apply && body.confirmed !== true) return c.json({ error_code: "template_setup_update_confirmation_required" }, 400);
  if (apply && (!body.setup_values || typeof body.setup_values !== "object" || Array.isArray(body.setup_values)))
    return c.json({ error_code: "template_setup_update_values_required" }, 400);
  if (!apply && (body.setup_values !== undefined || body.clear_fields !== undefined || body.confirmed !== undefined))
    return c.json({ error_code: "template_setup_update_invalid" }, 400);
  if (!apply && body.confirmed !== undefined) return c.json({ error_code: "template_setup_update_invalid" }, 400);

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const token = await mintInternalToken(c.env.PLATFORM_SECRET, tenantId);
  const installationResponse = await stub.fetch(new Request(`http://space-do/blueprint-installations?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId })}`, {
    headers: { "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": token },
  }));
  if (!installationResponse.ok) return new Response(installationResponse.body, { status: installationResponse.status, headers: { "content-type": "application/json" } });
  const installationData = await installationResponse.json() as { installations?: Array<{
    blueprint_id: string; artifact_sha256: string; listing_id: string | null; setup_schema_version: 1 | 2 | null; setup_revision: number; status: string;
  }> };
  const installation = installationData.installations?.find(item => item.blueprint_id === blueprintId);
  if (!installation || installation.status !== "installed" || !installation.listing_id)
    return c.json({ error_code: "template_setup_update_installation_unavailable" }, 404);
  if (installation.artifact_sha256 !== body.expected_artifact_sha256 || installation.setup_revision !== body.expected_setup_revision)
    return c.json({ error_code: "template_setup_update_revision_conflict" }, 409);
  const candidate = await resolveTemplateSetupUpdate(c.env, tenantId, blueprintId, installation.listing_id,
    installation.artifact_sha256, installation.setup_schema_version, body.source_listing_id, body.source_artifact_sha256);
  if (!candidate) return c.json({ error_code: "template_setup_update_source_changed_or_unsupported" }, 409);
  if (apply && candidate.setupMigrations.some(migration => migration.operations.some(operation => operation.kind === "drop"))
    && body.confirm_data_loss !== true)
    return c.json({ error_code: "template_setup_update_data_loss_confirmation_required" }, 400);
  const path = apply ? "/blueprint-installation-setup-update/apply" : "/blueprint-installation-setup-update/preview";
  const response = await stub.fetch(new Request(`http://space-do${path}?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, blueprint_id: blueprintId })}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId,
      "x-naelao-role": role, "x-naelao-internal-token": token },
    body: JSON.stringify({ expected_artifact_sha256: installation.artifact_sha256, expected_listing_id: installation.listing_id,
      expected_setup_revision: installation.setup_revision, source_listing_id: candidate.sourceListingId,
      source_artifact_sha256: candidate.sourceArtifactSha256, setup_schema_version: candidate.setupSchemaVersion,
      setup_schema_groups: candidate.setupSchemaGroups, setup_migrations: candidate.setupMigrations,
      ...(body.owner_values !== undefined ? { owner_values: body.owner_values } : {}),
      ...(apply ? { confirmed: true, confirm_data_loss: body.confirm_data_loss === true, setup_values: body.setup_values,
        clear_fields: body.clear_fields ?? [] } : {}) }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

app.post("/spaces/:spaceId/blueprints/:blueprintId/setup-update-preview", c => handleTemplateSetupUpdate(c, false));
app.post("/spaces/:spaceId/blueprints/:blueprintId/setup-update-apply", c => handleTemplateSetupUpdate(c, true));

app.get("/spaces/:spaceId/blueprints/:blueprintId/activation-preview", async c => {
  const identity = getCallerIdentity(c), tenantId = identity.tenantId, spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  if (!identity.userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id,config_json FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first<{ id: string; config_json: string | null }>();
  if (!owned) throw notFound("Space");
  const selectedListing = selectedTemplateListingId(owned.config_json ?? null);
  if (selectedListing.kind === "invalid") return c.json({ error_code: "template_listing_selection_invalid" }, 409);
  const listingId = selectedListing.kind === "selected" ? selectedListing.listingId : null;
  const value = await loadCertifiedBlueprint(c.env, tenantId, c.req.param("blueprintId"));
  if (!value) throw notFound("Blueprint");
  const blueprint = value.blueprint, artifact = { ...blueprint } as SpaceBlueprint & { securityRating?: unknown };
  delete artifact.securityRating;
  if (!await verifyArtifactCertificate(artifact, value.conformanceCertificate, c.env.PLATFORM_SECRET, "state-delta")) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  if (value.conformanceCertificate.issuerTenantId !== tenantId) {
    const fork = await c.env.PLATFORM_DB.prepare(`SELECT f.certificate_json,f.artifact_json FROM marketplace_forks f JOIN marketplace_listings l ON l.id=f.listing_id WHERE f.tenant_id=? AND f.blueprint_id=? AND (? IS NULL OR f.listing_id=?) AND l.status='published' LIMIT 1`).bind(tenantId, blueprint.id, listingId, listingId).first<{ certificate_json: string; artifact_json: string }>();
    if (!fork) return c.json({ error_code: "template_license_required" }, 402);
    try {
      const certificate = JSON.parse(fork.certificate_json) as ConformanceCertificate;
      if (certificate.signature !== value.conformanceCertificate.signature || JSON.stringify(JSON.parse(fork.artifact_json)) !== JSON.stringify(blueprint)) return c.json({ error_code: "template_license_mismatch" }, 403);
    } catch { return c.json({ error_code: "template_license_mismatch" }, 403); }
  }
  const security = evaluateBlueprintSecurity(blueprint);
  if (!security.publishable) return c.json({ error_code: "blueprint_rejected", security }, 422);
  try { instantiateBlueprint(blueprint, spaceId); }
  catch (error) { return c.json({ error_code: "blueprint_invalid", message: (error as Error).message.slice(0, 240) }, 422); }
  const hasRuntimeRequirements = blueprint.projects.some(project => project.runtimeRequirements?.length);
  const runtimeCatalogue = hasRuntimeRequirements ? await getPlanAwareRuntimeCatalogue(c.env, tenantId) : null;
  const runtimeReadiness = runtimeCatalogue ? blueprintRuntimeInstallability(blueprint, runtimeCatalogue.images, runtimeCatalogue.plan) : undefined;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const result = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: "__all__" })}`));
  if (!result.ok) return c.json({ error_code: "extension_readiness_unavailable" }, 503);
  const rows = await result.json<{ installations: Array<{ instance_id?: string; extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null; publisher_key_id?: string | null; activation_summary?: ExtensionActivationSummary }> }>();
  const trustedInstallations = await trustedExtensionInstallations(c.env, tenantId, spaceId, rows.installations ?? []);
  const preview = previewBlueprintActivation(blueprint, installedSpaceExtensionPins(trustedInstallations), await installableSpaceExtensionPins(), runtimeReadiness);
  const conversationsPerMonth = c.req.query("conversations_per_month"), interactionsPerConversation = c.req.query("interactions_per_conversation");
  let expectedUsage: ReturnType<typeof validateTemplateExpectedUsage> | undefined;
  if (conversationsPerMonth !== undefined || interactionsPerConversation !== undefined) {
    try {
      if (conversationsPerMonth === undefined || interactionsPerConversation === undefined) throw new Error("Both expected usage values are required");
      expectedUsage = validateTemplateExpectedUsage({ conversations_per_month: Number(conversationsPerMonth), interactions_per_conversation: Number(interactionsPerConversation) });
    } catch (error) { return c.json({ error_code: "template_expected_usage_invalid", message: (error as Error).message.slice(0, 160) }, 400); }
  }
  const costEstimate = await loadTemplateCostEstimate(c.env.PLATFORM_DB, tenantId, blueprint.id, listingId, new Date(), expectedUsage);
  return c.json({ ...preview, blueprint_id: blueprint.id, target_space_id: spaceId, security,
    evaluation: { passed: value.conformanceCertificate.passed, total: value.conformanceCertificate.total,
      evidence: value.conformanceCertificate.evidence ?? "literal-lint", issued_at: value.conformanceCertificate.issuedAt },
    cost_estimate: costEstimate,
  }, { headers: { "cache-control": "private, no-store" } });
});

async function handleTemplateSetupDraft(c: Context<{ Bindings: Env }>): Promise<Response> {
  const identity = getCallerIdentity(c), tenantId = identity.tenantId ?? "", userId = identity.userId ?? "";
  const spaceId = c.req.param("spaceId") ?? "", blueprintId = c.req.param("blueprintId") ?? "";
  if (!tenantId || !spaceId || !blueprintId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "forbidden" }, 403);
  if (!userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id,config_json FROM spaces WHERE id=? AND tenant_id=? AND status='active'")
    .bind(spaceId, tenantId).first<{ id: string; config_json: string | null }>();
  if (!owned) throw notFound("Space");
  let config: unknown;
  try { config = JSON.parse(owned.config_json ?? "{}"); } catch { return c.json({ error_code: "template_selection_invalid" }, 409); }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (config as { pending_blueprint_id?: unknown }).pending_blueprint_id !== blueprintId)
    return c.json({ error_code: "template_setup_not_pending" }, 409);
  const selected = selectedTemplateListingId(owned.config_json);
  if (selected.kind === "invalid") return c.json({ error_code: "template_listing_selection_invalid" }, 409);
  if (selected.kind !== "selected") return c.json({ error_code: "template_listing_selection_required" }, 409);

  const value = await loadCertifiedBlueprint(c.env, tenantId, blueprintId);
  if (!value) throw notFound("Blueprint");
  const blueprint = value.blueprint, artifact = { ...blueprint } as SpaceBlueprint & { securityRating?: unknown };
  delete artifact.securityRating;
  if (!await verifyArtifactCertificate(artifact, value.conformanceCertificate, c.env.PLATFORM_SECRET, "state-delta"))
    return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  const fork = await c.env.PLATFORM_DB.prepare(`SELECT f.certificate_json,f.artifact_json FROM marketplace_forks f
    JOIN marketplace_listings l ON l.id=f.listing_id WHERE f.tenant_id=? AND f.blueprint_id=? AND f.listing_id=? AND l.status='published' LIMIT 1`)
    .bind(tenantId, blueprintId, selected.listingId).first<{ certificate_json: string; artifact_json: string }>();
  if (!fork) return c.json({ error_code: "template_license_required" }, 402);
  try {
    const forkCertificate = JSON.parse(fork.certificate_json) as ConformanceCertificate;
    if (forkCertificate.signature !== value.conformanceCertificate.signature || JSON.stringify(JSON.parse(fork.artifact_json)) !== JSON.stringify(blueprint))
      return c.json({ error_code: "template_license_mismatch" }, 403);
  } catch { return c.json({ error_code: "template_license_mismatch" }, 403); }
  if (!evaluateBlueprintSecurity(blueprint).publishable) return c.json({ error_code: "blueprint_rejected" }, 422);
  let setupSchema: ReturnType<typeof validateBlueprintSetupSchema>;
  try { instantiateBlueprint(blueprint, spaceId); setupSchema = validateBlueprintSetupSchema(blueprint); }
  catch (error) { return c.json({ error_code: "blueprint_invalid", message: (error as Error).message.slice(0, 240) }, 422); }
  const digest = async (input: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const artifactSha256 = await digest(JSON.stringify(blueprint));
  const setupSchemaSha256 = await digest(JSON.stringify(setupSchema));
  const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, blueprint_id: blueprintId,
    listing_id: selected.listingId, artifact_sha256: artifactSha256,
    setup_schema_version: blueprint.setupSchemaVersion === undefined ? "null" : String(blueprint.setupSchemaVersion),
    setup_schema_sha256: setupSchemaSha256 });
  let body: string | undefined;
  if (c.req.method === "PUT") {
    try {
      const bytes = await readBoundedRequestBytes(c.req.raw, 64 * 1024);
      const submitted = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)
        || Object.keys(submitted).some(key => !["values", "expected_revision", "replace_context"].includes(key))) throw new Error("invalid_draft_body");
      body = JSON.stringify({ ...submitted, schema: setupSchema });
    } catch { return c.json({ error_code: "template_setup_draft_invalid" }, 400); }
  }
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "owner_or_admin_required" }, 403);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space-do/template-setup-draft?${query}`, {
    method: c.req.method,
    headers: { "content-type": "application/json", "x-naelao-user-id": userId, "x-naelao-role": role,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    ...(body ? { body } : {}),
  }));
}

app.get("/spaces/:spaceId/blueprints/:blueprintId/setup-draft", handleTemplateSetupDraft);
app.put("/spaces/:spaceId/blueprints/:blueprintId/setup-draft", handleTemplateSetupDraft);

app.post("/spaces/:spaceId/blueprints/:blueprintId/activate", async (c) => {
  const identity = getCallerIdentity(c);
  const tenantId = identity.tenantId;
  const spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) {
    return c.json({ error_code: "forbidden", message: "A verified Naelao session is required" }, 403);
  }
  if (!identity.userId) return c.json({ error_code: "human_activation_required" }, 403);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id,config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first<{ id: string; config_json: string | null }>();
  if (!owned) throw notFound("Space");
  const selectedListing = selectedTemplateListingId(owned.config_json ?? null);
  if (selectedListing.kind === "invalid") return c.json({ error_code: "template_listing_selection_invalid" }, 409);
  const listingId = selectedListing.kind === "selected" ? selectedListing.listingId : null;
  const requestBody = await c.req.json<{ approved_shared_filesystem?: unknown; setup_values?: unknown }>().catch(() => ({} as { approved_shared_filesystem?: unknown; setup_values?: unknown }));
  const storedValue = await loadCertifiedBlueprint(c.env, tenantId, c.req.param("blueprintId"));
  if (!storedValue) throw notFound("Blueprint");
  const certifiedBlueprint = storedValue.blueprint;
  const artifactForVerification = certifiedBlueprint ? { ...certifiedBlueprint } : {};
  delete (artifactForVerification as SpaceBlueprint & { securityRating?: unknown }).securityRating;
  if (!await verifyArtifactCertificate(
    artifactForVerification,
    storedValue.conformanceCertificate,
    c.env.PLATFORM_SECRET,
    "state-delta",
  )) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  const blueprint = certifiedBlueprint!;
  let setupValues: BlueprintSetupValues;
  try { setupValues = validateBlueprintSetupValues(blueprint, requestBody.setup_values ?? {}); }
  catch (error) { return c.json({ error_code: "template_setup_values_invalid", message: (error as Error).message.slice(0, 240) }, 400); }
  const approvedFilesystem = new Map<string, Array<{ path: string; access: "READ" | "READ_WRITE" }>>();
  if (requestBody.approved_shared_filesystem !== undefined) {
    const raw = requestBody.approved_shared_filesystem;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 128)
      return c.json({ error_code: "shared_filesystem_approval_invalid" }, 400);
    for (const [extensionId, grants] of Object.entries(raw as Record<string, unknown>)) {
      if (!(blueprint.requiredExtensions ?? []).includes(extensionId) || !Array.isArray(grants) || grants.length > 64
        || grants.some(item => !item || typeof item !== "object" || Array.isArray(item)
          || typeof (item as { path?: unknown }).path !== "string"
          || !["READ", "READ_WRITE"].includes(String((item as { access?: unknown }).access)))
        || new Set(grants.map(item => (item as { path: string }).path)).size !== grants.length)
        return c.json({ error_code: "shared_filesystem_approval_invalid", extension_id: extensionId }, 400);
      approvedFilesystem.set(extensionId, grants as Array<{ path: string; access: "READ" | "READ_WRITE" }>);
    }
  }
  // A valid publisher receipt alone does not grant every tenant a template license.
  // Publisher-owned exports may be activated directly; imported artifacts need a
  // tenant-scoped fork/entitlement created by the marketplace billing path.
  if (storedValue.conformanceCertificate.issuerTenantId !== tenantId) {
    const fork = await c.env.PLATFORM_DB.prepare(
      `SELECT f.certificate_json, f.artifact_json
       FROM marketplace_forks f JOIN marketplace_listings l ON l.id = f.listing_id
       WHERE f.tenant_id = ? AND f.blueprint_id = ? AND (? IS NULL OR f.listing_id = ?) AND l.status = 'published' LIMIT 1`
    ).bind(tenantId, c.req.param("blueprintId"), listingId, listingId).first<{ certificate_json: string; artifact_json: string }>();
    if (!fork) return c.json({ error_code: "template_license_required" }, 402);
    try {
      const forkCertificate = JSON.parse(fork.certificate_json) as ConformanceCertificate;
      const forkArtifact = JSON.parse(fork.artifact_json) as SpaceBlueprint;
      if (forkCertificate.signature !== storedValue.conformanceCertificate.signature ||
          JSON.stringify(forkArtifact) !== JSON.stringify(blueprint)) {
        return c.json({ error_code: "template_license_mismatch" }, 403);
      }
    } catch {
      return c.json({ error_code: "template_license_mismatch" }, 403);
    }
  }
  const security = evaluateBlueprintSecurity(blueprint);
  if (!security.publishable) return c.json({ error_code: "blueprint_rejected", security }, 422);
  try { instantiateBlueprint(blueprint, spaceId); }
  catch (error) { return c.json({ error_code: "blueprint_invalid", message: (error as Error).message.slice(0, 240) }, 422); }
  const hasRuntimeRequirements = blueprint.projects.some(project => project.runtimeRequirements?.length);
  const runtimeCatalogue = hasRuntimeRequirements ? await getPlanAwareRuntimeCatalogue(c.env, tenantId) : null;
  const runtimeReadiness = runtimeCatalogue ? blueprintRuntimeInstallability(blueprint, runtimeCatalogue.images, runtimeCatalogue.plan) : undefined;
  const targetId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
  const dependenciesResponse = await c.env.SPACE_DO.get(targetId).fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: "__all__" })}`));
  if (!dependenciesResponse.ok) return c.json({ error_code: "extension_readiness_unavailable" }, 503);
  const dependencies = await dependenciesResponse.json<{ installations: Array<{ instance_id?: string; extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null; publisher_key_id?: string | null; activation_summary?: ExtensionActivationSummary }> }>();
  const trustedDependencies = await trustedExtensionInstallations(c.env, tenantId, spaceId, dependencies.installations ?? []);
  const readiness = previewBlueprintActivation(blueprint, installedSpaceExtensionPins(trustedDependencies), await installableSpaceExtensionPins(), runtimeReadiness);
  if (!readiness.ready) {
    const runtimeBlockers = readiness.blockers.filter(blocker => blocker.startsWith("required_runtime_unavailable:"));
    if (runtimeBlockers.length) return c.json({ error_code: "required_runtime_unavailable", runtime_requirements: readiness.runtime_requirements, blockers: runtimeBlockers }, 422);
    const connectionBlockers = readiness.blockers.filter(blocker => blocker.startsWith("required_space_extension_connection_unsupported:"));
    if (connectionBlockers.length) return c.json({ error_code: "required_extension_connection_unsupported", extension_connections: readiness.extension_connections, blockers: connectionBlockers }, 422);
    const pinBlockers = readiness.blockers.filter(blocker => blocker.startsWith("required_extension_version_unpinned:"));
    if (pinBlockers.length) return c.json({ error_code: "required_extension_version_unpinned", dependencies: readiness.dependencies, blockers: pinBlockers }, 422);
    return c.json({ error_code: "required_extension_unavailable", blockers: readiness.blockers }, 422);
  }
  const newlyInstalledDependencies: Array<{ extensionId: string; instanceId: string }> = [];
  const rollbackNewDependencies = async () => {
    const failures: string[] = [];
    for (const dependency of [...newlyInstalledDependencies].reverse()) {
      const removed = await c.env.SPACE_DO.get(targetId).fetch(new Request(`http://space-do/extension-installation?${new URLSearchParams({
        instance_id: dependency.instanceId, tenant_id: tenantId, space_id: spaceId,
      })}`, { method: "DELETE" }));
      if (!removed.ok) failures.push(dependency.extensionId);
    }
    return failures;
  };
  for (const extensionId of blueprint.requiredExtensions ?? []) {
    if (readiness.dependencies.some(dependency => dependency.extension_id === extensionId && dependency.status === "installed")) {
      continue;
    }
    if (!DOGFOOD_EXTENSION_BY_ID[extensionId]) continue;
    // Do not grant shared filesystem access until the template and its runtimes have installed.
    const installed = await installFirstPartySpaceExtension(c.env, tenantId, spaceId, "naelao-template", extensionId);
    if (!installed.ok) {
      const rollbackFailures = await rollbackNewDependencies();
      return c.json({ error_code: rollbackFailures.length ? "required_extension_install_rollback_failed" : "required_extension_install_failed",
        extension_id: extensionId, reason: installed.error, ...(rollbackFailures.length ? { rollback_failures: rollbackFailures } : {}) }, 503);
    }
    newlyInstalledDependencies.push({ extensionId, instanceId: installed.installationId });
  }
  const response = await c.env.SPACE_DO.get(targetId).fetch(new Request("http://space-do/blueprints/instantiate", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) }, body: JSON.stringify({ blueprint, target_space_id: spaceId, activation_key: blueprint.id, listing_id: listingId, setup_values: setupValues }),
  }));
  if (!response.ok) {
    const rollbackFailures = await rollbackNewDependencies();
    if (rollbackFailures.length) return c.json({ error_code: "template_activation_rollback_failed", rollback_failures: rollbackFailures }, 503);
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  }
  const activation = await response.clone().json<{ projectIds?: string[] }>().catch(() => ({} as { projectIds?: string[] }));
  if (hasRuntimeRequirements) {
    const projectIds = activation.projectIds ?? [];
    for (const [index, project] of blueprint.projects.entries()) {
      const projectId = projectIds[index];
      if (!projectId) return c.json({ error_code: "runtime_project_mapping_missing" }, 503);
      for (const requirement of project.runtimeRequirements ?? []) {
        if (!requirement.required) continue;
        const readinessItem = runtimeReadiness?.get(`${project.id ?? project.name}:${requirement.id}`);
        const runtime = runtimeCatalogue?.images.find(image => image.id === requirement.id);
        if (!readinessItem?.installable || !runtime?.install_manifest) return c.json({ error_code: "required_runtime_unavailable", project_id: project.id ?? project.name, runtime_id: requirement.id }, 422);
        const manifest = validateExtensionManifest(runtime.install_manifest, { gatekeeperCapabilities: ["native-execution"] });
        for (const contract of manifest.containers ?? []) {
          if (contract.networkPolicy && contract.networkPolicy !== "none" || contract.mounts?.some(mount => !mount.writable))
            return c.json({ error_code: "runtime_install_profile_unsupported", project_id: projectId, runtime_id: requirement.id }, 422);
          const deployedImage = runtimeCatalogue?.images.find(image => image.available && image.image === contract.image);
          const deployedProfile = deployedImage?.install_manifest
            ? validateExtensionManifest(deployedImage.install_manifest).containers?.find(item => item.image === contract.image)
            : undefined;
          if (!deployedProfile || contract.resources.memoryMb > deployedProfile.resources.memoryMb || contract.resources.cpuCores > deployedProfile.resources.cpuCores)
            return c.json({ error_code: "runtime_image_not_approved", project_id: projectId, runtime_id: requirement.id }, 422);
        }
        const projectResponse = await c.env.SPACE_DO.get(targetId).fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}`));
        if (!projectResponse.ok) return c.json({ error_code: "runtime_project_lookup_failed", project_id: projectId }, 503);
        const details = await projectResponse.json<{ execution_ceiling?: number }>();
        if ((details.execution_ceiling ?? 5) < 6) return c.json({ error_code: "container_execution_ceiling_exceeded", project_id: projectId }, 422);
        const installResponse = await c.env.SPACE_DO.get(targetId).fetch(new Request("http://space-do/extensions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId, spaceId,
            scope: "PROJECT_SHARED", projectId, gatekeeperCapabilities: ["native-execution"] }),
        }));
        if (!installResponse.ok) return c.json({ error_code: "required_runtime_install_failed", project_id: projectId, runtime_id: requirement.id }, 503);
      }
    }
  }
  for (const [extensionId, grants] of approvedFilesystem) {
    const latest = await c.env.SPACE_DO.get(targetId).fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: extensionId })}`));
    if (!latest.ok) return c.json({ error_code: "shared_filesystem_approval_failed", extension_id: extensionId }, 503);
    const installations = await latest.json<{ installations: Array<{ instance_id?: string; scope?: string; status?: string }> }>();
    const active = installations.installations?.find(item => item.scope === "SPACE_SHARED" && item.status === "active" && item.instance_id);
    if (!active?.instance_id) return c.json({ error_code: "shared_filesystem_installation_missing", extension_id: extensionId }, 409);
    const updated = await c.env.SPACE_DO.get(targetId).fetch(new Request("http://space-do/extension-shared-filesystem-grants", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
      body: JSON.stringify({ tenantId, spaceId, instanceId: active.instance_id, approvedBy: identity.userId, grants }),
    }));
    if (!updated.ok) return c.json({ error_code: "shared_filesystem_approval_failed", extension_id: extensionId }, 422);
  }
  await c.env.PLATFORM_DB.prepare("UPDATE spaces SET config_json=json_remove(COALESCE(config_json,'{}'),'$.pending_blueprint_id') WHERE id=? AND tenant_id=? AND json_extract(config_json,'$.pending_blueprint_id')=?")
    .bind(spaceId, tenantId, blueprint.id).run();
  const assistantEmailSetups:Array<{kind:"space"|"project";projectId?:string;status:"ready"|"deferred";errorCode?:string}>=[];
  if(c.env.AGENTS_WORKER){
    const targets:["space"|"project",string|undefined][]=[["space",undefined],...(activation.projectIds??[]).map(projectId=>["project",projectId] as ["project",string])];
    for(const [kind,projectId] of targets){
      const query=new URLSearchParams(projectId?{project_id:projectId}:{});
      try{
        const setup=await c.env.AGENTS_WORKER.fetch(new Request(`http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications${query.size?`?${query}`:""}`,{method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":tenantId,"x-naelao-user-id":identity.userId,"x-naelao-role":identity.role,"x-naelao-internal-token":await mintInternalToken(c.env.PLATFORM_SECRET,tenantId)},body:JSON.stringify({action:"identity"})}));
        if(setup.ok)assistantEmailSetups.push({kind,...(projectId?{projectId}:{}),status:"ready"});
        else{const failure=await setup.json<{managedInbox?:{error_code?:string};error_code?:string}>().catch(()=>({} as {managedInbox?:{error_code?:string};error_code?:string}));assistantEmailSetups.push({kind,...(projectId?{projectId}:{}),status:"deferred",errorCode:failure.managedInbox?.error_code??failure.error_code??`http_${setup.status}`});}
      }catch{assistantEmailSetups.push({kind,...(projectId?{projectId}:{}),status:"deferred",errorCode:"assistant_setup_unavailable"});}
    }
  }
  return Response.json({...((await response.json<Record<string,unknown>>().catch(()=>({})))),assistantEmailSetups},{status:response.status});
});

async function installFirstPartySpaceExtension(env: Env, tenantId: string, spaceId: string, installedBy: string, extensionId: string,
  approvedSharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }> = []): Promise<{ ok: true; installationId: string } | { ok: false; error: string }> {
  const source = DOGFOOD_EXTENSION_BY_ID[extensionId];
  if (!source) return { ok: false, error: "first_party_extension_not_found" };
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try { manifest = validateExtensionManifest(source, { gatekeeperCapabilities: source.capabilityRequirements }); }
  catch { return { ok: false, error: "first_party_manifest_invalid" }; }
  if (!manifest.gadgets.some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3)) return { ok: false, error: "space_shared_gadget_required" };
  const spaceStub = await spaceDoStub(env, spaceId, tenantId);
  const existingResponse = await spaceStub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({
    tenant_id: tenantId, space_id: spaceId, extension_id: extensionId,
  })}`));
  if (!existingResponse.ok) return { ok: false, error: "extension_installation_lookup_unavailable" };
  let existingBody: { installations?: Array<{ instance_id?: string; scope?: string; project_id?: string | null; instance_key?: string; status?: string }> };
  try { existingBody = await readBoundedResponseJson(existingResponse, 256 * 1024); }
  catch { return { ok: false, error: "extension_installation_lookup_unavailable" }; }
  const existing = existingBody.installations?.find(item => item.scope === "SPACE_SHARED" && item.project_id === null
    && (item.instance_key ?? "default") === "default" && item.instance_id);
  if (existing && existing.status !== "active") return { ok: false, error: "extension_installation_paused" };
  const installed = await spaceStub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy, tenantId, spaceId, scope: "SPACE_SHARED", approvedSharedFilesystem, gatekeeperCapabilities: manifest.capabilityRequirements }) }));
  if (!installed.ok) return { ok: false, error: "extension_installation_rejected" };
  const result = await installed.json<{ installationId?: string }>().catch(() => ({} as { installationId?: string }));
  if (!result.installationId) return { ok: false, error: "extension_installation_id_missing" };
  const html = DOGFOOD_EXTENSION_CANVASES[extensionId];
  if (html) {
    const workId = crypto.randomUUID();
    const lease = await extensionRuntimeWork(env, { action: "acquire", tenantId, spaceId, projectId: null,
      installationId: result.installationId, workId, workKind: "gadget" });
    if (lease.acquired !== true) {
      if (!existing) await spaceStub.fetch(new Request(`http://space-do/extension-installation?${new URLSearchParams({
        instance_id: result.installationId, tenant_id: tenantId, space_id: spaceId,
      })}`, { method: "DELETE" }));
      return { ok: false, error: lease.errorCode === "extension_installation_inactive" ? "extension_installation_paused" : "extension_runtime_work_unavailable" };
    }
    let initialized = true;
    try {
      for (const gadget of manifest.gadgets.filter(item => item.scope === "SPACE_SHARED" && item.gadgetTier === 3)) {
        const actor = gadgetActorId(env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId: gadget.id });
        const response = await env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: gadget.id, scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: gadget.defaultSchemaSql, migrations: gadget.migrations ?? [], html }) }));
        if (!response.ok) { initialized = false; break; }
      }
    } catch { initialized = false; }
    finally { await extensionRuntimeWork(env, { action: "release", tenantId, spaceId, projectId: null,
      installationId: result.installationId, workId, workKind: "gadget" }); }
    if (!initialized) {
      const removed = existing ? null : await spaceStub.fetch(new Request(`http://space-do/extension-installation?${new URLSearchParams({
        instance_id: result.installationId, tenant_id: tenantId, space_id: spaceId,
      })}`, { method: "DELETE" }));
      return { ok: false, error: removed?.ok === false ? "extension_canvas_initialization_rollback_failed" : "extension_canvas_initialization_failed" };
    }
  }
  return { ok: true, installationId: result.installationId };
}

type SpaceExtensionDependencyInstallRow = {
  instance_id?: string; extension_id: string; instance_key?: string; project_id: string | null; scope: string; status: string;
  release_version?: string | null; publisher_key_id?: string | null; publisher_attestation_valid?: boolean;
  manifest_sha256?: string | null; manifest?: unknown;
};
async function resolveSpaceExtensionDependencies(env: Env, tenantId: string, spaceId: string,
  manifest: ReturnType<typeof validateExtensionManifest>, scope: string, projectId?: string,
  suppliedRows?: SpaceExtensionDependencyInstallRow[]) {
  if (!manifest.dependencies?.length) return resolveExtensionDependencyClosure(manifest, []);
  let rows = suppliedRows;
  if (!rows) {
    const stub = await spaceDoStub(env, spaceId, tenantId);
    const response = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId,
      space_id: spaceId, extension_id: "__all__", include_manifest: "1", ...(projectId ? { project_id: projectId } : {}) })}`));
    if (!response.ok) return { resolved: false as const, error: "dependency_registry_unavailable" };
    const body = await readBoundedResponseJson<{ installations?: SpaceExtensionDependencyInstallRow[] }>(response, 2 * 1024 * 1024).catch(() => null);
    if (!body?.installations) return { resolved: false as const, error: "dependency_registry_unavailable" };
    rows = body.installations;
  }
  const visible = rows.filter(row => row.status === "active" && (
    scope === "SPACE_SHARED" ? row.scope === "SPACE_SHARED" && row.project_id === null
      : row.scope === "SPACE_SHARED" && row.project_id === null
        || row.project_id === projectId && ["PROJECT_BOUND", "PROJECT_SHARED"].includes(row.scope)));
  const trusted = await trustedExtensionInstallations(env, tenantId, spaceId, visible);
  const pins = trusted.flatMap(row => row.extension_id && row.release_version && row.manifest_sha256 && row.manifest
    ? [{ extensionId: row.extension_id, releaseVersion: row.release_version, manifestSha256: row.manifest_sha256, manifest: row.manifest }]
    : []);
  return resolveExtensionDependencyClosure(manifest, pins);
}

type SpacePackageInstallReviewNode = {
  extension_id: string; version: string; manifest_sha256: string; publisher_id: string; publisher_key_id: string;
  permissions: string[]; capabilities: string[]; shared_filesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
  connections: Array<{ id: string; provider: string; purpose: string; required: boolean }>;
  dependencies: Array<{ extensionId: string; version: string; manifestSha256: string }>;
  is_requested: boolean; installed_state: "installed_exact" | "installed_disabled" | "install_required" | "pin_conflict";
  installable: boolean; publisher_signature_verified: true;
};
type VerifiedSpacePackageRelease = {
  manifest: ReturnType<typeof validateExtensionManifest>; manifestJson: string; manifestSha256: string; artifactSha256: string;
  publisherId: string; publisherKeyId: string; publisherSignature: string; publisherPayloadSha256: string; artifactPaths: string[];
  permissions: string[]; capabilities: string[]; sharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
  connections: Array<{ id: string; provider: string; purpose: string; required: boolean }>;
  dependencies: Array<{ extensionId: string; version: string; manifestSha256: string }>;
  installable: boolean;
};

function normalizeSpacePackageReviewGrants(manifest: ReturnType<typeof validateExtensionManifest>, raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 64) return null;
  const requested = manifest.shared_filesystem ?? [];
  const grants: Array<{ path: string; access: "READ" | "READ_WRITE" }> = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const grant = value as Record<string, unknown>;
    if (typeof grant.path !== "string" || !(grant.access === "READ" || grant.access === "READ_WRITE")
      || !requested.some(item => item.path === grant.path && (item.access === grant.access || item.access === "READ_WRITE" && grant.access === "READ"))) return null;
    grants.push({ path: grant.path, access: grant.access });
  }
  if (new Set(grants.map(grant => grant.path)).size !== grants.length) return null;
  return grants.sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectSignedSpacePackageRelease(env: Env, tenantId: string, spaceId: string, extensionId: string,
  version: string, trustedSpaceIds: string[] = [spaceId]): Promise<{ ok: true; package: VerifiedSpacePackageRelease } | { ok: false; error: string }> {
  const stub = await spaceDoStub(env, spaceId, tenantId);
  const response = await stub.fetch(new Request(`http://space-do/extension-package-release?${new URLSearchParams({ extension_id: extensionId, version })}`));
  if (response.status === 404) return { ok: false, error: "release_not_found" };
  if (!response.ok) return { ok: false, error: "release_untrusted" };
  const payload = await readBoundedResponseJson<{ release?: { extension_id: string; version: string; manifest: unknown; manifest_json: string;
    artifact_sha256: string; publisher?: { id?: string; key_id?: string; signature?: string; payload_sha256?: string } } }>(response, 2 * 1024 * 1024).catch(() => null);
  const release = payload?.release;
  if (!release || release.extension_id !== extensionId || release.version !== version || !/^[a-f0-9]{64}$/.test(release.artifact_sha256)
    || typeof release.manifest_json !== "string" || typeof release.publisher?.id !== "string" || typeof release.publisher.key_id !== "string"
    || typeof release.publisher.signature !== "string" || typeof release.publisher.payload_sha256 !== "string")
    return { ok: false, error: "release_identity_invalid" };
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try { manifest = validateExtensionManifest(JSON.parse(release.manifest_json), { gatekeeperCapabilities: [...SPACE_SHARED_PACKAGE_CAPABILITIES] }); }
  catch { return { ok: false, error: "manifest_invalid" }; }
  if (JSON.stringify(manifest) !== release.manifest_json || manifest.id !== extensionId || manifest.bundle?.version !== version)
    return { ok: false, error: "manifest_pin_mismatch" };
  const trustSpaces = [...new Set(trustedSpaceIds)];
  if (!trustSpaces.includes(spaceId)) trustSpaces.unshift(spaceId);
  let publicKey: ArrayBuffer | null = null;
  for (const trustSpaceId of trustSpaces) {
    const publisher = await env.PLATFORM_DB.prepare(`SELECT publisher_id,public_key_b64url FROM extension_publisher_keys
      WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, trustSpaceId, release.publisher.key_id)
      .first<{ publisher_id: string; public_key_b64url: string }>();
    if (!publisher || publisher.publisher_id !== release.publisher.id) return { ok: false, error: "publisher_key_untrusted_or_revoked" };
    let candidateKey: ArrayBuffer;
    try { candidateKey = decodeExtensionPublisherPublicKey(publisher.public_key_b64url); }
    catch { return { ok: false, error: "publisher_key_invalid" }; }
    if (await extensionPublisherKeyId(candidateKey) !== release.publisher.key_id) return { ok: false, error: "publisher_key_id_mismatch" };
    if (publicKey) {
      const previousBytes = new Uint8Array(publicKey), candidateBytes = new Uint8Array(candidateKey);
      if (previousBytes.byteLength !== candidateBytes.byteLength || previousBytes.some((byte, index) => byte !== candidateBytes[index]))
        return { ok: false, error: "publisher_trust_key_mismatch" };
    }
    publicKey = candidateKey;
  }
  if (!publicKey) return { ok: false, error: "publisher_key_untrusted_or_revoked" };
  if (!env.SCRIPTS_R2) return { ok: false, error: "artifact_storage_unavailable" };
  const primitives = manifest.bundle?.primitives ?? [];
  const canvases = primitives.filter(part => part.kind === "canvas");
  const gadgets = primitives.filter(part => part.kind === "gadget");
  const channels = primitives.filter(part => part.kind === "channel");
  const connections = manifest.bundle?.connections ?? [];
  const pathCandidates = [
    ...canvases.map(part => part.component),
    ...channels.map(part => part.handlerScript),
  ];
  if (canvases.some(part => !/^\.\/[A-Za-z0-9._-]{1,128}\.html$/.test(part.component))
    || channels.some(part => !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(part.handlerScript)))
    return { ok: false, error: "artifact_path_unsupported" };
  const paths = [...new Set(pathCandidates)].sort();
  if (paths.length !== pathCandidates.length) return { ok: false, error: "artifact_path_conflict" };
  const artifacts: Record<string, string> = {};
  const entries: Array<[string, string]> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const object = await env.SCRIPTS_R2.get(`spaces/${spaceId}/extensions/${extensionId}/${version}/${path.slice(2)}`);
    const maxBytes = /\.(?:ts|js)$/.test(path) ? 262_144 : 512_000;
    if (!object || object.size < 1 || object.size > maxBytes) return { ok: false, error: "artifact_missing_or_invalid" };
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) return { ok: false, error: "artifact_size_mismatch" };
    totalBytes += bytes.byteLength;
    if (totalBytes > 2_000_000) return { ok: false, error: "artifact_size_limit" };
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { return { ok: false, error: "artifact_encoding_invalid" }; }
    artifacts[path] = source;
    entries.push([path, source]);
  }
  const artifactSha256 = await spacePackageReviewDigest(JSON.stringify(entries));
  if (artifactSha256 !== release.artifact_sha256) return { ok: false, error: "artifact_digest_mismatch" };
  let publisherPayload: string;
  try { publisherPayload = extensionPublisherSigningPayload(release.manifest_json, artifacts); }
  catch { return { ok: false, error: "publisher_payload_invalid" }; }
  if (await spacePackageReviewDigest(publisherPayload) !== release.publisher.payload_sha256
    || !await verifyExtensionPublisherRelease({ publicKeyRaw: publicKey, signature: release.publisher.signature,
      manifestJson: release.manifest_json, artifacts })) return { ok: false, error: "publisher_signature_invalid" };
  const providerAllowlist = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
  const installable = manifest.bundle?.id === extensionId && manifest.bundle.version === version
    && canvases.length > 0 && primitives.length <= 32
    && primitives.every(part => ["canvas", "gadget", "channel"].includes(part.kind))
    && !(manifest.containers?.length || manifest.daemons?.length || manifest.commands?.length || manifest.widgetSubscriptions?.length)
    && !(manifest.bundle?.workerRoles?.length)
    && !(manifest.gadgets ?? []).some(gadget => gadget.scope !== "SPACE_SHARED" || gadget.gadgetTier !== 3)
    && !manifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
    && !manifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
    && canvases.every(part => part.layout === "CanvasMount" && !part.dynamicPage && part.permissions.length === 0 && part.capabilityRequirements.length === 0)
    && gadgets.every(part => part.scope === "SPACE_SHARED" && part.permissions.length === 0 && part.capabilityRequirements.length === 0)
    && channels.every(part => part.context === "channel_only"
      && (part.provider === "phone" || Boolean(part.connectionId && connections.some(connection => connection.id === part.connectionId
        && connection.provider === part.provider && connection.required))))
    && channels.every(part => providerAllowlist.has(part.provider))
    && connections.every(connection => providerAllowlist.has(connection.provider)
      && channels.some(part => part.connectionId === connection.id && part.provider === connection.provider));
  return { ok: true, package: { manifest, manifestJson: release.manifest_json, manifestSha256: await digestExtensionManifest(manifest),
    artifactSha256: release.artifact_sha256, publisherId: release.publisher.id, publisherKeyId: release.publisher.key_id,
    publisherSignature: release.publisher.signature, publisherPayloadSha256: release.publisher.payload_sha256, artifactPaths: paths,
    permissions: [...new Set(manifest.declaredPermissions)].sort(),
    capabilities: [...new Set(manifest.capabilityRequirements)].sort(), sharedFilesystem: [...(manifest.shared_filesystem ?? [])],
    connections: (manifest.bundle?.connections ?? []).map(connection => ({ id: connection.id ?? "", provider: connection.provider ?? "",
      purpose: connection.purpose ?? "", required: connection.required === true })), dependencies: manifest.dependencies ?? [], installable } };
}

function spacePackageInstallReviewClaims(input: { tenantId: string; spaceId: string; actorId: string; extensionId: string; version: string;
  instanceKey: string; manifestSha256: string; dependencies: Array<{ extensionId: string; version: string; manifestSha256: string }>;
  approvedSharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>; expiresAt: number }) {
  return { version: 1, tenantId: input.tenantId, spaceId: input.spaceId, actorId: input.actorId, extensionId: input.extensionId,
    releaseVersion: input.version, instanceKey: input.instanceKey, manifestSha256: input.manifestSha256,
    dependencies: [...input.dependencies].sort((left, right) => left.extensionId.localeCompare(right.extensionId)),
    approvedSharedFilesystem: [...input.approvedSharedFilesystem].sort((left, right) => left.path.localeCompare(right.path)), expiresAt: input.expiresAt };
}

function encodeSpacePackageReviewToken(payload: string, signature: string): string {
  return `${btoa(payload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.${signature}`;
}
function decodeSpacePackageReviewToken(token: string): { payload: string; signature: string } | null {
  const split = token.lastIndexOf(".");
  if (split <= 0) return null;
  const encoded = token.slice(0, split), signature = token.slice(split + 1);
  if (!/^[a-f0-9]{64}$/.test(signature) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return { payload: atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), signature };
  } catch { return null; }
}

function spaceSharedExtensionUpdateClaims(input: { tenantId: string; spaceId: string; actorId: string; installationId: string;
  extensionId: string; fromVersion: string; toVersion: string; artifactSha256: string; publisherId: string; publisherKeyId: string;
  expiresAt: number; requestId: string }) {
  return { version: 1, purpose: "space_shared_extension_update", tenantId: input.tenantId, spaceId: input.spaceId,
    actorId: input.actorId, installationId: input.installationId, extensionId: input.extensionId,
    fromVersion: input.fromVersion, toVersion: input.toVersion, artifactSha256: input.artifactSha256, publisherId: input.publisherId,
    publisherKeyId: input.publisherKeyId, expiresAt: input.expiresAt, requestId: input.requestId };
}

async function installSignedSpaceExtension(env: Env, tenantId: string, spaceId: string, installedBy: string,
  extensionId: string, version: string, instanceKey: string,
  approvedSharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>, reviewToken?: string): Promise<{ ok: true; installationId: string } | { ok: false; error: string }> {
  if (!/^ext_[a-z0-9_-]{2,62}$/.test(extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || !/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return { ok: false, error: "extension_package_identity_invalid" };
  if (!env.SCRIPTS_R2) return { ok: false, error: "extension_artifact_storage_unavailable" };
  const spaceStub = await spaceDoStub(env, spaceId, tenantId);
  const releaseResponse = await spaceStub.fetch(new Request(`http://space-do/extension-package-release?${new URLSearchParams({ extension_id: extensionId, version })}`));
  if (releaseResponse.status === 404) return { ok: false, error: "extension_package_release_unavailable" };
  if (!releaseResponse.ok) return { ok: false, error: "extension_package_release_untrusted" };
  const payload = await readBoundedResponseJson<{ release?: { extension_id: string; version: string; manifest: unknown;
    manifest_json: string; artifact_sha256: string; publisher?: { id?: string; key_id?: string; signature?: string; payload_sha256?: string } } }>(releaseResponse, 2 * 1024 * 1024);
  const release = payload.release;
  if (!release || release.extension_id !== extensionId || release.version !== version || !/^[a-f0-9]{64}$/.test(release.artifact_sha256)
    || typeof release.manifest_json !== "string" || typeof release.publisher?.id !== "string" || typeof release.publisher.key_id !== "string"
    || typeof release.publisher.signature !== "string" || typeof release.publisher.payload_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(release.publisher.key_id)) return { ok: false, error: "extension_package_release_unavailable" };
  const trustedPublisher = await env.PLATFORM_DB.prepare(`SELECT publisher_id FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, release.publisher.key_id)
    .first<{ publisher_id: string }>();
  if (!trustedPublisher || trustedPublisher.publisher_id !== release.publisher.id)
    return { ok: false, error: "extension_publisher_key_untrusted_or_revoked" };

  let manifest: ReturnType<typeof validateExtensionManifest>;
  try { manifest = validateExtensionManifest(JSON.parse(release.manifest_json), { gatekeeperCapabilities: [...SPACE_SHARED_PACKAGE_CAPABILITIES] }); }
  catch { return { ok: false, error: "extension_package_manifest_invalid" }; }
  if (JSON.stringify(manifest) !== release.manifest_json) return { ok: false, error: "extension_package_manifest_digest_mismatch" };
  const bundle = manifest.bundle;
  const primitives = bundle?.primitives ?? [];
  const canvases = primitives.filter((part): part is Extract<typeof part, { kind: "canvas" }> => part.kind === "canvas");
  const gadgets = primitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget");
  const legacyGadgets = (manifest.gadgets ?? []).filter(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3);
  const channels = primitives.filter((part): part is Extract<typeof part, { kind: "channel" }> => part.kind === "channel");
  const connections = bundle?.connections ?? [];
  if (!bundle || bundle.id !== extensionId || bundle.version !== version || canvases.length === 0
    || primitives.length > 32 || primitives.some(part => !["canvas", "gadget", "channel"].includes(part.kind))
    || (manifest.containers?.length ?? 0) > 0 || (manifest.daemons?.length ?? 0) > 0 || (manifest.commands?.length ?? 0) > 0
    || (manifest.widgetSubscriptions?.length ?? 0) > 0 || (bundle.workerRoles?.length ?? 0) > 0
    || (manifest.gadgets ?? []).some(gadget => gadget.scope !== "SPACE_SHARED" || gadget.gadgetTier !== 3)
    || manifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
    || manifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
    || canvases.some(canvas => !/^\.\/[A-Za-z0-9._-]{1,128}\.html$/.test(canvas.component) || canvas.layout !== "CanvasMount"
      || canvas.dynamicPage || canvas.permissions.length > 0 || canvas.capabilityRequirements.length > 0)
    || gadgets.some(gadget => gadget.scope !== "SPACE_SHARED" || gadget.permissions.length > 0 || gadget.capabilityRequirements.length > 0)
    || channels.some(channel => channel.context !== "channel_only"
      || !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(channel.handlerScript)
      || channel.provider !== "phone" && (!channel.connectionId || !connections.some(connection => connection.id === channel.connectionId
        && connection.provider === channel.provider && connection.required))))
    return { ok: false, error: "extension_space_shared_package_contract_unsupported" };
  const providerAllowlist = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
  if (channels.some(channel => !providerAllowlist.has(channel.provider))
    || connections.some(connection => !providerAllowlist.has(connection.provider)
      || !channels.some(channel => channel.connectionId === connection.id && channel.provider === connection.provider)))
    return { ok: false, error: "extension_package_connection_contract_unsupported" };

  const paths = [...new Set([
    ...canvases.map(canvas => canvas.component), ...channels.map(channel => channel.handlerScript),
  ])].sort();
  if (paths.length !== canvases.length + channels.length) return { ok: false, error: "extension_package_artifact_path_conflict" };
  const artifacts: Array<[string, string]> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const object = await env.SCRIPTS_R2.get(`spaces/${spaceId}/extensions/${extensionId}/${version}/${path.slice(2)}`);
    const maxBytes = /\.(?:ts|js)$/.test(path) ? 262_144 : 512_000;
    if (!object || object.size < 1 || object.size > maxBytes) return { ok: false, error: "extension_package_artifact_missing_or_invalid" };
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) return { ok: false, error: "extension_package_artifact_size_mismatch" };
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return { ok: false, error: "extension_package_artifact_encoding_invalid" }; }
    totalBytes += bytes.byteLength;
    if (totalBytes > 2_000_000) return { ok: false, error: "extension_package_artifact_size_limit" };
    artifacts.push([path, source]);
  }
  const artifactDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(artifacts))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (artifactDigest !== release.artifact_sha256) return { ok: false, error: "extension_package_artifact_digest_mismatch" };

  const collisions = await spaceStub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId,
    extension_id: "__all__", include_manifest: "1" })}`));
  if (!collisions.ok) return { ok: false, error: "extension_installation_lookup_unavailable" };
  const installed = await readBoundedResponseJson<{ installations?: Array<{ instance_id?: string; extension_id: string; instance_key?: string; scope: string;
    status: string; project_id: string | null; publisher_key_id?: string | null; publisher_attestation_valid?: boolean;
    release_version?: string | null; manifest_sha256?: string | null; manifest?: ReturnType<typeof validateExtensionManifest>;
    activation_summary?: { approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }> } }> }>(collisions, 2 * 1024 * 1024);
  const dependencyClosure = await resolveSpaceExtensionDependencies(env, tenantId, spaceId, manifest, "SPACE_SHARED", undefined, installed.installations ?? []);
  if (!dependencyClosure.resolved) return { ok: false, error: `extension_package_${dependencyClosure.error}` };
  if (manifest.dependencies?.length) {
    const decoded = reviewToken && reviewToken.length <= 16_384 ? decodeSpacePackageReviewToken(reviewToken) : null;
    if (!decoded || !await verifyHmac(decoded.payload, decoded.signature, env.PLATFORM_SECRET))
      return { ok: false, error: "extension_package_dependency_review_required" };
    let claims: ReturnType<typeof spacePackageInstallReviewClaims> | null = null;
    try { claims = JSON.parse(decoded.payload) as ReturnType<typeof spacePackageInstallReviewClaims>; } catch { /* invalid review token */ }
    const expiresAt = claims?.expiresAt ?? 0;
    const expected = spacePackageInstallReviewClaims({ tenantId, spaceId, actorId: installedBy, extensionId, version, instanceKey,
      manifestSha256: await digestExtensionManifest(manifest), dependencies: dependencyClosure.dependencies,
      approvedSharedFilesystem, expiresAt });
    if (!claims || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000 || JSON.stringify(claims) !== JSON.stringify(expected))
      return { ok: false, error: "extension_package_dependency_review_stale" };
  }
  const prior = installed.installations?.find(row => row.extension_id === extensionId && row.instance_key === instanceKey
    && row.scope === "SPACE_SHARED" && ["active", "disabled", "staging"].includes(row.status ?? ""));
  let approvedGrants = approvedSharedFilesystem;
  if (prior) {
    if (prior.release_version === version && prior.status === "active" && prior.instance_id) return { ok: true, installationId: prior.instance_id };
    if (prior.release_version !== version || prior.status !== "staging" || !prior.instance_id)
      return { ok: false, error: "extension_shared_installation_update_requires_review" };
    // A lost response or transient failure may leave the deterministic installation in staging.
    // Resume only that exact pin, preserving its already approved grants and reinitializing the
    // same app actors idempotently before the host activation check.
    approvedGrants = prior.activation_summary?.approved_shared_filesystem ?? [];
  }
  const appIds = new Set<string>();
  for (const row of installed.installations ?? []) {
    if (row.scope !== "SPACE_SHARED" || !["active", "disabled", "staging"].includes(row.status ?? "")) continue;
    if (row.instance_id === prior?.instance_id) continue;
    const prefix = row.instance_key && row.instance_key !== "default" ? `${row.instance_key}_` : "";
    for (const primitive of row.manifest?.bundle?.primitives ?? []) if (primitive.kind === "canvas" || primitive.kind === "gadget") appIds.add(`${prefix}${primitive.id}`);
    for (const gadget of row.manifest?.gadgets ?? []) if (gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3) appIds.add(`${prefix}${gadget.id}`);
  }
  const appIdsForPackage = [...canvases, ...gadgets, ...legacyGadgets].map(primitive => `${instanceKey === "default" ? "" : `${instanceKey}_`}${primitive.id}`);
  if (new Set(appIdsForPackage).size !== appIdsForPackage.length || appIdsForPackage.some(id => appIds.has(id)))
    return { ok: false, error: "extension_shared_canvas_id_conflict" };

  const manifestJson = release.manifest_json;
  const installedResponse = await spaceStub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy, tenantId, spaceId, scope: "SPACE_SHARED", instanceKey,
      approvedSharedFilesystem: approvedGrants, gatekeeperCapabilities: manifest.capabilityRequirements, artifactSha256: artifactDigest,
      publisherId: release.publisher.id, publisherKeyId: release.publisher.key_id,
      publisherSignature: release.publisher.signature, publisherPayloadSha256: release.publisher.payload_sha256, deferActivation: true,
    }) }));
  if (!installedResponse.ok) return { ok: false, error: "extension_installation_rejected" };
  const installedResult = await readBoundedResponseJson<{ installationId?: string; release?: { version?: string; artifactSha256?: string; hostSignature?: string } }>(installedResponse.clone(), 64 * 1024);
  const abort = async () => {
    if (!installedResult.installationId) return;
    await spaceStub.fetch(new Request("http://space-do/extension-installation/abort", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
      body: JSON.stringify({ installationId: installedResult.installationId, tenantId, spaceId, scope: "SPACE_SHARED" }) })).catch(() => undefined);
  };
  if (!installedResult.installationId || installedResult.release?.version !== version
    || installedResult.release.artifactSha256 !== artifactDigest || !/^[a-f0-9]{64}$/.test(installedResult.release.hostSignature ?? "")) {
    await abort();
    return { ok: false, error: "extension_runtime_release_attestation_unavailable" };
  }
  const fail = async (error: string) => { await abort(); return { ok: false as const, error }; };
  const appId = (primitiveId: string) => `${instanceKey === "default" ? "" : `${instanceKey}_`}${primitiveId}`;
  for (const canvas of canvases) {
    const html = artifacts.find(([path]) => path === canvas.component)?.[1];
    if (typeof html !== "string") return fail("extension_package_canvas_artifact_missing");
    const canvasSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hostSignature = installedResult.release.hostSignature;
    const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactDigest, hostSignature, canvas.component, canvasSha256]);
    const releaseProof = { extensionId, version, manifestJson, artifactSha256: artifactDigest, hostSignature,
      canvasPath: canvas.component, canvasSha256, bindingSignature: await signHmac(bindingPayload, env.PLATFORM_SECRET) };
    const actor = gadgetActorId(env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId: appId(canvas.id) });
    const initialized = await env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: appId(canvas.id), scope: "SPACE_SHARED", gadgetTier: 3, html, releaseProof }) }));
    if (!initialized.ok) return fail("extension_package_canvas_initialization_failed");
  }
  for (const gadget of gadgets) {
    const html = artifacts.find(([path]) => path === canvases[0]!.component)?.[1];
    if (typeof html !== "string") return fail("extension_package_canvas_artifact_missing");
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hostSignature = installedResult.release.hostSignature;
    const canvasPath = canvases[0]!.component;
    const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactDigest, hostSignature, canvasPath, sha256]);
    const releaseProof = { extensionId, version, manifestJson, artifactSha256: artifactDigest, hostSignature, canvasPath,
      canvasSha256: sha256, bindingSignature: await signHmac(bindingPayload, env.PLATFORM_SECRET) };
    const actor = gadgetActorId(env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId: appId(gadget.id) });
    const initialized = await env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: appId(gadget.id), scope: "SPACE_SHARED", gadgetTier: 3,
        defaultSchemaSql: gadget.schemaSql ?? "", migrations: gadget.migrations ?? [], html, releaseProof }) }));
    if (!initialized.ok) return fail("extension_package_gadget_initialization_failed");
  }
  for (const gadget of legacyGadgets) {
    const html = artifacts.find(([path]) => path === canvases[0]!.component)?.[1];
    if (typeof html !== "string") return fail("extension_package_canvas_artifact_missing");
    const canvasSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hostSignature = installedResult.release.hostSignature;
    const canvasPath = canvases[0]!.component;
    const bindingPayload = JSON.stringify([extensionId, version, manifestJson, artifactDigest, hostSignature, canvasPath, canvasSha256]);
    const releaseProof = { extensionId, version, manifestJson, artifactSha256: artifactDigest, hostSignature,
      canvasPath, canvasSha256, bindingSignature: await signHmac(bindingPayload, env.PLATFORM_SECRET) };
    const actor = gadgetActorId(env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId: appId(gadget.id) });
    const initialized = await env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: appId(gadget.id), scope: "SPACE_SHARED", gadgetTier: 3,
        defaultSchemaSql: gadget.defaultSchemaSql ?? "", migrations: gadget.migrations ?? [], html, releaseProof }) }));
    if (!initialized.ok) return fail("extension_package_gadget_initialization_failed");
  }
  const activePublisher = await env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND key_id=? AND publisher_id=? AND status='active'`)
    .bind(tenantId, spaceId, release.publisher.key_id, release.publisher.id).first();
  if (!activePublisher) return fail("extension_publisher_key_untrusted_or_revoked");
  const activation = await spaceStub.fetch(new Request("http://space-do/extension-installation/activate", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
      body: JSON.stringify({ installationId: installedResult.installationId, extensionId, version, artifactSha256: artifactDigest,
      tenantId, spaceId, scope: "SPACE_SHARED" }) }));
  if (!activation.ok) return fail("extension_runtime_activation_failed");
  return { ok: true, installationId: installedResult.installationId };
}

async function inspectSpacePackageDependencyClosure(env: Env, tenantId: string, spaceId: string,
  root: VerifiedSpacePackageRelease, trustedSpaceIds: string[] = [spaceId]): Promise<{ ok: true; packages: VerifiedSpacePackageRelease[];
    pins: Array<{ extensionId: string; releaseVersion: string; manifestSha256: string; manifest: unknown }>;
    dependencies: Array<{ extensionId: string; version: string; manifestSha256: string }> } | { ok: false; error: string }> {
  const requested = new Map<string, { version: string; manifestSha256: string }>();
  const visiting = new Set<string>([root.manifest.id]), visited = new Set<string>();
  const packages: VerifiedSpacePackageRelease[] = [], pins: Array<{ extensionId: string; releaseVersion: string; manifestSha256: string; manifest: unknown }> = [];
  let failure: string | null = null;
  const walk = async (manifest: ReturnType<typeof validateExtensionManifest>, depth: number): Promise<void> => {
    if (depth > 16 || visited.size > 32) { failure = "dependency_closure_limit_exceeded"; return; }
    for (const dependency of manifest.dependencies ?? []) {
      if (failure) return;
      const prior = requested.get(dependency.extensionId);
      if (prior && (prior.version !== dependency.version || prior.manifestSha256 !== dependency.manifestSha256)) {
        failure = "dependency_pin_conflict"; return;
      }
      requested.set(dependency.extensionId, { version: dependency.version, manifestSha256: dependency.manifestSha256 });
      if (visiting.has(dependency.extensionId)) { failure = "dependency_cycle"; return; }
      const key = `${dependency.extensionId}@${dependency.version}:${dependency.manifestSha256}`;
      if (visited.has(key)) continue;
      if (visited.size >= 32) { failure = "dependency_closure_limit_exceeded"; return; }
      const inspected = await inspectSignedSpacePackageRelease(env, tenantId, spaceId, dependency.extensionId, dependency.version, trustedSpaceIds);
      if (!inspected.ok) { failure = `dependency_${inspected.error}`; return; }
      if (inspected.package.manifestSha256 !== dependency.manifestSha256) { failure = "dependency_manifest_pin_mismatch"; return; }
      pins.push({ extensionId: dependency.extensionId, releaseVersion: dependency.version,
        manifestSha256: inspected.package.manifestSha256, manifest: inspected.package.manifest });
      visiting.add(dependency.extensionId);
      await walk(inspected.package.manifest, depth + 1);
      visiting.delete(dependency.extensionId);
      visited.add(key);
      packages.push(inspected.package);
    }
  };
  await walk(root.manifest, 0);
  if (failure) return { ok: false, error: failure };
  const resolved = await resolveExtensionDependencyClosure(root.manifest, pins);
  return resolved.resolved ? { ok: true, packages, pins, dependencies: resolved.dependencies } : { ok: false, error: resolved.error };
}

function spacePackageImportClaims(input: { tenantId: string; sourceSpaceId: string; destinationSpaceId: string; actorId: string;
  extensionId: string; version: string; packages: VerifiedSpacePackageRelease[]; expiresAt: number }) {
  return { version: 1, tenantId: input.tenantId, sourceSpaceId: input.sourceSpaceId, destinationSpaceId: input.destinationSpaceId,
    actorId: input.actorId, extensionId: input.extensionId, releaseVersion: input.version,
    packages: input.packages.map(pkg => ({ extensionId: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "",
      manifestSha256: pkg.manifestSha256, artifactSha256: pkg.artifactSha256, publisherId: pkg.publisherId, publisherKeyId: pkg.publisherKeyId }))
      .sort((left, right) => left.extensionId.localeCompare(right.extensionId)), expiresAt: input.expiresAt };
}

async function copyVerifiedSpacePackageRelease(env: Env, tenantId: string, sourceSpaceId: string, destinationSpaceId: string,
  pkg: VerifiedSpacePackageRelease): Promise<{ ok: true; copied: number; already_present: number } | { ok: false; error: string }> {
  const extensionId = pkg.manifest.id, version = pkg.manifest.bundle?.version ?? "";
  const inspected = await inspectSignedSpacePackageRelease(env, tenantId, sourceSpaceId, extensionId, version, [sourceSpaceId, destinationSpaceId]);
  if (!inspected.ok) return { ok: false, error: inspected.error };
  const current = inspected.package;
  if (current.manifestSha256 !== pkg.manifestSha256 || current.artifactSha256 !== pkg.artifactSha256
    || current.publisherKeyId !== pkg.publisherKeyId || current.publisherSignature !== pkg.publisherSignature)
    return { ok: false, error: "release_changed_since_review" };
  if (!env.SCRIPTS_R2) return { ok: false, error: "artifact_storage_unavailable" };
  const entries: Array<[string, string]> = [];
  const sources = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const path of current.artifactPaths) {
    const key = `spaces/${sourceSpaceId}/extensions/${extensionId}/${version}/${path.slice(2)}`;
    const object = await env.SCRIPTS_R2.get(key);
    if (!object || object.size < 1 || object.size > (path.endsWith(".html") ? 512_000 : 262_144)) return { ok: false, error: "artifact_missing_or_invalid" };
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== object.size) return { ok: false, error: "artifact_size_mismatch" };
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { return { ok: false, error: "artifact_encoding_invalid" }; }
    entries.push([path, source]);
    sources.set(path, { bytes, contentType: path.endsWith(".html") ? "text/html; charset=utf-8"
      : path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/typescript; charset=utf-8" });
  }
  const artifactSha256 = await spacePackageReviewDigest(JSON.stringify(entries));
  const payload = extensionPublisherSigningPayload(current.manifestJson, Object.fromEntries(entries));
  if (artifactSha256 !== current.artifactSha256 || await spacePackageReviewDigest(payload) !== current.publisherPayloadSha256)
    return { ok: false, error: "artifact_digest_mismatch" };
  const keyRow = await env.PLATFORM_DB.prepare(`SELECT publisher_id,public_key_b64url FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, destinationSpaceId, current.publisherKeyId)
    .first<{ publisher_id: string; public_key_b64url: string }>();
  if (!keyRow || keyRow.publisher_id !== current.publisherId) return { ok: false, error: "destination_publisher_key_untrusted_or_revoked" };
  let publicKey: ArrayBuffer;
  try { publicKey = decodeExtensionPublisherPublicKey(keyRow.public_key_b64url); }
  catch { return { ok: false, error: "destination_publisher_key_invalid" }; }
  if (await extensionPublisherKeyId(publicKey) !== current.publisherKeyId
    || !await verifyExtensionPublisherRelease({ publicKeyRaw: publicKey, signature: current.publisherSignature,
      manifestJson: current.manifestJson, artifacts: Object.fromEntries(entries) }))
    return { ok: false, error: "destination_publisher_signature_invalid" };

  let copied = 0, alreadyPresent = 0;
  for (const [path, source] of sources) {
    const destinationKey = `spaces/${destinationSpaceId}/extensions/${extensionId}/${version}/${path.slice(2)}`;
    const existing = await env.SCRIPTS_R2.get(destinationKey);
    if (existing) {
      const existingBytes = new Uint8Array(await existing.arrayBuffer());
      if (existingBytes.byteLength !== source.bytes.byteLength || existingBytes.some((byte, index) => byte !== source.bytes[index]))
        return { ok: false, error: "destination_artifact_immutable_conflict" };
      alreadyPresent++;
      continue;
    }
    const result = await env.SCRIPTS_R2.put(destinationKey, source.bytes, { onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { sha256: await spacePackageReviewDigest(new TextDecoder().decode(source.bytes)), size: String(source.bytes.byteLength) },
      httpMetadata: { contentType: source.contentType } });
    if (!result) {
      const raced = await env.SCRIPTS_R2.get(destinationKey);
      if (!raced) return { ok: false, error: "destination_artifact_write_conflict" };
      const racedBytes = new Uint8Array(await raced.arrayBuffer());
      if (racedBytes.byteLength !== source.bytes.byteLength || racedBytes.some((byte, index) => byte !== source.bytes[index]))
        return { ok: false, error: "destination_artifact_immutable_conflict" };
      alreadyPresent++;
      continue;
    }
    copied++;
    await reportExtensionArtifactWrite(env, { tenantId, spaceId: destinationSpaceId, bundleId: extensionId, version, path: path.slice(2), bytes: source.bytes.byteLength });
    const readback = await env.SCRIPTS_R2.get(destinationKey);
    if (!readback) return { ok: false, error: "destination_artifact_readback_missing" };
    const readbackBytes = new Uint8Array(await readback.arrayBuffer());
    if (readbackBytes.byteLength !== source.bytes.byteLength || readbackBytes.some((byte, index) => byte !== source.bytes[index]))
      return { ok: false, error: "destination_artifact_readback_mismatch" };
  }
  return { ok: true, copied, already_present: alreadyPresent };
}

async function persistImportedSpacePackageRelease(env: Env, tenantId: string, destinationSpaceId: string, importedBy: string,
  pkg: VerifiedSpacePackageRelease): Promise<{ ok: true; imported: boolean } | { ok: false; error: string }> {
  const stub = await spaceDoStub(env, destinationSpaceId, tenantId);
  const response = await stub.fetch(new Request("http://space-do/extension-package-release/import", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ tenantId, spaceId: destinationSpaceId, importedBy, extensionId: pkg.manifest.id,
      version: pkg.manifest.bundle?.version, manifestJson: pkg.manifestJson, artifactSha256: pkg.artifactSha256,
      publisherId: pkg.publisherId, publisherKeyId: pkg.publisherKeyId, publisherSignature: pkg.publisherSignature,
      publisherPayloadSha256: pkg.publisherPayloadSha256 }) }));
  const result = await readBoundedResponseJson<{ imported?: boolean; error_code?: string }>(response, 16 * 1024).catch(() => null);
  return response.ok && typeof result?.imported === "boolean" ? { ok: true, imported: result.imported }
    : { ok: false, error: result?.error_code ?? "destination_release_persist_failed" };
}

async function installReviewedSpaceExtension(env: Env, tenantId: string, spaceId: string, installedBy: string, extensionId: string,
  version: string, instanceKey: string, approvedSharedFilesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>, reviewToken?: string):
  Promise<{ ok: true; installationId: string; dependencyInstallations: Array<{ extensionId: string; version: string; installationId: string }> }
    | { ok: false; error: string; dependencyInstallations?: Array<{ extensionId: string; version: string; installationId: string }> }> {
  const directInstall = async () => ({ ...(await installSignedSpaceExtension(env, tenantId, spaceId, installedBy,
    extensionId, version, instanceKey, approvedSharedFilesystem, reviewToken)), dependencyInstallations: [] });
  if (!reviewToken) return directInstall();
  const releaseStub = await spaceDoStub(env, spaceId, tenantId);
  const releaseResponse = await releaseStub.fetch(new Request(`http://space-do/extension-package-release?${new URLSearchParams({ extension_id: extensionId, version })}`));
  if (!releaseResponse.ok) return directInstall();
  const releasePayload = await readBoundedResponseJson<{ release?: { manifest_json?: string } }>(releaseResponse, 2 * 1024 * 1024).catch(() => null);
  let reviewedManifest: ReturnType<typeof validateExtensionManifest> | null = null;
  try { reviewedManifest = validateExtensionManifest(JSON.parse(releasePayload?.release?.manifest_json ?? "null")); } catch { /* delegate the precise failure to installer */ }
  if (!reviewedManifest?.dependencies?.length) return directInstall();
  const root = await inspectSignedSpacePackageRelease(env, tenantId, spaceId, extensionId, version);
  if (!root.ok) return { ok: false, error: `extension_package_${root.error}` };
  const grants = normalizeSpacePackageReviewGrants(root.package.manifest, approvedSharedFilesystem);
  if (!grants) return { ok: false, error: "extension_package_shared_filesystem_approval_invalid" };

  const closure = await inspectSpacePackageDependencyClosure(env, tenantId, spaceId, root.package);
  if (!closure.ok) return { ok: false, error: `extension_package_${closure.error}` };
  const decoded = reviewToken && reviewToken.length <= 16_384 ? decodeSpacePackageReviewToken(reviewToken) : null;
  if (!decoded || !await verifyHmac(decoded.payload, decoded.signature, env.PLATFORM_SECRET))
    return { ok: false, error: "extension_package_dependency_review_required" };
  let claims: ReturnType<typeof spacePackageInstallReviewClaims> | null = null;
  try { claims = JSON.parse(decoded.payload) as ReturnType<typeof spacePackageInstallReviewClaims>; } catch { /* invalid review receipt */ }
  const expiresAt = claims?.expiresAt ?? 0;
  const expected = spacePackageInstallReviewClaims({ tenantId, spaceId, actorId: installedBy, extensionId, version, instanceKey,
    manifestSha256: root.package.manifestSha256, dependencies: closure.dependencies, approvedSharedFilesystem: grants, expiresAt });
  if (!claims || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000 || JSON.stringify(claims) !== JSON.stringify(expected))
    return { ok: false, error: "extension_package_dependency_review_stale" };
  if (!root.package.installable || closure.packages.some(pkg => !pkg.installable))
    return { ok: false, error: "extension_space_shared_package_contract_unsupported" };

  const spaceStub = await spaceDoStub(env, spaceId, tenantId);
  const dependencyInstallations: Array<{ extensionId: string; version: string; installationId: string }> = [];
  for (const pkg of closure.packages) {
    const rowsResponse = await spaceStub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: tenantId,
      space_id: spaceId, extension_id: "__all__", include_manifest: "1" })}`));
    if (!rowsResponse.ok) return { ok: false, error: "extension_installation_lookup_unavailable", dependencyInstallations };
    const stored = await readBoundedResponseJson<{ installations?: SpaceExtensionDependencyInstallRow[] }>(rowsResponse, 2 * 1024 * 1024).catch(() => null);
    if (!stored?.installations) return { ok: false, error: "extension_installation_lookup_unavailable", dependencyInstallations };
    const trusted = await trustedExtensionInstallations(env, tenantId, spaceId, stored.installations);
    const existing = trusted.find(row => row.scope === "SPACE_SHARED" && row.project_id === null && row.status === "active"
      && row.extension_id === pkg.manifest.id && row.release_version === pkg.manifest.bundle?.version
      && row.manifest_sha256 === pkg.manifestSha256 && row.instance_id);
    if (existing?.instance_id) {
      dependencyInstallations.push({ extensionId: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "", installationId: existing.instance_id });
      continue;
    }
    let dependencyToken: string | undefined;
    if (pkg.manifest.dependencies?.length) {
      const packageClosure = await resolveExtensionDependencyClosure(pkg.manifest, closure.pins);
      if (!packageClosure.resolved) return { ok: false, error: `extension_package_${packageClosure.error}`, dependencyInstallations };
      const dependencyClaims = spacePackageInstallReviewClaims({ tenantId, spaceId, actorId: installedBy, extensionId: pkg.manifest.id,
        version: pkg.manifest.bundle?.version ?? "", instanceKey: "default", manifestSha256: pkg.manifestSha256,
        dependencies: packageClosure.dependencies, approvedSharedFilesystem: [], expiresAt });
      const payload = JSON.stringify(dependencyClaims);
      dependencyToken = encodeSpacePackageReviewToken(payload, await signHmac(payload, env.PLATFORM_SECRET));
    }
    const installed = await installSignedSpaceExtension(env, tenantId, spaceId, installedBy, pkg.manifest.id,
      pkg.manifest.bundle?.version ?? "", "default", [], dependencyToken);
    if (!installed.ok) return { ok: false, error: installed.error, dependencyInstallations };
    dependencyInstallations.push({ extensionId: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "", installationId: installed.installationId });
  }
  const installedRoot = await installSignedSpaceExtension(env, tenantId, spaceId, installedBy, extensionId, version, instanceKey, grants, reviewToken);
  return installedRoot.ok ? { ok: true, installationId: installedRoot.installationId, dependencyInstallations }
    : { ok: false, error: installedRoot.error, dependencyInstallations };
}

app.use("/spaces/:spaceId/shared-extensions/:extensionId/install", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extensions/:extensionId/install", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/shared-extensions/:extensionId/install", async c => {
  const spaceId = c.req.param("spaceId"), identity = getCallerIdentity(c);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ version?: unknown; instance_key?: unknown; approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
    dependency_review_token?: unknown }>()
    .catch((): { version?: unknown; instance_key?: unknown; approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
      dependency_review_token?: unknown } => ({}));
  if (body.version !== undefined && typeof body.version !== "string") return c.json({ error_code: "extension_package_version_invalid" }, 400);
  const grants = body.approved_shared_filesystem ?? [];
  const result = typeof body.version === "string"
    ? await installReviewedSpaceExtension(c.env, owned.tenantId, spaceId, identity.userId ?? "space-admin", c.req.param("extensionId"),
      body.version, typeof body.instance_key === "string" ? body.instance_key : "default", grants,
      typeof body.dependency_review_token === "string" ? body.dependency_review_token : undefined)
    : await installFirstPartySpaceExtension(c.env, owned.tenantId, spaceId, identity.userId ?? "space-admin", c.req.param("extensionId"), grants);
  if (result.ok) return c.json({ extension_id: c.req.param("extensionId"), installation_id: result.installationId,
    dependency_installations: "dependencyInstallations" in result ? result.dependencyInstallations : [], scope: "SPACE_SHARED" }, 201);
  const status = result.error === "first_party_extension_not_found" || result.error === "extension_package_release_unavailable" ? 404
    : result.error.includes("publisher_key_untrusted") ? 403
    : result.error.includes("dependency_registry_unavailable") ? 503
    : result.error.includes("conflict") || result.error.includes("mismatch") || result.error.includes("untrusted") || result.error.includes("paused")
      || result.error.includes("dependency") || result.error.includes("requires_review") ? 409
    : result.error.includes("unsupported") ? 422
    : result.error.includes("invalid") ? 400 : 503;
  return c.json({ error_code: result.error, dependency_installations: "dependencyInstallations" in result ? result.dependencyInstallations : [] }, status);
});

/** Load a Space owned by the caller's tenant (ownership gate only). */
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

// Generic directory of mounted Space-shared extension canvases. The shell discovers apps from
// installed manifests instead of maintaining product-specific routes or navigation entries.
app.use("/spaces/:spaceId/shared-extension-apps", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-apps", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/shared-extension-apps", async c => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return forwardToSpaceDO(stub, `/space-shared-extensions?${new URLSearchParams({ tenant_id: owned.tenantId, space_id: spaceId })}`, "GET");
});
app.use("/spaces/:spaceId/shared-extension-catalog", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-catalog", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/shared-extension-catalog", async c => {
  const spaceId = c.req.param("spaceId"), owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const firstParty = Object.values(DOGFOOD_EXTENSION_BY_ID)
    .filter(manifest => manifest.gadgets.some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3))
    .map(manifest => ({ id: manifest.id, name: manifest.gadgets.find(gadget => gadget.scope === "SPACE_SHARED")?.name ?? manifest.id,
      requested_shared_filesystem: manifest.shared_filesystem ?? [] }));
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const response = await stub.fetch(new Request("http://space-do/extension-package-catalog"));
  if (!response.ok) return c.json({ error_code: "extension_package_catalog_unavailable" }, 503);
  const packages = await readBoundedResponseJson<{ releases?: Array<{ extension_id: string; version: string; has_canvas: boolean;
    name: string; requested_shared_filesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
    dependencies?: Array<{ extensionId: string; version: string; manifestSha256: string }>;
    publisher?: { id?: string; key_id?: string } }> }>(response, 2 * 1024 * 1024);
  const activeKeys = await c.env.PLATFORM_DB.prepare(`SELECT publisher_id,key_id FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND status='active'`).bind(owned.tenantId, spaceId).all<{ publisher_id: string; key_id: string }>();
  const trusted = new Set(activeKeys.results.map(key => `${key.publisher_id}:${key.key_id}`));
  const firstPartyIds = new Set<string>(firstParty.map(item => item.id));
  const signed = (packages.releases ?? []).flatMap(release => {
    const publisherPair = `${release.publisher?.id ?? ""}:${release.publisher?.key_id ?? ""}`;
    if (!release.has_canvas || firstPartyIds.has(release.extension_id) || !trusted.has(publisherPair)) return [];
    return [{ id: release.extension_id, version: release.version, name: release.name,
      publisher_id: release.publisher?.id ?? "", requested_shared_filesystem: release.requested_shared_filesystem ?? [], dependencies: release.dependencies ?? [] }];
  });
  return c.json({ extensions: [...firstParty, ...signed] }, 200, { "cache-control": "private, no-store" });
});

const sharedExtensionInstallReviewPath = "/spaces/:spaceId/shared-extensions/:extensionId/install-review";
app.use(sharedExtensionInstallReviewPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionInstallReviewPath, requireSpaceMembership({ POST: "admin" }));
app.post(sharedExtensionInstallReviewPath, async c => {
  const spaceId = c.req.param("spaceId"), extensionId = c.req.param("extensionId"), identity = getCallerIdentity(c);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ version?: unknown; instance_key?: unknown; approved_shared_filesystem?: unknown }>()
    .catch(() => ({} as { version?: unknown; instance_key?: unknown; approved_shared_filesystem?: unknown }));
  const version = typeof body.version === "string" ? body.version : "";
  const instanceKey = typeof body.instance_key === "string" ? body.instance_key : "default";
  if (!/^ext_[a-z0-9_-]{2,62}$/.test(extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || !/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return c.json({ error_code: "extension_package_identity_invalid" }, 400);
  const rootRelease = await inspectSignedSpacePackageRelease(c.env, owned.tenantId, spaceId, extensionId, version);
  if (!rootRelease.ok) {
    const status = rootRelease.error === "release_not_found" ? 404 : rootRelease.error.includes("publisher_key_untrusted") ? 403 : 409;
    return c.json({ error_code: `extension_package_${rootRelease.error}` }, status);
  }
  const grants = normalizeSpacePackageReviewGrants(rootRelease.package.manifest, body.approved_shared_filesystem ?? []);
  if (!grants) return c.json({ error_code: "extension_package_shared_filesystem_approval_invalid" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const installationsResponse = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: owned.tenantId,
    space_id: spaceId, extension_id: "__all__", include_manifest: "1" })}`));
  if (!installationsResponse.ok) return c.json({ error_code: "extension_package_installation_lookup_unavailable" }, 503);
  const stored = await readBoundedResponseJson<{ installations?: SpaceExtensionDependencyInstallRow[] }>(installationsResponse, 2 * 1024 * 1024).catch(() => null);
  if (!stored?.installations) return c.json({ error_code: "extension_package_installation_lookup_unavailable" }, 503);
  const trustedInstallations = await trustedExtensionInstallations(c.env, owned.tenantId, spaceId, stored.installations);
  const scopedInstallations = trustedInstallations.filter(row => row.scope === "SPACE_SHARED" && row.project_id === null);
  const installedState = (pkg: VerifiedSpacePackageRelease, isRoot: boolean): SpacePackageInstallReviewNode["installed_state"] => {
    const candidates = scopedInstallations.filter(row => row.extension_id === pkg.manifest.id
      && (isRoot ? row.instance_key === instanceKey : true));
    if (candidates.some(row => row.status === "active" && row.release_version === pkg.manifest.bundle?.version && row.manifest_sha256 === pkg.manifestSha256)) return "installed_exact";
    if (candidates.some(row => row.status === "disabled" && row.release_version === pkg.manifest.bundle?.version && row.manifest_sha256 === pkg.manifestSha256)) return "installed_disabled";
    return candidates.length ? "pin_conflict" : "install_required";
  };
  const toNode = (pkg: VerifiedSpacePackageRelease, isRoot: boolean): SpacePackageInstallReviewNode => ({
    extension_id: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "", manifest_sha256: pkg.manifestSha256,
    publisher_id: pkg.publisherId, publisher_key_id: pkg.publisherKeyId, permissions: pkg.permissions, capabilities: pkg.capabilities,
    shared_filesystem: pkg.sharedFilesystem, connections: pkg.connections, dependencies: pkg.dependencies, is_requested: isRoot,
    installed_state: installedState(pkg, isRoot), installable: pkg.installable, publisher_signature_verified: true,
  });
  const requested = new Map<string, { version: string; manifestSha256: string }>();
  const candidatePins: Array<{ extensionId: string; releaseVersion: string; manifestSha256: string; manifest: unknown }> = [];
  const dependencyPackages = new Map<string, VerifiedSpacePackageRelease>();
  const unavailable: Array<{ extension_id: string; version: string; manifest_sha256: string; error: string }> = [];
  const visiting = new Set<string>([extensionId]);
  const visited = new Set<string>();
  let closureError: string | null = null;
  const walk = async (manifest: ReturnType<typeof validateExtensionManifest>, depth: number): Promise<void> => {
    if (depth > 16 || dependencyPackages.size > 32) { closureError = "dependency_closure_limit_exceeded"; return; }
    for (const dependency of manifest.dependencies ?? []) {
      if (closureError) return;
      const prior = requested.get(dependency.extensionId);
      if (prior && (prior.version !== dependency.version || prior.manifestSha256 !== dependency.manifestSha256)) { closureError = "dependency_pin_conflict"; return; }
      requested.set(dependency.extensionId, { version: dependency.version, manifestSha256: dependency.manifestSha256 });
      if (visiting.has(dependency.extensionId)) { closureError = "dependency_cycle"; return; }
      const key = `${dependency.extensionId}@${dependency.version}:${dependency.manifestSha256}`;
      if (visited.has(key)) continue;
      const inspected = await inspectSignedSpacePackageRelease(c.env, owned.tenantId, spaceId, dependency.extensionId, dependency.version);
      if (!inspected.ok) {
        unavailable.push({ extension_id: dependency.extensionId, version: dependency.version, manifest_sha256: dependency.manifestSha256, error: inspected.error });
        closureError = `dependency_${inspected.error}`;
        return;
      }
      if (inspected.package.manifestSha256 !== dependency.manifestSha256) {
        unavailable.push({ extension_id: dependency.extensionId, version: dependency.version, manifest_sha256: dependency.manifestSha256, error: "manifest_pin_mismatch" });
        closureError = "dependency_manifest_pin_mismatch";
        return;
      }
      dependencyPackages.set(dependency.extensionId, inspected.package);
      candidatePins.push({ extensionId: dependency.extensionId, releaseVersion: dependency.version,
        manifestSha256: inspected.package.manifestSha256, manifest: inspected.package.manifest });
      visiting.add(dependency.extensionId);
      await walk(inspected.package.manifest, depth + 1);
      visiting.delete(dependency.extensionId);
      visited.add(key);
    }
  };
  await walk(rootRelease.package.manifest, 0);
  const resolved = closureError ? { resolved: false as const, error: closureError }
    : await resolveExtensionDependencyClosure(rootRelease.package.manifest, candidatePins);
  const rootNode = toNode(rootRelease.package, true);
  const dependencyNodes = [...dependencyPackages.values()].map(pkg => toNode(pkg, false)).sort((left, right) => left.extension_id.localeCompare(right.extension_id));
  const dependenciesInstallable = resolved.resolved && dependencyNodes.every(node => node.installable
    && (node.installed_state === "installed_exact" || node.installed_state === "install_required"));
  const readyToInstall = rootRelease.package.installable && dependenciesInstallable;
  let reviewToken: string | undefined;
  let reviewExpiresAt: number | undefined;
  if (readyToInstall && identity.userId) {
    const expiresAt = Date.now() + 5 * 60_000;
    reviewExpiresAt = expiresAt;
    const claims = spacePackageInstallReviewClaims({ tenantId: owned.tenantId, spaceId, actorId: identity.userId, extensionId, version,
      instanceKey, manifestSha256: rootRelease.package.manifestSha256, dependencies: resolved.resolved ? resolved.dependencies : [],
      approvedSharedFilesystem: grants, expiresAt });
    const payload = JSON.stringify(claims);
    reviewToken = encodeSpacePackageReviewToken(payload, await signHmac(payload, c.env.PLATFORM_SECRET));
  }
  return c.json({ extension_id: extensionId, version, space_id: spaceId, requested_package: rootNode, dependency_packages: dependencyNodes,
    unavailable_dependencies: unavailable, dependency_resolution: resolved, ready_to_install: readyToInstall,
    ...(reviewToken ? { review_token: reviewToken, review_expires_at: reviewExpiresAt } : {}), mutates_installation: false }, 200,
    { "cache-control": "private, no-store" });
});

const sharedExtensionImportReviewPath = "/spaces/:spaceId/shared-extension-imports/review";
const sharedExtensionImportPath = "/spaces/:spaceId/shared-extension-imports";
for (const path of [sharedExtensionImportReviewPath, sharedExtensionImportPath]) {
  app.use(path, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use(path, requireSpaceMembership({ POST: "admin" }));
}

async function canAdministerSpace(env: Env, tenantId: string, spaceId: string,
  identity: ReturnType<typeof getCallerIdentity>): Promise<boolean> {
  const role = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserSpaceRole(env.PLATFORM_DB, spaceId, identity.userId, tenantId) : identity.role;
  return role === "owner" || role === "admin";
}

app.post(sharedExtensionImportReviewPath, async c => {
  const destinationSpaceId = c.req.param("spaceId"), identity = getCallerIdentity(c);
  const destination = await loadOwnedSpace(c, destinationSpaceId);
  if (!destination.ok) return c.json({ error_code: destination.error_code, message: destination.message }, destination.status);
  const body = await c.req.json<{ source_space_id?: unknown; extension_id?: unknown; version?: unknown; expected_manifest_sha256?: unknown }>()
    .catch(() => ({} as { source_space_id?: unknown; extension_id?: unknown; version?: unknown; expected_manifest_sha256?: unknown }));
  const sourceSpaceId = typeof body.source_space_id === "string" ? body.source_space_id : "";
  const extensionId = typeof body.extension_id === "string" ? body.extension_id : "";
  const version = typeof body.version === "string" ? body.version : "";
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sourceSpaceId) || sourceSpaceId === destinationSpaceId
    || !/^ext_[a-z0-9_-]{2,62}$/.test(extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || body.expected_manifest_sha256 !== undefined && (typeof body.expected_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expected_manifest_sha256)))
    return c.json({ error_code: "extension_package_import_identity_invalid" }, 400);
  const source = await loadOwnedSpace(c, sourceSpaceId);
  if (!source.ok) return c.json({ error_code: "source_space_not_found" }, 404);
  if (!await canAdministerSpace(c.env, destination.tenantId, destinationSpaceId, identity)
    || !await canAdministerSpace(c.env, destination.tenantId, sourceSpaceId, identity))
    return c.json({ error_code: "source_and_destination_space_admin_required" }, 403);
  const trustedSpaces = [sourceSpaceId, destinationSpaceId];
  const root = await inspectSignedSpacePackageRelease(c.env, destination.tenantId, sourceSpaceId, extensionId, version, trustedSpaces);
  if (!root.ok) {
    const status = root.error === "release_not_found" ? 404 : root.error.includes("publisher_key_untrusted") ? 403 : 409;
    return c.json({ error_code: `extension_package_${root.error}` }, status);
  }
  if (typeof body.expected_manifest_sha256 === "string" && root.package.manifestSha256 !== body.expected_manifest_sha256)
    return c.json({ error_code: "extension_package_import_pin_mismatch", extension_id: extensionId, version,
      expected_manifest_sha256: body.expected_manifest_sha256, observed_manifest_sha256: root.package.manifestSha256 }, 409);
  const closure = await inspectSpacePackageDependencyClosure(c.env, destination.tenantId, sourceSpaceId, root.package, trustedSpaces);
  if (!closure.ok) return c.json({ error_code: `extension_package_${closure.error}` }, closure.error.includes("publisher_key_untrusted") ? 403 : 409);
  const packages = [...closure.packages, root.package];
  if (packages.some(pkg => !pkg.installable)) return c.json({ error_code: "extension_space_shared_package_contract_unsupported" }, 422);
  const expiresAt = Date.now() + 5 * 60_000;
  const claims = spacePackageImportClaims({ tenantId: destination.tenantId, sourceSpaceId, destinationSpaceId,
    actorId: identity.userId ?? "", extensionId, version, packages, expiresAt });
  const payload = JSON.stringify(claims);
  return c.json({ source_space_id: sourceSpaceId, destination_space_id: destinationSpaceId, extension_id: extensionId,
    version, ...(typeof body.expected_manifest_sha256 === "string" ? { expected_manifest_sha256: body.expected_manifest_sha256 } : {}),
    expires_at: expiresAt, review_token: encodeSpacePackageReviewToken(payload, await signHmac(payload, c.env.PLATFORM_SECRET)),
    packages: packages.map(pkg => ({ extension_id: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "",
      manifest_sha256: pkg.manifestSha256, artifact_sha256: pkg.artifactSha256, publisher_id: pkg.publisherId,
      publisher_key_id: pkg.publisherKeyId, publisher_signature_verified: true })), mutates_storage: false }, 200,
    { "cache-control": "private, no-store" });
});

app.post(sharedExtensionImportPath, async c => {
  const destinationSpaceId = c.req.param("spaceId"), identity = getCallerIdentity(c);
  const destination = await loadOwnedSpace(c, destinationSpaceId);
  if (!destination.ok) return c.json({ error_code: destination.error_code, message: destination.message }, destination.status);
  const body = await c.req.json<{ source_space_id?: unknown; extension_id?: unknown; version?: unknown; review_token?: unknown; expected_manifest_sha256?: unknown }>()
    .catch(() => ({} as { source_space_id?: unknown; extension_id?: unknown; version?: unknown; review_token?: unknown; expected_manifest_sha256?: unknown }));
  const sourceSpaceId = typeof body.source_space_id === "string" ? body.source_space_id : "";
  const extensionId = typeof body.extension_id === "string" ? body.extension_id : "";
  const version = typeof body.version === "string" ? body.version : "";
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sourceSpaceId) || sourceSpaceId === destinationSpaceId
    || !/^ext_[a-z0-9_-]{2,62}$/.test(extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    || body.expected_manifest_sha256 !== undefined && (typeof body.expected_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expected_manifest_sha256))
    || typeof body.review_token !== "string" || body.review_token.length > 16_384)
    return c.json({ error_code: "extension_package_import_request_invalid" }, 400);
  const source = await loadOwnedSpace(c, sourceSpaceId);
  if (!source.ok) return c.json({ error_code: "source_space_not_found" }, 404);
  if (!await canAdministerSpace(c.env, destination.tenantId, destinationSpaceId, identity)
    || !await canAdministerSpace(c.env, destination.tenantId, sourceSpaceId, identity))
    return c.json({ error_code: "source_and_destination_space_admin_required" }, 403);
  const root = await inspectSignedSpacePackageRelease(c.env, destination.tenantId, sourceSpaceId, extensionId, version,
    [sourceSpaceId, destinationSpaceId]);
  if (!root.ok) return c.json({ error_code: `extension_package_${root.error}` }, root.error === "release_not_found" ? 404
    : root.error.includes("publisher_key_untrusted") ? 403 : 409);
  if (typeof body.expected_manifest_sha256 === "string" && root.package.manifestSha256 !== body.expected_manifest_sha256)
    return c.json({ error_code: "extension_package_import_pin_mismatch", extension_id: extensionId, version,
      expected_manifest_sha256: body.expected_manifest_sha256, observed_manifest_sha256: root.package.manifestSha256 }, 409);
  const closure = await inspectSpacePackageDependencyClosure(c.env, destination.tenantId, sourceSpaceId, root.package,
    [sourceSpaceId, destinationSpaceId]);
  if (!closure.ok) return c.json({ error_code: `extension_package_${closure.error}` }, closure.error.includes("publisher_key_untrusted") ? 403 : 409);
  const packages = [...closure.packages, root.package];
  const decoded = decodeSpacePackageReviewToken(body.review_token);
  if (!decoded || !await verifyHmac(decoded.payload, decoded.signature, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "extension_package_import_review_required" }, 409);
  let claims: ReturnType<typeof spacePackageImportClaims> | null = null;
  try { claims = JSON.parse(decoded.payload) as ReturnType<typeof spacePackageImportClaims>; } catch { /* malformed receipt */ }
  const expiresAt = claims?.expiresAt ?? 0;
  const expected = spacePackageImportClaims({ tenantId: destination.tenantId, sourceSpaceId, destinationSpaceId,
    actorId: identity.userId ?? "", extensionId, version, packages, expiresAt });
  if (!claims || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000 || JSON.stringify(claims) !== JSON.stringify(expected))
    return c.json({ error_code: "extension_package_import_review_stale" }, 409);
  if (packages.some(pkg => !pkg.installable)) return c.json({ error_code: "extension_space_shared_package_contract_unsupported" }, 422);
  const completed: Array<{ extension_id: string; version: string; copied_artifacts: number; reused_artifacts: number; metadata_imported: boolean }> = [];
  for (const pkg of packages) {
    const copied = await copyVerifiedSpacePackageRelease(c.env, destination.tenantId, sourceSpaceId, destinationSpaceId, pkg);
    if (!copied.ok) return c.json({ error_code: `extension_package_${copied.error}`, completed_packages: completed, retryable: true }, 503);
    const persisted = await persistImportedSpacePackageRelease(c.env, destination.tenantId, destinationSpaceId, identity.userId ?? "space-admin", pkg);
    if (!persisted.ok) return c.json({ error_code: `extension_package_${persisted.error}`, completed_packages: completed, retryable: true }, 503);
    completed.push({ extension_id: pkg.manifest.id, version: pkg.manifest.bundle?.version ?? "",
      copied_artifacts: copied.copied, reused_artifacts: copied.already_present, metadata_imported: persisted.imported });
  }
  return c.json({ imported: true, source_space_id: sourceSpaceId, destination_space_id: destinationSpaceId,
    root_extension_id: extensionId, root_version: version, completed_packages: completed,
    next_action: "review_and_install_in_destination" }, 200);
});

type SpacePackageReviewManifest = ReturnType<typeof validateExtensionManifest>;
const spacePackageReviewArray = (value: readonly string[]) => [...new Set(value)].sort();
async function spacePackageReviewDigest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function spacePackageReviewSchemaRows(manifest: SpacePackageReviewManifest) {
  const rows: Array<{ id: string; kind: string; digest: string }> = [];
  for (const primitive of manifest.bundle?.primitives ?? []) {
    if (primitive.kind === "gadget") rows.push({ id: primitive.id, kind: "gadget", digest: JSON.stringify([primitive.schemaSql, primitive.migrations ?? []]) });
  }
  for (const gadget of manifest.gadgets ?? []) if (gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3)
    rows.push({ id: gadget.id, kind: "gadget", digest: JSON.stringify([gadget.defaultSchemaSql, gadget.migrations ?? []]) });
  for (const field of manifest.settingsSchema?.fields ?? [])
    rows.push({ id: field.id, kind: "setting", digest: JSON.stringify(field) });
  return rows;
}
function spacePackageReviewDiff<T extends { id: string; digest: string }>(before: T[], after: T[]) {
  const oldById = new Map(before.map(item => [item.id, item.digest]));
  const nextById = new Map(after.map(item => [item.id, item.digest]));
  return {
    added: [...nextById.keys()].filter(id => !oldById.has(id)).sort(),
    removed: [...oldById.keys()].filter(id => !nextById.has(id)).sort(),
    changed: [...nextById.keys()].filter(id => oldById.has(id) && oldById.get(id) !== nextById.get(id)).sort(),
  };
}
function spacePackageReviewConnectionRows(manifest: SpacePackageReviewManifest) {
  return (manifest.bundle?.connections ?? []).map(item => ({ id: item.id, digest: JSON.stringify([item.provider, item.purpose, item.required]) }));
}

const sharedExtensionUpdateReviewPath = "/spaces/:spaceId/shared-extension-installations/:instanceId/update-review";
const sharedExtensionReleasesPath = "/spaces/:spaceId/shared-extension-installations/:instanceId/releases";
app.use(sharedExtensionReleasesPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionReleasesPath, requireSpaceMembership({ GET: "admin" }));
app.get(sharedExtensionReleasesPath, async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  if (!/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId)) return c.json({ error_code: "extension_installation_id_invalid" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const installationsResponse = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({
    tenant_id: owned.tenantId, space_id: spaceId, extension_id: "__all__", include_manifest: "1",
  })}`));
  if (!installationsResponse.ok) return c.json({ error_code: "extension_release_history_installation_lookup_unavailable" }, 503);
  const installations = await readBoundedResponseJson<{ installations?: Array<{ instance_id: string; extension_id: string;
    project_id: string | null; scope: string; status: string }> }>(installationsResponse, 2 * 1024 * 1024);
  const installed = installations.installations?.find(item => item.instance_id === instanceId);
  if (!installed || installed.project_id !== null || installed.scope !== "SPACE_SHARED" || !["active", "disabled"].includes(installed.status))
    return c.json({ error_code: "extension_update_review_installation_not_found" }, 404);
  const releaseResponse = await stub.fetch(new Request(`http://space-do/extension-releases?${new URLSearchParams({
    extension_id: installed.extension_id, limit: "50",
  })}`));
  if (!releaseResponse.ok) return c.json({ error_code: "extension_release_history_unavailable" }, 503);
  const result = await readBoundedResponseJson<{ releases?: Array<PublisherTaggedRelease & { version?: string }> }>(releaseResponse, 1024 * 1024);
  const releases = await currentPublisherReleases(c.env, owned.tenantId, spaceId, result.releases ?? []);
  return c.json({ releases }, 200, { "cache-control": "private, no-store" });
});
app.use(sharedExtensionUpdateReviewPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionUpdateReviewPath, requireSpaceMembership({ POST: "admin" }));
app.post(sharedExtensionUpdateReviewPath, async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId"), identity = getCallerIdentity(c);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  if (!/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId)) return c.json({ error_code: "extension_installation_id_invalid" }, 400);
  let body: { expected_current_version?: unknown; candidate_version?: unknown };
  try {
    const bytes = await readBoundedRequestBytes(c.req.raw, 4 * 1024);
    body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => key !== "expected_current_version" && key !== "candidate_version")) throw new Error("invalid_review_body");
  } catch { return c.json({ error_code: "extension_update_review_request_invalid" }, 400); }
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (typeof body.expected_current_version !== "string" || !semver.test(body.expected_current_version)
    || typeof body.candidate_version !== "string" || !semver.test(body.candidate_version)
    || body.expected_current_version === body.candidate_version) return c.json({ error_code: "extension_update_review_request_invalid" }, 400);

  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const installationsResponse = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({
    tenant_id: owned.tenantId, space_id: spaceId, extension_id: "__all__", include_manifest: "1",
  })}`));
  if (!installationsResponse.ok) return c.json({ error_code: "extension_update_review_installation_lookup_unavailable" }, 503);
  const installations = await readBoundedResponseJson<{ installations?: Array<{ instance_id: string; extension_id: string; project_id: string | null;
    scope: string; instance_key?: string; status: string; release_version?: string | null; publisher_id?: string | null; publisher_key_id?: string | null;
    manifest_sha256?: string | null; manifest?: unknown }> }>(installationsResponse, 2 * 1024 * 1024);
  const installed = installations.installations?.find(item => item.instance_id === instanceId);
  if (!installed || installed.project_id !== null || installed.scope !== "SPACE_SHARED" || !["active", "disabled"].includes(installed.status))
    return c.json({ error_code: "extension_update_review_installation_not_found" }, 404);
  if (installed.release_version !== body.expected_current_version)
    return c.json({ error_code: "extension_update_review_stale_pin", current_version: installed.release_version ?? null }, 409);

  let currentManifest: SpacePackageReviewManifest, candidateManifest: SpacePackageReviewManifest;
  try {
    currentManifest = validateExtensionManifest(installed.manifest);
    if (!installed.manifest || currentManifest.id !== installed.extension_id || currentManifest.bundle?.version !== body.expected_current_version)
      throw new Error("current_manifest_pin_mismatch");
  } catch { return c.json({ error_code: "extension_update_review_current_manifest_invalid" }, 409); }

  const candidateResponse = await stub.fetch(new Request(`http://space-do/extension-package-release?${new URLSearchParams({
    extension_id: installed.extension_id, version: body.candidate_version,
  })}`));
  if (!candidateResponse.ok) return c.json({ error_code: candidateResponse.status === 404 ? "extension_update_review_candidate_not_found" : "extension_update_review_candidate_untrusted" }, candidateResponse.status === 404 ? 404 : 409);
  const release = await readBoundedResponseJson<{ release?: { extension_id: string; version: string; manifest: unknown; manifest_json: string;
    artifact_sha256: string; publisher?: { id?: string; key_id?: string; signature?: string; payload_sha256?: string } } }>(candidateResponse, 2 * 1024 * 1024);
  const candidate = release.release;
  if (!candidate || candidate.extension_id !== installed.extension_id || candidate.version !== body.candidate_version
    || typeof candidate.publisher?.id !== "string" || typeof candidate.publisher.key_id !== "string"
    || typeof candidate.publisher.signature !== "string" || typeof candidate.publisher.payload_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.publisher.key_id) || !/^[a-f0-9]{64}$/.test(candidate.artifact_sha256))
    return c.json({ error_code: "extension_update_review_candidate_invalid" }, 409);
  try {
    candidateManifest = validateExtensionManifest(JSON.parse(candidate.manifest_json), { gatekeeperCapabilities: [...SPACE_SHARED_PACKAGE_CAPABILITIES] });
    if (JSON.stringify(candidateManifest) !== candidate.manifest_json || candidateManifest.id !== installed.extension_id
      || candidateManifest.bundle?.version !== body.candidate_version || candidate.manifest_json !== JSON.stringify(candidate.manifest))
      throw new Error("manifest_identity_or_canonicalization_mismatch");
    if (!c.env.SCRIPTS_R2) return c.json({ error_code: "extension_artifact_storage_unavailable" }, 503);
    const bundle = candidateManifest.bundle;
    const primitives = bundle?.primitives ?? [];
    const canvases = primitives.filter((part): part is Extract<typeof part, { kind: "canvas" }> => part.kind === "canvas");
    const gadgets = primitives.filter((part): part is Extract<typeof part, { kind: "gadget" }> => part.kind === "gadget");
    const channels = primitives.filter((part): part is Extract<typeof part, { kind: "channel" }> => part.kind === "channel");
    const legacyGadgets = (candidateManifest.gadgets ?? []).filter(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3);
    const connections = bundle?.connections ?? [];
    if (!bundle || canvases.length === 0 || primitives.length > 32 || primitives.some(part => !["canvas", "gadget", "channel"].includes(part.kind))
      || (candidateManifest.containers?.length ?? 0) > 0 || (candidateManifest.daemons?.length ?? 0) > 0 || (candidateManifest.commands?.length ?? 0) > 0
      || (candidateManifest.widgetSubscriptions?.length ?? 0) > 0 || (bundle.workerRoles?.length ?? 0) > 0
      || (candidateManifest.gadgets ?? []).some(gadget => gadget.scope !== "SPACE_SHARED" || gadget.gadgetTier !== 3)
      || candidateManifest.capabilityRequirements.some(capability => !SPACE_SHARED_PACKAGE_CAPABILITIES.has(capability))
      || candidateManifest.declaredPermissions.some(permission => !SPACE_SHARED_PACKAGE_PERMISSIONS.has(permission))
      || canvases.some(canvas => canvas.layout !== "CanvasMount" || canvas.dynamicPage || canvas.permissions.length > 0 || canvas.capabilityRequirements.length > 0)
      || gadgets.some(gadget => gadget.scope !== "SPACE_SHARED" || gadget.permissions.length > 0 || gadget.capabilityRequirements.length > 0)
      || channels.some(channel => channel.context !== "channel_only" || !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(channel.handlerScript)
        || channel.provider !== "phone" && (!channel.connectionId || !connections.some(connection => connection.id === channel.connectionId
          && connection.provider === channel.provider && connection.required)))) throw new Error("space_shared_contract_unsupported");
    const providerAllowlist = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
    if (channels.some(channel => !providerAllowlist.has(channel.provider)) || connections.some(connection => !providerAllowlist.has(connection.provider)
      || !channels.some(channel => channel.connectionId === connection.id && channel.provider === connection.provider))) throw new Error("space_shared_connection_contract_unsupported");

    const paths = [...new Set([...canvases.map(item => item.component), ...channels.map(item => item.handlerScript)])].sort();
    if (paths.length !== canvases.length + channels.length) throw new Error("artifact_path_conflict");
    const artifacts: Record<string, string> = {};
    let totalBytes = 0;
    for (const path of paths) {
      const object = await c.env.SCRIPTS_R2?.get(`spaces/${spaceId}/extensions/${installed.extension_id}/${body.candidate_version}/${path.slice(2)}`);
      const maxBytes = /\.(?:ts|js)$/.test(path) ? 262_144 : 512_000;
      if (!object || object.size < 1 || object.size > maxBytes) throw new Error("artifact_missing_or_invalid");
      const bytes = await object.arrayBuffer();
      if (bytes.byteLength !== object.size) throw new Error("artifact_size_mismatch");
      totalBytes += bytes.byteLength;
      if (totalBytes > 2_000_000) throw new Error("artifact_size_limit");
      artifacts[path] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    }
    const entries = Object.entries(artifacts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (await spacePackageReviewDigest(JSON.stringify(entries)) !== candidate.artifact_sha256) throw new Error("artifact_digest_mismatch");
    const publisher = await c.env.PLATFORM_DB.prepare(`SELECT publisher_id,public_key_b64url FROM extension_publisher_keys
      WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(owned.tenantId, spaceId, candidate.publisher.key_id)
      .first<{ publisher_id: string; public_key_b64url: string }>();
    if (!publisher || publisher.publisher_id !== candidate.publisher.id) return c.json({ error_code: "extension_publisher_key_untrusted_or_revoked" }, 403);
    const publicKey = decodeExtensionPublisherPublicKey(publisher.public_key_b64url);
    if (await extensionPublisherKeyId(publicKey) !== candidate.publisher.key_id) return c.json({ error_code: "extension_publisher_key_id_mismatch" }, 403);
    const publisherPayload = extensionPublisherSigningPayload(candidate.manifest_json, artifacts);
    if (await spacePackageReviewDigest(publisherPayload) !== candidate.publisher.payload_sha256
      || !await verifyExtensionPublisherRelease({ publicKeyRaw: publicKey, signature: candidate.publisher.signature,
        manifestJson: candidate.manifest_json, artifacts })) throw new Error("publisher_signature_invalid");
  } catch (error) {
    return c.json({ error_code: "extension_update_review_candidate_invalid", reason: (error instanceof Error ? error.message : "invalid").slice(0, 120) }, 409);
  }

  const addedPermissions = candidateManifest.declaredPermissions.filter(item => !currentManifest.declaredPermissions.includes(item)).sort();
  const removedPermissions = currentManifest.declaredPermissions.filter(item => !candidateManifest.declaredPermissions.includes(item)).sort();
  const addedCapabilities = candidateManifest.capabilityRequirements.filter(item => !currentManifest.capabilityRequirements.includes(item)).sort();
  const removedCapabilities = currentManifest.capabilityRequirements.filter(item => !candidateManifest.capabilityRequirements.includes(item)).sort();
  const beforeSchema = spacePackageReviewSchemaRows(currentManifest), afterSchema = spacePackageReviewSchemaRows(candidateManifest);
  const schemaDigestRows = async (rows: typeof beforeSchema) => Promise.all(rows.map(async row => ({ id: `${row.kind}:${row.id}`, digest: await spacePackageReviewDigest(row.digest) })));
  const schemaChanges = spacePackageReviewDiff(await schemaDigestRows(beforeSchema), await schemaDigestRows(afterSchema));
  const currentConnections = (currentManifest.bundle?.connections ?? []).map(item => ({ id: item.id, provider: item.provider, purpose: item.purpose, required: item.required }));
  const candidateConnections = (candidateManifest.bundle?.connections ?? []).map(item => ({ id: item.id, provider: item.provider, purpose: item.purpose, required: item.required }));
  const connectionDiff = spacePackageReviewDiff(spacePackageReviewConnectionRows(currentManifest), spacePackageReviewConnectionRows(candidateManifest));
  const dependencyRows = (manifest: SpacePackageReviewManifest) => (manifest.dependencies ?? []).map(item => ({
    id: item.extensionId, digest: `${item.version}:${item.manifestSha256}`,
  }));
  const dependencyDiff = spacePackageReviewDiff(dependencyRows(currentManifest), dependencyRows(candidateManifest));
  const sameScopeDependencies = (installations.installations ?? []).filter(item => item.instance_id !== instanceId && item.status === "active"
    && item.scope === "SPACE_SHARED" && item.project_id === null);
  const trustedDependencyInstalls = await trustedExtensionInstallations(c.env, owned.tenantId, spaceId, sameScopeDependencies);
  const dependencyPins = trustedDependencyInstalls.flatMap(item => item.manifest && item.release_version && item.manifest_sha256
      ? [{ extensionId: item.extension_id, releaseVersion: item.release_version, manifestSha256: item.manifest_sha256, manifest: item.manifest }]
      : []);
  const currentDependencyClosure = await resolveExtensionDependencyClosure(currentManifest, dependencyPins);
  const candidateDependencyClosure = await resolveExtensionDependencyClosure(candidateManifest, dependencyPins);
  const dependencyNames = (manifest: SpacePackageReviewManifest) => (manifest.dependencies ?? []).map(item => `${item.extensionId}@${item.version}`).sort();
  const permissionExpansion = addedPermissions.length > 0 || addedCapabilities.length > 0
    || candidateManifest.shared_filesystem?.some(next => !currentManifest.shared_filesystem?.some(prior => prior.path === next.path && prior.access === next.access)) === true;
  const publisherChanged = installed.publisher_id !== candidate.publisher.id || installed.publisher_key_id !== candidate.publisher.key_id;
  const updateContractSupported = supportsVersionOnlySpaceSharedCodeUpdate(currentManifest, candidateManifest)
    && !publisherChanged && currentManifest.bundle?.version === body.expected_current_version
    && candidateManifest.bundle?.version === body.candidate_version && candidateDependencyClosure.resolved;
  let activeWorkCount = 0;
  if (updateContractSupported) {
    const runtimeStatusResponse = await stub.fetch(new Request("http://space-do/extension-runtime-work", { method: "POST",
      headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId) },
      body: JSON.stringify({ action: "status", tenantId: owned.tenantId, spaceId, projectId: null, instanceId,
        workId: "update-review-status", workKind: "channel" }) }));
    if (!runtimeStatusResponse.ok) return c.json({ error_code: "extension_update_review_runtime_status_unavailable" }, 503);
    const runtimeStatus = await readBoundedResponseJson<{ active_work_count?: number }>(runtimeStatusResponse, 16 * 1024);
    if (!Number.isSafeInteger(runtimeStatus.active_work_count) || (runtimeStatus.active_work_count ?? -1) < 0)
      return c.json({ error_code: "extension_update_review_runtime_status_invalid" }, 503);
    activeWorkCount = runtimeStatus.active_work_count!;
  }
  const canApply = installed.status === "disabled" && updateContractSupported && activeWorkCount === 0 && Boolean(identity.userId);
  let updateReviewToken: string | undefined;
  let updateReviewExpiresAt: number | undefined;
  if (canApply && identity.userId) {
    const expiresAt = Date.now() + 5 * 60_000;
    const claims = spaceSharedExtensionUpdateClaims({ tenantId: owned.tenantId, spaceId, actorId: identity.userId,
      installationId: instanceId, extensionId: installed.extension_id, fromVersion: body.expected_current_version,
      toVersion: body.candidate_version, artifactSha256: candidate.artifact_sha256, publisherId: candidate.publisher.id,
      publisherKeyId: candidate.publisher.key_id,
      expiresAt, requestId: crypto.randomUUID() });
    const payload = JSON.stringify(claims);
    updateReviewToken = encodeSpacePackageReviewToken(payload, await signHmac(payload, c.env.PLATFORM_SECRET));
    updateReviewExpiresAt = expiresAt;
  }
  const approvalRequired = true;
  return c.json({ installation_id: instanceId, extension_id: installed.extension_id, space_id: spaceId, scope: "SPACE_SHARED",
    current: { version: body.expected_current_version, publisher_id: installed.publisher_id ?? null, publisher_key_id: installed.publisher_key_id ?? null },
    candidate: { version: candidate.version, publisher_id: candidate.publisher.id, publisher_key_id: candidate.publisher.key_id,
      artifact_sha256: candidate.artifact_sha256, signature_verified: true },
    permissions: { current: spacePackageReviewArray(currentManifest.declaredPermissions), candidate: spacePackageReviewArray(candidateManifest.declaredPermissions), added: addedPermissions, removed: removedPermissions },
    capabilities: { current: spacePackageReviewArray(currentManifest.capabilityRequirements), candidate: spacePackageReviewArray(candidateManifest.capabilityRequirements), added: addedCapabilities, removed: removedCapabilities },
    dependencies: { package: { current: dependencyNames(currentManifest), candidate: dependencyNames(candidateManifest),
      current_pins: currentManifest.dependencies ?? [], candidate_pins: candidateManifest.dependencies ?? [],
      status: candidateDependencyClosure.resolved ? "resolved" : candidateDependencyClosure.error },
      provider_connections: { current: currentConnections, candidate: candidateConnections, ...connectionDiff } },
    schema_changes: schemaChanges,
    shared_filesystem: { current: currentManifest.shared_filesystem ?? [], candidate: candidateManifest.shared_filesystem ?? [],
      ...spacePackageReviewDiff((currentManifest.shared_filesystem ?? []).map(item => ({ id: item.path, digest: item.access })),
        (candidateManifest.shared_filesystem ?? []).map(item => ({ id: item.path, digest: item.access }))) },
    price_terms: { current: null, candidate: null, status: "not_declared_by_current_extension_contract" },
    dependency_resolution: { current: currentDependencyClosure.resolved ? { resolved: true as const } : currentDependencyClosure,
      candidate: candidateDependencyClosure.resolved ? { resolved: true as const } : candidateDependencyClosure },
    review: { authority_expanded: permissionExpansion, publisher_changed: publisherChanged, explicit_owner_approval_required: approvalRequired,
      mutates_installation: false, apply_supported: canApply, apply_block_reason: canApply ? null
        : installed.status !== "disabled" ? "pause the installation before applying an update"
        : activeWorkCount > 0 ? "wait for admitted runtime work to drain"
          : !identity.userId ? "a verified owner identity is required to apply an update"
            : "only same-publisher version-only static Canvas/channel code packages with unchanged configuration can update here" ,
      active_work_count: activeWorkCount, runtime_work_drained: activeWorkCount === 0 },
    ...(updateReviewToken ? { update_review_token: updateReviewToken, update_review_expires_at: updateReviewExpiresAt } : {}),
  }, 200, { "cache-control": "private, no-store" });
});

const sharedExtensionUpdatePath = "/spaces/:spaceId/shared-extension-installations/:instanceId/update";
app.use(sharedExtensionUpdatePath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionUpdatePath, requireSpaceMembership({ POST: "admin" }));
app.post(sharedExtensionUpdatePath, async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId"), identity = getCallerIdentity(c);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  if (!identity.userId || !/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId)) return c.json({ error_code: "extension_update_request_invalid" }, 400);
  let body: { review_token?: unknown };
  try {
    const bytes = await readBoundedRequestBytes(c.req.raw, 16 * 1024);
    body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "review_token")
      || typeof body.review_token !== "string") throw new Error("invalid_update_body");
  } catch { return c.json({ error_code: "extension_update_request_invalid" }, 400); }
  const decoded = body.review_token.length <= 16_384 ? decodeSpacePackageReviewToken(body.review_token) : null;
  if (!decoded || !await verifyHmac(decoded.payload, decoded.signature, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "extension_update_review_token_invalid" }, 409);
  let claims: ReturnType<typeof spaceSharedExtensionUpdateClaims> | null = null;
  try { claims = JSON.parse(decoded.payload) as ReturnType<typeof spaceSharedExtensionUpdateClaims>; } catch { /* invalid review token */ }
  if (!claims || JSON.stringify(claims) !== decoded.payload || claims.version !== 1 || claims.purpose !== "space_shared_extension_update"
    || claims.tenantId !== owned.tenantId || claims.spaceId !== spaceId || claims.actorId !== identity.userId || claims.installationId !== instanceId
    || !/^ext_[a-z0-9_-]{2,62}$/.test(claims.extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(claims.fromVersion)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(claims.toVersion) || claims.fromVersion === claims.toVersion
    || !/^[a-f0-9]{64}$/.test(claims.artifactSha256) || typeof claims.publisherId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(claims.publisherId) || !/^[a-f0-9]{64}$/.test(claims.publisherKeyId)
    || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.now() || claims.expiresAt > Date.now() + 5 * 60_000
    || !/^[0-9a-f-]{36}$/i.test(claims.requestId)) return c.json({ error_code: "extension_update_review_token_stale" }, 409);

  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const receiptQuery = new URLSearchParams({ tenant_id: owned.tenantId, space_id: spaceId, request_id: claims.requestId });
  const receiptResponse = await stub.fetch(new Request(`http://space-do/space-shared-extension-update-receipt?${receiptQuery}`, { headers: {
    "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId),
  } }));
  if (receiptResponse.ok) {
    const saved = await readBoundedResponseJson<{ receipt?: { request_id: string; installation_id: string; extension_id: string; from_version: string;
      to_version: string; artifact_sha256: string; publisher_key_id: string; actor_id: string; created_at: string } }>(receiptResponse, 32 * 1024);
    const receipt = saved.receipt;
    if (!receipt || receipt.request_id !== claims.requestId || receipt.installation_id !== claims.installationId
      || receipt.extension_id !== claims.extensionId || receipt.from_version !== claims.fromVersion || receipt.to_version !== claims.toVersion
      || receipt.artifact_sha256 !== claims.artifactSha256 || receipt.publisher_key_id !== claims.publisherKeyId || receipt.actor_id !== identity.userId)
      return c.json({ error_code: "extension_update_request_id_conflict" }, 409);
    return c.json({ updated: true, replayed: true, receipt }, 200, { "cache-control": "private, no-store" });
  }
  if (receiptResponse.status !== 404) return c.json({ error_code: "extension_update_receipt_lookup_unavailable" }, 503);

  const candidateNow = await inspectSignedSpacePackageRelease(c.env, owned.tenantId, spaceId, claims.extensionId, claims.toVersion);
  if (!candidateNow.ok || !candidateNow.package.installable || candidateNow.package.artifactSha256 !== claims.artifactSha256
    || candidateNow.package.publisherId !== claims.publisherId || candidateNow.package.publisherKeyId !== claims.publisherKeyId)
    return c.json({ error_code: candidateNow.ok ? "extension_update_candidate_changed" : `extension_${candidateNow.error}` }, 409);
  const response = await stub.fetch(new Request("http://space-do/space-shared-extension-update", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId),
      "x-naelao-tenant-id": owned.tenantId },
    body: JSON.stringify({ tenantId: owned.tenantId, spaceId, actorId: identity.userId, claims, reviewToken: body.review_token }) }));
  return new Response(response.body, { status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
});

const sharedExtensionUpdateReceiptsPath = "/spaces/:spaceId/shared-extension-update-receipts";
app.use(sharedExtensionUpdateReceiptsPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionUpdateReceiptsPath, requireSpaceMembership({ GET: "admin" }));
app.get(sharedExtensionUpdateReceiptsPath, async c => {
  const spaceId = c.req.param("spaceId"), owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const query = new URLSearchParams({ tenant_id: owned.tenantId, space_id: spaceId });
  return stub.fetch(new Request(`http://space-do/space-shared-extension-updates?${query}`, { headers: {
    "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId),
  } }));
});

app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/filesystem-grants", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/filesystem-grants", requireSpaceMembership({ PATCH: "admin" }));
app.patch("/spaces/:spaceId/shared-extension-installations/:instanceId/filesystem-grants", async c => {
  const identity = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ grants?: Array<{ path: string; access: "READ" | "READ_WRITE" }> }>()
    .catch((): { grants?: Array<{ path: string; access: "READ" | "READ_WRITE" }> } => ({}));
  if (!Array.isArray(body.grants)) return c.json({ error_code: "shared_filesystem_grants_required" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const response = await stub.fetch(new Request("http://space-do/extension-shared-filesystem-grants", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId) },
    body: JSON.stringify({ tenantId: owned.tenantId, spaceId, instanceId: c.req.param("instanceId"), approvedBy: identity.userId ?? "space-admin", grants: body.grants }) }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/lifecycle", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/lifecycle", requireSpaceMembership({ PATCH: "admin" }));
app.patch("/spaces/:spaceId/shared-extension-installations/:instanceId/lifecycle", async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ action?: "enable" | "disable"; drain_timeout_ms?: number }>()
    .catch((): { action?: "enable" | "disable"; drain_timeout_ms?: number } => ({}));
  if (body.action !== "enable" && body.action !== "disable") return c.json({ error_code: "extension_lifecycle_action_invalid" }, 400);
  if (body.drain_timeout_ms !== undefined && (!Number.isSafeInteger(body.drain_timeout_ms) || body.drain_timeout_ms < 0 || body.drain_timeout_ms > 10_000))
    return c.json({ error_code: "extension_lifecycle_drain_timeout_invalid" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return stub.fetch(new Request("http://space-do/space-shared-extension-lifecycle", { method: "PATCH",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId) },
    body: JSON.stringify({ tenantId: owned.tenantId, spaceId, instanceId, action: body.action, drainTimeoutMs: body.drain_timeout_ms ?? 0 }) }));
});

app.post("/internal/extensions/runtime-work", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET))
    return c.json({ error_code: "forbidden" }, 403);
  const bytes = await readBoundedRequestBytes(c.req.raw, 8 * 1024).catch(() => null);
  if (!bytes) return c.json({ error_code: "extension_runtime_work_request_invalid" }, 400);
  let body: { tenantId?: unknown; spaceId?: unknown };
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as typeof body; }
  catch { return c.json({ error_code: "extension_runtime_work_request_invalid" }, 400); }
  if (body.tenantId !== tenantId || typeof body.spaceId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.spaceId))
    return c.json({ error_code: "extension_runtime_work_request_invalid" }, 400);
  const stub = await spaceDoStub(c.env, body.spaceId, tenantId);
  return stub.fetch(new Request("http://space-do/extension-runtime-work", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": c.req.header("x-naelao-internal-token") ?? "" }, body: bytes }));
});

app.use("/spaces/:spaceId/shared-extension-installations/:instanceId", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId", requireSpaceMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/shared-extension-installations/:instanceId", async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return stub.fetch(new Request(`http://space-do/extension-installation?${new URLSearchParams({ instance_id: instanceId, tenant_id: owned.tenantId, space_id: spaceId })}`, { method: "DELETE" }));
});

const sharedExtensionSettingsAuditPath = "/spaces/:spaceId/extension-installations/:instanceId/settings-audit";
app.use(sharedExtensionSettingsAuditPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use(sharedExtensionSettingsAuditPath, requireSpaceMembership({ GET: "admin" }));
app.get(sharedExtensionSettingsAuditPath, async c => {
  const identity = getCallerIdentity(c), spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  if (!identity.tenantId || !identity.userId || !/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId))
    return c.json({ error_code: "extension_settings_scope_required" }, 400);
  const actorRole = identity.role === "product_end_user"
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId)
    : identity.role;
  if (actorRole !== "owner" && actorRole !== "admin") return c.json({ error_code: "forbidden" }, 403);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return stub.fetch(new Request(`http://space-do/extension-settings-audit?${new URLSearchParams({ tenant_id: owned.tenantId, space_id: spaceId, instance_id: instanceId })}`,
    { headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId), "x-naelao-user-id": identity.userId, "x-naelao-role": actorRole } }));
});

// ── PATCH /spaces/:id ───────────────────────────────────────────────────────
app.patch("/spaces/:id", async (c) => {
  const { tenantId, role } = getCallerIdentity(c);
  if (!["owner", "admin", "editor"].includes(role)) {
    return c.json({ error_code: "forbidden" }, 403);
  }
  const spaceId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    status?: string;
    config_overrides?: Record<string, unknown>;
  }>();
  const now = new Date().toISOString();

  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT id, suspension_reason FROM spaces WHERE id = ? AND tenant_id = ?"
  )
    .bind(spaceId, tenantId)
    .first<{ id: string; status: string; suspension_reason: string | null }>();
  if (!existing) throw notFound("Space");

  if (body.status !== undefined && !["draft", "active", "paused"].includes(body.status)) {
    return c.json({ error_code: "invalid_status" }, 400);
  }
  if (body.status !== undefined && role !== "owner" && role !== "admin") {
    return c.json({ error_code: "forbidden" }, 403);
  }
  if (body.status !== undefined && (existing.suspension_reason !== null || existing.status === "suspended")) {
    return c.json({ error_code: "suspension_reason_mismatch" }, 409);
  }

  if (body.name) {
    await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.name, now, spaceId)
      .run();
  }
  if (body.status) {
    const updated = await c.env.PLATFORM_DB.prepare(
      "UPDATE spaces SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND suspension_reason IS NULL AND status != 'suspended'"
    )
      .bind(body.status, now, spaceId, tenantId)
      .run();
    if (updated.meta.changes === 0) return c.json({ error_code: "suspension_reason_mismatch" }, 409);
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
  const { tenantId, role } = getCallerIdentity(c);
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
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
  const requestedUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  const endUserId = requestedUserId ? await authorizeProductEndUserSpace(c, spaceId, requestedUserId) : null;
  if (!endUserId) return c.json({ error_code: "forbidden", message: "A valid product-user session for this space is required" }, 403);

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
  const requestedUserId = c.req.query("end_user_id") ?? c.req.header("x-naelao-end-user-id") ?? "";
  const endUserId = requestedUserId ? await authorizeProductEndUserSpace(c, spaceId, requestedUserId) : null;
  if (!endUserId) return c.json({ error_code: "forbidden", message: "A valid product-user session for this space is required" }, 403);

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
// URL — resolveEndUserSpaceRole now requires an actual Space membership
// role before the GET is allowed, same as requireSpaceMembership's other routes.
// Gated inline (not via a separate app.use(...)) — see the /internal/space-types-record-install/
// :id route's comment for the full root-cause writeup: a separate app.use(...) on an overlapping
// wildcard pattern was found, at this app's route-table scale, to be silently bypassable (a
// genuine Hono RegExpRouter/TrieRouter limitation, not application logic) — this route's own
// "no token" test started failing OPEN (500 reaching the handler instead of 403) once an
// unrelated part of the same corruption elsewhere in this file was fixed, proving the risk is
// real, not theoretical.
// Keep the collection route explicit. Hono's mixed `:param*` route form is
// unreliable in this worker's large route table and was returning 404 for the
// shell's collection request even though the SpaceDO handler was healthy.
app.all("/spaces/:spaceId/agent-definitions", async (c) => {
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
    const spaceRole = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, callerIdentity.userId);
    if (!spaceRole) {
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
const handleSpaceMembers = async (c: Context<{ Bindings: Env }>) => {
  const spaceId = c.req.param("spaceId");
  if (!spaceId) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  let activeSpace: { id: string } | null;
  try {
    activeSpace = await c.env.PLATFORM_DB.prepare(`SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first<{ id: string }>();
  } catch {
    return c.json({ error_code: "tenant_status_unavailable" }, 503);
  }
  if (!activeSpace) return c.json({ error_code: "tenant_suspended" }, 403);

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
};
// Register the collection and descendant routes explicitly. The `members*` suffix pattern can
// fall through to 404 in this large Hono route table, so unauthenticated callers never reach the
// internal-token check and receive a misleading response.
app.all("/spaces/:spaceId/members", handleSpaceMembers);
app.all("/spaces/:spaceId/members/*", handleSpaceMembers);

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
  const active = await c.env.PLATFORM_DB.prepare(
    `SELECT s.id FROM spaces s WHERE s.id=? AND s.tenant_id=? AND s.status='active'
     AND EXISTS (SELECT 1 FROM orgs o WHERE o.id=s.tenant_id AND o.status='active')`,
  ).bind(spaceId, tenantId).first<{ id: string }>();
  if (!active) return c.json({ found: false }, 404);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/members?space_id=${encodeURIComponent(spaceId)}`, "GET");
  if (!res.ok) return c.json({ found: false }, 404);
  const { data } = await res.json<{ data?: Array<{ user_id: string; role: string }> }>();
  const owner = (data ?? []).find((m) => m.role === "owner");
  if (!owner) return c.json({ found: false }, 404);
  const user = await c.env.PLATFORM_DB.prepare("SELECT email FROM users WHERE id = ?").bind(owner.user_id).first<{ email: string }>();
  if (!user?.email) return c.json({ found: false }, 404);
  return c.json({ found: true, email: user.email,user_id:owner.user_id });
});

// Executive-channel and customer-analytics storage. These are service-to-service only; the
// public router can never use them to probe registered personal contact identifiers.
app.use("/internal/spaces/:spaceId/executive/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.all("/internal/spaces/:spaceId/executive/*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const suffix = new URL(c.req.url).pathname.split(`/internal/spaces/${spaceId}/executive/`)[1] ?? "";
  const target = suffix === "contacts" ? `/internal/executive-contacts?space_id=${encodeURIComponent(spaceId)}`
    : suffix === "verify" ? "/internal/executive/verify" : "/internal/emergency-stop";
  return forwardToSpaceDO(stub, target, c.req.method, c.req.raw.body);
});

// ── /internal/space-role ────────────────────────────────────────────────────
// Internal identity-to-Space membership check used by workers that authorize product sessions.
app.use("/internal/space-role", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/space-role", async (c) => {
  const spaceId = c.req.query("spaceId") ?? "";
  const userId = c.req.query("endUserId") ?? "";
  if (!spaceId || !userId) return c.json({ error_code: "bad_request" }, 400);
  const role = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId);
  if (!role) return c.json({ error_code: "forbidden" }, 404);
  return c.json({ role });
});

// Product-user roster for this Space. This is the generic membership index used by the shell;
// platform team collaborators remain in SpaceDO's separate `/members` store.
app.use("/spaces/:spaceId/memberships", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/memberships", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/memberships", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const result = await c.env.PLATFORM_DB.prepare(
    `SELECT end_user_id, email, display_name, role, created_at AS joined_at,
            CASE WHEN suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS status
     FROM space_members WHERE space_id = ? AND tenant_id = ? ORDER BY created_at ASC`
  ).bind(spaceId, tenantId).all();
  return c.json({ data: result.results ?? [], count: result.results?.length ?? 0 });
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
// Keep the collection and nested session paths explicit. The mixed `:param*`
// form can skip the bare collection route in this worker's large Hono table,
// which made the shell's recent-session request return 404 while nested calls
// still worked.
const handleSpaceSessions = async (c: any) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId, role, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (role === "product_end_user" && !userId) return c.json({ error_code: "unauthorized", message: "Missing end-user identity" }, 401);
  const token = c.req.header("x-naelao-internal-token");
  if (!(await verifyInternalToken(token, tenantId, c.env.PLATFORM_SECRET))) {
    return errorResponse(forbidden("Missing or invalid internal token — this endpoint is not directly reachable"), c.get("requestId") ?? "unknown");
  }

  // S0.1: For product_end_user callers, verify business membership.
  if (role === "product_end_user" && userId) {
    const memberRole = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId);
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
    // Sessions-page filter (ordinary vs heartbeat/cron-wake) — only "heartbeat" does anything;
    // anything else is dropped rather than forwarded blind, same allowlist discipline as limit.
    const kind = url.searchParams.get("kind");
    if (kind === "heartbeat") qs.set("kind", kind);
    search = `?${qs.toString()}`;
  } else if (
    (c.req.method === "GET" || c.req.method === "DELETE") &&
    /^\/sessions\/([^/]+)(?:\/messages|\/compact-scope)?$/.test(doPath) &&
    isProductEndUser
  ) {
    // For GET /sessions/:id and GET /sessions/:id/messages, pass end_user_id so SpaceDO can verify
    // the caller owns this session before returning it. DELETE /sessions/:id/messages (the
    // edit-and-re-ask truncate) needs the same check for the stronger reason — it WRITES — so it
    // rides the same derived-from-claims id rather than anything the client sent.
    const qs = new URLSearchParams(url.searchParams);
    qs.set("end_user_id", callerId);
    search = `?${qs.toString()}`;
  } else if (c.req.method === "POST" && /^\/sessions\/([^/]+)\/messages$/.test(doPath)) {
    // End-user ownership is derived from verified claims; discard any client-supplied query id.
    const qs = new URLSearchParams();
    if (isProductEndUser) qs.set("end_user_id", callerId);
    search = qs.size ? `?${qs.toString()}` : "";
  } else if (isProductEndUser && /^\/sessions\/[^/]+(?:\/.*)?$/.test(doPath)) {
    // Every remaining session subroute (metadata, state, connector preferences, and future
    // session-local APIs) receives the verified owner identity too. SpaceDO enforces it before
    // dispatch; never trust an end_user_id supplied in the original query string.
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
    // `callerId` is the verified acting user for BOTH shapes of caller, and using it for both is
    // what fixes the assistant-created thread still reporting "Session not found":
    //  • a product_end_user chatting directly — their own id, exactly as before;
    //  • an internal caller acting on someone's behalf (thread.create, which mints a session for
    //    the person who asked) — that person's id, forwarded as x-naelao-user-id by a caller that
    //    already proved itself with an internal token.
    // Before this, the second case fell through to the client-supplied body field, which the agent
    // doesn't send — so the session landed with end_user_id NULL, owned by nobody, and getSession's
    // ownership check (`session.end_user_id !== endUserId`) rejected the very user who asked for
    // it. The thread existed and was correctly linked; it was simply unreadable.
    // Still never client-trusted: callerId comes from a header only a verified internal caller can
    // set, and the body field remains a last resort for internal callers that supply neither.
    // Truthiness, not `??`: getCallerIdentity defaults userId to "" rather than undefined, so a
    // nullish check would pin end_user_id to "" for a caller that sends no user header at all and
    // silently stop honouring the body field.
    const endUserId = callerId || (parsedBody as { end_user_id?: string }).end_user_id;
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
};

app.all("/spaces/:spaceId/sessions", handleSpaceSessions);
app.all("/spaces/:spaceId/sessions/*", handleSpaceSessions);

// ── Space hierarchy: registry, sub-spaces (departments), cross-space grants ──
// (spec §10 SpaceDO registry, §49 Sub-Space Architecture, G-Y15/G-Y16).
//
// Two distinct creation flows, deliberately kept separate:
//  • Departments (in-DO sub-spaces) — POST /spaces/:id/sub-spaces. Rows in the parent's
//    SpaceDO `spaces` registry, isolated by space_id. Depth 1-2, available to any Space Template.
//  • User-created Spaces — POST /spaces/:id/spaces. Each has its own SpaceDO, membership, and
//    optional FDE-authored Space Template installation.

/** Get the SpaceDO stub for a (spaceId, tenantId), HMAC-named to prevent enumeration. */
async function spaceDoStub(env: Env, spaceId: string, tenantId: string) {
  const doId = env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET));
  return env.SPACE_DO.get(doId);
}

async function activePublisherKeyIds(env: Env, tenantId: string, spaceId: string, keyIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(keyIds.filter(keyId => /^[a-f0-9]{64}$/.test(keyId)))];
  if (!unique.length) return new Set();
  const placeholders = unique.map(() => "?").join(",");
  const rows = await env.PLATFORM_DB.prepare(`SELECT key_id FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND status='active' AND key_id IN (${placeholders})`)
    .bind(tenantId, spaceId, ...unique).all<{ key_id: string }>();
  return new Set((rows.results ?? []).map(row => row.key_id));
}

async function trustedExtensionInstallations<T extends { publisher_key_id?: string | null }>(
  env: Env,
  tenantId: string,
  spaceId: string,
  installations: T[],
): Promise<T[]> {
  const keyIds = installations.flatMap(item => item.publisher_key_id ? [item.publisher_key_id] : []);
  const active = await activePublisherKeyIds(env, tenantId, spaceId, keyIds);
  return retainActivePublisherInstallations(installations, active);
}

async function currentPublisherReleases<T extends PublisherTaggedRelease>(
  env: Env,
  tenantId: string,
  spaceId: string,
  releases: T[],
): Promise<T[]> {
  const keyIds = releases.flatMap(release => release.publisher?.keyId ? [release.publisher.keyId] : []);
  const active = await activePublisherKeyIds(env, tenantId, spaceId, keyIds);
  return releases.map(release => applyPublisherKeyRegistry(release, active));
}

async function blueprintPublisherTrust(
  env: Env,
  stub: Fetcher,
  tenantId: string,
  spaceId: string,
  blueprint: SpaceBlueprint,
): Promise<"trusted" | "unavailable" | "untrusted"> {
  const pinnedReleases = Object.entries(blueprint.requiredExtensionVersions ?? {});
  if (!pinnedReleases.length) return "trusted";
  const summaries = await Promise.all(pinnedReleases.map(async ([extensionId, version]) => {
    const response = await stub.fetch(new Request(`http://space-do/extension-releases?extension_id=${encodeURIComponent(extensionId)}`));
    if (!response.ok) return null;
    const result = await readBoundedResponseJson<{ releases?: Array<PublisherTaggedRelease & { version?: string }> }>(response, 256 * 1024).catch(() => null);
    return result?.releases?.find(release => release.version === version) ?? false;
  }));
  if (summaries.some(release => release === null)) return "unavailable";
  const releases = summaries.filter((release): release is PublisherTaggedRelease & { version?: string } => release !== false && release !== null);
  if (releases.length !== pinnedReleases.length || releases.some(release => release.signatureValid !== true)) return "untrusted";
  const active = await activePublisherKeyIds(env, tenantId, spaceId,
    releases.flatMap(release => release.publisher?.keyId ? [release.publisher.keyId] : []));
  return releases.every(release => isTrustedPublisherRelease(release, active)) ? "trusted" : "untrusted";
}

app.post("/internal/spaces/:spaceId/widget-event-subscribers", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const body = await c.req.json<{ event?: { spaceId?: unknown }; actorId?: string }>().catch(() => ({} as { event?: { spaceId?: unknown }; actorId?: string }));
  if (body.event?.spaceId !== c.req.param("spaceId")) return c.json({ error_code: "scope_mismatch" }, 403);
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  return stub.fetch(new Request("http://space-do/widget-event-subscribers", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": c.req.header("x-naelao-internal-token") ?? "" }, body: JSON.stringify(body) }));
});

app.get("/spaces/:spaceId/workflow-installations/:instanceId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  const response = await stub.fetch(new Request("http://space-do/workflow-installation?" + new URLSearchParams({ instance_id: c.req.param("instanceId"), tenant_id: tenantId, space_id: c.req.param("spaceId"), ...(c.req.query("include_disabled") === "1" ? { include_disabled: "1" } : {}) })));
  if (!response.ok) return response;
  const result = await response.json<Record<string, unknown>>();
  const release = result.release as { version?: unknown; artifactSha256?: unknown; signatureValid?: unknown; publisher?: { keyId?: unknown } } | null | undefined;
  const dependencyRelease = result.release as { dependenciesResolved?: unknown } | null | undefined;
  if (result.dependenciesResolved !== true && dependencyRelease?.dependenciesResolved !== true)
    return c.json({ error_code: "extension_dependency_unavailable" }, 409, { "cache-control": "private, no-store" });
  const keyId = release?.publisher?.keyId;
  if (release && typeof keyId === "string") {
    const trusted = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
      WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, c.req.param("spaceId"), keyId).first();
    if (!trusted) release.signatureValid = false;
  }
  if (c.req.query("include_phone_settings") === "1") {
    const instance = result.instance as { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; status?: string } | undefined;
    const manifest = result.manifest as { declaredPermissions?: unknown[]; capabilityRequirements?: unknown[]; settingsSchema?: unknown } | undefined;
    const readCapability = manifest?.capabilityRequirements?.includes("extension.settings.read") ?? false;
    const readPermission = manifest?.declaredPermissions?.includes("extension.settings.read") ?? false;
    if (readCapability !== readPermission || readCapability !== Boolean(manifest?.settingsSchema))
      return c.json({ error_code: "phone_extension_settings_declaration_invalid" }, 409, { "cache-control": "private, no-store" });
    if (instance?.status !== "active" || instance.instance_id !== c.req.param("instanceId")
      || instance.tenant_id !== tenantId || instance.space_id !== c.req.param("spaceId") || release?.signatureValid !== true)
      return c.json({ error_code: "phone_extension_installation_untrusted" }, 409, { "cache-control": "private, no-store" });
    if (typeof release.version !== "string" || typeof release.artifactSha256 !== "string")
      return c.json({ error_code: "phone_extension_release_unavailable" }, 409, { "cache-control": "private, no-store" });
    if (!readCapability) return c.json(result, 200, { "cache-control": "private, no-store" });
    const settingsQuery = new URLSearchParams({ tenant_id: tenantId, space_id: c.req.param("spaceId"), instance_id: c.req.param("instanceId"),
      expected_version: release.version, expected_artifact_sha256: release.artifactSha256,
      ...(instance.project_id ? { project_id: instance.project_id } : {}) });
    const settingsResponse = await stub.fetch(new Request(`http://space-do/phone-extension-settings?${settingsQuery}`, {
      headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    }));
    if (!settingsResponse.ok) return new Response(await settingsResponse.text(), { status: settingsResponse.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
    result.phone_settings = await settingsResponse.json();
  }
  return c.json(result);
});

app.get("/spaces/:spaceId/internal/channel-installations", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const projectId = c.req.query("project_id");
  if (projectId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)) return c.json({ error_code: "project_id_invalid" }, 400);
  const space = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first();
  if (!space) throw notFound("Space");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await stub.fetch(new Request("http://space-do/channel-installations?" + new URLSearchParams({ ...(projectId ? { project_id: projectId } : {}), tenant_id: tenantId, space_id: spaceId, ...(c.req.query("include_disabled") === "1" ? { include_disabled: "1" } : {}) })));
  if (!response.ok) return response;
  const result = await response.json<{ installations?: Array<{ publisher_key_id?: string; publisher_attestation_valid?: boolean; dependencies_resolved?: boolean }> }>();
  const installations = result.installations ?? [];
  const keyIds = [...new Set(installations.flatMap(item => item.publisher_key_id ? [item.publisher_key_id] : []))];
  let activeKeys = new Set<string>();
  if (keyIds.length) {
    const placeholders = keyIds.map(() => "?").join(",");
    const trusted = await c.env.PLATFORM_DB.prepare(`SELECT key_id FROM extension_publisher_keys
      WHERE tenant_id=? AND space_id=? AND status='active' AND key_id IN (${placeholders})`).bind(tenantId, spaceId, ...keyIds).all<{ key_id: string }>();
    activeKeys = new Set((trusted.results ?? []).map(row => row.key_id));
  }
  return c.json({ ...result, installations: retainActivePublisherInstallations(installations, activeKeys).filter(item => item.dependencies_resolved !== false) });
});

app.get("/spaces/:spaceId/container-installations", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!tenantId || !userId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  if (c.req.query("include_disabled") === "1") {
    const projectId = c.req.query("project_id");
    if (projectId) {
      const denied = await requireManageableAutomationProject(c, c.req.param("spaceId"), projectId);
      if (denied) return denied;
    } else if (!await canExportBlueprint(c, c.req.param("spaceId"))) {
      return c.json({ error_code: "owner_or_admin_required" }, 403);
    }
  }
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  return stub.fetch(new Request("http://space-do/container-installations?" + new URLSearchParams({ tenant_id: tenantId, space_id: c.req.param("spaceId"), user_id: userId, project_id: c.req.query("project_id") ?? "", ...(c.req.query("include_disabled") === "1" ? { include_disabled: "1" } : {}) })));
});

app.use("/spaces/:spaceId/runtime-catalog", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/runtime-catalog", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/runtime-catalog", async c => {
  const identity = getCallerIdentity(c);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(c.req.param("spaceId"), identity.tenantId).first();
  if (!owned) throw notFound("Space");
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "runtime_catalog_unavailable" }, 503);
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/container-images"));
  if (!response.ok) return c.json({ error_code: "runtime_catalog_unavailable" }, 503);
  const catalogue = await response.json<{ images: Array<{ id: string; available: boolean; image?: string; billing_tier?: string; install_manifest?: unknown; plan_available?: boolean; plan_reason?: string }> }>();
  const plan = await new EntitlementsChecker(c.env.PLATFORM_DB).getTenantTier(identity.tenantId);
  const images = catalogue.images.map(image => {
    const requirements = (image.install_manifest as { containers?: Array<{ resources?: { cpuCores?: number; memoryMb?: number } }> } | undefined)?.containers ?? [];
    let planAvailable = image.available;
    let planReason = image.available ? undefined : "runtime_not_deployed";
    if (image.available && image.billing_tier && !isPlanTierAtLeast(plan, image.billing_tier)) {
      planAvailable = false;
      planReason = "subscription_plan_required";
    }
    try {
      for (const container of requirements) {
        if (!container.resources || typeof container.resources.cpuCores !== "number" || typeof container.resources.memoryMb !== "number") throw new Error("runtime_requirements_invalid");
        assertExecutionPlanResources(plan, { cpuCores: container.resources.cpuCores, memoryMb: container.resources.memoryMb });
      }
    } catch (error) {
      planAvailable = false;
      planReason = (error as Error).message === "container_subscription_resource_limit" ? "subscription_resource_limit" : (error as Error).message;
    }
    return { ...image, plan_available: planAvailable, ...(planReason ? { plan_reason: planReason } : {}) };
  });
  return c.json({ images, installed_slots_per_workspace: getExecutionLimits(plan).installedContainersPerWorkspace });
});

// Explicit human installation. The catalogue is refreshed rather than trusting a cached
// availability bit or a model-supplied digest. Runtime discovery never invokes this write.
app.use("/spaces/:spaceId/runtime-installations", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/runtime-installations", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/runtime-installations", async c => {
  const { tenantId, userId } = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  if (!tenantId || !userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
  const body = await c.req.json<{ image_id?: string; manifest?: unknown; scope?: string; project_id?: string; acknowledge_permissions?: boolean; promote_existing?: boolean; acknowledge_promotion?: boolean; acknowledge_isolation?: boolean }>().catch(() => null);
  if (!body || body.acknowledge_permissions !== true) return c.json({ error_code: "runtime_install_approval_required" }, 400);
  if (typeof body.image_id !== "string" || body.manifest !== undefined) return c.json({ error_code: "deployment_generated_runtime_required" }, 422);
  if (!["SPACE_SHARED", "SPACE_ASSISTANT", "PROJECT_SHARED"].includes(body.scope ?? "")
    || ["SPACE_SHARED", "SPACE_ASSISTANT"].includes(body.scope ?? "") && body.project_id
    || body.scope === "PROJECT_SHARED" && (!body.project_id || typeof body.project_id !== "string")) return c.json({ error_code: "runtime_scope_invalid" }, 400);
  if (body.project_id) {
    const denied = await requireManageableAutomationProject(c, spaceId, body.project_id);
    if (denied) return denied;
    const project = await (await spaceDoStub(c.env, spaceId, tenantId)).fetch(new Request(`http://space-do/projects/${encodeURIComponent(body.project_id)}`));
    if (!project.ok) return c.json({ error_code: "project_not_found" }, 404);
    const details = await project.json<{ execution_ceiling?: number }>();
    if ((details.execution_ceiling ?? 6) < 6) return c.json({ error_code: "container_execution_ceiling_exceeded" }, 403);
  }
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "runtime_catalog_unavailable" }, 503);
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/container-images"));
  if (!response.ok) return c.json({ error_code: "runtime_catalog_unavailable" }, 503);
  const catalogue = await response.json<{ images: Array<{ id: string; available: boolean; image?: string; billing_tier?: string; install_manifest?: unknown }> }>();
  const candidate = catalogue.images.find(entry => entry.id === body.image_id && entry.available && entry.install_manifest);
  if (!candidate) return c.json({ error_code: "runtime_not_deployed_or_approved" }, 409);
  const plan = await new EntitlementsChecker(c.env.PLATFORM_DB).getTenantTier(tenantId);
  if (candidate.billing_tier && !isPlanTierAtLeast(plan, candidate.billing_tier))
    return c.json({ error_code: "subscription_plan_required" }, 403);
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try {
    manifest = validateExtensionManifest(candidate.install_manifest, { gatekeeperCapabilities: ["native-execution"] });
    if (!manifest.containers?.length || manifest.gadgets.length || manifest.daemons.length || manifest.commands.length) throw new Error("Only container declarations belong on this runtime installation route");
    for (const contract of manifest.containers) {
      if (contract.networkPolicy && contract.networkPolicy !== "none" || contract.mounts?.some(mount => !mount.writable)) throw new Error("Runtime network/mount profile is unavailable");
      const approved = catalogue.images.find(entry => entry.available && entry.image === contract.image);
      if (!approved) throw new Error("Runtime digest is not deployed and approved");
      const profile = validateExtensionManifest(approved.install_manifest).containers?.[0];
      if (!profile || contract.resources.memoryMb > profile.resources.memoryMb || contract.resources.cpuCores > profile.resources.cpuCores) throw new Error("Runtime exceeds deployed resources");
    }
  } catch (error) { return c.json({ error_code: "runtime_manifest_invalid", message: (error as Error).message }, 422); }
  try {
    for (const contract of manifest.containers ?? []) {
      const resources = contract.resources;
      if (!resources || typeof resources.cpuCores !== "number" || typeof resources.memoryMb !== "number") throw new Error("runtime_requirements_invalid");
      assertExecutionPlanResources(plan, { cpuCores: resources.cpuCores, memoryMb: resources.memoryMb });
    }
  } catch (error) {
    const reason = (error as Error).message;
    return c.json({ error_code: reason === "container_subscription_resource_limit" ? reason : "runtime_plan_validation_failed" }, 403);
  }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const installationsResponse = await stub.fetch(new Request("http://space-do/extension-installations?" + new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: manifest.id })));
  if (!installationsResponse.ok) return c.json({ error_code: "runtime_installation_lookup_unavailable" }, 503);
  const installations = await installationsResponse.json<{ installations: Array<{ instance_id: string; project_id: string | null; scope: string }> }>();
  const projectInstalls = installations.installations.filter(item => item.scope === "PROJECT_SHARED");
  const sharedInstall = installations.installations.find(item => item.scope === "SPACE_SHARED");
  const assistantInstall = installations.installations.find(item => item.scope === "SPACE_ASSISTANT");
  if (body.scope === "PROJECT_SHARED" && sharedInstall)
    return c.json({ status: "already_available_space_shared", installation_id: sharedInstall.instance_id, scope: "SPACE_SHARED" });
  if (body.scope === "SPACE_ASSISTANT" && assistantInstall)
    return c.json({ status: "already_available_assistant", installation_id: assistantInstall.instance_id, scope: "SPACE_ASSISTANT" });
  const otherProjects = body.project_id ? projectInstalls.filter(item => item.project_id !== body.project_id) : projectInstalls;
  const promotionApplies = body.scope === "SPACE_SHARED" ? projectInstalls.length > 0 : body.scope === "PROJECT_SHARED" ? otherProjects.length > 0 : false;
  if (promotionApplies && !body.promote_existing && !body.acknowledge_isolation) {
    return c.json({ status: "promotion_confirmation_required", extension_id: manifest.id,
      existing_project_ids: [...new Set(projectInstalls.map(item => item.project_id).filter((id): id is string => Boolean(id)))],
      requested_project_id: body.project_id, recommended_scope: "SPACE_SHARED",
      warning: "Promotion deactivates project-scoped installations and uses the extension's dedicated Space workspace. Project files and workspace contents are not moved. Runtime savings are not guaranteed." });
  }
  if (body.promote_existing && (body.scope !== "SPACE_SHARED" || body.acknowledge_promotion !== true))
    return c.json({ error_code: "runtime_promotion_confirmation_required" }, 400);
  return forwardToSpaceDO(stub, "/extensions", "POST", JSON.stringify({ manifest, installedBy: userId, tenantId, spaceId,
      scope: body.scope, ...(body.project_id ? { projectId: body.project_id } : {}), ...(body.promote_existing ? { promoteExisting: true } : {}), gatekeeperCapabilities: ["native-execution"] }));
});

// Canonical project-universal cron registration. The SpaceDO performs the authoritative
// project/space ownership check atomically with persistence.
app.post("/spaces/:spaceId/project-crons", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("spaceId");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const body = await c.req.json<Record<string, unknown>>();
  return forwardToSpaceDO(stub, "/internal/project-crons", "POST", JSON.stringify({ ...body, space_id: spaceId }));
});

// Space-owned private LoRA manifests. The adapter identifier never leaves the trusted workers;
// the agents worker resolves it immediately before Workers AI inference.
async function resolveGlossarySpace(c: { env: Env; req: { header(name: string): string | undefined } }, spaceId: string) {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !spaceId) return null;
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) return null;
  if (c.req.header("x-naelao-role") === "product_end_user") {
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!userId || !await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId)) return null;
  }
  return owned;
}
async function canEditGlossary(c: { env: Env; req: { header(name: string): string | undefined } }, spaceId: string): Promise<boolean> {
  const role = c.req.header("x-naelao-role") ?? "";
  if (role === "owner" || role === "admin") return true;
  if (role !== "product_end_user") return false;
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!userId) return false;
  const membership = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId);
  return membership === "owner" || membership === "admin";
}
app.get("/spaces/:spaceId/domain-glossary", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await resolveGlossarySpace(c, spaceId);
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  return (await spaceDoStub(c.env, spaceId, c.req.header("x-naelao-tenant-id") ?? "")).fetch(new Request(`http://space/internal/domain-glossary?space_id=${encodeURIComponent(spaceId)}`));
});
app.post("/spaces/:spaceId/domain-glossary", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await resolveGlossarySpace(c, spaceId);
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  if (!await canEditGlossary(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const actorId = c.req.header("x-naelao-user-id") ?? "system";
  return (await spaceDoStub(c.env, spaceId, c.req.header("x-naelao-tenant-id") ?? "")).fetch(new Request("http://space/internal/domain-glossary", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: spaceId, actor_id: actorId, entry: await c.req.json().catch(() => null) }),
  }));
});
app.delete("/spaces/:spaceId/domain-glossary", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await resolveGlossarySpace(c, spaceId);
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  if (!await canEditGlossary(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const source = new URL(c.req.url);
  return (await spaceDoStub(c.env, spaceId, c.req.header("x-naelao-tenant-id") ?? "")).fetch(new Request(`http://space/internal/domain-glossary?space_id=${encodeURIComponent(spaceId)}&term=${encodeURIComponent(source.searchParams.get("term") ?? "")}&locale=${encodeURIComponent(source.searchParams.get("locale") ?? "und")}`, { method: "DELETE" }));
});
app.use("/internal/spaces/:spaceId/domain-glossary/lookup", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/domain-glossary/lookup", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  const owned = tenantId && await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  return (await spaceDoStub(c.env, spaceId, tenantId)).fetch(new Request("http://space/internal/domain-glossary/lookup", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(await c.req.json().catch(() => ({}))), space_id: spaceId }),
  }));
});

async function canManageCustomModel(c: { req: { header(name: string): string | undefined }; env: Env }, spaceId: string): Promise<boolean> {
  const role = c.req.header("x-naelao-role") ?? "";
  if (role === "owner" || role === "admin") return true;
  if (role !== "product_end_user") return false;
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!userId) return false;
  const membership = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId);
  return membership === "owner" || membership === "admin";
}
async function spaceModelInternalHeaders(secret: string, tenantId: string, extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  headers.set("x-naelao-tenant-id", tenantId);
  headers.set("x-naelao-internal-token", await mintInternalToken(secret, tenantId));
  return headers;
}

app.get("/custom-models/:modelId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.query("space_id") ?? "";
  if (!tenantId || !spaceId) return c.json({ error_code: "bad_request", message: "tenant and space_id are required" }, 400);
  if (!await canManageCustomModel(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ?").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}/lifecycle?space_id=${encodeURIComponent(spaceId)}`, {
    headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId),
  }));
});
app.put("/custom-models/:modelId", async (c) => {
  return c.json({ error_code: "lifecycle_required", message: "Import adapters through /spaces/:spaceId/custom-models/:modelId/lifecycle after recording data consent and provenance" }, 410);
});
app.use("/internal/spaces/:spaceId/custom-models/:modelId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/custom-models/:modelId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ?").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}?space_id=${encodeURIComponent(spaceId)}`, {
    headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId),
  }));
});
app.get("/spaces/:spaceId/custom-models/:modelId/lifecycle", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  if (!await canManageCustomModel(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}/lifecycle?space_id=${encodeURIComponent(spaceId)}`));
});
app.get("/spaces/:spaceId/custom-models/:modelId/test-sets", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId");
  if (!await canManageCustomModel(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found" }, 404);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const target = new URL(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}/test-sets?space_id=${encodeURIComponent(spaceId)}`);
  const id = c.req.query("test_set_id"); if (id) target.searchParams.set("test_set_id", id);
  return stub.fetch(new Request(target, { headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId) }));
});
app.post("/spaces/:spaceId/custom-models/:modelId/test-sets", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId"), actorId = c.req.header("x-naelao-user-id") ?? "";
  if (!await canManageCustomModel(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
  if (!owned) return c.json({ error_code: "not_found" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}/test-sets?space_id=${encodeURIComponent(spaceId)}`, {
    method: "POST", headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId, { "content-type": "application/json" }), body: JSON.stringify({ ...body, actorId }),
  }));
});

// Space data lifecycle controls are owner/admin-only. The identity used for audit is derived
// from verified request claims; the browser cannot select an actor or tenant.
app.use("/spaces/:spaceId/data-ops", requireSpaceMembership({ GET: "admin", POST: "admin" }));
app.get("/spaces/:spaceId/data-ops", async c => {
  const { tenantId, userId } = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  if (!tenantId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/data-ops?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, actor_id: userId })}`, { headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId) }));
});
app.post("/spaces/:spaceId/data-ops", async c => {
  const { tenantId, userId } = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  if (!tenantId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.action !== "string") return c.json({ error_code: "bad_request" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space/data-ops", { method: "POST", headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId, { "content-type": "application/json" }), body: JSON.stringify({ ...body, tenant_id: tenantId, space_id: spaceId, actor_id: userId }) }));
});
app.post("/spaces/:spaceId/custom-models/:modelId/lifecycle", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  const actorId = c.req.header("x-naelao-user-id") ?? "";
  if (!await canManageCustomModel(c, spaceId)) return c.json({ error_code: "forbidden", message: "Owner or admin role required" }, 403);
  const space = await c.env.PLATFORM_DB.prepare("SELECT config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first<{ config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const cloudAdapterAction = ["import_adapter", "approve_activation", "submit_training"].includes(String(body["action"]));
  if (cloudAdapterAction && airGappedOnlyFromConfig(space.config_json)) return c.json({ error_code: "compliance_violation", message: "Cloud Workers AI adapters are blocked by this Space's air-gap policy" }, 403);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(c.req.param("modelId"))}/lifecycle?space_id=${encodeURIComponent(spaceId)}`, {
    method: "POST", headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, tenantId, { "content-type": "application/json" }), body: JSON.stringify({ ...body, actorId }),
  }));
});

/** Get the BuilderAccountDO stub for a builder (== tenant), HMAC-named like every other DO. */
async function builderAccountDoStub(env: Env, tenantId: string) {
  const doId = env.BUILDER_ACCOUNT_DO.idFromName(
    await getDOName("builder", tenantId, tenantId, env.PLATFORM_SECRET)
  );
  return env.BUILDER_ACCOUNT_DO.get(doId);
}

/** Get the ProductUserDO stub for a (product, end-user) pair, HMAC-named to prevent enumeration. */
async function productUserDoStub(env: Env, productId: string, endUserId: string, tenantId: string) {
  const doId = env.PRODUCT_USER_DO.idFromName(
    await getDOName("produser", `${productId}:${endUserId}`, tenantId, env.PLATFORM_SECRET)
  );
  return env.PRODUCT_USER_DO.get(doId);
}

/** Resolve a Product or an end-user Space to its Product identity and requested tenant. */
async function resolveProductScope(
  env: Env,
  resourceId: string
): Promise<{ id: string; tenant_id: string; resource_tenant_id: string } | null> {
  const direct = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id FROM products WHERE id = ? AND status = 'active'"
  ).bind(resourceId).first<{ id: string; tenant_id: string }>();
  if (direct) return { ...direct, resource_tenant_id: direct.tenant_id };
  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, product_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(resourceId).first<{ tenant_id: string; product_id: string | null }>();
  if (!space) return null;
  if (space.product_id) {
    const product = await env.PLATFORM_DB.prepare(
      "SELECT id, tenant_id FROM products WHERE id = ? AND status = 'active'"
    ).bind(space.product_id).first<{ id: string; tenant_id: string }>();
    // A direct Space-to-Product reference is only valid within the Space's tenant.
    if (!product || product.tenant_id !== space.tenant_id) return null;
    return { ...product, resource_tenant_id: space.tenant_id };
  }

  // Child businesses can be nested below the Product root. Resolve only through live parent
  // rows and cap traversal so corrupt/cyclic hierarchies cannot turn session verification into
  // unbounded work. A parent link is the existing business hierarchy authority; the caller's
  // tenant remains the resource tenant returned to Router, while the Product tenant names the DO.
  const ancestor = await env.PLATFORM_DB.prepare(
    `WITH RECURSIVE product_ancestors(id, parent_space_id, status, depth) AS (
       SELECT id, parent_space_id, status, 0 FROM spaces WHERE id = ? AND status != 'deleted'
       UNION ALL
       SELECT parent.id, parent.parent_space_id, parent.status, child.depth + 1
         FROM spaces parent JOIN product_ancestors child ON parent.id = child.parent_space_id
        WHERE parent.status != 'deleted' AND child.depth < 32
     )
     SELECT p.id, p.tenant_id
       FROM product_ancestors a JOIN products p ON p.id = a.id
      WHERE a.depth > 0 AND p.status = 'active'
      ORDER BY a.depth LIMIT 1`
  ).bind(resourceId).first<{ id: string; tenant_id: string }>();
  return ancestor ? { ...ancestor, resource_tenant_id: space.tenant_id } : null;
}

async function resolveProductIdentity(env: Env, spaceId: string): Promise<{ id: string; tenant_id: string } | null> {
  const scope = await resolveProductScope(env, spaceId);
  return scope ? { id: scope.id, tenant_id: scope.tenant_id } : null;
}

async function isActiveProductUser(env: Env, productId: string, tenantId: string, userId: string): Promise<number | null> {
  const row = await env.PLATFORM_DB.prepare(
    `SELECT u.security_generation FROM products p JOIN product_end_users u ON u.product_space_id = p.id
      WHERE p.id = ? AND p.tenant_id = ? AND p.status = 'active' AND u.end_user_id = ?
        AND u.suspended_at IS NULL AND u.deleted_at IS NULL`
  ).bind(productId, tenantId, userId).first<{ security_generation: number }>();
  return row && Number.isSafeInteger(row.security_generation) && row.security_generation >= 0 ? row.security_generation : null;
}

async function verifyProductSession(env: Env, resourceId: string, userId: string, token: string): Promise<{ tenant_id: string; security_generation: number } | null> {
  const scope = await resolveProductScope(env, resourceId);
  if (!scope) return null;
  const securityGeneration = await isActiveProductUser(env, scope.id, scope.tenant_id, userId);
  if (securityGeneration === null) return null;
  const stub = await productUserDoStub(env, scope.id, userId, scope.tenant_id);
  const response = await stub.fetch(new Request("http://do/sessions/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_token: token, security_generation: securityGeneration }),
  }));
  if (!response.ok || !(await response.json<{ valid?: boolean }>()).valid) return null;
  return { tenant_id: scope.resource_tenant_id, security_generation: securityGeneration };
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

async function requireManageableAutomationProject(c: any, spaceId: string, projectId: unknown): Promise<Response | null> {
  return requireAutomationProjectAccess(c, spaceId, projectId, "manage");
}

async function requireReadableAutomationProject(c: any, spaceId: string, projectId: unknown): Promise<Response | null> {
  return requireAutomationProjectAccess(c, spaceId, projectId, "read");
}

async function requireAutomationProjectAccess(c: any, spaceId: string, projectId: unknown, access: "read" | "manage"): Promise<Response | null> {
  if (typeof projectId !== "string" || !projectId.trim()) {
    return c.json({ error_code: "bad_request", message: "project_id is required" }, 400);
  }
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  const spaceRole = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : null;
  const qs = new URLSearchParams({ space_id: spaceId, user_id: identity.userId ?? "" });
  if (!identity.userId || spaceRole === "admin" || spaceRole === "owner") qs.set("space_manager", "1");
  if (access === "read") qs.set("access", "read");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const result = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/automation-access?${qs}`, "GET");
  if (result.ok) return null;
  const detail = await result.json<{ error_code?: string; message?: string }>().catch(() => ({} as { error_code?: string; message?: string }));
  return c.json({ error_code: detail.error_code ?? "forbidden", message: detail.message ?? "Project access denied" }, result.status as 403 | 404);
}

/** List only projects the current caller may see. This is used before reading project-owned
 * automation so a Space membership alone never reveals private project schedules. */
async function visibleAutomationProjectIds(c: any, spaceId: string): Promise<string[] | Response> {
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const params = new URLSearchParams({ space_id: spaceId });
  if (identity.userId) params.set("viewer_id", identity.userId);
  else params.set("space_manager", "1");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await forwardToSpaceDO(stub, `/projects?${params.toString()}`, "GET");
  if (!response.ok) return c.json({ error_code: "project_access_unavailable", message: "Could not resolve visible projects" }, 503);
  const payload = await response.json<{ data?: Array<{ id?: string }> }>().catch(() => null);
  return (payload?.data ?? []).flatMap((project) => typeof project.id === "string" ? [project.id] : []);
}

async function visibleAutomationProjectPage(
  c: any,
  spaceId: string,
  after: string,
  limit: number,
): Promise<{ projectIds: string[]; nextCursor: string | null; hasMore: boolean } | Response> {
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const params = new URLSearchParams({ space_id: spaceId, after, limit: String(limit) });
  if (identity.userId) params.set("viewer_id", identity.userId);
  else params.set("space_manager", "1");
  const response = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, tenantId),
    `/projects/blackboard-visible-page?${params}`, "GET");
  if (!response.ok) return c.json({ error_code: "project_access_unavailable", message: "Could not resolve visible project page" }, 503);
  const payload = await response.json<{ project_ids?: unknown; next_cursor?: unknown; truncated?: unknown }>()
    .catch(() => null);
  const projectIds = payload?.project_ids;
  const nextCursor = payload?.next_cursor;
  const truncated = payload?.truncated;
  const validIds = Array.isArray(projectIds) && projectIds.length <= limit &&
    projectIds.every((id, index) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(id) &&
      id > after && (index === 0 || id > projectIds[index - 1]));
  const validCursor = nextCursor === null || (typeof nextCursor === "string" &&
    /^[A-Za-z0-9._:-]{1,160}$/.test(nextCursor) && nextCursor > after);
  if (!payload || !validIds || !validCursor || typeof truncated !== "boolean" ||
      (truncated && (!nextCursor || !projectIds.length || nextCursor !== projectIds[projectIds.length - 1])) ||
      (!truncated && nextCursor !== null)) {
    return c.json({ error_code: "project_page_unavailable", message: "Invalid visible project page" }, 503);
  }
  return { projectIds: projectIds as string[], nextCursor: nextCursor as string | null, hasMore: truncated };
}

app.use("/internal/spaces/:spaceId/projects/:projectId/automation-access", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/projects/:projectId/automation-access", async (c) => {
  const denied = await requireManageableAutomationProject(c, c.req.param("spaceId"), c.req.param("projectId"));
  return denied ?? c.json({ project_id: c.req.param("projectId"), can_manage: true });
});

// Blackboard publication is explicit. A caller must retain access to both the Space and
// each project whose shared card is returned; an internal token alone is not a user identity.
app.use("/internal/spaces/:spaceId/blackboard/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/internal/spaces/:spaceId/blackboard/*", async (c, next) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId || c.req.header("x-naelao-role") !== "product_end_user") return c.json({ error_code: "user_identity_required" }, 403);
  const space = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status!='deleted'").bind(c.req.param("spaceId"), tenantId).first();
  if (!space) return c.json({ error_code: "space_not_found" }, 404);
  return next();
});
app.put("/internal/spaces/:spaceId/blackboard/cards/:projectId", async c => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId"), tenantId = c.req.header("x-naelao-tenant-id")!;
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  let body: { summary?: unknown; capabilities?: unknown; evidence?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 16384)); } catch { return c.json({ error_code: "invalid_card" }, 400); }
  const validList = (x: unknown, count: number, length: number): x is string[] => Array.isArray(x) && x.length <= count && x.every(v => typeof v === "string" && v.trim().length > 0 && v.length <= length);
  if (!body || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 4000 || !validList(body.capabilities, 64, 120) || !validList(body.evidence, 32, 512)) return c.json({ error_code: "invalid_card" }, 400);
  const updatedAt = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(`INSERT INTO space_blackboard_cards(tenant_id,space_id,project_id,summary,capabilities_json,evidence_json,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET summary=excluded.summary,capabilities_json=excluded.capabilities_json,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
    .bind(tenantId, spaceId, projectId, body.summary.trim(), JSON.stringify([...new Set(body.capabilities.map(v => v.trim()))]), JSON.stringify([...new Set(body.evidence.map(v => v.trim()))]), updatedAt).run();
  return c.json({ published: true, project_id: projectId, updated_at: updatedAt });
});
app.delete("/internal/spaces/:spaceId/blackboard/cards/:projectId", async c => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId");
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  try { await unpublishBlackboardProject(c.env.PLATFORM_DB, c.req.header("x-naelao-tenant-id")!, spaceId, projectId); }
  catch { return c.json({ error_code: "blackboard_unpublish_unavailable" }, 503); }
  return c.json({ unpublished: true });
});
app.get("/internal/spaces/:spaceId/blackboard/cards/:projectId", async c => {
  const space=c.req.param("spaceId"), project=c.req.param("projectId"), denied=await requireReadableAutomationProject(c,space,project);
  if(denied)return denied;
  const card=await c.env.PLATFORM_DB.prepare("SELECT project_id,summary,capabilities_json,evidence_json,updated_at FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?").bind(c.req.header("x-naelao-tenant-id"),space,project).first<{project_id:string;summary:string;capabilities_json:string;evidence_json:string;updated_at:string}>();
  return c.json({card:card ? {projectId:card.project_id,summary:card.summary,capabilities:JSON.parse(card.capabilities_json),evidence:JSON.parse(card.evidence_json),updatedAt:card.updated_at} : null});
});
app.get("/internal/spaces/:spaceId/blackboard/cards", async c => {
  const spaceId = c.req.param("spaceId");
  const cursor = c.req.query("after") ?? "";
  if (cursor && !/^[A-Za-z0-9._:-]{1,160}$/.test(cursor)) return c.json({ error_code:"invalid_cursor" },400);
  const visible = await visibleAutomationProjectPage(c, spaceId, cursor, 90);
  if (visible instanceof Response) return visible;
  const page = visible.projectIds;
  if (!page.length) return c.json({ cards: [], next_cursor: visible.nextCursor, truncated: visible.hasMore });
  const placeholders = page.map(() => "?").join(",");
  const cards = await c.env.PLATFORM_DB.prepare(`SELECT project_id,summary,capabilities_json,evidence_json,updated_at FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id IN (${placeholders}) ORDER BY project_id`).bind(c.req.header("x-naelao-tenant-id"), spaceId, ...page).all<{ project_id: string; summary: string; capabilities_json: string; evidence_json: string; updated_at: string }>();
  return c.json({ next_cursor: visible.nextCursor, truncated: visible.hasMore, cards: cards.results.map(card => ({ projectId: card.project_id, summary: card.summary, capabilities: JSON.parse(card.capabilities_json), evidence: JSON.parse(card.evidence_json), updatedAt: card.updated_at })) });
});
app.post("/internal/spaces/:spaceId/blackboard/requests", async c => {
  const spaceId = c.req.param("spaceId"), tenant = c.req.header("x-naelao-tenant-id")!, user = c.req.header("x-naelao-user-id")!;
  let b: Record<string, unknown>;
  try { b = JSON.parse(await readBoundedRequestText(c.req.raw, 16384)); } catch { return c.json({ error_code: "invalid_request" }, 400); }
  const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(v);
  if (!b || !validId(b.id) || !validId(b.source_project_id) || !validId(b.target_project_id) || b.source_project_id === b.target_project_id || typeof b.objective !== "string" || !b.objective.trim() || b.objective.length > 4000 || typeof b.expected_result !== "string" || !b.expected_result.trim() || b.expected_result.length > 2000 || (b.deadline !== undefined && (typeof b.deadline !== "string" || !Number.isFinite(Date.parse(b.deadline))))) return c.json({ error_code: "invalid_request" }, 400);
  const sourceDenied = await requireManageableAutomationProject(c, spaceId, b.source_project_id); if (sourceDenied) return sourceDenied;
  const targetDenied = await requireReadableAutomationProject(c, spaceId, b.target_project_id); if (targetDenied) return targetDenied;
  const card = await c.env.PLATFORM_DB.prepare("SELECT project_id FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?").bind(tenant,spaceId,b.target_project_id).first();
  if (!card) return c.json({ error_code: "target_not_shared" }, 409);
  const now = new Date().toISOString(), deadline = b.deadline ?? null;
  await createBlackboardRequestIfPublished(c.env.PLATFORM_DB, { tenantId: tenant, spaceId, requestId: b.id,
    sourceProjectId: b.source_project_id, targetProjectId: b.target_project_id, objective: b.objective.trim(),
    expectedResult: b.expected_result.trim(), deadline, userId: user, now });
  const row = await c.env.PLATFORM_DB.prepare("SELECT * FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=?").bind(tenant,spaceId,b.id).first<{source_project_id:string;target_project_id:string;objective:string;expected_result:string;deadline:string|null;created_by:string}>();
  if (!row) return c.json({ error_code: "target_not_shared" }, 409);
  if (row.source_project_id !== b.source_project_id || row.target_project_id !== b.target_project_id || row.objective !== b.objective.trim() || row.expected_result !== b.expected_result.trim() || row.deadline !== deadline || row.created_by !== user) return c.json({ error_code: "request_id_conflict" }, 409);
  return c.json({ request: row });
});
app.get("/internal/spaces/:spaceId/blackboard/requests/:projectId", async c => {
  const spaceId=c.req.param("spaceId"), projectId=c.req.param("projectId");
  const denied=await requireReadableAutomationProject(c,spaceId,projectId); if(denied) return denied;
  const rows=await c.env.PLATFORM_DB.prepare("SELECT * FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND (source_project_id=? OR target_project_id=?) ORDER BY updated_at DESC,id LIMIT 101").bind(c.req.header("x-naelao-tenant-id"),spaceId,projectId,projectId).all();
  return c.json({ requests: rows.results.slice(0,100), truncated: rows.results.length>100 });
});
app.post("/internal/spaces/:spaceId/blackboard/requests/:id/transition", async c => {
  const spaceId=c.req.param("spaceId"), tenant=c.req.header("x-naelao-tenant-id")!, id=c.req.param("id");
  let b: Record<string,unknown>; try { b=JSON.parse(await readBoundedRequestText(c.req.raw,8192)); } catch { return c.json({ error_code:"invalid_transition" },400); }
  if (!b || typeof b.project_id!=="string" || !["accept","decline","complete","cancel"].includes(String(b.action)) || (b.response!==undefined && (typeof b.response!=="string" || b.response.length>4000))) return c.json({ error_code:"invalid_transition" },400);
  const denied=await requireManageableAutomationProject(c,spaceId,b.project_id); if(denied) return denied;
  const row=await c.env.PLATFORM_DB.prepare("SELECT source_project_id,target_project_id,status,response FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=?").bind(tenant,spaceId,id).first<{source_project_id:string;target_project_id:string;status:string;response:string|null}>();
  if(!row || (b.project_id!==row.source_project_id && b.project_id!==row.target_project_id)) return c.json({ error_code:"request_not_found" },404);
  const intended=b.action==="accept" && b.project_id===row.target_project_id ? "accepted" : b.action==="decline" && b.project_id===row.target_project_id ? "declined" : b.action==="complete" && b.project_id===row.target_project_id ? "completed" : b.action==="cancel" && b.project_id===row.source_project_id ? "cancelled" : null;
  const response=typeof b.response==="string" ? b.response.trim() : null;
  if (intended && row.status===intended && row.response===response) return c.json({ id,status:intended,deduplicated:true });
  const next=b.action==="accept" && b.project_id===row.target_project_id && row.status==="pending" ? "accepted" : b.action==="decline" && b.project_id===row.target_project_id && row.status==="pending" ? "declined" : b.action==="complete" && b.project_id===row.target_project_id && row.status==="accepted" ? "completed" : b.action==="cancel" && b.project_id===row.source_project_id && ["pending","accepted"].includes(row.status) ? "cancelled" : null;
  if(!next) return c.json({ error_code:"invalid_transition" },409);
  const now = new Date().toISOString(), recipient = b.project_id===row.source_project_id ? row.target_project_id : row.source_project_id;
  const batch=await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("UPDATE space_blackboard_requests SET status=?,response=?,updated_at=? WHERE tenant_id=? AND space_id=? AND id=? AND status=?").bind(next,response,now,tenant,spaceId,id,row.status),
    c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO space_blackboard_events(tenant_id,space_id,event_id,project_id,request_id,kind,created_at) SELECT tenant_id,space_id,id||':'||status,?,id,'request.'||status,updated_at FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=? AND status=? AND updated_at=?").bind(recipient,tenant,spaceId,id,next,now),
  ]);
  if(!batch[0]?.meta.changes) return c.json({ error_code:"request_changed" },409);
  return c.json({ id,status:next });
});
app.get("/internal/spaces/:spaceId/blackboard/events/:projectId", async c => {
  const spaceId=c.req.param("spaceId"), projectId=c.req.param("projectId");
  const denied=await requireReadableAutomationProject(c,spaceId,projectId); if(denied) return denied;
  const unread=c.req.query("unread") === "true";
  const rows=await c.env.PLATFORM_DB.prepare(`SELECT e.event_id,e.request_id,e.kind,e.created_at,r.read_at FROM space_blackboard_events e
    LEFT JOIN space_blackboard_event_receipts r ON r.tenant_id=e.tenant_id AND r.space_id=e.space_id AND r.project_id=e.project_id AND r.event_id=e.event_id AND r.user_id=?
    WHERE e.tenant_id=? AND e.space_id=? AND e.project_id=? ${unread ? "AND r.event_id IS NULL" : ""}
    ORDER BY e.created_at DESC,e.event_id DESC LIMIT 101`).bind(c.req.header("x-naelao-user-id"),c.req.header("x-naelao-tenant-id"),spaceId,projectId).all();
  return c.json({ events:rows.results.slice(0,100),truncated:rows.results.length>100 });
});
app.get("/internal/spaces/:spaceId/blackboard/policy/:projectId", async c => {
  const space=c.req.param("spaceId"), project=c.req.param("projectId");
  const denied=await requireReadableAutomationProject(c,space,project); if(denied) return denied;
  const row=await c.env.PLATFORM_DB.prepare("SELECT wake_enabled,updated_at FROM space_blackboard_policies WHERE tenant_id=? AND space_id=? AND project_id=?").bind(c.req.header("x-naelao-tenant-id"),space,project).first<{wake_enabled:number;updated_at:string}>();
  return c.json({ wake_enabled:row?.wake_enabled===1, updated_at:row?.updated_at ?? null });
});
app.put("/internal/spaces/:spaceId/blackboard/policy/:projectId", async c => {
  const space=c.req.param("spaceId"), project=c.req.param("projectId");
  const denied=await requireManageableAutomationProject(c,space,project); if(denied) return denied;
  let b: { wake_enabled?: unknown }; try { b=JSON.parse(await readBoundedRequestText(c.req.raw,4096)); } catch { return c.json({ error_code:"invalid_policy" },400); }
  if (!b || typeof b.wake_enabled!=="boolean") return c.json({ error_code:"invalid_policy" },400);
  await persistBlackboardWakePolicy(c.env.PLATFORM_DB, {
    tenantId:c.req.header("x-naelao-tenant-id")!, spaceId:space, projectId:project,
    userId:c.req.header("x-naelao-user-id")!, wakeEnabled:b.wake_enabled,
    updatedAt:new Date().toISOString(), nowSeconds:Math.floor(Date.now()/1000),
  });
  // Policy revocation and cancellation of unaccepted wake claims commit together. An already
  // accepted dispatch is the linearization point and may finish; later events stay disabled.
  return c.json({ wake_enabled:b.wake_enabled });
});
app.on(["GET","PUT"], "/internal/spaces/:spaceId/blackboard/sharing/:projectId", async c => {
  const space=c.req.param("spaceId"), project=c.req.param("projectId"), tenant=c.req.header("x-naelao-tenant-id")!, user=c.req.header("x-naelao-user-id")!;
  const denied=await (c.req.method==="PUT" ? requireManageableAutomationProject(c,space,project) : requireReadableAutomationProject(c,space,project)); if(denied) return denied;
  if(c.req.method==="GET") {
    const row=await c.env.PLATFORM_DB.prepare("SELECT peers_json,daily_limit,updated_at FROM space_blackboard_sharing_policies WHERE tenant_id=? AND space_id=? AND project_id=?").bind(tenant,space,project).first<{peers_json:string;daily_limit:number;updated_at:string}>();
    return c.json({ peers:row ? JSON.parse(row.peers_json) : [], daily_limit:row?.daily_limit ?? 0, updated_at:row?.updated_at ?? null });
  }
  let b:{peers?:unknown;daily_limit?:unknown};try{b=JSON.parse(await readBoundedRequestText(c.req.raw,8192));}catch{return c.json({error_code:"invalid_sharing_policy"},400);}
  if(!b || !Array.isArray(b.peers) || b.peers.length>30 || b.peers.some(v=>typeof v!=="string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(v) || v===project) || !Number.isSafeInteger(b.daily_limit) || Number(b.daily_limit)<0 || Number(b.daily_limit)>50) return c.json({error_code:"invalid_sharing_policy"},400);
  const peers=[...new Set(b.peers as string[])];
  const visible=await visibleAutomationProjectIds(c,space); if(visible instanceof Response)return visible;
  if(peers.some(peer=>!visible.includes(peer)))return c.json({error_code:"peer_not_accessible"},403);
  await c.env.PLATFORM_DB.prepare("INSERT INTO space_blackboard_sharing_policies(tenant_id,space_id,project_id,authorized_user_id,peers_json,daily_limit,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET authorized_user_id=excluded.authorized_user_id,peers_json=excluded.peers_json,daily_limit=excluded.daily_limit,updated_at=excluded.updated_at")
    .bind(tenant,space,project,user,JSON.stringify(peers),b.daily_limit,new Date().toISOString()).run();
  return c.json({peers,daily_limit:b.daily_limit});
});
app.post("/internal/spaces/:spaceId/blackboard/authorize", async c => {
  const space=c.req.param("spaceId"), tenant=c.req.header("x-naelao-tenant-id")!, user=c.req.header("x-naelao-user-id")!;
  let b:{project_id?:unknown;action?:unknown;params?:Record<string,unknown>};try{b=JSON.parse(await readBoundedRequestText(c.req.raw,16384));}catch{return c.json({allowed:false},400);}
  const idPattern=/^[A-Za-z0-9._:-]{1,160}$/;
  if(!b || typeof b.project_id!=="string" || !idPattern.test(b.project_id) || !["blackboard.request","blackboard.respond"].includes(String(b.action)) || !b.params || typeof b.params!=="object" || Array.isArray(b.params) || typeof b.params.id!=="string" || !idPattern.test(b.params.id))return c.json({allowed:false},400);
  const project=b.project_id, denied=await requireManageableAutomationProject(c,space,project); if(denied)return denied;
  const policy=await c.env.PLATFORM_DB.prepare("SELECT authorized_user_id,peers_json,daily_limit FROM space_blackboard_sharing_policies WHERE tenant_id=? AND space_id=? AND project_id=?").bind(tenant,space,project).first<{authorized_user_id:string;peers_json:string;daily_limit:number}>();
  if(!policy || policy.authorized_user_id!==user || policy.daily_limit<1)return c.json({allowed:false});
  let peers:string[];try{peers=JSON.parse(policy.peers_json);}catch{return c.json({allowed:false});}
  const card=await c.env.PLATFORM_DB.prepare("SELECT summary FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?").bind(tenant,space,project).first<{summary:string}>();
  if(!card)return c.json({allowed:false});
  const request=b.action==="blackboard.respond" ? await c.env.PLATFORM_DB.prepare("SELECT source_project_id,target_project_id FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=?").bind(tenant,space,b.params.id).first<{source_project_id:string;target_project_id:string}>() : null;
  const candidate=standingBlackboardPeer({action:String(b.action),projectId:project,summary:card.summary,params:b.params,request});
  if(!candidate)return c.json({allowed:false});
  const {peer,actionKey}=candidate;
  if(!peers.includes(peer) || (await requireReadableAutomationProject(c,space,peer)))return c.json({allowed:false});
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([b.action,b.params]))));
  const hash=[...digest].map(v=>v.toString(16).padStart(2,"0")).join(""),day=new Date().toISOString().slice(0,10);
  await c.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO space_blackboard_policy_uses(tenant_id,space_id,project_id,action_key,payload_hash,user_id,used_day)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM space_blackboard_policy_uses WHERE tenant_id=? AND space_id=? AND project_id=? AND used_day=?) < ?
      AND EXISTS (SELECT 1 FROM space_blackboard_sharing_policies WHERE tenant_id=? AND space_id=? AND project_id=? AND authorized_user_id=? AND peers_json=? AND daily_limit=?)
      AND EXISTS (SELECT 1 FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=? AND summary=?)`)
    .bind(tenant,space,project,actionKey,hash,user,day,tenant,space,project,day,policy.daily_limit,tenant,space,project,user,policy.peers_json,policy.daily_limit,tenant,space,project,card.summary).run();
  const used=await c.env.PLATFORM_DB.prepare("SELECT payload_hash,user_id FROM space_blackboard_policy_uses WHERE tenant_id=? AND space_id=? AND project_id=? AND action_key=?").bind(tenant,space,project,actionKey).first<{payload_hash:string;user_id:string}>();
  const current=await c.env.PLATFORM_DB.prepare("SELECT 1 AS valid FROM space_blackboard_sharing_policies p JOIN space_blackboard_cards c ON c.tenant_id=p.tenant_id AND c.space_id=p.space_id AND c.project_id=p.project_id WHERE p.tenant_id=? AND p.space_id=? AND p.project_id=? AND p.authorized_user_id=? AND p.peers_json=? AND p.daily_limit=? AND c.summary=?")
    .bind(tenant,space,project,user,policy.peers_json,policy.daily_limit,card.summary).first();
  return c.json({allowed:Boolean(current && used?.payload_hash===hash && used.user_id===user)});
});
app.post("/internal/spaces/:spaceId/blackboard/events/:projectId/:eventId/read", async c => {
  const spaceId=c.req.param("spaceId"), projectId=c.req.param("projectId"), eventId=c.req.param("eventId"), tenant=c.req.header("x-naelao-tenant-id")!, user=c.req.header("x-naelao-user-id")!;
  const denied=await requireReadableAutomationProject(c,spaceId,projectId); if(denied) return denied;
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) return c.json({ error_code:"invalid_event" },400);
  const event=await c.env.PLATFORM_DB.prepare("SELECT event_id FROM space_blackboard_events WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?").bind(tenant,spaceId,projectId,eventId).first();
  if(!event) return c.json({ error_code:"event_not_found" },404);
  await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO space_blackboard_event_receipts(tenant_id,space_id,project_id,event_id,user_id,read_at) VALUES(?,?,?,?,?,?)").bind(tenant,spaceId,projectId,eventId,user,new Date().toISOString()).run();
  return c.json({ acknowledged:true,event_id:eventId });
});
// Read-only Space extension entry point. The internal handlers retain their user and project
// authorization checks; the frame never receives an internal service token.
app.on(["GET", "PUT"], "/spaces/:spaceId/blackboard/*", async c => {
  let suffix: string;
  try { suffix = decodeURIComponent(c.req.path.split("/blackboard/")[1] ?? ""); } catch { return c.json({ error_code: "not_found" }, 404); }
  if (!/^(?:cards|requests\/[A-Za-z0-9._:-]{1,160}|events\/[A-Za-z0-9._:-]{1,160}|policy\/[A-Za-z0-9._:-]{1,160}|sharing\/[A-Za-z0-9._:-]{1,160})$/.test(suffix) || (c.req.method === "PUT" && !suffix.startsWith("policy/") && !suffix.startsWith("sharing/"))) return c.json({ error_code: "not_found" }, 404);
  const url = new URL(c.req.url);
  const [view, projectId] = suffix.split("/");
  url.pathname = `/internal/spaces/${encodeURIComponent(c.req.param("spaceId"))}/blackboard/${view}${projectId ? `/${encodeURIComponent(projectId)}` : ""}`;
  return app.fetch(new Request(url.toString(), c.req.raw), c.env);
});

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
// tenant_id rides the query string, not a header — forwardToSpaceDO doesn't forward client
// headers (see fireExternalEvent's own comment for the real bug this fixed: this route 400'd on
// every real call until tenant_id had a way to actually reach the DO).
app.use("/internal/spaces/:spaceId/events/fire", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/events/fire", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/internal/events/fire?tenant_id=${encodeURIComponent(tenantId)}`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Service-authenticated receipt writes. The SpaceDO is the single writer for a space's
// tamper-evident action chain; records contain hashes and identifiers, never action payloads.
app.use("/internal/spaces/:spaceId/action-receipts", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/spaces/:spaceId/action-receipts", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/internal/action-receipts?space_id=${encodeURIComponent(spaceId)}&tenant_id=${encodeURIComponent(tenantId)}`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.use("/internal/spaces/:spaceId/action-receipts/verify", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/action-receipts/verify", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space/internal/action-receipts/verify"));
});

// Projects (thread grouping) — real traffic always arrives either via the router (proxyTo
// already mints the token off verified JWT OR product_end_user claims) or a direct internal
// caller (NaelaoAgentDO, agents worker — both updated to mint it too), so requireInternalHmac
// stays the "came through the router" gate for everyone. Phase B (§A1.17): the Product Shell
// needs list/create/read here for a product_end_user caller — requireSpaceMembership adds the
// extra floor ONLY for that role (every other role is unaffected). rules/spend stay OFF the
// router's product_end_user allowlist entirely (server-to-server agent accounting, no-code rule
// config) — requireInternalHmac alone still fully gates them; no product_end_user request can
// ever reach them regardless of what's declared below.
app.use("/spaces/:spaceId/projects", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects", requireSpaceMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/projects/:projectId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId", requireSpaceMembership({ GET: "member" }));
registerProjectMcpRoutes(app, requireManageableAutomationProject);

// The LSP indexer is an optional, owner-installed project extension. Templates can name
// `ext_lsp_indexer`; installation and runtime checks remain project-scoped and fail closed.
app.post("/spaces/:spaceId/projects/:projectId/extensions/lsp-indexer", async (c) => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId");
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const identity = getCallerIdentity(c);
  const spaceRole = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : identity.role;
  if (spaceRole !== "owner" && spaceRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  const manifest = DOGFOOD_EXTENSION_BY_ID["ext_lsp_indexer"];
  if (!manifest) return c.json({ error_code: "lsp_extension_unavailable" }, 503);
  const response = await (await spaceDoStub(c.env, spaceId, identity.tenantId)).fetch(new Request("http://space-do/extensions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId: identity.tenantId, spaceId,
      projectId, scope: "PROJECT_BOUND", gatekeeperCapabilities: manifest.capabilityRequirements }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

// Owner/admin channel-only package installation. This narrow path grants only the dedicated
// channel.invoke capability. The separate signed project-bundle installer below supports
// reviewed Canvas/Gadget/workflow/channel compositions and stages activation around setup.
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions", requireSpaceMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/channel-extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/channel-extensions", requireSpaceMembership({ POST: "admin" }));
const installChannelExtension = async (c: Context<{Bindings:Env}>) => {
  const spaceId = c.req.param("spaceId")!, projectId = c.req.param("projectId") || undefined;
  if (projectId) {
    const denied = await requireManageableAutomationProject(c, spaceId, projectId);
    if (denied) return denied;
  }
  const identity = getCallerIdentity(c);
  const role = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  if (!projectId) {
    const active=await c.env.PLATFORM_DB.prepare("SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'").bind(spaceId,identity.tenantId).first();
    if(!active)return c.json({error_code:"space_unavailable"},403);
  }
  const body = await c.req.json<{ manifest?: unknown; scope?: unknown; handlerSources?: unknown; instanceKey?: string; upgrade?: boolean; permissionExpansionApproved?: boolean; attachmentAccessApproved?: boolean }>()
    .catch(() => ({} as { manifest?: unknown; scope?: unknown; handlerSources?: unknown; instanceKey?: string; upgrade?: boolean; permissionExpansionApproved?: boolean; attachmentAccessApproved?: boolean }));
  const instanceKey = body.instanceKey ?? "default";
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return c.json({ error_code: "extension_instance_key_invalid" }, 400);
  if (body.upgrade !== undefined && body.upgrade !== true) return c.json({ error_code: "extension_upgrade_confirmation_invalid" }, 400);
  if (body.scope !== undefined && !(projectId ? ["PROJECT_BOUND", "PROJECT_SHARED"] : ["SPACE_SHARED"]).includes(String(body.scope))) return c.json({ error_code: "channel_install_scope_invalid" }, 400);
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try {
    manifest = validateExtensionManifest(body.manifest, { gatekeeperCapabilities: ["channel.invoke"] });
    const bundle = manifest.bundle;
    const channels = manifest.channels ?? [];
    if (channels.some(channel => channel.attachmentAccess !== undefined) && body.attachmentAccessApproved !== true) {
      return c.json({ error_code: "channel_attachment_access_approval_required" }, 409);
    }
    const supportedProviders = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
    if (!bundle || !channels.length || channels.length > 8
      || bundle.primitives.some(primitive => primitive.kind !== "channel")
      || (bundle.workerRoles?.length ?? 0) > 0
      || manifest.declaredPermissions.length > 0
      || manifest.capabilityRequirements.length !== 1 || manifest.capabilityRequirements[0] !== "channel.invoke"
      || manifest.gadgets.length > 0 || manifest.daemons.length > 0 || manifest.commands.length > 0
      || (manifest.containers?.length ?? 0) > 0
      || channels.some(channel => !supportedProviders.has(channel.provider) || !channel.connectionId || (!projectId && channel.provider !== "phone"))
      || (bundle.connections ?? []).some(connection => !supportedProviders.has(connection.provider))) {
      throw new Error("channel_package_must_be_restricted_and_have_host_connections");
    }
    const requiredConnections = new Set((bundle.connections ?? []).filter(connection => connection.required).map(connection => connection.id));
    const usedConnections = new Set(channels.map(channel => channel.connectionId!));
    if (channels.some(channel => !requiredConnections.has(channel.connectionId!))
      || (bundle.connections ?? []).some(connection => !usedConnections.has(connection.id))) throw new Error("channel_connection_requirement_missing");
  } catch (error) {
    return c.json({ error_code: "channel_manifest_invalid", message: error instanceof Error ? error.message : "invalid_manifest" }, 400);
  }
  const scope = !projectId ? "SPACE_SHARED" : body.scope === "PROJECT_SHARED" ? "PROJECT_SHARED" : "PROJECT_BOUND";
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const dependencyClosure = await resolveSpaceExtensionDependencies(c.env, identity.tenantId, spaceId, manifest, scope, projectId);
  if (!dependencyClosure.resolved) return c.json({ error_code: `extension_${dependencyClosure.error}` }, dependencyClosure.error === "dependency_registry_unavailable" ? 503 : 409);
  if (body.upgrade === true) {
    const current = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({ tenant_id: identity.tenantId, space_id: spaceId, extension_id: manifest.id })}`));
    if (!current.ok) return c.json({ error_code: "extension_upgrade_preflight_unavailable" }, 503);
    const installs = await readBoundedResponseJson<{ installations?: Array<{ instance_id: string; project_id: string | null; scope: string; instance_key?: string; status: string; permissions?: string[]; capabilities?: string[] }> }>(current, 2 * 1024 * 1024);
    const currentInstall = installs.installations?.find(item => item.project_id === projectId && item.scope === scope && (item.instance_key ?? "default") === instanceKey
      && ["active", "disabled", "staging"].includes(item.status));
    if (currentInstall) {
      const expansion = extensionReleaseAccessExpansion(currentInstall, { permissions: manifest.declaredPermissions, capabilities: manifest.capabilityRequirements });
      if ((expansion.permissions.length || expansion.capabilities.length) && body.permissionExpansionApproved !== true) {
        return c.json({ error_code: "permission_expansion_approval_required", added_permissions: expansion.permissions, added_capabilities: expansion.capabilities }, 409);
      }
    }
  }
  const sourceEntries: Array<[string, string]> = [];
  if (body.handlerSources !== undefined) {
    if (!body.handlerSources || typeof body.handlerSources !== "object" || Array.isArray(body.handlerSources))
      return c.json({ error_code: "channel_handler_sources_invalid" }, 400);
    const sourceMap = body.handlerSources as Record<string, unknown>;
    const declaredPaths = new Set((manifest.channels ?? []).map(channel => channel.handlerScript));
    const keys = Object.keys(sourceMap);
    if (!keys.length || keys.length !== declaredPaths.size || keys.some(path => !declaredPaths.has(path)))
      return c.json({ error_code: "channel_handler_sources_must_match_manifest" }, 400);
    let totalBytes = 0;
    for (const path of keys) {
      const code = sourceMap[path];
      if (typeof code !== "string" || !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(path) || code.includes("\u0000"))
        return c.json({ error_code: "channel_handler_source_invalid" }, 400);
      const bytes = new TextEncoder().encode(code).byteLength;
      totalBytes += bytes;
      if (!bytes || bytes > 262_144 || totalBytes > 524_288)
        return c.json({ error_code: "channel_handler_source_limit" }, 413);
      sourceEntries.push([path, code]);
    }
    if (!c.env.SCRIPTS_R2) return c.json({ error_code: "channel_artifact_storage_unavailable" }, 503);
    if (!c.env.AGENTS_WORKER) return c.json({ error_code: "channel_handler_validator_unavailable" }, 503);
    const bundle = manifest.bundle!;
    for (const [path, code] of sourceEntries) {
      const validation = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/channel-extensions/validate-handler", {
        method: "POST",
        headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
        body: JSON.stringify({ source: code, language: path.endsWith(".js") ? "javascript" : "typescript" }),
      }));
      if (!validation.ok) return c.json({ error_code: "channel_handler_source_invalid", message: (await readBoundedResponseText(validation, 8 * 1024).catch(() => "")).slice(0, 300) }, 400);
      const filename = path.slice(2);
      const key = `spaces/${spaceId}/extensions/${bundle.id}/${bundle.version}/${filename}`;
      const existing = await c.env.SCRIPTS_R2.get(key);
      if (existing) {
        if (existing.size > 262_144) return c.json({ error_code: "channel_artifact_version_is_immutable" }, 409);
        const existingBytes = await existing.arrayBuffer();
        if (existingBytes.byteLength !== existing.size || new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(existingBytes) !== code)
          return c.json({ error_code: "channel_artifact_version_is_immutable" }, 409);
      }
    }
    for (const [path, code] of sourceEntries) {
      const filename = path.slice(2);
      const key = `spaces/${spaceId}/extensions/${bundle.id}/${bundle.version}/${filename}`;
      if (!await c.env.SCRIPTS_R2.head(key)) {
        await c.env.SCRIPTS_R2.put(key, code, { httpMetadata: { contentType: path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/typescript; charset=utf-8" } });
        await reportExtensionArtifactWrite(c.env, { tenantId: identity.tenantId, spaceId, ...(projectId ? {projectId} : {}), bundleId: bundle.id, version: bundle.version,
          path, bytes: new TextEncoder().encode(code).byteLength });
      }
    }
  }
  const artifactPayload = JSON.stringify(sourceEntries.sort(([a], [b]) => a.localeCompare(b)));
  const artifactDigestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifactPayload));
  const artifactSha256 = [...new Uint8Array(artifactDigestBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await stub.fetch(new Request("http://space-do/extensions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId: identity.tenantId, spaceId, projectId, scope,
      gatekeeperCapabilities: ["channel.invoke"], artifactSha256, instanceKey, ...(body.upgrade === true ? { upgrade: true } : {}) }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
};
app.post("/spaces/:spaceId/projects/:projectId/channel-extensions", installChannelExtension);
app.post("/spaces/:spaceId/channel-extensions", installChannelExtension);

// Publisher trust is configured independently from package uploads so a package cannot trust its own key.
app.use("/spaces/:spaceId/extension-publishers", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-publishers", requireSpaceMembership({ GET: "admin", POST: "admin" }));
app.get("/spaces/:spaceId/extension-publishers", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId");
  const result = await c.env.PLATFORM_DB.prepare(`SELECT publisher_id,key_id,algorithm,public_key_b64url,status,created_by,created_at,revoked_by,revoked_at
    FROM extension_publisher_keys WHERE tenant_id=? AND space_id=? ORDER BY publisher_id,key_id`).bind(tenantId, spaceId).all();
  return c.json({ publishers: result.results });
});
app.post("/spaces/:spaceId/extension-publishers", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId"), identity = getCallerIdentity(c);
  const body = await c.req.json<{ publisher_id?: unknown; public_key_b64url?: unknown }>().catch(() => ({} as { publisher_id?: unknown; public_key_b64url?: unknown }));
  if (!tenantId || !identity.userId || typeof body.publisher_id !== "string" || !/^pub_[a-z0-9_-]{1,48}$/.test(body.publisher_id)
    || typeof body.public_key_b64url !== "string" || body.public_key_b64url.length > 256) return c.json({ error_code: "publisher_key_request_invalid" }, 400);
  let publicKey: ArrayBuffer, keyId: string;
  try {
    publicKey = decodeExtensionPublisherPublicKey(body.public_key_b64url);
    await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    keyId = await extensionPublisherKeyId(publicKey);
  } catch { return c.json({ error_code: "publisher_public_key_invalid" }, 400); }
  const existing = await c.env.PLATFORM_DB.prepare(`SELECT publisher_id,public_key_b64url,status FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND key_id=?`).bind(tenantId, spaceId, keyId).first<{ publisher_id: string; public_key_b64url: string; status: string }>();
  if (existing?.status === "revoked") return c.json({ error_code: "publisher_key_revoked" }, 409);
  if (existing && existing.publisher_id !== body.publisher_id) return c.json({ error_code: "publisher_key_owner_conflict" }, 409);
  if (existing && existing.public_key_b64url !== body.public_key_b64url) return c.json({ error_code: "publisher_key_id_conflict" }, 409);
  await c.env.PLATFORM_DB.prepare(`INSERT INTO extension_publisher_keys(tenant_id,space_id,publisher_id,key_id,public_key_b64url,created_by)
    VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,space_id,key_id) DO NOTHING`).bind(tenantId, spaceId, body.publisher_id, keyId, body.public_key_b64url, identity.userId).run();
  return c.json({ registered: true, publisher_id: body.publisher_id, key_id: keyId, algorithm: "ECDSA_P256_SHA256" }, { status: 201 });
});
app.use("/spaces/:spaceId/extension-publishers/:keyId/revocation", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-publishers/:keyId/revocation", requireSpaceMembership({ GET: "admin" }));
app.get("/spaces/:spaceId/extension-publishers/:keyId/revocation", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId"), keyId = c.req.param("keyId");
  if (!tenantId || !/^[a-f0-9]{64}$/.test(keyId)) return c.json({ error_code: "publisher_key_id_invalid" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, key_id: keyId });
  const response = await stub.fetch(new Request(`http://space-do/extension-publisher-revocation?${query}`, {
    headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
  }));
  if (response.status === 404) return c.json({ error_code: "publisher_revocation_receipt_not_found" }, 404);
  if (!response.ok) return c.json({ error_code: "publisher_revocation_receipt_unavailable" }, 503);
  const result = await response.json<{ receipt?: unknown }>().catch(() => null);
  if (!result?.receipt) return c.json({ error_code: "publisher_revocation_receipt_unavailable" }, 503);
  c.header("cache-control", "private, no-store");
  return c.json(result);
});
app.use("/spaces/:spaceId/extension-publishers/:keyId", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-publishers/:keyId", requireSpaceMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/extension-publishers/:keyId", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId"), keyId = c.req.param("keyId"), identity = getCallerIdentity(c);
  if (!/^[a-f0-9]{64}$/.test(keyId) || !tenantId || !identity.userId) return c.json({ error_code: "publisher_key_id_invalid" }, 400);
  const result = await c.env.PLATFORM_DB.prepare(`UPDATE extension_publisher_keys SET status='revoked',revoked_by=?,revoked_at=datetime('now')
    WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(identity.userId, tenantId, spaceId, keyId).run();
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const invalidated = await stub.fetch(new Request("http://space-do/extension-publisher-revoke", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ tenantId, spaceId, keyId, actorId: identity.userId }) }));
  if (!invalidated.ok) return c.json({ error_code: "publisher_revocation_invalidation_unavailable" }, 503);
  const receipt = await invalidated.json<{ revoked?: unknown; key_id?: unknown; active_work_count?: unknown; state?: unknown;
    revoked_at?: unknown; revoked_by?: unknown; revoked_release_count?: unknown; disabled_installation_count?: unknown;
    new_work_denied?: unknown; admitted_work_policy?: unknown; changed?: unknown }>().catch(() => null);
  if (!receipt || receipt.revoked !== true || receipt.key_id !== keyId || !["draining", "drained"].includes(String(receipt.state)))
    return c.json({ error_code: "publisher_revocation_receipt_unavailable" }, 503);
  const status: 200 | 202 = invalidated.status === 202 ? 202 : 200;
  c.header("cache-control", "private, no-store");
  return c.json({ ...receipt, changed: receipt.changed === true || (result.meta?.changes ?? 0) > 0 }, status);
});

// Project bundle installation for Canvas + Gadget + external channel + Durable Workflow
// compositions. Workflow code uses the host's restricted execute(step,ctx) ABI.
app.use("/spaces/:spaceId/projects/:projectId/extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/extensions", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/extensions", async c => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId");
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const identity = getCallerIdentity(c);
  const role = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  const body = await c.req.json<{ manifest?: unknown; artifacts?: unknown; instanceKey?: string; upgrade?: boolean; permissionExpansionApproved?: boolean; attachmentAccessApproved?: boolean; publisherSignature?: { key_id?: unknown; signature?: unknown } }>()
    .catch(() => ({} as { manifest?: unknown; artifacts?: unknown; instanceKey?: string; upgrade?: boolean; permissionExpansionApproved?: boolean; attachmentAccessApproved?: boolean; publisherSignature?: { key_id?: unknown; signature?: unknown } }));
  const instanceKey = body.instanceKey ?? "default";
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return c.json({ error_code: "extension_instance_key_invalid" }, 400);
  if (body.upgrade !== undefined && body.upgrade !== true) return c.json({ error_code: "extension_upgrade_confirmation_invalid" }, 400);
  const requiredCapabilities = new Set<string>();
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try {
    manifest = validateExtensionManifest(body.manifest, { gatekeeperCapabilities: ["extension.project_canvas", "extension.gadget.read", "extension.workflow", "channel.invoke", "events.subscribe"] });
    const bundle = manifest.bundle;
    const primitives = bundle?.primitives ?? [];
    if (!bundle || !primitives.length || primitives.some(item => !["canvas", "gadget", "channel", "workflow"].includes(item.kind))
      || manifest.containers?.length || manifest.daemons.length || manifest.commands.length
      || manifest.declaredPermissions.some(permission => permission !== "events.subscribe"))
      throw new Error("project_bundle_primitive_not_supported");
    if (bundle.primitives.some(item => item.kind === "canvas" || item.kind === "gadget")) requiredCapabilities.add("extension.project_canvas");
    if (bundle.primitives.some(item => item.kind === "canvas" && (item.gadgetReads?.length ?? 0) > 0)) requiredCapabilities.add("extension.gadget.read");
    if (bundle.primitives.some(item => item.kind === "workflow")) requiredCapabilities.add("extension.workflow");
    if (bundle.primitives.some(item => item.kind === "channel")) requiredCapabilities.add("channel.invoke");
    if (manifest.widgetSubscriptions?.length) requiredCapabilities.add("events.subscribe");
    if (manifest.capabilityRequirements.length !== requiredCapabilities.size || manifest.capabilityRequirements.some(item => !requiredCapabilities.has(item)))
      throw new Error("project_bundle_capability_declaration_mismatch");
    if (manifest.widgetSubscriptions?.length ? !manifest.declaredPermissions.includes("events.subscribe") : manifest.declaredPermissions.length > 0)
      throw new Error("widget_event_permission_declaration_mismatch");
    const workflowIds = new Set(bundle.primitives.filter(item => item.kind === "workflow").map(item => item.id));
    if ((bundle.workerRoles ?? []).some(role => role.principal !== "project_member" || role.execution !== "worker" || !["workflow_step", "tool"].includes(role.invocation)
      || role.primitiveIds.some(id => !workflowIds.has(id)))) throw new Error("extension_worker_role_runtime_not_supported");
    const providerAllowlist = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
    const channels = bundle.primitives.filter(item => item.kind === "channel");
    if (channels.some(channel => channel.kind === "channel" && channel.attachmentAccess !== undefined) && body.attachmentAccessApproved !== true) {
      return c.json({ error_code: "channel_attachment_access_approval_required" }, 409);
    }
    const requirements = bundle.connections ?? [];
    if (channels.some(item => !providerAllowlist.has(item.provider) || !item.connectionId || !requirements.some(connection => connection.id === item.connectionId && connection.provider === item.provider && connection.required))
      || requirements.some(connection => !providerAllowlist.has(connection.provider) || !channels.some(channel => channel.kind === "channel" && channel.connectionId === connection.id)))
      throw new Error("channel_connections_must_be_declared_host_managed_and_used");
    for (const primitive of primitives) {
      if (primitive.kind === "canvas" && (primitive.layout !== "CanvasMount" || primitive.dynamicPage || primitive.permissions.length || primitive.capabilityRequirements.length))
        throw new Error("canvas_requires_project_mount_and_no_unreviewed_capabilities");
      if (primitive.kind === "gadget" && (primitive.scope !== "PROJECT_BOUND" || primitive.permissions.length || primitive.capabilityRequirements.length))
        throw new Error("gadget_requires_project_bound_scope_and_no_unreviewed_capabilities");
      if (primitive.kind === "workflow") {
        if (primitive.steps.length) throw new Error("workflow_multi_entry_steps_not_supported_use_execute_entry");
        if (primitive.permissions.length || primitive.capabilityRequirements.length
          || primitive.toolNames.some(name => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)))
          throw new Error("workflow_requires_owner_reviewed_installed_tool_names");
        const gadgetOperations = primitive.toolNames.filter(name => name.startsWith("extension.gadget."));
        if (gadgetOperations.some(name => !["extension.gadget.list", "extension.gadget.get", "extension.gadget.insert", "extension.gadget.update", "extension.gadget.delete"].includes(name))
          || (gadgetOperations.length > 0 && !primitives.some(item => item.kind === "gadget")))
          throw new Error("workflow_gadget_operation_requires_declared_gadget");
      }
    }
  } catch (error) {
    return c.json({ error_code: "extension_bundle_invalid", message: error instanceof Error ? error.message : "invalid_manifest" }, 400);
  }
  const bundle = manifest.bundle!;
  const manifestJson = JSON.stringify(manifest);
  const canvases = bundle.primitives.filter((item): item is Extract<typeof item, { kind: "canvas" }> => item.kind === "canvas");
  const gadgets = bundle.primitives.filter((item): item is Extract<typeof item, { kind: "gadget" }> => item.kind === "gadget");
  const channels = bundle.primitives.filter((item): item is Extract<typeof item, { kind: "channel" }> => item.kind === "channel");
  const workflows = bundle.primitives.filter((item): item is Extract<typeof item, { kind: "workflow" }> => item.kind === "workflow");
  const widgetPaths = new Set((manifest.widgetSubscriptions ?? []).map(item => item.component));
  // v1 runs one isolated execute(step, ctx) entrypoint; it can compose sequential
  // actions with step.do and ctx.tools.call. Additional roles become separate workflow parts.
  const workflowPaths = new Set(workflows.map(item => item.entry));
  if (canvases.some(item => !/^\.\/[A-Za-z0-9._-]{1,128}\.html$/.test(item.component)) || (!canvases.length && !gadgets.length && !channels.length && !workflows.length))
    return c.json({ error_code: "extension_artifact_declaration_invalid" }, 400);
  if (!body.artifacts || typeof body.artifacts !== "object" || Array.isArray(body.artifacts)) return c.json({ error_code: "extension_artifacts_required" }, 400);
  const artifacts = body.artifacts as Record<string, unknown>, required = new Set([
    ...canvases.map(item => item.component), ...channels.map(item => item.handlerScript), ...workflowPaths, ...widgetPaths,
  ]);
  if (channels.some(channel => !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(channel.handlerScript))) return c.json({ error_code: "extension_channel_artifact_invalid" }, 400);
  if (Object.keys(artifacts).length !== required.size || Object.keys(artifacts).some(path => !required.has(path))) return c.json({ error_code: "extension_artifacts_must_match_manifest" }, 400);
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "extension_artifact_storage_unavailable" }, 503);
  if ((channels.length || workflows.length || widgetPaths.size) && !c.env.AGENTS_WORKER) return c.json({ error_code: "extension_source_validator_unavailable" }, 503);
  const sourceEntries: Array<[string, string]> = [];
  const publisherArtifacts: Record<string, string> = {};
  let total = 0;
  for (const path of [...required].sort()) {
    let source = artifacts[path];
    if (typeof source !== "string" || source.includes("\u0000")) return c.json({ error_code: "extension_artifact_invalid" }, 400);
    let size = new TextEncoder().encode(source).byteLength; total += size;
    const isHandler = /\.(?:ts|js)$/.test(path);
    if (!size || size > (isHandler ? 262_144 : 512_000) || total > 2_000_000) return c.json({ error_code: "extension_artifact_size_limit" }, 413);
    publisherArtifacts[path] = source;
    if (workflowPaths.has(path)) {
      const validation = await c.env.AGENTS_WORKER!.fetch(new Request("http://agents-worker/internal/workflow-extensions/compile", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) }, body: JSON.stringify({ source }),
      }));
      const compiled = await validation.json<{ source?: string; message?: string }>().catch(() => ({} as { source?: string; message?: string }));
      const compiledSource = compiled.source;
      if (!validation.ok || typeof compiledSource !== "string") return c.json({ error_code: "extension_workflow_artifact_invalid", message: compiled.message?.slice(0, 300) }, 400);
      source = compiledSource; size = new TextEncoder().encode(compiledSource).byteLength;
      if (!size || size > 512_000 || total + size > 2_000_000) return c.json({ error_code: "extension_workflow_artifact_size_limit" }, 413);
      total += size;
    } else if (channels.some(channel => channel.handlerScript === path) || widgetPaths.has(path)) {
      const validation = await c.env.AGENTS_WORKER!.fetch(new Request("http://agents-worker/internal/channel-extensions/validate-handler", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
        body: JSON.stringify({ source, language: path.endsWith(".js") ? "javascript" : "typescript" }),
      }));
      if (!validation.ok) return c.json({ error_code: "extension_channel_artifact_invalid", message: (await readBoundedResponseText(validation, 8 * 1024).catch(() => "")).slice(0, 300) }, 400);
    }
    if (typeof source !== "string") return c.json({ error_code: "extension_artifact_invalid" }, 400);
    const key = `spaces/${spaceId}/extensions/${bundle.id}/${bundle.version}/${path.slice(2)}`;
    const previous = await c.env.SCRIPTS_R2.get(key);
    if (previous) {
      if (previous.size > 262_144) return c.json({ error_code: "extension_release_artifact_immutable" }, 409);
      const previousBytes = await previous.arrayBuffer();
      if (previousBytes.byteLength !== previous.size || new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(previousBytes) !== source)
        return c.json({ error_code: "extension_release_artifact_immutable" }, 409);
    }
    sourceEntries.push([path, source]);
  }
  const publisherKeyId = body.publisherSignature?.key_id;
  const publisherSignature = body.publisherSignature?.signature;
  if (typeof publisherKeyId !== "string" || !/^[a-f0-9]{64}$/.test(publisherKeyId)
    || typeof publisherSignature !== "string" || publisherSignature.length > 256) return c.json({ error_code: "extension_publisher_signature_required" }, 400);
  const trustedPublisher = await c.env.PLATFORM_DB.prepare(`SELECT publisher_id,public_key_b64url FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(identity.tenantId, spaceId, publisherKeyId)
    .first<{ publisher_id: string; public_key_b64url: string }>();
  if (!trustedPublisher) return c.json({ error_code: "extension_publisher_key_untrusted_or_revoked" }, 403);
  let publisherPayload: string, publisherPayloadSha256: string, publisherSignatureValid: boolean;
  try {
    publisherPayload = extensionPublisherSigningPayload(manifestJson, publisherArtifacts);
    const publicKey = decodeExtensionPublisherPublicKey(trustedPublisher.public_key_b64url);
    if (await extensionPublisherKeyId(publicKey) !== publisherKeyId) return c.json({ error_code: "extension_publisher_key_id_mismatch" }, 403);
    publisherSignatureValid = await verifyExtensionPublisherRelease({ publicKeyRaw: publicKey, signature: publisherSignature, manifestJson, artifacts: publisherArtifacts });
    publisherPayloadSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publisherPayload)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return c.json({ error_code: "extension_publisher_signature_invalid" }, 403); }
  if (!publisherSignatureValid) return c.json({ error_code: "extension_publisher_signature_invalid" }, 403);
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const dependencyClosure = await resolveSpaceExtensionDependencies(c.env, identity.tenantId, spaceId, manifest, "PROJECT_BOUND", projectId);
  if (!dependencyClosure.resolved) return c.json({ error_code: `extension_${dependencyClosure.error}` }, dependencyClosure.error === "dependency_registry_unavailable" ? 503 : 409);
  if (body.upgrade === true) {
    const current = await stub.fetch(new Request(`http://space-do/extension-installations?${new URLSearchParams({
      tenant_id: identity.tenantId, space_id: spaceId, extension_id: bundle.id,
    })}`));
    if (!current.ok) return c.json({ error_code: "extension_upgrade_preflight_unavailable" }, 503);
    const currentInstalls = await readBoundedResponseJson<{ installations?: Array<{ instance_id: string; extension_id: string; project_id: string | null;
      scope: string; instance_key?: string; status: string; release_version?: string | null; permissions?: string[]; capabilities?: string[] }> }>(current, 2 * 1024 * 1024);
    const otherInstances = findUnsafeProjectExtensionUpgrade(currentInstalls.installations ?? [], { extensionId: bundle.id, projectId, instanceKey });
    if (otherInstances.length) return c.json({ error_code: "extension_upgrade_multiple_instances_unsupported",
      message: "A legacy sibling installation has no verified pinned release. Remove or migrate it before upgrading this extension.",
      affected_installations: otherInstances.length }, 409);
    const currentInstall = currentInstalls.installations?.find(item => item.project_id === projectId && item.scope === "PROJECT_BOUND"
      && (item.instance_key ?? "default") === instanceKey && ["active", "disabled", "staging"].includes(item.status));
    if (currentInstall) {
      const expansion = extensionReleaseAccessExpansion(currentInstall, { permissions: manifest.declaredPermissions, capabilities: manifest.capabilityRequirements });
      if ((expansion.permissions.length || expansion.capabilities.length) && body.permissionExpansionApproved !== true) {
        return c.json({ error_code: "permission_expansion_approval_required", added_permissions: expansion.permissions, added_capabilities: expansion.capabilities }, 409);
      }
    }
  }
  // Persist immutable files before exposing any mounted app. Repeated installs are idempotent.
  for (const [path, source] of sourceEntries) {
    const key = `spaces/${spaceId}/extensions/${bundle.id}/${bundle.version}/${path.slice(2)}`;
    if (!await c.env.SCRIPTS_R2.head(key)) {
      await c.env.SCRIPTS_R2.put(key, source, { httpMetadata: { contentType: path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") || workflowPaths.has(path) ? "text/javascript; charset=utf-8" : "text/typescript; charset=utf-8" } });
      await reportExtensionArtifactWrite(c.env, { tenantId: identity.tenantId, spaceId, projectId, bundleId: bundle.id, version: bundle.version,
        path, bytes: new TextEncoder().encode(source).byteLength });
    }
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sourceEntries))))].map(x => x.toString(16).padStart(2, "0")).join("");
  const requiresRuntimeActivation = canvases.length > 0 || gadgets.length > 0;
  const installed = await stub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId: identity.tenantId, spaceId, projectId, scope: "PROJECT_BOUND", gatekeeperCapabilities: [...requiredCapabilities], artifactSha256: digest, instanceKey,
      publisherId: trustedPublisher.publisher_id, publisherKeyId, publisherSignature, publisherPayloadSha256,
      ...(requiresRuntimeActivation ? { deferActivation: true } : {}), ...(body.upgrade ? { upgrade: true } : {}) }) }));
  if (!installed.ok) return new Response(installed.body, { status: installed.status, headers: { "content-type": installed.headers.get("content-type") ?? "application/json" } });
  const installedResult = await readBoundedResponseJson<{ installationId?: string; release?: { version?: string; artifactSha256?: string; hostSignature?: string; publisher?: { keyId?: string } } }>(installed.clone(), 64 * 1024);
  const abortStagedInstall = async () => {
    if (!requiresRuntimeActivation || typeof installedResult.installationId !== "string") return;
    await stub.fetch(new Request("http://space-do/extension-installation/abort", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
      body: JSON.stringify({ installationId: installedResult.installationId, tenantId: identity.tenantId, spaceId, projectId, scope: "PROJECT_BOUND" }),
    })).catch(() => undefined);
  };
  const stagedFailure = async (errorCode: string, status: 400 | 409 | 500 | 503, message: string) => {
    await abortStagedInstall();
    return c.json({ error_code: errorCode, installation: installedResult, message: message.slice(0, 300) }, status);
  };
  if (requiresRuntimeActivation && (installedResult.release?.version !== bundle.version || installedResult.release.artifactSha256 !== digest
    || !/^[a-f0-9]{64}$/.test(installedResult.release.hostSignature ?? ""))) return stagedFailure("extension_runtime_release_attestation_unavailable", 503, "Host release attestation was unavailable.");
  const runtimeAppId = (primitiveId: string) => {
    const appId = instanceKey === "default" ? primitiveId : `${instanceKey}_${primitiveId}`;
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) throw new Error("extension_runtime_app_id_invalid");
    return appId;
  };
  for (const canvas of canvases) {
    const appId = runtimeAppId(canvas.id);
    const canvasHtml = artifacts[canvas.component] as string;
    const canvasSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canvasHtml)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const hostSignature = installedResult.release!.hostSignature!;
    const bindingPayload = JSON.stringify([bundle.id, bundle.version, manifestJson, digest, hostSignature, canvas.component, canvasSha256]);
    const releaseProof = { extensionId: bundle.id, version: bundle.version, manifestJson, artifactSha256: digest,
      hostSignature, canvasPath: canvas.component, canvasSha256, bindingSignature: await signHmac(bindingPayload, c.env.PLATFORM_SECRET) };
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const init = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, scope: "PROJECT_BOUND", gadgetTier: 3, html: canvasHtml, releaseProof }) }));
    if (!init.ok) return stagedFailure("extension_canvas_initialize_failed", 500, await readBoundedResponseText(init, 8 * 1024).catch(() => ""));
  }
  for (const gadget of gadgets) {
    const appId = runtimeAppId(gadget.id);
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const init = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: gadget.schemaSql ?? "", migrations: gadget.migrations ?? [] }) }));
    if (!init.ok) return stagedFailure("extension_gadget_initialize_failed", 500, await readBoundedResponseText(init, 8 * 1024).catch(() => ""));
  }
  if (requiresRuntimeActivation) {
    const publisherKeyId = installedResult.release?.publisher?.keyId;
    if (publisherKeyId) {
      const activePublisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(identity.tenantId, spaceId, publisherKeyId).first();
      if (!activePublisher) return stagedFailure("extension_publisher_key_untrusted_or_revoked", 409, "The publisher key was revoked before this installation could activate.");
    }
    const activation = await stub.fetch(new Request("http://space-do/extension-installation/activate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
      body: JSON.stringify({ installationId: (await readBoundedResponseJson<{ installationId?: string }>(installed.clone(), 64 * 1024)).installationId,
        extensionId: bundle.id, version: bundle.version, artifactSha256: digest, tenantId: identity.tenantId, spaceId, projectId, scope: "PROJECT_BOUND" }),
    }));
    if (!activation.ok) return stagedFailure("extension_runtime_activation_failed", 503, await readBoundedResponseText(activation, 8 * 1024).catch(() => ""));
  }
  if (canvases[0]) {
    const update = await stub.fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(identity.tenantId)}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewport_config: { component: "CanvasMount", resourceId: runtimeAppId(canvases[0].id) } }) }));
    if (!update.ok) return c.json({ installed: true, ...installedResult, canvas_mount_warning: "The extension is installed and active, but this Canvas could not be selected as the project default. Select it from the project Canvas menu." }, 201);
  }
  return new Response(installed.body, { status: installed.status, headers: { "content-type": installed.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/extension-releases/rollback", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-releases/rollback", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/extension-releases/rollback", async c => {
  const { tenantId, userId } = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  if (!tenantId || !userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const body = await c.req.json<{ extension_id?: string; version?: string; project_id?: string; installation_id?: string; expected_current_version?: string | null; permission_expansion_approved?: boolean }>()
    .catch(() => ({} as { extension_id?: string; version?: string; project_id?: string; installation_id?: string; expected_current_version?: string | null; permission_expansion_approved?: boolean }));
  if (!body.extension_id || !body.version || !body.project_id || !body.installation_id
    || !Object.prototype.hasOwnProperty.call(body, "expected_current_version")
    || (body.expected_current_version !== null && typeof body.expected_current_version !== "string")) return c.json({ error_code: "rollback_scope_required" }, 400);
  const denied = await requireManageableAutomationProject(c, spaceId, body.project_id);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const installed = await stub.fetch(new Request("http://space-do/extension-installations?" + new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: body.extension_id })));
  if (!installed.ok) return c.json({ error_code: "extension_installation_lookup_unavailable" }, 503);
  const rows = await readBoundedResponseJson<{ installations: Array<{ instance_id: string; project_id: string | null; release_version: string | null; permissions?: string[]; capabilities?: string[] }> }>(installed, 2 * 1024 * 1024);
  const current = rows.installations.find(item => item.instance_id === body.installation_id && item.project_id === body.project_id);
  if (!current) return c.json({ error_code: "project_extension_not_installed" }, 404);
  if (current.release_version !== body.expected_current_version) return c.json({ error_code: "extension_installation_version_changed", current_version: current.release_version }, 409);
  const releasesResponse = await stub.fetch(new Request(`http://space-do/extension-releases?extension_id=${encodeURIComponent(body.extension_id)}`));
  if (!releasesResponse.ok) return c.json({ error_code: "extension_release_trust_unavailable" }, 503);
  const releases = await readBoundedResponseJson<{ releases?: Array<PublisherTaggedRelease & { version?: string }> }>(releasesResponse, 256 * 1024);
  const targetRelease = releases.releases?.find(release => release.version === body.version);
  if (!targetRelease) return c.json({ error_code: "extension_release_not_found" }, 404);
  const [trustedTarget] = await currentPublisherReleases(c.env, tenantId, spaceId, [targetRelease]);
  if (!trustedTarget || trustedTarget.signatureValid !== true) return c.json({ error_code: "extension_release_publisher_untrusted" }, 409);
  const accessExpansion = extensionReleaseAccessExpansion(current, targetRelease);
  if ((accessExpansion.permissions.length || accessExpansion.capabilities.length) && body.permission_expansion_approved !== true) {
    return c.json({ error_code: "permission_expansion_approval_required", added_permissions: accessExpansion.permissions, added_capabilities: accessExpansion.capabilities }, 409);
  }
  const response = await stub.fetch(new Request("http://space-do/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    extensionId: body.extension_id, version: body.version, installationId: body.installation_id, tenantId, spaceId, projectId: body.project_id,
    expectedCurrentVersion: body.expected_current_version, permissionExpansionApproved: body.permission_expansion_approved === true,
  }) }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/projects/:projectId/extensions/:extensionId/releases", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/extensions/:extensionId/releases", requireSpaceMembership({ GET: "admin" }));
app.get("/spaces/:spaceId/projects/:projectId/extensions/:extensionId/releases", async c => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId"), extensionId = c.req.param("extensionId");
  const identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const installed = await stub.fetch(new Request("http://space-do/extension-installations?" + new URLSearchParams({ tenant_id: identity.tenantId, space_id: spaceId, extension_id: extensionId })));
  if (!installed.ok) return c.json({ error_code: "extension_installation_lookup_unavailable" }, 503);
  const rows = await readBoundedResponseJson<{ installations: Array<{ project_id: string | null }> }>(installed, 2 * 1024 * 1024);
  if (!rows.installations.some(item => item.project_id === projectId)) return c.json({ error_code: "project_extension_not_installed" }, 404);
  const response = await stub.fetch(new Request("http://space-do/extension-releases?extension_id=" + encodeURIComponent(extensionId)));
  if (!response.ok) return response;
  const releases = await readBoundedResponseJson<{ releases?: Array<PublisherTaggedRelease & { version?: string }> }>(response, 256 * 1024);
  return c.json({ releases: await currentPublisherReleases(c.env, identity.tenantId, spaceId, releases.releases ?? []) });
});

app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId/session-state", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId/session-state", requireSpaceMembership({ GET: "admin", DELETE: "admin" }));
app.on(["GET", "DELETE"], "/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId/session-state", async c => {
  const { spaceId, projectId, instanceId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "channel_session_controls_unavailable" }, 503);
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/channel-extensions/session-state", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ spaceId, projectId, installationId: instanceId, action: c.req.method === "DELETE" ? "clear" : "summary" }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId", requireSpaceMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId", async c => {
  const { spaceId, projectId, instanceId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "channel_uninstall_unavailable" }, 503);
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const pause = await stub.fetch(new Request("http://space-do/project-extension-lifecycle", { method: "PATCH",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ tenantId, spaceId, projectId, instanceId, action: "disable", drainTimeoutMs: 10_000 }) }));
  if (!pause.ok) {
    if (pause.status === 404) {
      const persisted = await stub.fetch(new Request(`http://space-do/workflow-installation?${new URLSearchParams({
        instance_id: instanceId, tenant_id: tenantId, space_id: spaceId, include_removed: "1",
      })}`));
      const result = persisted.ok ? await readBoundedResponseJson<{ instance?: { project_id?: string | null; status?: string } }>(persisted, 2 * 1024 * 1024).catch(() => null) : null;
      if (result?.instance?.project_id === projectId && result.instance.status === "removed") return c.json({ removed: true, already_removed: true });
    }
    return new Response(pause.body, { status: pause.status, headers: { "content-type": "application/json" } });
  }
  const drain = await readBoundedResponseJson<{ drained?: unknown; active_work_count?: unknown }>(pause, 8 * 1024)
    .catch(() => ({} as { drained?: unknown; active_work_count?: unknown }));
  if (drain.drained !== true) return c.json({ error_code: "extension_runtime_work_not_drained",
    active_work_count: Number.isSafeInteger(drain.active_work_count) ? drain.active_work_count : null,
    message: "The installation is paused. Wait for admitted work to finish, then retry removal." }, 409);
  const cleanup = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/channel-extensions/session-state", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ spaceId, projectId, installationId: instanceId, requestedBy: identity.userId, action: "uninstall" }),
  }));
  if (!cleanup.ok) return new Response(cleanup.body, { status: cleanup.status, headers: { "content-type": "application/json" } });
  const removed = await stub.fetch(new Request("http://space-do/extension-installation?" + new URLSearchParams({
    instance_id: instanceId, tenant_id: tenantId, space_id: spaceId, project_id: projectId,
  }), { method: "DELETE" }));
  return new Response(removed.body, { status: removed.status, headers: { "content-type": "application/json" } });
});

app.use("/spaces/:spaceId/projects/:projectId/extension-provider-revocations", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/extension-provider-revocations", requireSpaceMembership({ GET: "admin", POST: "admin" }));
app.on(["GET", "POST"], "/spaces/:spaceId/projects/:projectId/extension-provider-revocations", async c => {
  const { spaceId, projectId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "provider_revocation_status_unavailable" }, 503);
  const tenantId = getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const body = c.req.method === "POST"
    ? await c.req.json<{ operation_id?: string }>().catch(() => ({} as { operation_id?: string }))
    : {};
  if (c.req.method === "POST" && !body.operation_id) return c.json({ error_code: "provider_cleanup_scope_invalid" }, 400);
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/channel-extensions/provider-revocations", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ spaceId, projectId, action: c.req.method === "POST" ? "retry" : "list",
      ...(body.operation_id ? { operationId: body.operation_id } : {}) }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
});

app.use("/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/lifecycle", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.patch("/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/lifecycle", async c => {
  const { spaceId, projectId, instanceId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const body = await c.req.json<{ action?: "enable" | "disable"; drain_timeout_ms?: number }>()
    .catch((): { action?: "enable" | "disable"; drain_timeout_ms?: number } => ({}));
  if (body.action !== "enable" && body.action !== "disable") return c.json({ error_code: "extension_lifecycle_action_invalid" }, 400);
  if (body.drain_timeout_ms !== undefined && (!Number.isSafeInteger(body.drain_timeout_ms) || body.drain_timeout_ms < 0 || body.drain_timeout_ms > 10_000))
    return c.json({ error_code: "extension_lifecycle_drain_timeout_invalid" }, 400);
  const tenantId = getCallerIdentity(c).tenantId;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space-do/project-extension-lifecycle", { method: "PATCH",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ tenantId, spaceId, projectId, instanceId, action: body.action, drainTimeoutMs: body.drain_timeout_ms ?? 0 }) }));
});

const projectExtensionSettingsPath = "/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/settings";
app.use(projectExtensionSettingsPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
async function forwardProjectExtensionSettings(c: any) {
  const identity = getCallerIdentity(c), { spaceId, projectId, instanceId } = c.req.param();
  if (!identity.tenantId || !identity.userId || !/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)
    || !/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId)) return c.json({ error_code: "extension_settings_scope_required" }, 400);
  let manageable = false;
  if (c.req.method === "PATCH") {
    const deniedManage = await requireManageableAutomationProject(c, spaceId, projectId);
    if (!deniedManage) manageable = true;
    else {
      const deniedRead = await requireReadableAutomationProject(c, spaceId, projectId);
      if (deniedRead) return deniedRead;
    }
  } else {
    const deniedRead = await requireReadableAutomationProject(c, spaceId, projectId);
    if (deniedRead) return deniedRead;
    manageable = !(await requireManageableAutomationProject(c, spaceId, projectId));
  }
  let body: ArrayBuffer | undefined;
  if (c.req.method === "PATCH") {
    try { body = (await readBoundedRequestBytes(c.req.raw, 64 * 1024)).buffer as ArrayBuffer; }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
  }
  const query = new URLSearchParams({ tenant_id: identity.tenantId, space_id: spaceId, project_id: projectId, instance_id: instanceId });
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  return stub.fetch(new Request(`http://space-do/extension-settings?${query}`, {
    method: c.req.method,
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId),
      "x-naelao-role": identity.role, "x-naelao-user-id": identity.userId, "x-naelao-project-read": "1", ...(manageable ? { "x-naelao-project-manage": "1" } : {}) },
    ...(body ? { body } : {}),
  }));
}
app.get(projectExtensionSettingsPath, forwardProjectExtensionSettings);
app.patch(projectExtensionSettingsPath, forwardProjectExtensionSettings);

const projectExtensionSettingsAuditPath = "/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/settings-audit";
app.use(projectExtensionSettingsAuditPath, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.get(projectExtensionSettingsAuditPath, async c => {
  const identity = getCallerIdentity(c), { spaceId, projectId, instanceId } = c.req.param();
  if (!identity.tenantId || !identity.userId || !/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)
    || !/^[A-Za-z0-9._:-]{1,768}$/.test(instanceId)) return c.json({ error_code: "extension_settings_scope_required" }, 400);
  const deniedRead = await requireReadableAutomationProject(c, spaceId, projectId);
  if (deniedRead) return deniedRead;
  const manageable = !(await requireManageableAutomationProject(c, spaceId, projectId));
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const query = new URLSearchParams({ tenant_id: identity.tenantId, space_id: spaceId, project_id: projectId, instance_id: instanceId });
  return stub.fetch(new Request(`http://space-do/extension-settings-audit?${query}`, {
    headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId),
      "x-naelao-user-id": identity.userId, "x-naelao-role": identity.role, "x-naelao-project-read": "1",
      ...(manageable ? { "x-naelao-project-manage": "1" } : {}) },
  }));
});

app.use("/internal/spaces/:spaceId/projects/:projectId/extensions/:extensionId/active", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.get("/internal/spaces/:spaceId/projects/:projectId/extensions/:extensionId/active", async (c) => {
  const extensionId = c.req.param("extensionId");
  if (extensionId !== "ext_lsp_indexer") return c.json({ error_code: "extension_not_supported" }, 404);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const { spaceId, projectId } = c.req.param();
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await stub.fetch(new Request("http://space-do/extension-installations?" + new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: extensionId })));
  if (!response.ok) return c.json({ error_code: "extension_installation_lookup_unavailable" }, 503);
  const result = await response.json<{ installations?: Array<{ scope: string; project_id: string | null; status: string }> }>();
  const active = result.installations?.some(item => item.status === "active" && item.scope === "PROJECT_BOUND" && item.project_id === projectId) ?? false;
  return active ? c.json({ active: true }) : c.json({ error_code: "project_extension_not_installed" }, 404);
});

// External channel behavior is supplied by installed project extensions. There is no built-in
// project rule editor or customer-agent behavior in the Spaces kernel.
app.use("/spaces/:spaceId/projects/:projectId/spend", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

app.use("/spaces/:spaceId/projects/:projectId/usage", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/usage", requireSpaceMembership({ GET: "admin" }));
app.get("/spaces/:spaceId/projects/:projectId/usage", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  if (!c.env.BILLING_WORKER) return c.json({ error_code: "billing_unavailable" }, 503);
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const query = new URLSearchParams({ space_id: spaceId, project_id: projectId, days: c.req.query("days") ?? "30" });
  const response = await c.env.BILLING_WORKER.fetch(new Request(`http://billing-worker/internal/usage/project-summary?${query}`, {
    headers: { "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

// GET lists, POST creates — proxied to the SpaceDO. §A1.17 Phase T1: viewer_id/created_by are
// ALWAYS derived from the caller's own verified identity (never a client-supplied field) so
// visibility filtering and project_members ownership can't be spoofed.
app.get("/spaces/:spaceId/projects", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const viewerParam = identity.userId
    ? `&viewer_id=${encodeURIComponent(identity.userId)}`
    : "&space_manager=1";
  const res = await forwardToSpaceDO(stub, `/projects?space_id=${encodeURIComponent(spaceId)}${viewerParam}`, "GET");
  if (c.req.query("include_subspaces") === "1" && identity.userId && res.ok) {
    const roots = await res.json<{ data?: Array<{ id?: string }> }>();
    const hierarchy = await forwardToSpaceDO(stub, "/spaces", "GET");
    if (!hierarchy.ok) return c.json({ error_code: "subspace_listing_unavailable" }, 503);
    const entries = await hierarchy.json<{ data?: Array<{ id?: string; parent_id?: string | null; status?: string }> }>();
    const projects = new Map((roots.data ?? []).filter(item => item.id).map(item => [item.id!, item]));
    for (const entry of entries.data ?? []) {
      if (!entry.id || entry.parent_id !== spaceId || entry.status !== "active") continue;
      if (!(await authorizeDepartmentMember(stub, identity.userId, entry.id, "read")).permitted) continue;
      const scoped = await forwardToSpaceDO(stub, `/projects?space_id=${encodeURIComponent(spaceId)}&subspace_id=${encodeURIComponent(entry.id)}${viewerParam}`, "GET");
      if (!scoped.ok) return c.json({ error_code: "subspace_projects_unavailable" }, 503);
      const payload = await scoped.json<{ data?: Array<{ id?: string }> }>();
      for (const project of payload.data ?? []) if (project.id) projects.set(project.id, project);
    }
    return c.json({ data: [...projects.values()], count: projects.size });
  }
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
  if(res.ok&&identity.userId&&c.env.AGENTS_WORKER){
    const created=await res.clone().json<{id:string}>();
    c.executionCtx.waitUntil(c.env.AGENTS_WORKER.fetch(new Request(`http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications?project_id=${encodeURIComponent(created.id)}`,{method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":tenantId,"x-naelao-user-id":identity.userId,"x-naelao-role":identity.role,"x-naelao-internal-token":await mintInternalToken(c.env.PLATFORM_SECRET,tenantId)},body:JSON.stringify({action:"identity"})})).then(response=>{if(!response.ok)console.warn(`Project assistant identity or template inbox setup deferred: ${response.status}`);}).catch(()=>{console.warn("Project assistant identity or template inbox setup deferred");}));
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

/** Stamp a canonical drop-in room into an existing SpaceDO. */
app.use("/spaces/:spaceId/project-templates/:templateId/stamp", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/project-templates/:templateId/stamp", requireSpaceMembership({ POST: "member" }));
app.post("/spaces/:spaceId/project-templates/:templateId/stamp", async (c) => {
  const spaceId = c.req.param("spaceId");
  const templateId = c.req.param("templateId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ overrides?: { name?: string } }>().catch((): { overrides?: { name?: string } } => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await stub.fetch(new Request("http://space-do/project-templates/stamp", { method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ space_id: spaceId, template_id: templateId, overrides: body.overrides ?? {} }),
  }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// §A1.17 Phase T1: project members (real ACL, not just presence). §A1.17 Phase T3: exclusive-
// mode thread activation.
app.use("/spaces/:spaceId/projects/:projectId/members", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/members", requireSpaceMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/members/:userId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/members/:userId", requireSpaceMembership({ DELETE: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/activate-thread", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/activate-thread", requireSpaceMembership({ POST: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/mode", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/mode", requireSpaceMembership({ GET: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/subspace-migration-preflight", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/subspace-migration-preflight", requireSpaceMembership({ GET: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/graduate-to-subspace", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/graduate-to-subspace", requireSpaceMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/return-to-parent", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/return-to-parent", requireSpaceMembership({ POST: "admin" }));
for (const route of ["/spaces/:spaceId/projects/:projectId/sub-spaces", "/spaces/:spaceId/projects/:projectId/sub-spaces/:subId"]) {
  app.use(route, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use(route, requireSpaceMembership({ GET: "member", POST: "admin", DELETE: "admin" }));
}
for (const route of ["/spaces/:spaceId/sub-spaces/:subId/projects", "/spaces/:spaceId/sub-spaces/:subId/projects/*"]) {
  app.use(route, requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
  app.use(route, requireSpaceMembership({ GET: "member", POST: "member" }));
}
for (const route of ["/spaces/:spaceId/sub-spaces/:subId/members", "/spaces/:spaceId/sub-spaces/:subId/members/*"]) {
  app.use(route, requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
  app.use(route, requireSpaceMembership({ GET: "member", POST: "member", DELETE: "member" }));
}
app.use("/spaces/:spaceId/projects/:projectId/promote", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/promote", requireSpaceMembership({ POST: "admin" }));

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
  const body = await c.req.json().catch(() => ({}));
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/members`, "POST", JSON.stringify({ ...body, tenant_id: tenantId }));
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

/** Read text inline and preserve every unrecognized/binary file as base64 bytes. */
async function readWorkspaceObject(obj: R2ObjectBody, relative: string, expected?: { sha256: string; size: number; contentType?: string }): Promise<Response> {
  if (obj.size > WORKSPACE_MAX_FILE_BYTES) {
    return Response.json({ path: relative, size: obj.size, too_large: true, message: "File exceeds the 2MB inline view limit" });
  }
  const bytes = await obj.arrayBuffer();
  if (bytes.byteLength !== obj.size || bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    return Response.json({ path: relative, size: obj.size, error_code: "workspace_file_changed_during_read" }, { status: 409 });
  }
  if (expected) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (obj.size !== expected.size || sha256 !== expected.sha256) {
      return Response.json({ path: relative, error_code: "workspace_content_integrity_failed" }, { status: 503 });
    }
  }
  const contentType = resolveFileContentType(relative, expected?.contentType ?? obj.httpMetadata?.contentType);
  return Response.json({ path: relative, size: obj.size, content_type: contentType, ...encodeWorkspaceFileContent(new Uint8Array(bytes), contentType) });
}
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
  const dualRead = c.env.WORKSPACE_DUAL_READ_ENABLED === "true";
  const compat = await readWorkspaceCompat({ enabled: c.env.UNIFIED_WORKSPACE_ENABLED === "true" || dualRead, verificationOnly: dualRead && c.env.UNIFIED_WORKSPACE_ENABLED !== "true", enforcePolicy: true, agentsWorker: c.env.AGENTS_WORKER,
    platformSecret: c.env.PLATFORM_SECRET, tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" : "global" });
  if (compat.kind === "error") return new Response(compat.response.body, { status: compat.response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (compat.kind === "canonical") {
    if (dualRead && !c.env.SCRIPTS_R2) return c.json({ error_code: "workspace_dual_read_unavailable" }, 503);
    const verification = dualRead && c.env.SCRIPTS_R2 ? await verifyWorkspaceDualRead({ bucket: c.env.SCRIPTS_R2, prefix: workspaceKeyPrefix(spaceId, projectId),
      tenantId, spaceId, projectId, head: compat.head, entries: compat.entries }) : undefined;
    if (c.env.UNIFIED_WORKSPACE_ENABLED !== "true" && c.env.SCRIPTS_R2) {
      // Verification mode observes the manifest but leaves the legacy UI view authoritative.
      const prefix = workspaceKeyPrefix(spaceId, projectId);
      const files: Array<{ path: string; size: number; uploaded: string }> = [];
      const listing = await c.env.SCRIPTS_R2.list({ prefix, limit: WORKSPACE_MAX_FILES });
      for (const obj of listing.objects) if (!obj.key.endsWith("/.keep") && obj.customMetadata?.deleted !== "true") files.push({ path: obj.key.slice(prefix.length), size: obj.size, uploaded: obj.uploaded.toISOString() });
      return c.json({ data: files, count: files.length, truncated: listing.truncated || files.length >= WORKSPACE_MAX_FILES,
        verification: { branch: compat.head.branch, revision: compat.head.revision, ...(verification ? { compared: verification.compared, matching: verification.matching, mismatched: verification.mismatched, truncatedPass: verification.truncated, drifts: verification.drifts } : {}) } });
    }
    const files = compat.entries.map((entry) => ({ path: entry.path, size: entry.size, uploaded: compat.head.updatedAt }));
    return c.json({ data: files, count: files.length, truncated: false, branch: compat.head.branch, revision: compat.head.revision,
      ...(verification ? { verification: { compared: verification.compared, matching: verification.matching, mismatched: verification.mismatched, truncated: verification.truncated, drifts: verification.drifts } } : {}) }, 200, { "cache-control": "no-store" });
  }
  if (!c.env.SCRIPTS_R2) return c.json({ data: [], count: 0, unavailable: true });
  const prefix = workspaceKeyPrefix(spaceId, projectId);
  const files: Array<{ path: string; size: number; uploaded: string }> = [];
  let cursor: string | undefined;
  do {
    const list = await c.env.SCRIPTS_R2.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const obj of list.objects) {
      if (obj.key.endsWith("/.keep") || obj.customMetadata?.deleted === "true") continue;
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
app.use("/spaces/:spaceId/projects/:projectId/workspace/files/*", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files/*", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
  const rest = c.req.path.split("/workspace/files/")[1] ?? "";
  // Collapse any .. traversal server-side; the key must stay inside the project's own prefix.
  const relative = decodeURIComponent(rest).split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  if (!relative) return c.json({ error_code: "bad_request", message: "file path required" }, 400);
  const dualRead = c.env.WORKSPACE_DUAL_READ_ENABLED === "true";
  const compat = await readWorkspaceCompat({ enabled: c.env.UNIFIED_WORKSPACE_ENABLED === "true" || dualRead, verificationOnly: dualRead && c.env.UNIFIED_WORKSPACE_ENABLED !== "true", enforcePolicy: true, agentsWorker: c.env.AGENTS_WORKER,
    platformSecret: c.env.PLATFORM_SECRET, tenantId, spaceId, projectId, path: relative, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" : "global" });
  if (compat.kind === "error") return new Response(compat.response.body, { status: compat.response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (compat.kind === "canonical") {
    if (dualRead && !c.env.SCRIPTS_R2) return c.json({ error_code: "workspace_dual_read_unavailable" }, 503);
    const verification = dualRead && c.env.SCRIPTS_R2 ? await verifyWorkspaceDualRead({ bucket: c.env.SCRIPTS_R2, prefix: workspaceKeyPrefix(spaceId, projectId),
      tenantId, spaceId, projectId, head: compat.head, entries: compat.entries, path: relative }) : undefined;
    if (c.env.UNIFIED_WORKSPACE_ENABLED !== "true" && c.env.SCRIPTS_R2) {
      const prefix = workspaceKeyPrefix(spaceId, projectId);
      const legacy = await c.env.SCRIPTS_R2.get(prefix + relative);
      if (!legacy || legacy.customMetadata?.deleted === "true") return c.json({ error_code: "not_found", message: "File not found" }, 404);
      return readWorkspaceObject(legacy, relative);
    }
    const entry = compat.entries.find((candidate) => candidate.path === relative);
    if (!entry) return c.json({ error_code: "not_found", message: "File not found" }, 404, { "cache-control": "no-store" });
    const object = await c.env.SCRIPTS_R2?.get(entry.objectKey);
    if (!object) return c.json({ error_code: "workspace_content_unavailable" }, 503, { "cache-control": "no-store" });
    const response = await readWorkspaceObject(object, relative, { sha256: entry.sha256, size: entry.size, ...(entry.contentType ? { contentType: entry.contentType } : {}) });
    const headers = new Headers(response.headers);
    headers.set("x-workspace-branch", compat.head.branch);
    headers.set("x-workspace-revision", String(compat.head.revision));
    if (verification) {
      headers.set("x-workspace-dual-read-compared", String(verification.compared));
      headers.set("x-workspace-dual-read-matched", String(verification.matching));
      headers.set("x-workspace-dual-read-drifted", String(verification.mismatched));
      headers.set("x-workspace-dual-read-truncated", String(verification.truncated));
    }
    return new Response(response.body, { status: response.status, headers });
  }
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable", message: "Workspace storage not configured" }, 503);
  const prefix = workspaceKeyPrefix(spaceId, projectId);
  const obj = await c.env.SCRIPTS_R2.get(prefix + relative);
  if (!obj || obj.customMetadata?.deleted === "true") return c.json({ error_code: "not_found", message: "File not found" }, 404);
  return readWorkspaceObject(obj, relative);
});

// Existing-project import is an explicit admin action. The coordinator installs a durable
// write barrier, verifies the legacy snapshot twice, initializes revision 1, and retains the
// legacy-prefix rollback alias. It is independent of the global rollout flag.
app.use("/spaces/:spaceId/projects/:projectId/workspace/migrate", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/migrate", requireSpaceMembership({ GET: "admin", POST: "admin" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/migrate", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_migration_unavailable" }, 503);
  const actorRole = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (actorRole !== "owner" && actorRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const access = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, identity.tenantId), `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/migration-status", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) }, body: JSON.stringify({ scope }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
app.post("/spaces/:spaceId/projects/:projectId/workspace/migrate", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const actorRole = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (actorRole !== "owner" && actorRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let migrationRequest: { branchNames?: unknown } = {};
  try {
    const raw = await readBoundedRequestText(c.req.raw, 64 * 1024);
    if (raw.trim()) migrationRequest = JSON.parse(raw) as typeof migrationRequest;
  } catch { return c.json({ error_code: "invalid_workspace_migration_request" }, 400); }
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_migration_unavailable" }, 503);
  const space = await c.env.PLATFORM_DB.prepare("SELECT 1 AS found FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, identity.tenantId).first();
  if (!space) return c.notFound();
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(scope)));
  const migrationId = `project-migration-${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/migrate-existing-project", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
    body: JSON.stringify({ scope, migrationId, ...(migrationRequest.branchNames !== undefined ? { branchNames: migrationRequest.branchNames } : {}) }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

app.use("/spaces/:spaceId/projects/:projectId/workspace/repair", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/repair", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workspace/repair", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_migration_unavailable" }, 503);
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let request: { migrationId?: unknown };
  try { request = JSON.parse(await readBoundedRequestText(c.req.raw, 8 * 1024)) as typeof request; }
  catch { return c.json({ error_code: "invalid_workspace_migration_repair_request" }, 400); }
  if (typeof request.migrationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.migrationId)) return c.json({ error_code: "invalid_workspace_migration_repair_request" }, 400);
  const access = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, identity.tenantId), `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/migration-repair", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
    body: JSON.stringify({ scope, migrationId: request.migrationId }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

app.use("/spaces/:spaceId/projects/:projectId/workspace/cutover", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/cutover", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workspace/cutover", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_migration_unavailable" }, 503);
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let request: { migrationId?: unknown; rollbackWindowMs?: unknown };
  try { request = JSON.parse(await readBoundedRequestText(c.req.raw, 8 * 1024)) as typeof request; }
  catch { return c.json({ error_code: "invalid_workspace_cutover_request" }, 400); }
  if (typeof request.migrationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.migrationId) ||
      !Number.isSafeInteger(request.rollbackWindowMs) || Number(request.rollbackWindowMs) < 60 * 60_000 || Number(request.rollbackWindowMs) > 90 * 24 * 60 * 60_000) return c.json({ error_code: "invalid_workspace_cutover_request" }, 400);
  const access = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, identity.tenantId), `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/migration-cutover", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
    body: JSON.stringify({ scope, migrationId: request.migrationId, rollbackWindowMs: request.rollbackWindowMs }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

app.use("/spaces/:spaceId/projects/:projectId/workspace/cleanup-alias", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/cleanup-alias", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workspace/cleanup-alias", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_alias_cleanup_unavailable" }, 503);
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let request: { migrationId?: unknown };
  try { request = JSON.parse(await readBoundedRequestText(c.req.raw, 8 * 1024)) as typeof request; }
  catch { return c.json({ error_code: "invalid_workspace_alias_cleanup_request" }, 400); }
  if (typeof request.migrationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.migrationId)) return c.json({ error_code: "invalid_workspace_alias_cleanup_request" }, 400);
  const access = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, identity.tenantId), `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/retire-alias", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) }, body: JSON.stringify({ scope, migrationId: request.migrationId }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

app.use("/spaces/:spaceId/projects/:projectId/workspace/restore", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/restore", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workspace/restore", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !c.env.AGENTS_WORKER) return c.json({ error_code: "workspace_restore_unavailable" }, 503);
  const actorRole = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, identity.tenantId) : identity.role;
  if (actorRole !== "owner" && actorRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let restoreRequest: { confirm?: unknown; restoreId?: unknown; expectedHeads?: unknown };
  try { restoreRequest = JSON.parse(await readBoundedRequestText(c.req.raw, 64 * 1024)) as typeof restoreRequest; }
  catch { return c.json({ error_code: "invalid_workspace_restore_request" }, 400); }
  if (restoreRequest.confirm !== true || typeof restoreRequest.restoreId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(restoreRequest.restoreId)) return c.json({ error_code: "invalid_workspace_restore_request" }, 400);
  const space = await c.env.PLATFORM_DB.prepare("SELECT 1 AS found FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, identity.tenantId).first();
  if (!space) return c.notFound();
  const access = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, identity.tenantId), `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const scope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const response = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/migration-restore", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
    body: JSON.stringify({ scope, confirm: true, restoreId: restoreRequest.restoreId,
      ...(restoreRequest.expectedHeads !== undefined ? { expectedHeads: restoreRequest.expectedHeads } : {}) }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

// The visual workflow authoring surface can save only validated workflow source paths. It cannot
// overwrite arbitrary project artifacts or add capabilities; runtime grants remain authoritative.
app.use("/spaces/:spaceId/projects/:projectId/workflows/plan", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workflows/plan", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workflows/plan", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const role = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId) : identity.role;
  if (!role || !["owner", "admin"].includes(role)) return c.json({ error_code: "forbidden" }, 403);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return c.json({ error_code: "invalid_project_id" }, 400);
  const body = await c.req.json<{ path?: unknown; plan?: unknown }>().catch(() => ({} as { path?: unknown; plan?: unknown }));
  const relative = typeof body.path === "string" ? body.path : "";
  if (!/^workflows\/[a-z0-9][a-z0-9_-]{0,62}\.ts$/.test(relative)) {
    return c.json({ error_code: "workflow_plan_path_invalid" }, 400);
  }
  let source: string;
  try {
    const plan = body.plan as Parameters<typeof compileWorkflowPlan>[0];
    source = compileWorkflowPlan(plan, Array.isArray(plan?.steps) ? plan.steps.map(step => step.operation) : []).source;
  } catch (error) {
    return c.json({ error_code: "workflow_plan_invalid", message: error instanceof Error ? error.message : "Workflow plan invalid" }, 400);
  }
  if (new TextEncoder().encode(source).byteLength > 65_536) return c.json({ error_code: "workflow_plan_too_large" }, 400);
  if (!c.env.SCRIPTS_R2 || !c.env.AGENTS_WORKER) return c.json({ error_code: "workflow_authoring_unavailable" }, 503);
  const space = await c.env.PLATFORM_DB.prepare("SELECT 1 AS found FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, identity.tenantId).first();
  if (!space) return c.notFound();
  const spaceStub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const project = await forwardToSpaceDO(spaceStub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!project.ok) return c.json({ error_code: project.status === 404 ? "project_not_found" : "project_forbidden" }, project.status === 404 ? 404 : 403);
  const key = workspaceKeyPrefix(spaceId, projectId) + relative;
  if (c.env.UNIFIED_WORKSPACE_ENABLED !== "true" && await c.env.SCRIPTS_R2.head(key)) return c.json({ error_code: "workflow_plan_draft_exists", message: "Choose a new workflow name to preserve the existing draft." }, 409);
  const compilation = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workflow-extensions/compile", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) }, body: JSON.stringify({ source }),
  }));
  if (!compilation.ok) {
    const detail = await compilation.json<{ error_code?: string; message?: string }>().catch((): { error_code?: string; message?: string } => ({}));
    return c.json({ error_code: detail.error_code ?? "workflow_plan_compile_failed", message: detail.message }, 400);
  }
  const compiled = await compilation.json<{ digest?: string; bytes?: number }>();
  if (c.env.UNIFIED_WORKSPACE_ENABLED === "true") {
    const sourceBytes = new TextEncoder().encode(source);
    let binary = "";
    for (let offset = 0; offset < sourceBytes.length; offset += 0x8000) binary += String.fromCharCode(...sourceBytes.subarray(offset, offset + 0x8000));
    const suppliedKey = c.req.header("idempotency-key") ?? "";
    const idempotencyKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(suppliedKey) ? suppliedKey : crypto.randomUUID();
    const published = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/checked-publish", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
      body: JSON.stringify({ scope: { tenantId: identity.tenantId, spaceId, projectId,
        jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" : "global" }, actorId: identity.userId, path: relative,
        expectedHash: null, contentBase64: btoa(binary), idempotencyKey }),
    }));
    if (!published.ok) return new Response(published.body, { status: published.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const publication = await published.json<{ publication?: { revision?: number; status?: string } }>();
    return c.json({ saved: true, path: relative, digest: compiled.digest, bytes: compiled.bytes,
      branch: "main", revision: publication.publication?.revision, publicationStatus: publication.publication?.status }, 200, { "cache-control": "no-store" });
  }
  const sourceBytes = new TextEncoder().encode(source);
  let binary = "";
  for (let offset = 0; offset < sourceBytes.length; offset += 0x8000) binary += String.fromCharCode(...sourceBytes.subarray(offset, offset + 0x8000));
  const legacyScope = { tenantId: identity.tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const legacySaved = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/legacy-write", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) },
    body: JSON.stringify({ scope: legacyScope, actorId: identity.userId, path: relative, expectedHash: null, contentBase64: btoa(binary),
      contentType: "text/typescript; charset=utf-8", idempotencyKey: `workflow:${projectId}:${compiled.digest}` }),
  }));
  if (legacySaved.status === 409) return c.json({ error_code: "workflow_plan_draft_exists", message: "Choose a new workflow name to preserve the existing draft." }, 409);
  if (!legacySaved.ok) return new Response(legacySaved.body, { status: legacySaved.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return c.json({ saved: true, path: relative, digest: compiled.digest, bytes: compiled.bytes });
});

// The space worker authorizes node-level document editing; lease owner identity always comes
// from the verified shell session, never from a client-supplied holder_id.
app.use("/spaces/:spaceId/projects/:projectId/document-nodes/:nodeId/lease", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/document-nodes/:nodeId/lease", requireSpaceMembership({ POST: "member" }));
app.post("/spaces/:spaceId/projects/:projectId/document-nodes/:nodeId/lease", async (c) => {
  const { spaceId, projectId, nodeId } = c.req.param();
  const identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId || !/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) return c.json({ error_code: "bad_request" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
  return forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/document-nodes/${encodeURIComponent(nodeId)}/lease?space_id=${encodeURIComponent(spaceId)}&viewer_id=${encodeURIComponent(identity.userId)}`, "POST", await readBoundedRequestText(c.req.raw, 1024 * 1024));
});

// F-36: the effective role an assistant has in a project when acting for a given user (member GET
// gate — anyone who can read the member list can read this derived value).
app.use("/spaces/:spaceId/projects/:projectId/assistant-access", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/assistant-access", requireSpaceMembership({ GET: "member" }));
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
// dashboard reachable, matching project spend's existing internal-only posture.
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
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // The SpaceDO owns the confidential-project ACL. The viewer comes only from router-verified
  // identity headers, never from a query parameter supplied by the client.
  const accessParam = identity.userId
    ? `viewer_id=${encodeURIComponent(identity.userId)}`
    : "space_manager=1";
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?${accessParam}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.patch("/spaces/:spaceId/projects/:projectId", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  let archivesProject = false;
  try {
    const body = await c.req.raw.clone().json() as { status?: unknown };
    archivesProject = !!body && typeof body === "object" && body.status === "archived";
  } catch { /* Preserve the existing SpaceDO validation response for malformed JSON. */ }
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // §A1.17 Phase V: tenant_id rides the query string (not a header, since forwardToSpaceDO
  // doesn't forward client headers, and the body is streamed through unparsed) so
  // updateProject can live-sync via broadcastSpaceEvent.
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(tenantId)}`, "PATCH", c.req.raw.body);
  if (res.ok && archivesProject) {
    try {
      await retireProjectCoordination(c.env.PLATFORM_DB, tenantId, spaceId, projectId);
    } catch {
      return c.json({ error_code: "project_coordination_cleanup_unavailable", archived: true, retryable: true }, 503, { "cache-control": "no-store" });
    }
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Project workspace deletion is retryable and starts by archiving the project so new work is
// no longer admitted. Coordinator erasure revokes workspace sessions/subscriptions and removes
// aliases/staging; legacy project-prefix objects are then deleted a bounded page at a time.
// Tenant provider connections live outside this project-owned prefix and remain untouched.
app.use("/spaces/:spaceId/projects/:projectId", requireSpaceMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/projects/:projectId", async c => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const actorRole = identity.role === "product_end_user" ? await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, identity.userId, tenantId) : identity.role;
  if (actorRole !== "owner" && actorRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  let body: { confirm?: unknown; cursor?: unknown };
  try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 16 * 1024)) as typeof body; }
  catch { return c.json({ error_code: "invalid_project_deletion_request" }, 400); }
  if (body.confirm !== true || (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 1024))) return c.json({ error_code: "invalid_project_deletion_request" }, 400);
  const space = await c.env.PLATFORM_DB.prepare("SELECT 1 AS found FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first();
  if (!space) return c.notFound();
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return c.json({ error_code: access.status === 404 ? "project_not_found" : "project_forbidden" }, access.status === 404 ? 404 : 403);
  const archived = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(tenantId)}`, "PATCH", JSON.stringify({ status: "archived" }));
  if (!archived.ok) return new Response(archived.body, { status: archived.status, headers: { "content-type": "application/json" } });
  try {
    await retireProjectCoordination(c.env.PLATFORM_DB, tenantId, spaceId, projectId);
  } catch {
    return c.json({ error_code: "project_coordination_cleanup_unavailable", archived: true, retryable: true }, 503, { "cache-control": "no-store" });
  }
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "project_workspace_cleanup_unavailable", archived: true }, 503);
  const scope = { tenantId, spaceId, projectId, jurisdiction: c.env.DATA_JURISDICTION === "eu" ? "eu" as const : "global" as const };
  const cleanup = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workspaces/delete-project", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ scope, confirm: true, ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}) }),
  }));
  const result = await cleanup.json().catch(() => ({ error_code: "project_workspace_cleanup_unavailable" }));
  return Response.json({ ...(result && typeof result === "object" ? result as Record<string, unknown> : { error_code: "project_workspace_cleanup_unavailable" }), archived: true }, {
    status: cleanup.status, headers: { "cache-control": "no-store" },
  });
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

// Internal customer-channel quota claim. HMAC authentication prevents callers from spoofing
// sender hashes or consuming another tenant's project allowance.
app.use("/spaces/:spaceId/projects/:projectId/external-message-usage", requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.post("/spaces/:spaceId/projects/:projectId/external-message-usage", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const query = new URLSearchParams({ space_id: spaceId });
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/external-message-usage?${query}`, "POST", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Container Marketplace slots (§A1.17 Phase L) — builder/operator-only for now (like spend/
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
// configured slot limit from host configuration. SpaceDO checks that limit beside its
// synchronous insert so concurrent requests cannot overbook; its hard ceiling is a backstop.
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
  if (image.install_manifest) {
    return c.json({ error_code: "runtime_installation_required", message: "Install this deployed runtime through the owner-approved runtime installation flow" }, 409);
  }

  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ spacetype_id: string; config_json: string | null }>();
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json);
  const maxSlots = pc?.containerMarketplace?.maxSlotsPerProject ?? 0;

  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // Pass the host-derived limit to the actor that owns the rows. A separate GET/count
  // followed by POST lets concurrent installs all observe the same free slot.
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/container-slots`, "POST", JSON.stringify({ ...body, max_slots: maxSlots }));
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
// requireSpaceMembership for a product_end_user caller specifically, since tenant-match alone
// would let any end user of ANY business under the same owning tenant reach another business's
// grants. user_id is ALWAYS derived from the verified caller identity, never a client-supplied
// field — a caller can only grant/connect their OWN machine, never name someone else's.
app.use("/spaces/:spaceId/local-grants", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-grants/:grantId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-tunnel/connect-token", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/local-grants", requireSpaceMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/local-grants/:grantId", requireSpaceMembership({ DELETE: "admin" }));
app.use("/spaces/:spaceId/local-tunnel/connect-token", requireSpaceMembership({ POST: "member" }));

app.get("/spaces/:spaceId/local-grants", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // A business member sees only their OWN grants (directory paths are sensitive); a builder/
  // owner JWT caller keeps seeing the whole space's grants, unchanged from before this pass.
  const userFilter = identity.role === "product_end_user" && identity.userId ? `&user_id=${encodeURIComponent(identity.userId)}` : "";
  // Optional ?project_id= narrows to grants that would actually apply within one project (its
  // own scoped grants plus every space-wide one) — what a project-scoped panel wants to show.
  const projectId = c.req.query("project_id");
  const projectFilter = projectId ? `&project_id=${encodeURIComponent(projectId)}` : "";
  const res = await forwardToSpaceDO(stub, `/local-grants?space_id=${encodeURIComponent(spaceId)}${userFilter}${projectFilter}`, "GET");
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

// Device enrollment/administration requires both router identity and a live space role.
app.use("/spaces/:spaceId/tunnels", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tunnels/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tunnels", requireSpaceMembership({ GET: "member" }));
app.use("/spaces/:spaceId/tunnels/*", requireSpaceMembership({ GET: "member", POST: "admin", DELETE: "admin" }));
app.get("/spaces/:spaceId/tunnels", async c => {
  const identity = getCallerIdentity(c), tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  return stub.fetch(new Request("http://space-do/machine-authority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list", tenantId, spaceId: c.req.param("spaceId"), actorId: identity.userId }) }));
});
app.post("/spaces/:spaceId/tunnels/enrollment", async c => {
  const identity = getCallerIdentity(c), tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const body = await c.req.json<{ name?: string; grants?: unknown }>();
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  return stub.fetch(new Request("http://space-do/machine-authority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "enrollment", tenantId, spaceId: c.req.param("spaceId"), actorId: identity.userId, name: body.name, grants: body.grants ?? [] }) }));
});
app.post("/spaces/:spaceId/tunnels/:machineId/:action", async c => {
  const identity = getCallerIdentity(c), tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  const action = c.req.param("action");
  if (!["rename", "revoke", "remove", "grants"].includes(action)) return c.json({ error_code: "bad_request" }, 400);
  if (!tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const body = await c.req.json<{ name?: string; grants?: unknown }>();
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  return stub.fetch(new Request("http://space-do/machine-authority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, tenantId, spaceId: c.req.param("spaceId"), actorId: identity.userId, machineId: c.req.param("machineId"), name: body.name, grants: body.grants }) }));
});
app.post("/spaces/:spaceId/tunnel-authority", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const spaceId = c.req.param("spaceId");
  const active = await c.env.PLATFORM_DB.prepare(
    `SELECT s.id FROM spaces s WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active'
     AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = s.tenant_id AND o.status = 'active')`,
  ).bind(spaceId, tenantId).first<{ id: string }>();
  if (!active) return c.json({ error_code: "tenant_suspended" }, 403);
  const body = await c.req.json<Record<string, unknown>>();
  if (!["enroll", "authenticate", "lookup", "heartbeat"].includes(String(body.action))) return c.json({ error_code: "forbidden" }, 403);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space-do/machine-authority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, tenantId, spaceId }) }));
});

// ── Per-business connector connect (BYO Whop account, no Naelao Platforms invite needed) ──────
// Every business's revenue-cut billing runs through the existing revenue-tracker + reseller_ledger
// surcharge mechanism — a business
// owner connects their OWN Whop account here (a normal Whop API key from their own dashboard,
// generally available, no invite required), the agent reads it read-only via mcp-connector, and
// revenue-tracker bills Naelao's configured cut % on the builder's NEXT platform subscription.
// The existing /connectors/* routes on the agents worker already implement the store-credential +
// register-mcp-server logic (dashboard's Connectors console has used them since that build) but
// only check `requireVerifiedTenant` — no per-space ownership check at all, which is fine for a
// builder (their JWT's tenant owns every one of their own spaces) but NOT safe to open to an end
// user directly, whose session tenant is the PRODUCT's owning tenant spanning every business under
// it. This wrapper adds the missing requireSpaceMembership check, then proxies to the
// already-tested agents-worker logic with the space's own owning tenant (not the caller's raw
// claims), using the verified tenant and internal-token boundary.
// F-33-class trap (documented repeatedly in this file): a NEW dynamic path segment shape can
// silently corrupt Hono's RegExpRouter compilation for UNRELATED routes elsewhere in this
// 170+-route file. A `/spaces/:spaceId/connectors/:platform/connect` shape reproduced exactly
// that corruption (members/agent-definitions/sessions routes started 404ing in the full suite,
// not this route itself) — fixed the established way: remove the extra dynamic segment rather
// than add a second `app.use(dynamicPattern, ...)` registration. `platform` moves to the request
// body; only "whop" is supported today anyway.
app.use("/spaces/:spaceId/connectors/*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/connectors/status", requireSpaceMembership({ GET: "member" }));
// §A1.18: the floor is now "member", not "admin" — a scope_model='user' connector (a member's
// OWN personal account, see catalogue.ts's own header) should need no more than membership to
// connect. The admin requirement for a scope_model='space' connector is enforced downstream, in
// the agents worker's own connect handler, which is the one place that actually knows a given
// platform's scope_model — see the x-naelao-space-role forwarding below. Only the GATE moved;
// no new route or route-shape changed, so this isn't the class of change that's previously
// triggered this file's documented Hono route-table corruption (items 40/52/60 were all about
// adding a NEW dynamic-segment-then-static-suffix route, not loosening an existing gate).
app.use("/spaces/:spaceId/connectors/connect", requireSpaceMembership({ POST: "member" }));

// Generic authenticated proxy to the agents worker (connectors) — mints a real internal token
// for the Space's owning tenant.
async function proxyToAgentsWorker(
  c: { env: Env; req: { header: (n: string) => string | undefined } },
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  if (!c.env.AGENTS_WORKER) {
    return Response.json({ error_code: "connectors_unavailable", message: "Agents worker not configured" }, { status: 503 });
  }
  const identity = getCallerIdentity(c);
  // Prefer the already-verified header set by the
  // router/requireSpaceMembership chain (the space's OWNING tenant), never the raw caller
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
app.use("/spaces/:spaceId/connectors/directory", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/connectors/directory", async (c) => {
  const params = new URLSearchParams();
  const q = c.req.query("q");
  const cursor = c.req.query("cursor");
  const limit = c.req.query("limit");
  const sort = c.req.query("sort");
  params.set("space_id", c.req.param("spaceId"));
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", limit);
  if (sort) params.set("sort", sort);
  const qs = params.toString();
  return proxyToAgentsWorker(c, `/connectors/directory${qs ? `?${qs}` : ""}`, "GET");
});

// Step 28: business-wide BYOK LLM keys (AI Studio / Groq). GET member (see which providers are
// wired), PUT admin (store the business's own key), DELETE admin (remove it). Same wrapper pattern
// as connectors above — identity/business-role gate here, the agents worker holds the credential
// vault and the requireVerifiedTenant floor. `/llm-byok` and `/llm-byok/:provider` are a static
// collection + a single dynamic leaf (the /members(/:userId) shape), never the corrupting
// dynamic-then-static shape. The KEY is never returned by GET — the agents route projects
// configured:boolean only.
app.use("/spaces/:spaceId/llm-byok", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok", requireSpaceMembership({ GET: "member", PUT: "admin" }));
app.use("/spaces/:spaceId/llm-byok/models", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/models", requireSpaceMembership({ GET: "member" }));
app.use("/spaces/:spaceId/llm-byok/select", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/select", requireSpaceMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/llm-byok/remove", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/remove", requireSpaceMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/llm-byok/:provider", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/:provider", requireSpaceMembership({ DELETE: "admin" }));

app.get("/spaces/:spaceId/llm-byok", async (c) =>
  proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok`, "GET")
);
app.get("/spaces/:spaceId/llm-byok/models", async (c) =>
  proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok/models`, "GET")
);
app.put("/spaces/:spaceId/llm-byok", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok`, "PUT", body);
});

app.get("/spaces/:spaceId/projects/:projectId/mode", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/mode`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/projects/:projectId/subspace-migration-preflight", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/subspace-migration-preflight`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

async function authorizeDepartmentMember(
  stub: ReturnType<Env["SPACE_DO"]["get"]>, userId: string, subspaceId: string, action: "read" | "manage"
): Promise<{ permitted: boolean; role: string }> {
  const response = await forwardToSpaceDO(stub,
    `/hierarchy-authorize?user_id=${encodeURIComponent(userId)}&target_space_id=${encodeURIComponent(subspaceId)}&action=${action}`, "GET");
  const result = await response.json<{ permitted?: boolean; role?: string }>().catch(() => ({} as { permitted?: boolean; role?: string }));
  return { permitted: response.ok && result.permitted === true, role: result.role ?? "" };
}

for (const action of ["graduate-to-subspace", "return-to-parent"] as const) {
  app.post(`/spaces/:spaceId/projects/:projectId/${action}`, async (c) => {
    const { spaceId, projectId } = c.req.param();
    const { tenantId, userId } = getCallerIdentity(c);
    if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
    const stub = await spaceDoStub(c.env, spaceId, tenantId);
    const authorization = await authorizeDepartmentMember(stub, userId, spaceId, "manage");
    if (!authorization.permitted) return c.json({ error_code: "forbidden", message: "Root space owner or admin role required" }, 403);
    const supplied = await c.req.json<{ name?: string; settings?: Record<string, unknown> }>().catch(() => ({} as { name?: string; settings?: Record<string, unknown> }));
    const response = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/${action}`, "POST",
      JSON.stringify({ ...supplied, actor_id: userId, tenant_id: tenantId }));
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  });
}

app.get("/spaces/:spaceId/projects/:projectId/sub-spaces", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const denied = await requireReadableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, spaceId, "read")).permitted)
    return c.json({ error_code: "forbidden" }, 403);
  return forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/sub-spaces`, "GET");
});

app.post("/spaces/:spaceId/projects/:projectId/sub-spaces", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, spaceId, "manage")).permitted)
    return c.json({ error_code: "forbidden" }, 403);
  const body = await c.req.json<{ subspace_id?: string }>().catch(() => ({} as { subspace_id?: string }));
  if (!body.subspace_id) return c.json({ error_code: "subspace_required" }, 400);
  if (!(await authorizeDepartmentMember(stub, userId, body.subspace_id, "manage")).permitted)
    return c.json({ error_code: "forbidden", message: "Department management permission required" }, 403);
  return forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/sub-spaces`, "POST",
    JSON.stringify({ subspace_id: body.subspace_id, actor_id: userId }));
});

app.delete("/spaces/:spaceId/projects/:projectId/sub-spaces/:subId", async (c) => {
  const { spaceId, projectId, subId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, spaceId, "manage")).permitted ||
      !(await authorizeDepartmentMember(stub, userId, subId, "manage")).permitted)
    return c.json({ error_code: "forbidden" }, 403);
  return forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/sub-spaces/${encodeURIComponent(subId)}`, "DELETE",
    JSON.stringify({ actor_id: userId, tenant_id: tenantId }));
});

app.get("/spaces/:spaceId/sub-spaces/:subId/projects", async (c) => {
  const { spaceId, subId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const authorization = await authorizeDepartmentMember(stub, userId, subId, "read");
  if (!authorization.permitted) return c.json({ error_code: "forbidden" }, 403);
  const query = new URLSearchParams({ space_id: spaceId, subspace_id: subId, viewer_id: userId });
  if (authorization.role === "owner" || authorization.role === "admin") query.set("space_manager", "1");
  return forwardToSpaceDO(stub, `/projects?${query}`, "GET");
});

app.post("/spaces/:spaceId/sub-spaces/:subId/projects", async (c) => {
  const { spaceId, subId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const authorization = await authorizeDepartmentMember(stub, userId, subId, "read");
  if (!authorization.permitted || authorization.role === "viewer") return c.json({ error_code: "forbidden" }, 403);
  const supplied = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const response = await forwardToSpaceDO(stub, "/projects", "POST", JSON.stringify({
    ...supplied, space_id: spaceId, subspace_id: subId, tenant_id: tenantId, created_by: userId, system_caller: false,
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.get("/spaces/:spaceId/sub-spaces/:subId/members", async (c) => {
  const { spaceId, subId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, subId, "read")).permitted) return c.json({ error_code: "forbidden" }, 403);
  return forwardToSpaceDO(stub, `/members?space_id=${encodeURIComponent(subId)}`, "GET");
});

app.post("/spaces/:spaceId/sub-spaces/:subId/members", async (c) => {
  const { spaceId, subId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, subId, "manage")).permitted) return c.json({ error_code: "forbidden" }, 403);
  const body = await c.req.json<{ user_id?: string; role?: string }>().catch(() => ({} as { user_id?: string; role?: string }));
  if (!body.user_id || !["owner", "admin", "editor", "member", "viewer"].includes(body.role ?? "")) return c.json({ error_code: "bad_request", message: "user_id and a valid member role are required" }, 400);
  const response = await forwardToSpaceDO(stub, "/members", "POST", JSON.stringify({ ...body, space_id: subId }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.delete("/spaces/:spaceId/sub-spaces/:subId/members/:userId", async (c) => {
  const { spaceId, subId, userId: targetUserId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, subId, "manage")).permitted) return c.json({ error_code: "forbidden" }, 403);
  const response = await forwardToSpaceDO(stub, `/members/${encodeURIComponent(targetUserId)}?space_id=${encodeURIComponent(subId)}`, "DELETE");
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.post("/spaces/:spaceId/projects/:projectId/promote", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/promote`, "POST",
    JSON.stringify({ promoted_by: identity.userId || null, tenant_id: tenantId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.post("/spaces/:spaceId/llm-byok/select", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok/select`, "POST", body);
});
app.post("/spaces/:spaceId/llm-byok/remove", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  return proxyToAgentsWorker(c, `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok/remove`, "POST", body);
});
app.delete("/spaces/:spaceId/llm-byok/:provider", async (c) =>
  proxyToAgentsWorker(
    c,
    `/spaces/${encodeURIComponent(c.req.param("spaceId"))}/llm-byok/${encodeURIComponent(c.req.param("provider"))}`,
    "DELETE",
  )
);

app.post("/spaces/:spaceId/connectors/connect", async (c) => {
  const body = await c.req.json<{ platform?: string; api_key?: string }>().catch(() => ({}) as Record<string, never>);
  const platform = body.platform ?? "";
  if (!platform) return c.json({ error_code: "bad_request", message: "platform is required" }, 400);
  // §A1.18: the gate above only enforces "member" — the agents worker's own connect handler
  // makes the real admin-vs-any-member decision per the PLATFORM's scope_model, which only it
  // knows. It needs this caller's actual BUSINESS role to do that, which for a product_end_user
  // is a resolved value from the generic Space membership table, not the raw
  // "product_end_user" JWT role — resolved here, once, and forwarded. Absent for every other
  // caller (a builder's own JWT role isn't a business role and never needs to be): the connect
  // handler treats a missing header as "not an end user, apply today's unchanged behavior".
  const identity = getCallerIdentity(c);
  let spaceRole: string | undefined;
  if (identity.role === "product_end_user" && identity.userId) {
    spaceRole = (await resolveEndUserSpaceRole(c.env.PLATFORM_DB, c.req.param("spaceId"), identity.userId)) ?? undefined;
  }
  return proxyToAgentsWorker(
    c,
    `/connectors/${encodeURIComponent(platform)}/connect`,
    "POST",
    { space_id: c.req.param("spaceId"), api_key: body.api_key },
    spaceRole ? { "x-naelao-space-role": spaceRole } : undefined
  );
});

// "Connect with X" OAuth flow — same admin-only gate as the manual-key connect above, same
// platform-in-body shape (never a URL param) for the same router-corruption reason. Returns
// {authorize_url}; the frontend does a real browser navigation to it (see oauth.ts's header).
app.use("/spaces/:spaceId/connectors/oauth-start", requireSpaceMembership({ POST: "admin" }));
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

// Tenant-provided OAuth apps use the same admin boundary as platform OAuth. Forward credentials
// only to the Agents worker's vault-sealing setup route; they are never echoed to the client.
app.use("/spaces/:spaceId/connectors/custom-oauth-start", requireSpaceMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/connectors/custom-oauth-redirect", requireSpaceMembership({ GET: "admin" }));
app.get("/spaces/:spaceId/connectors/custom-oauth-redirect", async (c) => {
  const id = c.req.query("connector_id") ?? "";
  if (!id) return c.json({ error_code: "bad_request", message: "connector_id is required" }, 400);
  return proxyToAgentsWorker(c, `/connectors/custom-oauth/${encodeURIComponent(id)}/oauth/redirect-uri`, "GET");
});
app.post("/spaces/:spaceId/connectors/custom-oauth-start", async (c) => {
  const body = await c.req.json<{ connector_id?: string; return_url?: string; display_name?: string; client_id?: string; client_secret?: string; authorization_url?: string; token_url?: string; scopes?: string[]; mcp_url?: string }>().catch(() => ({} as Record<string, never>));
  if (!body.connector_id || !body.return_url) return c.json({ error_code: "bad_request", message: "connector_id and return_url are required" }, 400);
  return proxyToAgentsWorker(c, `/connectors/custom-oauth/${encodeURIComponent(body.connector_id)}/oauth/start`, "POST", {
    space_id: c.req.param("spaceId"), return_url: body.return_url, display_name: body.display_name,
    client_id: body.client_id, client_secret: body.client_secret, authorization_url: body.authorization_url,
    token_url: body.token_url, scopes: body.scopes, mcp_url: body.mcp_url,
  });
});

// Composio "click Install" hosted-connect flow (G-1/G-3 growth layer) — same admin-only gate and
// platform-in-body shape as oauth-start above (same router-corruption reasoning: never a dynamic
// :platform URL segment on a spaces-worker route). Returns {connect_url}; the frontend does a real
// browser navigation to it (see composio.ts's header).
app.use("/spaces/:spaceId/connectors/provider-connect-start", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/connectors/provider-connect-start", async (c) => {
  const body = await c.req.json<{ platform?: string; return_url?: string; preferred_provider?: "composio" | "pipedream" }>().catch(() => ({}) as Record<string, never>);
  const platform = body.platform ?? "";
  if (!platform) return c.json({ error_code: "bad_request", message: "platform is required" }, 400);
  if (!body.return_url) return c.json({ error_code: "bad_request", message: "return_url is required" }, 400);
  return proxyToAgentsWorker(c, `/connectors/${encodeURIComponent(platform)}/provider-connect/start`, "POST", {
    space_id: c.req.param("spaceId"),
    return_url: body.return_url,
    ...(body.preferred_provider ? { preferred_provider: body.preferred_provider } : {}),
  });
});

// ── User-configured workers ──────────────────────────────────────────────────
// Workers are all instances of the shared Naelao agent runtime. Their task-specific
// instructions, tools, skills, model policy, and project binding are configured at creation.
app.use("/spaces/:spaceId/agents/custom", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/agents/custom", async (c) => {
  const body = await c.req.json<{
    name?: string; description?: string; instructions?: string; system_prompt?: string;
    prebuilt_scripts?: string[]; approval_mode?: string; auto_approved_actions?: string[];
    project_id?: string; archetype?: string; skills?: string[]; connectors?: string[];
  }>().catch((): { name?: string; description?: string; instructions?: string; system_prompt?: string; prebuilt_scripts?: string[]; approval_mode?: string; auto_approved_actions?: string[]; project_id?: string; archetype?: string; skills?: string[]; connectors?: string[] } => ({}));
  if (!body.name?.trim()) return c.json({ error_code: "bad_request", message: "name is required" }, 400);
  if (!body.instructions?.trim()) return c.json({ error_code: "bad_request", message: "instructions are required" }, 400);
  return proxyToAgentsWorker(c, "/agents/custom", "POST", { space_id: c.req.param("spaceId"), ...body });
});

// Presence (space collaboration, A1.8) — heartbeat: "I'm here" (space-level, or scoped to a
// project/thread). Callers poll GET periodically to see who's currently active. Phase B
// (§A1.17): allowlisted for product_end_user callers on the router — the same membership floor
// as projects/threads above (every other role's access is unchanged).
app.use("/spaces/:spaceId/presence", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/presence", requireSpaceMembership({ GET: "member", POST: "member" }));
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
  const userId = c.req.query("user_id");
  if (userId) qs.set("user_id", userId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/presence?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Event triggers (@naelao/events) — no-code "after X happens (thread created, project
// created, ...), run script Y." Automation is always owned by a project.
app.use("/spaces/:spaceId/event-triggers", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/event-triggers", requireSpaceMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/event-triggers/:triggerId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/event-triggers/:triggerId", requireSpaceMembership({ PATCH: "admin", DELETE: "admin" }));
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
  const body = await c.req.json<{ project_id?: string }>().catch(() => ({} as { project_id?: string }));
  const denied = await requireManageableAutomationProject(c, spaceId, body.project_id);
  if (denied) return denied;
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

app.patch("/spaces/:spaceId/event-triggers/:triggerId", async (c) => {
  const { spaceId, triggerId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const listed = await forwardToSpaceDO(await spaceDoStub(c.env, spaceId, tenantId), `/event-triggers?space_id=${encodeURIComponent(spaceId)}`, "GET");
  const listing = await listed.json<{ data?: Array<{ id?: string; project_id?: string }> }>().catch(() => ({} as { data?: Array<{ id?: string; project_id?: string }> }));
  const trigger = listing.data?.find(row => row.id === triggerId);
  if (!trigger) return c.json({ error_code: "event_trigger_not_found" }, 404);
  const denied = await requireManageableAutomationProject(c, spaceId, trigger.project_id);
  if (denied) return denied;
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => null);
  if (typeof body?.enabled !== "boolean") return c.json({ error_code: "invalid_event_trigger_state" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/event-triggers/${encodeURIComponent(triggerId)}?space_id=${encodeURIComponent(spaceId)}`, "PATCH", JSON.stringify({ enabled: body.enabled, actor_id: userId }));
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
// warns about, so this adds the same resolveEndUserSpaceRole floor every other end-user-
// reachable route in this file already has. POST/PATCH/DELETE were originally un-allowlisted
// entirely — Phase 3 item 27/28's Crons editing UI (below) added requireSpaceMembership's
// admin floor to all three and allowlisted the router for exactly that reason.
/** computeNextRun throws on a malformed cron_expression — create/update already reject one via
 *  validateCronExpression, but a row could in principle predate that check, and a next-run
 *  display bug must never take down the whole Crons list. */
function safeComputeNextRun(cronExpression: string, fromMs: number): number | null {
  try {
    return computeNextRun(cronExpression, fromMs);
  } catch {
    return null;
  }
}

/** Phase 3 item 29: a cron/heartbeat CONFIG change (created/updated/enabled/paused/deleted) is
 *  itself an event worth an agent noticing, exactly like the existing scheduled_job.disabled
 *  auto-disable event (agents worker, recordScheduledJobFailure) already is — a business owner
 *  reconfiguring their own assistant's schedule is real, structural state a no-code trigger
 *  should be able to react to (e.g. "when a cron is paused, tell the assistant why"), the same
 *  precedent thread.created/project.created already set for every other structural mutation.
 *  Reuses the SAME fireMatchingTriggers path via the DO directly (we're already inside this
 *  worker, so no need for the internal-HTTP round trip the agents worker's own caller needs).
 *  Best-effort: never throws, never blocks an already-successful CRUD response on a firing
 *  failure — matches this file's own standing "never fail a successful mutation over a side
 *  effect" convention everywhere else. */
async function fireScheduledJobEvent(
  env: Env,
  spaceId: string,
  tenantId: string,
  type: "scheduled_job.created" | "scheduled_job.updated" | "scheduled_job.enabled" | "scheduled_job.paused" | "scheduled_job.deleted",
  jobId: string,
  projectId: string | null | undefined,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    const stub = await spaceDoStub(env, spaceId, tenantId);
    await forwardToSpaceDO(
      stub,
      `/internal/events/fire?tenant_id=${encodeURIComponent(tenantId)}`,
      "POST",
      JSON.stringify({
        type,
        space_id: spaceId,
        ...(projectId ? { project_id: projectId } : {}),
        occurred_at: Date.now(),
        payload: { scheduled_job_id: jobId, ...(extra ?? {}) },
      })
    );
  } catch (err) {
    console.error(`[scheduled-jobs] failed to fire ${type} for job=${jobId} space=${spaceId}:`, (err as Error).message);
  }
}

// Phase 3 item 27/28's own Crons editing UI needed real write access for a business's own
// admin/owner end user — POST used to forbid every product_end_user outright (WS-2's original
// note below), which left every end-user-created business with no self-serve way to create a
// job at all, only a JWT builder. requireSpaceMembership's admin floor is what makes this
// safe (same precedent as model-config/assistant-policy PATCH): a plain member still can't
// create/edit one, and a caller who isn't a member of THIS business at all is refused before
// reaching the handler. GET keeps its existing member floor, just expressed as middleware
// instead of an inline check so PATCH/DELETE below can share the same convention.
app.use("/spaces/:spaceId/scheduled-jobs", requireSpaceMembership({ GET: "member", POST: "admin" }));
app.get("/spaces/:spaceId/scheduled-jobs", async (c) => {
  const owned = await loadOwnedSpace(c, c.req.param("spaceId"));
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  // The assistant/Home view wants its own space-wide jobs. A project thread gets only its own
  // jobs after project read authorization. An unfiltered dashboard query is intersected with
  // projects visible to this caller; Space membership alone must not expose private schedules.
  const projectId = c.req.query("project_id");
  const scope = c.req.query("scope");
  const spaceId = c.req.param("spaceId");
  let query: D1PreparedStatement;
  if (projectId) {
    const denied = await requireReadableAutomationProject(c, spaceId, projectId);
    if (denied) return denied;
    query = c.env.PLATFORM_DB.prepare(
        `SELECT id, name, cron_expression, script_name, params, project_id, agent_id, goal, enabled, last_run_at,
                quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
                consecutive_failures, last_error, created_at, updated_at
           FROM scheduled_jobs WHERE space_id = ? AND project_id = ? ORDER BY created_at DESC`
      ).bind(spaceId, projectId);
  } else if (scope === "assistant") {
    query = c.env.PLATFORM_DB.prepare(
        `SELECT id, name, cron_expression, script_name, params, project_id, agent_id, goal, enabled, last_run_at,
                quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
                consecutive_failures, last_error, created_at, updated_at
           FROM scheduled_jobs WHERE space_id = ? AND project_id IS NULL ORDER BY created_at DESC`
      ).bind(spaceId);
  } else {
    const visible = await visibleAutomationProjectIds(c, spaceId);
    if (visible instanceof Response) return visible;
    if (visible.length === 0) return c.json({ data: [], count: 0 });
    const placeholders = visible.map(() => "?").join(",");
    query = c.env.PLATFORM_DB.prepare(
        `SELECT id, name, cron_expression, script_name, params, project_id, agent_id, goal, enabled, last_run_at,
                quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
                consecutive_failures, last_error, created_at, updated_at
           FROM scheduled_jobs WHERE space_id = ? AND project_id IN (${placeholders}) ORDER BY created_at DESC`
      ).bind(spaceId, ...visible);
  }
  const { results } = await query.all();
  // Phase 3 item 27/28: when does this job fire next, for the Crons editing UI. Computed here
  // (not stored) so it's always accurate against the CURRENT time and never drifts — a disabled
  // job or a malformed cron_expression (shouldn't exist given create/update validation, but a
  // row could predate it) reports null rather than throwing and losing the whole list.
  const now = Date.now();
  const withNextRun = (results as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    next_run_at: row["enabled"] ? safeComputeNextRun(String(row["cron_expression"]), now) : null,
  }));
  return c.json({ data: withNextRun, count: withNextRun.length });
});

// Read-only deterministic portfolio review signals. Project visibility is resolved by the
// SpaceDO; only those project IDs are used to read routine failure counts from PLATFORM_DB.
app.use("/spaces/:spaceId/project-steward/reviews", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/project-steward/reviews", requireSpaceMembership({ GET: "member" }));
async function applyProjectStewardDecisions(c: any, spaceId: string, tenantId: string, visibleIds: string[], reviews: ProjectStewardReview[]) {
  const placeholders = visibleIds.map(() => "?").join(",");
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT project_id,review_key,action,actor_id,note,snoozed_until,created_at
       FROM project_steward_decisions WHERE tenant_id=? AND space_id=? AND project_id IN (${placeholders})`
  ).bind(tenantId, spaceId, ...visibleIds).all();
  const byKey = new Map((results as Array<Record<string, unknown>>).map(row => [`${row.project_id}:${row.review_key}`, row]));
  const now = Date.now();
  const visible: Array<ProjectStewardReview & { review_key: string; decision?: { action: string; actor_id: string; note: string | null; created_at: number } }> = [];
  for (const review of reviews) {
    if (!review || !["inspect_routine", "review_blocked_work", "inspect_extension_health", "owner_check_in"].includes(review.recommendation)
      || !Array.isArray(review.evidence)) continue;
    const reviewKey = await projectStewardReviewKey(review);
    const row = byKey.get(`${review.project_id}:${reviewKey}`);
    if (row?.action === "dismiss" || row?.action === "snooze" && Number(row.snoozed_until) > now) continue;
    visible.push({ ...review, review_key: reviewKey,
      ...(row?.action === "acknowledge" ? { decision: { action: "acknowledge", actor_id: String(row.actor_id), note: row.note as string | null, created_at: Number(row.created_at) } } : {}) });
  }
  return visible;
}
app.get("/spaces/:spaceId/project-steward/reviews", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const visibleIds = await visibleAutomationProjectIds(c, spaceId);
  if (visibleIds instanceof Response) return visibleIds;
  if (visibleIds.length === 0) return c.json({ data: [], count: 0, generated_at: Date.now() });

  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const projectResponse = await forwardToSpaceDO(stub, `/project-steward-facts?${new URLSearchParams({ space_id: spaceId })}`, "GET");
  if (!projectResponse.ok) return c.json({ error_code: "project_review_unavailable" }, 503);
  const projectPayload = await projectResponse.json<{ data?: Array<{ project_id: string; project_name: string; created_at: string; last_activity_at: string | null; pending_task_count: number; in_progress_task_count: number; blocked_task_count: number; active_extension_count: number }> }>();
  const projects = (projectPayload.data ?? []).filter((project) => visibleIds.includes(project.project_id));
  if (projects.length === 0) return c.json({ data: [], count: 0, generated_at: Date.now() });

  // Prefer the last scheduled Space Project Steward report. Filter it against the caller's
  // current project visibility so membership changes take effect immediately; a report is never
  // itself an authorization grant. Before the first daily run, preserve the live deterministic
  // fallback so the page is useful on a newly created Space.
  const saved = await c.env.PLATFORM_DB.prepare(
    "SELECT report_json FROM project_steward_runs WHERE space_id=? AND report_json IS NOT NULL"
  ).bind(spaceId).first<{ report_json: string }>();
  if (saved?.report_json) {
    try {
      const report = JSON.parse(saved.report_json) as { run_day?: string; generated_at?: number; advisory_only?: boolean; data?: Array<{ project_id: string }> };
      if (report.advisory_only === true && Array.isArray(report.data)) {
        const data = await applyProjectStewardDecisions(c, spaceId, owned.tenantId, visibleIds,
          report.data.filter((item) => visibleIds.includes(item.project_id)) as ProjectStewardReview[]);
        return c.json({ data, count: data.length, generated_at: report.generated_at ?? Date.now(), run_day: report.run_day ?? null, advisory_only: true });
      }
    } catch { /* corrupt historical report: return the live deterministic fallback below */ }
  }

  const placeholders = projects.map(() => "?").join(",");
  const { results: failures } = await c.env.PLATFORM_DB.prepare(
    `SELECT project_id, id, consecutive_failures FROM scheduled_jobs
      WHERE space_id = ? AND project_id IN (${placeholders}) AND consecutive_failures > 0
      ORDER BY consecutive_failures DESC, id`
  ).bind(spaceId, ...projects.map((project) => project.project_id)).all<{ project_id: string; id: string; consecutive_failures: number }>();
  const { results: unhealthyConnections } = await c.env.PLATFORM_DB.prepare(
    `SELECT project_id,COUNT(*) AS count FROM extension_provider_connections
      WHERE tenant_id=? AND space_id=? AND project_id IN (${placeholders}) AND status IN ('expired','error')
      GROUP BY project_id`
  ).bind(owned.tenantId, spaceId, ...projects.map((project) => project.project_id)).all<{ project_id: string; count: number }>();
  const connectionFailuresByProject = new Map(unhealthyConnections.map((row) => [row.project_id, row.count]));
  const failuresByProject = new Map<string, Array<{ id: string; consecutive_failures: number }>>();
  for (const failure of failures) {
    const list = failuresByProject.get(failure.project_id) ?? [];
    list.push({ id: failure.id, consecutive_failures: failure.consecutive_failures });
    failuresByProject.set(failure.project_id, list);
  }
  const facts: ProjectStewardFact[] = projects.map((project) => ({
    project_id: project.project_id,
    project_name: project.project_name,
    last_activity_at: project.last_activity_at,
    created_at: project.created_at,
    failed_routines: failuresByProject.get(project.project_id) ?? [],
    pending_task_count: project.pending_task_count,
    in_progress_task_count: project.in_progress_task_count,
    blocked_task_count: project.blocked_task_count,
    active_extension_count: project.active_extension_count,
    unhealthy_extension_connection_count: connectionFailuresByProject.get(project.project_id) ?? 0,
  }));
  const data = await applyProjectStewardDecisions(c, spaceId, owned.tenantId, visibleIds, rankProjectStewardReviews(facts));
  return c.json({ data, count: data.length, generated_at: Date.now(), advisory_only: true });
});

app.use("/spaces/:spaceId/project-steward/reviews/decision", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/project-steward/reviews/decision", requireSpaceMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/project-steward/reviews/decision", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const body = await c.req.json<{ project_id?: string; review_key?: string; recommendation?: string; action?: string; note?: string }>().catch(() => null);
  if (!body) return c.json({ error_code: "invalid_project_review_decision" }, 400);
  if (!body.project_id || !/^[a-f0-9]{64}$/.test(body.review_key ?? "")
    || !["inspect_routine", "review_blocked_work", "inspect_extension_health", "owner_check_in"].includes(body.recommendation ?? "")
    || !isProjectStewardDecisionAction(body.action)
    || (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 240))) {
    return c.json({ error_code: "invalid_project_review_decision" }, 400);
  }
  const visibleIds = await visibleAutomationProjectIds(c, spaceId);
  if (visibleIds instanceof Response) return visibleIds;
  if (!visibleIds.includes(body.project_id)) return c.json({ error_code: "project_not_visible" }, 404);
  const now = Date.now();
  const decisionId = crypto.randomUUID();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO project_steward_decisions(decision_id,tenant_id,space_id,project_id,review_key,recommendation,action,actor_id,note,snoozed_until,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(space_id,project_id,review_key) DO UPDATE SET recommendation=excluded.recommendation,action=excluded.action,
       actor_id=excluded.actor_id,note=excluded.note,snoozed_until=excluded.snoozed_until,created_at=excluded.created_at`
  ).bind(decisionId, identity.tenantId, spaceId, body.project_id, body.review_key, body.recommendation, body.action, identity.userId,
    body.note?.trim() || null, body.action === "snooze" ? now + 7 * 24 * 60 * 60 * 1000 : null, now).run();
  return c.json({ decision_id: decisionId, project_id: body.project_id, review_key: body.review_key, action: body.action, actor_id: identity.userId, created_at: now });
});

// Typed, read-only grant for the platform-managed Space Project Steward extension. It carries
// project portfolio metadata and routine failure counts only; no files, message content, members,
// lifecycle mutation methods, or general planner tools are exposed through this grant.
app.use("/internal/spaces/:spaceId/project-steward/summary", requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.get("/internal/spaces/:spaceId/project-steward/summary", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const active = await c.env.PLATFORM_DB.prepare(
    `SELECT s.id FROM spaces s WHERE s.id=? AND s.tenant_id=? AND s.status='active'
     AND EXISTS (SELECT 1 FROM orgs o WHERE o.id=s.tenant_id AND o.status='active')`,
  ).bind(spaceId, owned.tenantId).first<{ id: string }>();
  if (!active) return c.json({ error_code: "tenant_suspended" }, 403);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const projectResponse = await forwardToSpaceDO(stub, `/project-steward-facts?${new URLSearchParams({ space_id: spaceId })}`, "GET");
  if (!projectResponse.ok) return c.json({ error_code: "project_review_unavailable" }, 503);
  const payload = await projectResponse.json<{ data?: Array<{ project_id: string; project_name: string; created_at: string; last_activity_at: string | null; pending_task_count: number; in_progress_task_count: number; blocked_task_count: number; active_extension_count: number }> }>();
  const projects = payload.data ?? [];
  if (!projects.length) return c.json({ grant: "space.project_steward.read_summary.v1", data: [], generated_at: Date.now() });
  const placeholders = projects.map(() => "?").join(",");
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT project_id, id, consecutive_failures FROM scheduled_jobs
      WHERE space_id=? AND project_id IN (${placeholders}) AND consecutive_failures>0 ORDER BY project_id,id`
  ).bind(spaceId, ...projects.map((project) => project.project_id)).all<{ project_id: string; id: string; consecutive_failures: number }>();
  const { results: unhealthyConnections } = await c.env.PLATFORM_DB.prepare(
    `SELECT project_id,COUNT(*) AS count FROM extension_provider_connections
      WHERE tenant_id=? AND space_id=? AND project_id IN (${placeholders}) AND status IN ('expired','error')
      GROUP BY project_id`
  ).bind(owned.tenantId, spaceId, ...projects.map((project) => project.project_id)).all<{ project_id: string; count: number }>();
  const connectionFailuresByProject = new Map(unhealthyConnections.map((row) => [row.project_id, row.count]));
  const failures = new Map<string, Array<{ routine_id: string; consecutive_failures: number }>>();
  for (const row of results) {
    const current = failures.get(row.project_id) ?? [];
    current.push({ routine_id: row.id, consecutive_failures: row.consecutive_failures });
    failures.set(row.project_id, current);
  }
  return c.json({ grant: "space.project_steward.read_summary.v1", generated_at: Date.now(), data: projects.map((project) => ({
    project_id: project.project_id, project_name: project.project_name, created_at: project.created_at,
    last_activity_at: project.last_activity_at, failed_routines: failures.get(project.project_id) ?? [],
    pending_task_count: project.pending_task_count, in_progress_task_count: project.in_progress_task_count,
    blocked_task_count: project.blocked_task_count, active_extension_count: project.active_extension_count,
    unhealthy_extension_connection_count: connectionFailuresByProject.get(project.project_id) ?? 0,
  })) });
});

// Idempotently provision the platform-owned Space-wide Steward through the same SpaceDO
// installation lifecycle used by other extensions. Its manifest declares no executable
// primitives or broad permissions; the scheduler's separately authenticated typed summary
// grant is its only data capability.
app.use("/internal/spaces/:spaceId/project-steward/installation", requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.post("/internal/spaces/:spaceId/project-steward/installation", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const active = await c.env.PLATFORM_DB.prepare(
    `SELECT s.id FROM spaces s WHERE s.id=? AND s.tenant_id=? AND s.status='active'
     AND EXISTS (SELECT 1 FROM orgs o WHERE o.id=s.tenant_id AND o.status='active')`,
  ).bind(spaceId, owned.tenantId).first<{ id: string }>();
  if (!active) return c.json({ error_code: "tenant_suspended" }, 403);
  const manifest = validateExtensionManifest(PROJECT_STEWARD_EXTENSION_MANIFEST, {
    gatekeeperCapabilities: ["space.project_steward.read_summary"],
  });
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  const response = await stub.fetch(new Request("http://space-do/extensions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: "naelao-platform", tenantId: owned.tenantId, spaceId,
      scope: "SPACE_SHARED", gatekeeperCapabilities: ["space.project_steward.read_summary"] }),
  }));
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  const result = await response.json<{ installationId?: string }>();
  if (!result.installationId) return c.json({ error_code: "project_steward_installation_id_missing" }, 503);
  return c.json({ extension_id: manifest.id, installation_id: result.installationId, scope: "SPACE_SHARED", platform_managed: true });
});

// Scheduler fence for queued project routines: SpaceDO remains the authority for project
// lifecycle, and this narrowly scoped internal lookup lets a redelivered job re-check it before
// invoking either a planner or direct script.
app.use("/internal/project-lifecycle", requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.get("/internal/project-lifecycle", async (c) => {
  const spaceId = c.req.query("space_id") ?? "";
  const projectId = c.req.query("project_id") ?? "";
  if (!spaceId || !projectId) return c.json({ error_code: "project_scope_required" }, 400);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return forwardToSpaceDO(stub, `/project-lifecycle?${new URLSearchParams({ space_id: spaceId, project_id: projectId })}`, "GET");
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
    project_id: string;
    /** Which agent's own R2 config (system prompt, approval gates) to wake. Omitted = the
     *  Space Assistant ("naelao-agent"), same as before this field existed. */
    agent_id?: string;
    /** When set, the dispatcher wakes the full reasoning loop with this goal instead of
     *  firing script_name directly (see infra/migrations/0043). */
    goal?: string;
    quiet_hours_start?: string | null;
    quiet_hours_end?: string | null;
    quiet_hours_timezone?: string;
  }>().catch(() => ({}) as Record<string, never>);
  if (!body.name || !body.project_id || !body.cron_expression || (!body.script_name && !body.goal)) {
    return c.json({ error_code: "bad_request", message: "name, project_id, cron_expression, and either script_name or goal are required" }, 400);
  }
  const denied = await requireManageableAutomationProject(c, spaceId, body.project_id);
  if (denied) return denied;
  const cronError = validateCronExpression(body.cron_expression);
  if (cronError) return c.json({ error_code: "bad_request", message: `Invalid cron_expression: ${cronError}` }, 400);
  const quietHoursError = validateScheduledQuietHours({ start: body.quiet_hours_start, end: body.quiet_hours_end, timeZone: body.quiet_hours_timezone ?? "UTC" });
  if (quietHoursError) return c.json({ error_code: "bad_request", message: quietHoursError }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO scheduled_jobs (id, space_id, tenant_id, project_id, name, cron_expression, script_name, params, agent_id, goal, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(
    id, spaceId, owned.tenantId, body.project_id, body.name, body.cron_expression,
    body.script_name ?? "", JSON.stringify(body.params ?? {}), body.agent_id ?? null, body.goal ?? null,
    body.quiet_hours_start || null, body.quiet_hours_end || null, body.quiet_hours_timezone ?? "UTC", now, now
  ).run();

  await fireScheduledJobEvent(c.env, spaceId, owned.tenantId, "scheduled_job.created", id, body.project_id, {
    name: body.name,
    cron_expression: body.cron_expression,
  });

  return c.json({
    id, name: body.name, cron_expression: body.cron_expression, script_name: body.script_name ?? "",
    quiet_hours_start: body.quiet_hours_start || null, quiet_hours_end: body.quiet_hours_end || null, quiet_hours_timezone: body.quiet_hours_timezone ?? "UTC",
    project_id: body.project_id, agent_id: body.agent_id ?? null, goal: body.goal ?? null,
    enabled: true, last_run_at: null, created_at: now,
  }, 201);
});

// Same admin floor as POST above — a plain business member can view crons but not edit or
// remove one; a business admin/owner end user genuinely can, mirroring model-config/
// assistant-policy PATCH's own precedent for "an end-user-created business's own admin IS its
// owner." No GET is registered on this path (single-job reads don't exist, only the list), so
// only PATCH/DELETE need a floor here.
app.use("/spaces/:spaceId/scheduled-jobs/:jobId", requireSpaceMembership({ PATCH: "admin", DELETE: "admin" }));
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
    quiet_hours_start?: string | null;
    quiet_hours_end?: string | null;
    quiet_hours_timezone?: string;
    enabled?: boolean;
  }>().catch(() => ({}) as Record<string, never>);

  if (body.cron_expression !== undefined) {
    const cronError = validateCronExpression(body.cron_expression);
    if (cronError) return c.json({ error_code: "bad_request", message: `Invalid cron_expression: ${cronError}` }, 400);
  }

  // Needed only for the fired event's project scoping — the UPDATE below can't change project_id
  // (there's no such field on this route), so a plain read-before-write is fine for an
  // admin-only, low-frequency write, unlike a hot path that would want this folded into one query.
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT project_id, quiet_hours_start, quiet_hours_end, quiet_hours_timezone FROM scheduled_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(jobId, spaceId, owned.tenantId).first<{ project_id: string | null; quiet_hours_start: string | null; quiet_hours_end: string | null; quiet_hours_timezone: string }>();
  const quietHoursError = validateScheduledQuietHours({
    start: body.quiet_hours_start === undefined ? existing?.quiet_hours_start : body.quiet_hours_start,
    end: body.quiet_hours_end === undefined ? existing?.quiet_hours_end : body.quiet_hours_end,
    timeZone: body.quiet_hours_timezone ?? existing?.quiet_hours_timezone ?? "UTC",
  });
  if (quietHoursError) return c.json({ error_code: "bad_request", message: quietHoursError }, 400);

  const now = new Date().toISOString();
  const res = await c.env.PLATFORM_DB.prepare(
    `UPDATE scheduled_jobs SET
       name = COALESCE(?, name),
       cron_expression = COALESCE(?, cron_expression),
       script_name = COALESCE(?, script_name),
       params = COALESCE(?, params),
       agent_id = COALESCE(?, agent_id),
       goal = COALESCE(?, goal),
       quiet_hours_start = COALESCE(?, quiet_hours_start),
       quiet_hours_end = COALESCE(?, quiet_hours_end),
       quiet_hours_timezone = COALESCE(?, quiet_hours_timezone),
       enabled = COALESCE(?, enabled),
       updated_at = ?
     WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(
    body.name ?? null, body.cron_expression ?? null, body.script_name ?? null,
    body.params !== undefined ? JSON.stringify(body.params) : null,
    body.agent_id ?? null, body.goal ?? null,
    body.quiet_hours_start === undefined ? null : (body.quiet_hours_start || ""),
    body.quiet_hours_end === undefined ? null : (body.quiet_hours_end || ""), body.quiet_hours_timezone ?? null,
    body.enabled === undefined ? null : (body.enabled ? 1 : 0),
    now, jobId, spaceId, owned.tenantId
  ).run();

  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Scheduled job not found" }, 404);

  // A pure enable/pause toggle (the shell's own toggleScheduledJob helper sends ONLY {enabled})
  // gets its own, more specific event than a content edit — a no-code trigger reacting to "this
  // was paused" shouldn't also have to distinguish that from "the goal text changed".
  const eventType = body.enabled !== undefined ? (body.enabled ? "scheduled_job.enabled" : "scheduled_job.paused") : "scheduled_job.updated";
  await fireScheduledJobEvent(c.env, spaceId, owned.tenantId, eventType, jobId, existing?.project_id ?? null);

  return c.json({ id: jobId, updated_at: now });
});

app.delete("/spaces/:spaceId/scheduled-jobs/:jobId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const jobId = c.req.param("jobId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  // Needed for the fired event's project scoping — read before delete, since the row (and its
  // project_id) is gone the moment the DELETE below succeeds.
  const existing = await c.env.PLATFORM_DB.prepare(
    "SELECT project_id FROM scheduled_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(jobId, spaceId, owned.tenantId).first<{ project_id: string | null }>();
  const res = await c.env.PLATFORM_DB.prepare(
    "DELETE FROM scheduled_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(jobId, spaceId, owned.tenantId).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "Scheduled job not found" }, 404);
  await fireScheduledJobEvent(c.env, spaceId, owned.tenantId, "scheduled_job.deleted", jobId, existing?.project_id ?? null);
  return c.json({ deleted: true, id: jobId });
});

// GET /spaces/:spaceId/scheduled-job-runs?job_id=X — recent fires for a scheduled job (migration
// 0071). Deliberately a FLAT sibling of /scheduled-jobs, `job_id` in the query string, not
// nested under the existing dynamic /scheduled-jobs/:jobId route — a dynamic segment followed by
// a static suffix (":jobId/runs") is exactly the shape that has repeatedly corrupted this
// codebase's Hono route tables (items 40/52/60), and this file already carries one dynamic
// segment there (PATCH/DELETE above); a second static suffix under it is not worth that risk for
// a read endpoint. Same auth floor as GET /scheduled-jobs directly above it — a
// product_end_user viewing their own business's Crons panel needs to see its history too.
app.get("/spaces/:spaceId/scheduled-job-runs", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const callerIdentity = getCallerIdentity(c);
  if (callerIdentity.role === "product_end_user") {
    const role = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, callerIdentity.userId);
    if (!role) return c.json({ error_code: "forbidden", message: "Not a member of this business" }, 403);
  }
  const jobId = c.req.query("job_id");
  if (!jobId) return c.json({ error_code: "bad_request", message: "job_id is required" }, 400);
  const job = await c.env.PLATFORM_DB.prepare(
    "SELECT project_id FROM scheduled_jobs WHERE id = ? AND space_id = ? AND tenant_id = ?"
  ).bind(jobId, spaceId, owned.tenantId).first<{ project_id: string }>();
  if (!job) return c.json({ error_code: "not_found", message: "Scheduled job not found" }, 404);
  const denied = await requireReadableAutomationProject(c, spaceId, job.project_id);
  if (denied) return denied;
  const limitParam = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
  const { results } = await c.env.PLATFORM_DB.prepare(
    `SELECT id, fired_at, ok, error, duration_ms, skipped_busy FROM scheduled_job_runs
       WHERE job_id = ? AND space_id = ? ORDER BY fired_at DESC LIMIT ?`
  ).bind(jobId, spaceId, limit).all();
  return c.json({ data: results, count: results.length });
});

// Space Assistant approval policy — "same access as the owning user, ask first unless the
// user has trusted this action." WS-2: GET is reachable by a product_end_user viewing their own
// Space Assistant's Status panel (which permissions the assistant currently has) — gated by the
// same resolveEndUserSpaceRole floor every other end-user-reachable route uses. PATCH used to
// be blocked outright for every product_end_user, on the theory that only a JWT builder could
// ever be "the owner" — but on a Launchpad business an end user with admin role on their OWN
// business genuinely IS its owner (§A1.18/item 79: an end-user-created business needs the SAME
// guided/autonomous toggle a dashboard-created one already has, or "does everything on the
// user's behalf in yolo mode" has no real control surface for the person who actually runs the
// business). requireSpaceMembership's admin floor is what makes this safe: a plain member
// still cannot change it, and a caller who isn't a member of THIS business at all is refused
// before reaching here — same precedent as local-grants/pricing's own admin-gated writes. A
// builder JWT caller (role !== "product_end_user") is untouched, exactly as before.
app.use("/spaces/:spaceId/assistant-policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/assistant-policy", requireSpaceMembership({ GET: "member", PATCH: "admin" }));
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
app.use("/spaces/:spaceId/model-config", requireSpaceMembership({ PATCH: "admin" }));
app.patch("/spaces/:spaceId/model-config", async (c) => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);

  const body = await c.req.json<{ model?: string; effort?: string }>().catch(() => ({}) as { model?: string; effort?: string });
  const isCustomModel = Boolean(body.model?.startsWith("custom/"));
  if (!body.model || (!isCustomModel && !isAllowedModel(body.model))) {
    return c.json({ error_code: "bad_request", message: `model must be one of ${ALLOWED_MODELS.join(", ")}` }, 400);
  }
  if (isCustomModel) {
    if (airGappedOnlyFromConfig(owned.configJson)) return c.json({ error_code: "compliance_violation", message: "Air-gapped spaces cannot select Workers AI adapters" }, 403);
    const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
    const lifecycleResponse = await stub.fetch(new Request(`http://space/custom-models/${encodeURIComponent(body.model!)}/lifecycle?space_id=${encodeURIComponent(spaceId)}`, {
      headers: await spaceModelInternalHeaders(c.env.PLATFORM_SECRET, owned.tenantId),
    }));

    if (!lifecycleResponse.ok) return c.json({ error_code: "adapter_lifecycle_unavailable" }, 503);
    const lifecycle = await lifecycleResponse.json<{ status?: string }>();
    if (lifecycle.status !== "active") return c.json({ error_code: "adapter_not_active", message: "Complete consent, import, evaluation, and owner approval before selecting this adapter" }, 409);
    if (body.effort) return c.json({ error_code: "unsupported_effort", message: "Private adapters do not declare a verified reasoning-effort contract" }, 400);
  }
  if (body.effort && !isValidEffortLevel(body.model, body.effort)) {
    return c.json({ error_code: "bad_request", message: `effort '${body.effort}' is not offered by model '${body.model}'` }, 400);
  }

  let config: { productConfig?: Partial<SpaceTypeProductConfig> } & Record<string, unknown> = {};
  if (owned.configJson) {
    try { config = JSON.parse(owned.configJson); } catch { /* start clean on malformed */ }
  }
  config.productConfig = {
    ...(config.productConfig ?? {}),
    modelConfig: { model: body.model, ...(body.effort ? { effort: body.effort } : {}) },
  };
  await c.env.PLATFORM_DB.prepare(
    "UPDATE spaces SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).bind(JSON.stringify(config), new Date().toISOString(), spaceId, owned.tenantId).run();

  return c.json({ model: body.model, ...(body.effort ? { effort: body.effort } : {}) });
});

// Agent runs use this host endpoint to enforce the SpaceDO daily budget.
app.use("/internal/user-budget/debit", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/user-budget/debit", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const body = await c.req.json<{ space_id?: string; user_id?: string; credits?: number }>();
  if (!tenantId || !body.space_id || !body.user_id || !Number.isFinite(body.credits) || body.credits! < 0) return c.json({ error_code: "bad_request" }, 400);
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT s.id FROM spaces s JOIN orgs o ON o.id = s.tenant_id WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active' AND o.status = 'active'",
  ).bind(body.space_id, tenantId).first<{ id: string }>();
  if (!space) return c.json({ error_code: "not_found" }, 404);
  const stub = await spaceDoStub(c.env, body.space_id, tenantId);
  return forwardToSpaceDO(stub, "/internal/user-budget/debit", "POST", JSON.stringify({ space_id: body.space_id, user_id: body.user_id, credits: body.credits }));
});

// Internal read used by NaelaoAgentDO's final model gate. Public callers are checked at
// /agent/run, but scheduled/channel/worker dispatches can enter the DO directly; keeping this
// lookup behind the platform HMAC makes the DO's policy decision independent of its ingress.
app.use("/internal/spaces/:spaceId/model-policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/model-policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT config_json, product_id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(spaceId, tenantId).first<{ config_json: string | null; product_id: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  let policy: SpaceModelPolicy | null = null;
  try {
    const localConfig = JSON.parse(row.config_json || "{}") as {
      model_policy?: { mode?: string; allowedModelIds?: unknown };
      productConfig?: { modelPolicy?: { mode?: string; allowedModelIds?: unknown } };
    };
    const productId = row.product_id;
    const productRow = productId
      ? await c.env.PLATFORM_DB.prepare("SELECT config_json FROM products WHERE id = ? AND tenant_id = ? AND status = 'active'").bind(productId, tenantId).first<{ config_json: string | null }>()
      : row;
    const productConfig = JSON.parse(productRow?.config_json || "{}") as {
      productConfig?: { modelPolicy?: { mode?: string; allowedModelIds?: unknown }; workerModelPool?: { modelIds?: unknown; modelsByPlan?: Record<string, unknown>; selectionMode?: unknown; inputUsdPerMillion?: unknown; outputUsdPerMillion?: unknown } };
    };
    const candidate = localConfig.model_policy ?? localConfig.productConfig?.modelPolicy ?? productConfig.productConfig?.modelPolicy;
    const workerPool = productConfig.productConfig?.workerModelPool;
    const configuredModels = workerPool?.modelIds;
    if (candidate?.mode === "open" || candidate?.mode === "whitelist_only" || workerPool) {
      policy = {
        mode: candidate?.mode === "whitelist_only" ? "whitelist_only" : "open",
        allowedModelIds: candidate && Array.isArray(candidate.allowedModelIds)
          ? candidate.allowedModelIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [],
        ...(Array.isArray(configuredModels) ? { workerModelIds: configuredModels.filter((id): id is string => typeof id === "string" && /^openrouter\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)
          && (candidate?.mode !== "whitelist_only" || (candidate && Array.isArray(candidate.allowedModelIds) && candidate.allowedModelIds.includes(id)))).slice(0, 100) } : {}),
        workerSelectionMode: workerPool?.selectionMode === "planner" ? "planner" : "automatic",
        ...(workerPool ? { workerModelPriceCeiling: {
          ...(typeof workerPool.inputUsdPerMillion === "number" && Number.isFinite(workerPool.inputUsdPerMillion) ? { inputUsdPerMillion: workerPool.inputUsdPerMillion } : {}),
          ...(typeof workerPool.outputUsdPerMillion === "number" && Number.isFinite(workerPool.outputUsdPerMillion) ? { outputUsdPerMillion: workerPool.outputUsdPerMillion } : {}),
        } } : {}),
      };
    }
  } catch {
    // A malformed config has no usable model policy; the agents worker applies its existing
    // conservative compliance handling for air-gap state separately.
  }
  return c.json({ policy });
});

// ── Builder observability surface (security audit follow-up) ────────────────
// A builder had no consolidated view of what their agent has actually been doing — run
// history, cost, why it escalated. NaelaoAgentDO posts one row per run completion/failure and
// per approval request/resolution to POST /internal/spaces/:spaceId/agent-activity (internal
// only — see NaelaoAgentDO.logAgentActivity); GET /spaces/:spaceId/agent-activity is the
// builder-facing read, deliberately builder-only (not requireSpaceMembership like
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

// Space-scoped user preferences. The user id is always derived from verified claims so callers
// can change only their own presentation and detail-filter preferences.
app.use("/spaces/:spaceId/preferences", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/preferences", requireSpaceMembership({ GET: "member", PUT: "member" }));
app.get("/spaces/:spaceId/preferences", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Authenticated Space membership required" }, 401);
  const spaceId = c.req.param("spaceId");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await forwardToSpaceDO(stub, `/spaces/${encodeURIComponent(spaceId)}/users/${encodeURIComponent(userId)}/preferences`, "GET");
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
});
app.put("/spaces/:spaceId/preferences", async (c) => {
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Authenticated Space membership required" }, 401);
  const spaceId = c.req.param("spaceId");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await forwardToSpaceDO(stub, `/spaces/${encodeURIComponent(spaceId)}/users/${encodeURIComponent(userId)}/preferences`, "PUT", c.req.raw.body);
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
});

// ── Notifications inbox ──────────────────────────────────────────────────────
// Unlike agent-activity (builder-only technical audit trail), this IS end-user-facing — a
// business admin reading their own business's inbox — so the public route is
// requireSpaceMembership-gated, not builder-only. Internal-only CREATE (NaelaoAgentDO's
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
app.use("/spaces/:spaceId/notifications", requireSpaceMembership({ GET: "member", POST: "member" }));
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

// Browser Web Push: membership is checked here, then the tenant-scoped internal HMAC protects
// the Notifications Worker storage operation. A user can only enroll/remove their own endpoint.
app.use("/spaces/:spaceId/push-notifications", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/push-notifications", requireSpaceMembership({ GET: "member", PUT: "member", DELETE: "member" }));
app.all("/spaces/:spaceId/push-notifications", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!tenantId || !userId || !c.env.NOTIFICATIONS_WORKER) {
    return c.json({ error_code: "unavailable", message: "Push service or authenticated user unavailable" }, 503);
  }
  const path = c.req.method === "GET" ? "/internal/push/config" : "/internal/push/subscription";
  const token = await mintInternalToken(c.env.PLATFORM_SECRET, tenantId);
  const headers = new Headers({
    "content-type": "application/json",
    "x-naelao-tenant-id": tenantId,
    "x-naelao-user-id": userId,
    "x-naelao-internal-token": token,
  });
  let body: string | undefined;
  if (c.req.method === "PUT" || c.req.method === "DELETE") {
    try {
      body = JSON.stringify(JSON.parse(await readBoundedRequestText(c.req.raw, 16 * 1024)));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return c.json({ error_code: "request_body_too_large" }, 413);
      return c.json({ error_code: "invalid_request_body" }, 400);
    }
  }
  const response = await c.env.NOTIFICATIONS_WORKER.fetch(new Request(`http://notifications-worker${path}`, {
    method: c.req.method, headers, ...(body ? { body } : {}),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
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
// requireSpaceMembership floor at all) — a business admin who owns their own Launchpad
// business had no reachable way to configure a project agent's own approvals, same gap
// assistant-policy itself had before item 79 relaxed it. Same fix, same precedent.
app.use("/spaces/:spaceId/agents/:agentId/policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/agents/:agentId/policy", requireSpaceMembership({ GET: "member", PATCH: "admin" }));
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

// Resolve team-only nbk_ tokens before router middleware checks tenant suspension. The token is
// still scope checked by builder-routes on every request; this endpoint only returns identity.
app.post("/internal/builder-api-keys/verify", async c => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) return c.json({ valid: false }, 403);
  const body = await c.req.json<{ key?: string }>().catch(() => ({} as { key?: string }));
  if (typeof body.key !== "string" || !/^nbk_[a-f0-9]{32}$/.test(body.key)) return c.json({ valid: false }, 400);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.key));
  const keyHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const row = await c.env.PLATFORM_DB.prepare("SELECT tenant_id FROM builder_api_key_index WHERE key_hash=?")
    .bind(keyHash).first<{ tenant_id: string }>();
  if (!row) return c.json({ valid: false });
  const stub = await builderAccountDoStub(c.env, row.tenant_id);
  const response = await stub.fetch(new Request("http://builder-account/api-keys/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: body.key }),
  }));
  const verified = await response.json<{ valid?: boolean; scopes?: string[] }>().catch((): { valid?: boolean; scopes?: string[] } => ({}));
  return verified.valid === true ? c.json({ valid: true, tenant_id: row.tenant_id, scopes: verified.scopes ?? [] }) : c.json({ valid: false });
});

// Threads (spec-canonical). A sub-agent spawn or a channel session mirrors in here as a
// subthread (thread_kind + parent_thread_id) — hidden from the default list unless the
// project's show_sub_threads is on, or the caller passes include_sub_threads=true.
// A1.16.10 (layer-3 backstop, bucket A) gated this builder-only (widget/portal never called it —
// end-user chat transport was /sessions, not /threads). Phase B (§A1.17) changes that: the
// Product Shell's Projects/Threads views need to list/create/read threads directly (distinct
// from the chat transport) — requireSpaceMembership adds the product_end_user floor here the
// same way as the projects routes above; every other role's access is unchanged.
app.use("/spaces/:spaceId/threads", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/threads", requireSpaceMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/threads/:threadId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/threads/:threadId", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/threads", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  if (identity.userId) qs.set("viewer_id", identity.userId);
  else qs.set("space_manager", "1");
  const includeSubThreads = c.req.query("include_sub_threads");
  if (includeSubThreads) qs.set("include_sub_threads", includeSubThreads);
  const includeSystem = c.req.query("include_system");
  if (includeSystem) qs.set("include_system", includeSystem);
  const parentThreadId = c.req.query("parent_thread_id");
  if (parentThreadId) qs.set("parent_thread_id", parentThreadId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/threads?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/threads", async (c) => {
  const spaceId = c.req.param("spaceId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  // tenant_id travels in the body — forwardToSpaceDO doesn't forward headers, and SpaceDO
  // needs it to fire event_triggers (thread.created) via the agents worker.
  const res = await forwardToSpaceDO(stub, "/threads", "POST", JSON.stringify({ ...body, space_id: spaceId, tenant_id: tenantId, ...(identity.userId ? { user_id: identity.userId, created_by: identity.userId } : {}) }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.get("/spaces/:spaceId/threads/:threadId", async (c) => {
  const { spaceId, threadId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URLSearchParams();
  if (identity.userId) qs.set("viewer_id", identity.userId);
  else qs.set("space_manager", "1");
  const res = await forwardToSpaceDO(stub, `/threads/${encodeURIComponent(threadId)}?${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// PATCH /spaces/:spaceId/threads/:threadId — rename and/or archive. There is no hard-delete
// route: `requireSpaceMembership({ GET: "member" })` above already defaults PATCH to
// "admin" for a product_end_user caller (same convention /projects/:projectId's own PATCH
// relies on), so archiving someone else's thread out from under them needs the same privilege
// a rename does.
app.patch("/spaces/:spaceId/threads/:threadId", async (c) => {
  const { spaceId, threadId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await readBoundedRequestText(c.req.raw, 1024 * 1024);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/threads/${encodeURIComponent(threadId)}`, "PATCH", body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── tasks (AVOS plan step 4 — a per-project task DAG, agent-facing via the `tasks` prebuilt) ──
// Same two-gate pattern as /threads above: requireInternalHmac verifies the CALLING WORKER (the
// agents worker's tasks prebuilt mints this via mintInternalToken); requireSpaceMembership
// then checks the ACTING PERSON the agent is running on behalf of (forwarded x-naelao-user-id) —
// a plain member may read/create/progress tasks, same floor as creating a thread.
app.use("/spaces/:spaceId/tasks", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tasks", requireSpaceMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/tasks/:taskId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tasks/:taskId", requireSpaceMembership({ PATCH: "member", DELETE: "member" }));

app.get("/spaces/:spaceId/tasks", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const qs = new URLSearchParams({ space_id: spaceId });
  const projectId = c.req.query("project_id");
  if (projectId) qs.set("project_id", projectId);
  const threadId = c.req.query("thread_id");
  if (threadId) qs.set("thread_id", threadId);
  const status = c.req.query("status");
  if (status) qs.set("status", status);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/tasks?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.post("/spaces/:spaceId/tasks", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/tasks", "POST", JSON.stringify({ ...body, space_id: spaceId }));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.patch("/spaces/:spaceId/tasks/:taskId", async (c) => {
  const { spaceId, taskId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await readBoundedRequestText(c.req.raw, 1024 * 1024);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/tasks/${encodeURIComponent(taskId)}`, "PATCH", body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

app.delete("/spaces/:spaceId/tasks/:taskId", async (c) => {
  const { spaceId, taskId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/tasks/${encodeURIComponent(taskId)}`, "DELETE");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Review cards are scoped shared-workspace artifacts, reached through verified worker identity.
app.use("/spaces/:spaceId/pull-request-cards", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/pull-request-cards", requireSpaceMembership({ GET: "member", POST: "member" }));
app.get("/spaces/:spaceId/pull-request-cards", async c => {
  const spaceId = c.req.param("spaceId"), tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId || !spaceId) return c.json({ error_code: "unauthorized" }, 401);
  const projectId = c.req.query("project_id");
  if (!projectId) return c.json({ error_code: "project_required" }, 400);
  return forwardToSpaceDO(await spaceDoStub(c.env, spaceId, tenantId), `/pull-request-cards?${new URLSearchParams({ space_id: spaceId, project_id: projectId })}`, "GET");
});
app.post("/spaces/:spaceId/pull-request-cards", async c => {
  const spaceId = c.req.param("spaceId"), tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId || !spaceId) return c.json({ error_code: "unauthorized" }, 401);
  const body = await c.req.json<Record<string, unknown>>();
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space-do/pull-request-cards", { method: "POST", headers: c.req.raw.headers,
    body: JSON.stringify({ ...body, space_id: spaceId }) }));
});

// Internal repository merge notifications emitted only after the agents worker has checked the
// acting person's SpaceDO membership. Keep the event route behind a tenant-bound internal token.
app.post("/spaces/:spaceId/workspace-events", async c => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)))
    return c.json({ error_code: "forbidden", message: "internal only" }, 403);
  const body = await c.req.json<{ space_id?: string; project_id?: string; event?: { type?: string } }>().catch(() => ({} as { space_id?: string; project_id?: string; event?: { type?: string } }));
  if (body.space_id !== spaceId || !body.project_id || body.event?.type !== "workspace.merged")
    return c.json({ error_code: "bad_request", message: "space, project and merged event are required" }, 400);
  return forwardToSpaceDO(await spaceDoStub(c.env, spaceId, tenantId), "/workspace-events", "POST", JSON.stringify(body));
});
app.post("/spaces/:spaceId/pull-request-cards/:cardId/status", async c => {
  const { spaceId, cardId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !(await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)))
    return c.json({ error_code: "forbidden", message: "internal only" }, 403);
  const body = await c.req.json<{ project_id?: string; status?: string }>().catch(() => ({} as { project_id?: string; status?: string }));
  if (!body.project_id) return c.json({ error_code: "project_required" }, 400);
  return forwardToSpaceDO(await spaceDoStub(c.env, spaceId, tenantId),
    `/pull-request-cards/${encodeURIComponent(cardId)}/status`, "POST",
    JSON.stringify({ ...body, space_id: spaceId }));
});

// Leasing uses the same worker/person boundary as other task mutations.
app.use("/spaces/:spaceId/tasks/:taskId/lease", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/tasks/:taskId/lease", requireSpaceMembership({ POST: "member" }));
app.post("/spaces/:spaceId/tasks/:taskId/lease", async c => {
  const { spaceId, taskId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId || !spaceId || !taskId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return forwardToSpaceDO(stub, `/tasks/${encodeURIComponent(taskId)}/lease`, "POST", await readBoundedRequestText(c.req.raw, 1024 * 1024));
});

// Product sessions prove identity; membership in the end-user Space grants access to its
// subspaces. Neither product membership nor membership in a sibling Space is sufficient.
for (const route of ["/spaces/:spaceId/sub-spaces", "/spaces/:spaceId/sub-spaces/:subId"]) {
  app.use(route, requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use(route, requireSpaceMembership({ GET: "member", POST: "admin", PATCH: "admin" }));
}

// GET /spaces/:spaceId/sub-spaces — list the end-user Space's local hierarchy.
app.get("/spaces/:spaceId/sub-spaces", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId, userId, role } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/spaces", "GET");
  if (role === "product_end_user" && res.ok) {
    if (!userId) return c.json({ error_code: "unauthorized" }, 401);
    const result = await res.json<{ data?: Array<{ id?: unknown }> }>();
    const visible: Array<{ id?: unknown }> = [];
    for (const item of result.data ?? []) {
      if (typeof item.id === "string" && (await authorizeDepartmentMember(stub, userId, item.id, "read")).permitted) visible.push(item);
    }
    return c.json({ data: visible });
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// POST /spaces/:spaceId/sub-spaces — create a department (in-DO sub-space).
// Gated by the product's userPermissions.canCreateSubSpaces. End-user (non-builder)
// callers always inherit the parent space_type (force_parent_type) and can never pick a type.
app.post("/spaces/:spaceId/sub-spaces", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { tenantId, userId, role } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing authenticated user or tenant" }, 401);

  // Resolve the Space (D1) to apply its optional template policy.
  const parentSpace = await c.env.PLATFORM_DB.prepare(
    "SELECT name, spacetype_id, config_json, tenancy_mode, agency_shell, depth, parent_space_id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ name: string; spacetype_id: string; config_json: string | null; tenancy_mode: string; agency_shell: number; depth: number; parent_space_id: string | null }>();
  if (!parentSpace) throw notFound("Space");
  if (parentSpace.parent_space_id || parentSpace.depth !== 0) {
    return c.json({ error_code: "max_depth_exceeded", message: "Invalid Space hierarchy" }, 400);
  }

  const pc = await loadEffectiveProductConfig(c.env, parentSpace.spacetype_id, parentSpace.config_json);
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

  const parentId = body.parent_id ?? spaceId;
  if (role === "product_end_user" && parentId !== spaceId)
    return c.json({ error_code: "max_depth_exceeded", message: "A subspace cannot have child spaces" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (role === "product_end_user" && (c.env.ENVIRONMENT === "development" || c.env.ENVIRONMENT === "test") &&
      (!c.env.PROVISION_QUEUE || c.env.ENVIRONMENT === "development")) {
    // Local Wrangler can run without a provisioner queue. Repair the same root and owner
    // records that the production provisioner writes, using fresh D1 membership authority.
    const membership = await resolveEndUserSpaceRole(c.env.PLATFORM_DB, spaceId, userId, tenantId);
    if (membership !== "owner" && membership !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const registry = await forwardToSpaceDO(stub, "/spaces", "GET");
    const current = registry.ok ? await registry.json<{ data?: Array<{ id?: string }> }>().catch(() => null) : null;
    if (!current?.data) return c.json({ error_code: "local_space_initialization_unavailable" }, 503);
    if (!current.data.some(entry => entry.id === spaceId)) {
      const initialized = await forwardToSpaceDO(stub, "/spaces", "POST", JSON.stringify({
        id: spaceId, name: parentSpace.name, space_type: parentSpace.spacetype_id,
        tenancy_mode: parentSpace.tenancy_mode, agency_shell: parentSpace.agency_shell === 1,
      }));
      if (!initialized.ok) return c.json({ error_code: "local_space_initialization_unavailable" }, 503);
    }
    const synced = await forwardToSpaceDO(stub, "/members", "POST", JSON.stringify({ space_id: spaceId, user_id: userId, role: membership }));
    if (!synced.ok) return c.json({ error_code: "local_space_initialization_unavailable" }, 503);
  }
  const auth = await forwardToSpaceDO(stub, `/hierarchy-authorize?user_id=${encodeURIComponent(userId)}&target_space_id=${encodeURIComponent(parentId)}`, "GET");
  const authorization = await auth.json<{ permitted?: boolean }>().catch(() => ({} as { permitted?: boolean }));
  if (!auth.ok || authorization.permitted !== true) return c.json({ error_code: "forbidden", message: "Administrative membership is required" }, 403);

  // Builders (owner/admin) may select a type (subject to agency_shell rules in the DO);
  // end-user roles are forced to the parent's type.
  const payload = {
    parent_id: parentId,
    name: body.name,
    scenario_type: "organizational" as const,
    ...(role !== "product_end_user" && body.space_type ? { space_type: body.space_type } : { force_parent_type: true }),
    ...(body.settings ? { settings: body.settings } : {}),
  };

  const res = await forwardToSpaceDO(stub, "/sub-spaces", "POST", JSON.stringify(payload));
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// PATCH /spaces/:spaceId/sub-spaces/:subId — update a department (status/name/settings).
app.patch("/spaces/:spaceId/sub-spaces/:subId", async (c) => {
  const spaceId = c.req.param("spaceId");
  const subId = c.req.param("subId");
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const auth = await forwardToSpaceDO(stub, `/hierarchy-authorize?user_id=${encodeURIComponent(userId)}&target_space_id=${encodeURIComponent(subId)}`, "GET");
  const authorization = await auth.json<{ permitted?: boolean }>().catch(() => ({} as { permitted?: boolean }));
  if (!auth.ok || authorization.permitted !== true) return c.json({ error_code: "forbidden", message: "Administrative membership is required" }, 403);
  const res = await forwardToSpaceDO(stub, `/spaces/${subId}`, "PATCH", c.req.raw.body);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// ── Cross-space access grants (spec §49 checkPermission) ─────────────────────
app.all("/spaces/:spaceId/cross-space-grants/:grantId?", async (c) => {
  const spaceId = c.req.param("spaceId");
  const grantId = c.req.param("grantId");
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing tenant or user" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const auth = await forwardToSpaceDO(stub, `/hierarchy-authorize?user_id=${encodeURIComponent(userId)}&target_space_id=${encodeURIComponent(spaceId)}&action=manage`, "GET");
  if (!auth.ok) return c.json({ error_code: "forbidden", message: "Space administration is required to manage cross-Space grants" }, 403);

  const url = new URL(c.req.url);
  let doPath: string;
  if (c.req.method === "POST") {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (body.target_space_id !== spaceId) return c.json({ error_code: "bad_request", message: "Grant must be created by the Space that owns the shared resource" }, 400);
    if (typeof body.resource_id === "string" && body.resource_id.startsWith("knowledge-document:")) {
      if (Array.isArray(body.permissions) && (body.permissions.length !== 1 || body.permissions[0] !== "read")) return c.json({ error_code: "bad_request", message: "Knowledge documents support read-only grants" }, 400);
      if (!c.env.KNOWLEDGE_WORKER) return c.json({ error_code: "knowledge_reference_resolver_unavailable" }, 503);
      const documentId = body.resource_id.slice("knowledge-document:".length);
      const response = await c.env.KNOWLEDGE_WORKER.fetch(new Request(`http://knowledge-worker/internal/spaces/${encodeURIComponent(spaceId)}/kb/references/resolve`, {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
        body: JSON.stringify({ document_ids: [documentId] }),
      }));
      const resolved: { documents?: Array<{ resolved?: boolean }> } = response.ok
        ? await response.json<{ documents?: Array<{ resolved?: boolean }> }>().catch(() => ({}))
        : {};
      if (!resolved.documents?.[0]?.resolved) return c.json({ error_code: "shareable_knowledge_document_required", message: "Only indexed Space-wide documents can be shared by this capability" }, 400);
    }
    doPath = "/cross-space-grants";
    const response = await forwardToSpaceDO(stub, doPath, "POST", JSON.stringify({ ...body, granted_by: userId }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  }
  if (c.req.method === "DELETE") doPath = `/cross-space-grants/${encodeURIComponent(grantId ?? "")}?space_id=${encodeURIComponent(spaceId)}`;
  else doPath = `/cross-space-grants?space_id=${encodeURIComponent(spaceId)}`;
  const res = await forwardToSpaceDO(
    stub,
    doPath,
    c.req.method,
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

// Legacy business subscription, credit-pack, wallet, and business revenue checkout routes were
// removed. Naelao subscriptions and FDE Space Template marketplace settlement are hosted by the
// platform billing and marketplace APIs instead.

// Aggregate Space usage analytics (runs, credits, and agent activity). This is a generic Space
// capability; it contains no storefront orders, customer revenue, or commerce accounting.
app.use("/spaces/:spaceId/agent-analytics", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/agent-analytics", requireSpaceMembership({ GET: "member" }));
app.get("/spaces/:spaceId/agent-analytics", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/agent-analytics${qs}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Product-user stored-value credit routes have been retired; usage is billed to the Space plan quota.

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

// POST /internal/space-types-record-install/:id — called at end of provisioning (step 9).
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
  const body = await c.req.json<{ spaceId: string; version: string }>().catch(() => null);
  if (!body) return c.json({ error_code: "install_record_invalid" }, 400);
  const registry = getRegistryDO(c.env);
  const response = await registry.fetch(new Request("http://registry/record-install", {
    method: "POST",
    body: JSON.stringify({ typeId, spaceId: body.spaceId, version: body.version }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
});

// POST /internal/space-types/seed — Naelao platform use only: seed built-in manifests
// Called once at deploy/bootstrap time to seed the Launchpad manifest.
app.post("/internal/space-types/seed", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const registry = getRegistryDO(c.env);
  const results = [];
  for (const manifest of [LAUNCHPAD_MANIFEST, WORKSPACE_MANIFEST]) {
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
// A session is Product-scoped; a Space has its own membership authorization. Resolve the
// requested Product or Space through the Product registry, with a legacy parent fallback.
app.post("/internal/product-sessions/verify", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const body = await c.req.json<{ productId: string; endUserId: string; sessionToken: string }>();
  if (!body.productId || !body.endUserId || !body.sessionToken) {
    return c.json({ valid: false }, 400);
  }

  const verified = await verifyProductSession(c.env, body.productId, body.endUserId, body.sessionToken);
  return verified ? c.json({ valid: true, tenant_id: verified.tenant_id, end_user_id: body.endUserId }) : c.json({ valid: false });
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
  const verified = await verifyProductSession(c.env, productId, endUserId, sessionToken);
  if (!verified) return c.json({ error: "invalid_session" }, 401);
  const ticket = crypto.randomUUID();
  const key = `stream-ticket:${productId}:${endUserId}:${ticket}`;
  await c.env.NAELAO_CONFIG_KV.put(key, JSON.stringify({ tenant_id: verified.tenant_id, security_generation: verified.security_generation }), { expirationTtl: 60 });
  return c.json({ ticket, expires_in: 60 });
});

app.post("/internal/stream-tickets/consume", async (c) => {
  if (c.req.header("x-naelao-platform-secret") !== c.env.PLATFORM_SECRET) {
    return c.json({ valid: false }, 403);
  }
  const { productId, endUserId, ticket } = await c.req.json<{ productId: string; endUserId: string; ticket: string }>();
  if (!productId || !endUserId || !ticket) return c.json({ valid: false }, 400);
  const key = `stream-ticket:${productId}:${endUserId}:${ticket}`;
  const encoded = await c.env.NAELAO_CONFIG_KV.get(key);
  if (encoded === null) return c.json({ valid: false }); // expired or already consumed
  let ticketPayload: { tenant_id: string; security_generation: number };
  try {
    ticketPayload = JSON.parse(encoded) as typeof ticketPayload;
    if (!ticketPayload.tenant_id || !Number.isSafeInteger(ticketPayload.security_generation) || ticketPayload.security_generation < 0) return c.json({ valid: false });
  } catch { return c.json({ valid: false }); }
  // Single-use: delete immediately after reading.
  await c.env.NAELAO_CONFIG_KV.delete(key);
  // Suspension or deletion after ticket issue takes effect before it can be redeemed.
  const scope = await resolveProductScope(c.env, productId);
  const securityGeneration = scope ? await isActiveProductUser(c.env, scope.id, scope.tenant_id, endUserId) : null;
  if (!scope || scope.resource_tenant_id !== ticketPayload.tenant_id || securityGeneration !== ticketPayload.security_generation)
    return c.json({ valid: false });
  return c.json({ valid: true, tenant_id: scope.resource_tenant_id });
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
  const cacheKey = `space-type-manifest:v2:${spaceTypeId}`;
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
 * §A1.17 Phase L: load the Container Marketplace catalogue from the agents worker's real
 * GET /container-images, KV-cached 1h like loadTemplateCatalog above — this worker never
 * hand-maintains its own copy of image availability/billing-tier data.
 */
async function loadContainerCatalogue(env: Env): Promise<Array<{ id: string; name: string; available: boolean; billing_tier: string; install_manifest?: unknown }>> {
  const cacheKey = "container-image-catalogue";
  const cached = await env.NAELAO_CONFIG_KV.get(cacheKey, "json") as Array<{ id: string; name: string; available: boolean; billing_tier: string; install_manifest?: unknown }> | null;
  if (cached) return cached;
  if (!env.AGENTS_WORKER) return [];
  const resp = await env.AGENTS_WORKER.fetch(new Request("http://agents-worker/container-images"));
  if (!resp.ok) return [];
  const body = await resp.json<{ images: Array<{ id: string; name: string; available: boolean; billing_tier: string; install_manifest?: unknown }> }>();
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
  spaceConfigJson: string | null,
  loadedManifest?: NaelaoSpaceTypeManifestV2
): Promise<SpaceTypeProductConfig | null> {
  const manifest = loadedManifest ?? await loadManifest(env, spaceTypeId);
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
  if (slug === "launchpad" && c.env.NAELAO_DASHBOARD_TENANT_ID) {
    try { await ensureLaunchpad(c.env); }
    catch (error) { console.error("Launchpad bootstrap failed", error); return c.json({ error_code: "launchpad_unavailable" }, 503); }
  }
  const space = await c.env.PLATFORM_DB.prepare(
    "SELECT id, name, spacetype_id, config_json FROM products WHERE product_slug = ? AND status = 'active'"
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

  let space = tenantId
    ? await c.env.PLATFORM_DB.prepare(
        "SELECT id, name, spacetype_id, config_json FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
      ).bind(spaceId, tenantId).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>()
    : await c.env.PLATFORM_DB.prepare(
        "SELECT id, name, spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
      ).bind(spaceId).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>();
  if (!space) {
    const query = "SELECT id, name, spacetype_id, config_json FROM products WHERE id = ? AND status = 'active'" + (tenantId ? " AND tenant_id = ?" : "");
    space = await c.env.PLATFORM_DB.prepare(query).bind(...(tenantId ? [spaceId, tenantId] : [spaceId])).first<{ id: string; name: string; spacetype_id: string; config_json: string | null }>();
  }
  if (!space) return c.json({ error_code: "not_found", message: "Space not found" }, 404);

  const manifest = await loadManifest(c.env, space.spacetype_id);
  if (!manifest) return c.json({ error_code: "not_found", message: "SpaceType manifest not found" }, 404);
  const pc = await loadEffectiveProductConfig(c.env, space.spacetype_id, space.config_json, manifest);
  let spaceConfig: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(space.config_json ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) spaceConfig = parsed as Record<string, unknown>; } catch { /* malformed legacy config uses product default */ }

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
    presentation_profile: ["guided", "balanced", "advanced"].includes(String(spaceConfig["presentation_profile"])) ? spaceConfig["presentation_profile"] : "guided",
    // §A1.28 (model switcher): null means "unset" — the dispatch layer's own DEFAULT_WORKING_MODEL
    // fallback (@naelao/billing-core, a Workers AI id — see CLAUDE.md item 68/79: a Claude default
    // 404s on an account with no Anthropic provider on its gateway) applies, same meaning as every
    // other unset productConfig field in this projection.
    model: pc?.modelConfig?.model ?? null,
    // The stored escalation-budget default for this business — the shell reads it as the
    // starting point for a session that's never chosen its own effort locally yet. Same
    // null-means-unset convention as model above (the dispatch layer's own default is "low").
    effort: pc?.modelConfig?.effort ?? null,
    sub_space_display: pc?.subSpaceDisplay ?? null,
    auth_provider: pc?.authProvider?.provider ?? "naelao-native",
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
// account profile. Resolves identity from the
// caller's OWN claims only (role must be product_end_user; userId is that end user's own
// end_user_id, set by the router's resolveProductEndUserClaims) — there is deliberately no way
// to pass a different end_user_id and read someone else's profile through this route.
app.get("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductIdentity(c.env, spaceId);
  if (!root || !tenantId || root.tenant_id !== tenantId) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT email, display_name, first_seen_at, last_seen_at, suspended_at, email_verified_at, preferred_language FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(root.id, userId).first<{ email: string | null; display_name: string | null; first_seen_at: string; last_seen_at: string | null; suspended_at: string | null; email_verified_at: string | null; preferred_language: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "End user not found" }, 404);

  return c.json({
    end_user_id: userId,
    email: row.email,
    display_name: row.display_name,
    joined_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    suspended: row.suspended_at !== null,
    // The shell uses this state to show the account-verification banner.
    email_verified: row.email_verified_at !== null,
    preferred_language: row.preferred_language,
  });
});

app.patch("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductIdentity(c.env, spaceId);
  if (!root || !tenantId || root.tenant_id !== tenantId) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const body = await c.req.json<{ display_name?: string; preferred_language?: string | null }>().catch(() => ({}) as { display_name?: string; preferred_language?: string | null });
  if (body.display_name === undefined && body.preferred_language === undefined) {
    return c.json({ error_code: "bad_request", message: "Nothing to update" }, 400);
  }
  if (body.preferred_language !== undefined && body.preferred_language !== null && !normalizePreferredLanguage(body.preferred_language)) {
    return c.json({ error_code: "bad_request", message: "preferred_language must be a valid BCP-47 language tag or null" }, 400);
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.display_name !== undefined) { sets.push("display_name = ?"); values.push(body.display_name); }
  if (body.preferred_language !== undefined) { sets.push("preferred_language = ?"); values.push(body.preferred_language === null ? null : normalizePreferredLanguage(body.preferred_language)); }
  values.push(root.id, userId);
  const res = await c.env.PLATFORM_DB.prepare(
    `UPDATE product_end_users SET ${sets.join(", ")} WHERE product_space_id = ? AND end_user_id = ?`
  ).bind(...values).run();
  if (res.meta.changes === 0) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  return c.json({ ok: true, ...(body.display_name !== undefined ? { display_name: body.display_name } : {}), ...(body.preferred_language !== undefined ? { preferred_language: body.preferred_language === null ? null : normalizePreferredLanguage(body.preferred_language) } : {}) });
});

// GET /spaces/:spaceId/product-users/me/export — portability export for the authenticated
// end user. The DO contains session metadata, credits, conversation references, and preferences;
// D1 contains the user's roster/profile fields. Credentials and password hashes are never returned.
app.get("/spaces/:spaceId/product-users/me/export", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductIdentity(c.env, spaceId);
  if (!root || !tenantId || root.tenant_id !== tenantId) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const profile = await c.env.PLATFORM_DB.prepare(
    "SELECT email, display_name, phone_e164, phone_verified_at, first_seen_at, last_seen_at, suspended_at, email_verified_at, preferred_language, deleted_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(root.id, userId).first<{ email: string | null; display_name: string | null; phone_e164: string | null; phone_verified_at: string | null; first_seen_at: string; last_seen_at: string | null; suspended_at: string | null; email_verified_at: string | null; preferred_language: string | null; deleted_at: string | null }>();
  if (!profile) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const stub = await productUserDoStub(c.env, root.id, userId, root.tenant_id);
  const response = await stub.fetch(new Request("http://do/export"));
  if (!response.ok) return c.json({ error_code: "data_export_unavailable" }, 502);
  return c.json({
    export_version: "1",
    exported_at: new Date().toISOString(),
    profile: { end_user_id: userId, ...profile },
    product_user_data: await response.json(),
  });
});

// DELETE /spaces/:spaceId/product-users/me — GDPR Art. 17, the direct inverse of GET (export)
// above: erasing exactly what /export reports. Tier 2/3 follow-up — export existed, deletion
// didn't. Self-service only: end_user_id is derived from the caller's OWN verified claims, never
// a client-supplied field (same precedent as GET/PATCH above) — there is no builder-initiated
// erasure path here, matching the fact this route lives under /product-users/me, not an
// admin-facing /product-users/:endUserId. Erases ProductUserDO's session/conversation/preference
// state, then anonymizes (never hard-deletes — see migration 0058's own comment on why) the D1
// roster row's PII. The generic membership migration owns cross-Space identity cleanup; this
// route does not delete SpaceDO's thread/message history — a separate erasure scope (see G-AO31) — a real,
// documented boundary for a future pass, not silently dropped.
app.delete("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductIdentity(c.env, spaceId);
  if (!root || !tenantId || root.tenant_id !== tenantId) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT deleted_at FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(root.id, userId).first<{ deleted_at: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "End user not found" }, 404);

  await eraseAssistantCommunications(c.env,tenantId,root.id,userId,true);
  await eraseWebsiteConnections(c.env, tenantId, { userId, productSpaceId: root.id });
  const stub = await productUserDoStub(c.env, root.id, userId, root.tenant_id);
  const eraseRes = await stub.fetch(new Request("http://do/erase", { method: "DELETE" }));
  const erased = await eraseRes.json<{ erased_at: string; sessions_deleted: number; conversations_deleted: number }>();

  if (!row.deleted_at) {
    // Remove outstanding recovery/verification material as part of account erasure. These
    // token hashes and WhatsApp challenge rows remain sensitive even though they are not usable
    // once the profile is anonymized.
    await Promise.all([
      c.env.PLATFORM_DB.prepare("DELETE FROM password_reset_tokens WHERE product_space_id = ? AND end_user_id = ?").bind(root.id, userId).run(),
      c.env.PLATFORM_DB.prepare("DELETE FROM email_verification_tokens WHERE product_space_id = ? AND end_user_id = ?").bind(root.id, userId).run(),
      c.env.PLATFORM_DB.prepare("DELETE FROM whatsapp_auth_challenges WHERE product_space_id = ? AND end_user_id = ?").bind(root.id, userId).run(),
    ]);
    await c.env.PLATFORM_DB.prepare(
      "UPDATE product_end_users SET email = NULL, display_name = NULL, phone_e164 = NULL, phone_verified_at = NULL, email_verified_at = NULL, preferred_language = NULL, password_hash = NULL, last_seen_at = NULL, suspended_at = NULL, deleted_at = datetime('now') WHERE product_space_id = ? AND end_user_id = ?"
    ).bind(root.id, userId).run();
  }

  return c.json({ erased: true, erased_at: erased.erased_at, sessions_deleted: erased.sessions_deleted, conversations_deleted: erased.conversations_deleted });
});

// Platform member language preference. Stored on the authenticated platform user record,
// separate from product_end_users so a member's settings cannot bleed into product users.
app.get("/me/preferences", async (c) => {
  const { role, userId } = getCallerIdentity(c);
  if (!userId || !["owner", "admin", "editor", "viewer"].includes(role ?? "")) {
    return c.json({ error_code: "unauthorized", message: "Platform member authentication required" }, 401);
  }
  const row = await c.env.PLATFORM_DB.prepare("SELECT preferred_language FROM users WHERE id = ?")
    .bind(userId).first<{ preferred_language: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "User not found" }, 404);
  return c.json({ preferred_language: row.preferred_language });
});

app.patch("/me/preferences", async (c) => {
  const { role, userId } = getCallerIdentity(c);
  if (!userId || !["owner", "admin", "editor", "viewer"].includes(role ?? "")) {
    return c.json({ error_code: "unauthorized", message: "Platform member authentication required" }, 401);
  }
  const body = await c.req.json<{ preferred_language?: string | null }>().catch(() => ({} as { preferred_language?: string | null }));
  if (body.preferred_language === undefined || (body.preferred_language !== null && !normalizePreferredLanguage(body.preferred_language))) {
    return c.json({ error_code: "bad_request", message: "preferred_language must be a valid BCP-47 language tag or null" }, 400);
  }
  const preferredLanguage = body.preferred_language === null ? null : normalizePreferredLanguage(body.preferred_language);
  const result = await c.env.PLATFORM_DB.prepare("UPDATE users SET preferred_language = ? WHERE id = ?")
    .bind(preferredLanguage, userId).run();
  if (result.meta.changes === 0) return c.json({ error_code: "not_found", message: "User not found" }, 404);
  return c.json({ preferred_language: preferredLanguage });
});

// GET /spaces/:spaceId/sessions (list) is handled by the generic SpaceDO session proxy above
// (app.all("/spaces/:spaceId/sessions*", ...)) — see that handler's own comment for why the
// end_user_id filter is derived from verified caller claims there, never a client-supplied
// query param.

// Legacy reseller portfolios, statements, child-business lifecycle, and manual payout APIs were
// removed. FDE template royalty settlement is handled by the marketplace subsystem.

// Three-Tier Platform Model, Phase 3 (docs/spec-appendix A1.17) — /builder/* routes.
registerBuilderRoutes(app);
// Three-Tier Platform Model, Phase 6 — public, unauthenticated end-user signup/login.
registerProductEndUserRoutes(app);

app.onError((err, c) => err instanceof RequestBodyTooLargeError
  ? c.json({ error_code: "request_body_too_large", message: "Request body exceeds the 1 MiB limit" }, 413)
  : errorResponse(err, c.get("requestId") ?? "unknown"));

const MAX_SPACES_REQUEST_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!request.body || request.method === "GET" || request.method === "HEAD")
      return app.fetch(request, env, ctx);
    try {
      const bytes = await readBoundedRequestBytes(request, MAX_SPACES_REQUEST_BYTES);
      return app.fetch(new Request(request, { body: bytes }), env, ctx);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return Response.json({ error_code: "request_body_too_large", message: "Request body exceeds the 8 MiB limit" }, { status: 413 });
      return errorResponse(error, "unknown");
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.NAELAO_DASHBOARD_TENANT_ID) {
      try { await ensureLaunchpad(env); }
      catch (error) { console.error("Launchpad bootstrap failed", error); }
    }
    if (env.PROVISION_QUEUE) {
      const provisions = await dispatchPendingProvisioningOutbox(env.PLATFORM_DB, env.PROVISION_QUEUE);
      console.log(`[provisioning-outbox] sent=${provisions.sent} deferred=${provisions.deferred}`);
    }
    if (env.EVENTS_QUEUE) {
      const erasures = await dispatchPendingErasureOutbox(env.PLATFORM_DB, env.EVENTS_QUEUE);
      console.log(`[erasure-outbox] sent=${erasures.sent} deferred=${erasures.deferred}`);
    }
    const accountSecurity = await dispatchPendingProductAccountSecurityOutbox(env.PLATFORM_DB, env);
    console.log(`[product-account-security-outbox] completed=${accountSecurity.completed} deferred=${accountSecurity.deferred}`);
    const authEmails = await dispatchPendingProductAuthEmails(env.PLATFORM_DB, env);
    console.log(`[product-auth-email-outbox] accepted=${authEmails.accepted} deferred=${authEmails.deferred}`);
  },
} satisfies ExportedHandler<Env>;
