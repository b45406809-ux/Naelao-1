import { registerAssistantVoiceRoutes } from "./routes/assistant-voice.js";
import { Hono, type Context } from "hono";
import { errorResponse, requestId, notFound, requireInternalHmac, mintInternalToken, verifyInternalToken, forbidden, mintLocalTunnelToken, readBoundedRequestBytes, readBoundedRequestText, readBoundedResponseJson, readBoundedResponseText, RequestBodyTooLargeError } from "@naelao/http";
import { getDOName, signHmac, verifyHmac } from "@naelao/crypto";
import { normalizePreferredLanguage, validateScheduledQuietHours } from "@naelao/types";
import { compileWorkflowPlan } from "@naelao/sdk/workflow";
import type { SpaceModelPolicy } from "@naelao/agent-sdk";
import type { SpaceDO } from "./do/SpaceDO.js";
import type { SpaceTypeRegistryDO, SpaceTypeProductConfig, NaelaoSpaceTypeManifestV2 } from "./do/SpaceTypeRegistryDO.js";
import { LAUNCHPAD_MANIFEST } from "./launchpad-manifest.js";
import { cfSaasConfig, createCustomHostname, deleteCustomHostname, getCustomHostname, normalizeCustomHostname } from "./cf-saas.js";
import { validateCronExpression, computeNextRun } from "@naelao/events";
import { registerBuilderRoutes } from "./builder-routes.js";
import { registerProductEndUserRoutes, FREE_TIER_DEFAULT_SIGNUP_CREDITS } from "./product-end-user-routes.js";
import { registerBusinessRoutes } from "./business-routes.js";
import { createSpaceRecord, SpaceCreationError } from "./create-space.js";
import { dispatchPendingProvisioningOutbox } from "./provisioning-outbox.js";
import type { ProvisionMessage } from "./create-space.js";
import { requireBusinessMembership, resolveEndUserBusinessRole } from "./business-auth.js";
import { loadTemplateCatalog, loadShellCatalog } from "./template-catalog.js";
import { ALLOWED_MODELS, isAllowedModel, isValidEffortLevel } from "@naelao/billing-core";
import { registerProjectMcpRoutes } from "./routes/mcp.js";
import { registerGadgetMcpRoutes } from "./routes/gadget-mcp.js";
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
  DOGFOOD_EXTENSION_BY_ID, DOGFOOD_EXTENSION_CANVASES, digestExtensionManifest, instantiateBlueprint, validateExtensionManifest, type SpaceBlueprint } from "@naelao/agent-sdk";
import { rankProjectStewardReviews, type ProjectStewardFact, type ProjectStewardReview } from "./project-steward.js";
import { isProjectStewardDecisionAction, projectStewardReviewKey } from "./project-steward-decisions.js";
import { PROJECT_STEWARD_EXTENSION_MANIFEST } from "./project-steward-extension.js";
import { reportExtensionArtifactWrite } from "./extension-storage-usage.js";
import { eraseAssistantCommunications } from "./assistant-communication-erasure.js";
import { eraseWebsiteConnections } from "./website-connection-erasure.js";
import { eraseProductUsersForSpace } from "./product-user-erasure.js";
import { eraseBusinessServiceProviders } from "./business-erasure.js";
import { cancelPendingErasure, createPendingErasureRequest, dispatchPendingErasureOutbox } from "./erasure-request-state.js";
import { previewBlueprintActivation } from "./blueprint-activation.js";
import { assertExecutionPlanResources, EntitlementsChecker, getExecutionLimits, isPlanTierAtLeast } from "@naelao/entitlements";

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
  DATA_JURISDICTION?: "eu";
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
  /** Tenant allowed to operate and retain Naelao's single Launchpad root product. */
  NAELAO_DASHBOARD_TENANT_ID?: string;
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
app.use("*", requestId);
app.use("*", async (c, next) => { validateEnv(c.env); await next(); });
app.get("/health", (c) => c.json({ ok: true, service: "spaces", env: c.env.ENVIRONMENT }));
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
    "SELECT id, status, created_at, updated_at, completed_at FROM gdpr_requests WHERE id = ? AND tenant_id = ? AND requested_by = ? AND request_type = 'erasure'",
  ).bind(requestId, identity.tenantId, identity.userId)
    .first<{ id: string; status: string; created_at: string; updated_at: string; completed_at: string | null }>();
  if (!request) return c.json({ error_code: "not_found" }, 404);
  return c.json({ request_id: request.id, status: request.status, created_at: request.created_at, updated_at: request.updated_at, completed_at: request.completed_at });
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
    const role = await resolveEndUserBusinessRole(env.PLATFORM_DB, spaceId, userId);
    if (role !== "owner" && role !== "admin") return null;
    const root = await resolveProductRootSpace(env, spaceId);
    if (!root) return null;
    const product = await env.PLATFORM_DB.prepare("SELECT product_slug FROM spaces WHERE id = ?").bind(root.id).first<{ product_slug: string | null }>();
    if (!product?.product_slug) return null;
    const response = await (await productUserDoStub(env, root.id, userId, root.tenant_id)).fetch(new Request("http://do/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth_provider: "verified-mobile-desk-drop" }),
    }));
    if (!response.ok) return null;
    const session = await response.json<{ session_token: string; expires_at: string }>();
    return { token: session.session_token, expiresAt: session.expires_at, productId: root.id, slug: product.product_slug };
  },
  async verifySession(rawEnv, session) {
    const env = rawEnv as Env;
    if (!await resolveEndUserBusinessRole(env.PLATFORM_DB, session.spaceId, session.userId)) return false;
    const root = await resolveProductRootSpace(env, session.spaceId);
    if (!root || root.id !== session.productId) return false;
    const response = await (await productUserDoStub(env, root.id, session.userId, root.tenant_id)).fetch(new Request("http://do/sessions/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_token: session.token }),
    }));
    return response.ok && (await response.json<{ valid: boolean }>()).valid;
  },
  async revokeSession(rawEnv, session) {
    const env = rawEnv as Env;
    const root = await resolveProductRootSpace(env, session.spaceId);
    if (!root || root.id !== session.productId) return;
    const stub = await productUserDoStub(env, root.id, session.userId, root.tenant_id);
    const verify = await stub.fetch(new Request("http://do/sessions/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_token: session.token }) }));
    const verified = await verify.json<{ valid: boolean; session_id?: string }>();
    if (verified.valid && verified.session_id) await stub.fetch(new Request("http://do/sessions/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: verified.session_id }) }));
  },
});
registerGraduationRoutes(app);
registerWebsiteConnectionRoutes(app);
registerAssistantChannelRoutes(app);
registerAssistantVoiceRoutes(app);

// Extract caller identity from headers (set by router worker after JWT validation)
function getCallerIdentity(c: { req: { header: (h: string) => string | undefined } }) {
  return {
    tenantId: c.req.header("x-naelao-tenant-id") ?? "",
    userId: c.req.header("x-naelao-user-id") ?? "",
    role: c.req.header("x-naelao-role") ?? "viewer",
  };
}
type ExtensionReleasePin = { version: string | null; digest: string | null; status?: string };
function installedSpaceExtensionPins(rows: Array<{ extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null }>): Map<string, ExtensionReleasePin> {
  const pins = new Map<string, ExtensionReleasePin>();
  for (const row of rows) {
    if (row.scope !== "SPACE_SHARED" || typeof row.extension_id !== "string") continue;
    const previous = pins.get(row.extension_id);
    if (previous?.status === "active" || (previous && row.status !== "active")) continue;
    pins.set(row.extension_id, { version: row.release_version ?? null, digest: row.manifest_sha256 ?? null, ...(row.status ? { status: row.status } : {}) });
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
export function blueprintRuntimeInstallability(blueprint: SpaceBlueprint, images: readonly RuntimeCatalogueRecord[], plan = "free"): Map<string, { installable: boolean; reason?: RuntimeReadinessReason }> {
  const result = new Map<string, { installable: boolean; reason?: RuntimeReadinessReason }>();
  for (const project of blueprint.projects) for (const requirement of project.runtimeRequirements ?? []) {
    const requiredReleases = new Map<string, number>();
    for (const needed of project.runtimeRequirements ?? []) {
      if (!needed.required) continue;
      const release = images.find(item => item.id === needed.id);
      const manifest = release?.install_manifest as { id?: string; containers?: unknown[] } | undefined;
      requiredReleases.set(manifest?.id ?? needed.id, manifest?.containers?.length ?? 1);
    }
    const requiredSlots = [...requiredReleases.values()].reduce((sum, count) => sum + count, 0);
    const key = `${project.id ?? project.name}:${requirement.id}`, image = images.find(item => item.id === requirement.id);
    let reason: RuntimeReadinessReason | undefined;
    if (!image?.available) reason = "runtime_not_deployed";
    else if (!requirement.capabilities.every(capability => capability === "bash" || image.exported_binaries?.includes(capability))) reason = "runtime_capability_mismatch";
    else if (!image.plan_available) reason = image.plan_reason === "subscription_resource_limit" ? "subscription_resource_limit" : "subscription_plan_required";
    else if (requirement.required && requiredSlots > getExecutionLimits(plan).installedContainersPerWorkspace) reason = "subscription_slot_limit";
    else if ((typeof project.configuration?.executionCeiling === "number" ? project.configuration.executionCeiling : 5) < 6) reason = "project_execution_ceiling_required";
    result.set(key, reason ? { installable: false, reason } : { installable: true });
  }
  return result;
}
async function installableSpaceExtensionPins(): Promise<Map<string, { version: string; digest: string }>> {
  const entries = await Promise.all(Object.entries(DOGFOOD_EXTENSION_BY_ID).filter(([, manifest]) => manifest.gadgets.some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3)).map(async ([id, raw]) => {
    const manifest = validateExtensionManifest(raw, { gatekeeperCapabilities: raw.capabilityRequirements });
    const version = manifest.releaseVersion ?? manifest.bundle?.version;
    return version ? [id, { version, digest: await digestExtensionManifest(manifest) }] as const : null;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, { version: string; digest: string }] => entry !== null));
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
  const space = await c.env.PLATFORM_DB.prepare("SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'")
    .bind(spaceId).first<{ tenant_id: string; parent_space_id: string | null }>();
  if (!space || space.tenant_id !== tenantId) return null;
  if (space.parent_space_id) {
    if (!await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId)) return null;
  } else {
    const roster = await c.env.PLATFORM_DB.prepare(
      "SELECT 1 AS active FROM product_end_users WHERE product_space_id = ? AND end_user_id = ? AND suspended_at IS NULL AND deleted_at IS NULL"
    ).bind(spaceId, identity.userId).first();
    if (!roster) return null;
  }
  return identity.userId;
}
async function canExportBlueprint(c: { env: Env; req: { header(h: string): string | undefined } }, spaceId: string): Promise<boolean> {
  const { role, userId } = getCallerIdentity(c);
  if (role === "product_end_user") {
    const membership = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, userId);
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

// ── POST /spaces — create a space ───────────────────────────────────────────
app.post("/spaces", async (c) => {
  const { tenantId, userId, role } = getCallerIdentity(c);
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (!["owner", "admin", "editor"].includes(role)) return c.json({ error_code: "forbidden" }, 403);

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await readBoundedRequestBytes(c.req.raw, 64 * 1024);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) return c.json({ error_code: "payload_too_large" }, 413);
    return c.json({ error_code: "invalid_request_body" }, 400);
  }
  let bodyValue: unknown;
  try {
    bodyValue = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return c.json({ error_code: "invalid_request_body" }, 400);
  }
  if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) {
    return c.json({ error_code: "invalid_request_body" }, 400);
  }
  const body = bodyValue as {
    name: string;
    spacetype_id: string;
    /** For Launchpad: the selected product template (e.g. "creator-store"). */
    template_id?: string;
    config_overrides?: Record<string, unknown>;
    parent_space_id?: string;
    depth?: number;
  };

  // A root space is the platform's single Launchpad product. Customer-owned spaces are
  // departments/businesses under an existing root and use the dedicated parent-scoped flows.
  // Keep this legacy route aligned with /builder/products so it cannot bypass team-only creation.
  if (!body.parent_space_id) {
    if (!c.env.NAELAO_DASHBOARD_TENANT_ID || tenantId !== c.env.NAELAO_DASHBOARD_TENANT_ID) {
      return c.json({ error_code: "forbidden", message: "Only the Naelao team can create the Launchpad root product" }, 403);
    }
    if (body.name !== "Launchpad" || body.spacetype_id !== "launchpad" || body.template_id || body.config_overrides) {
      return c.json({ error_code: "unsupported_product", message: "The Naelao dashboard creates one centrally configured Launchpad product" }, 400);
    }
  }

  try {
    const result = await createSpaceRecord(c.env, {
      tenantId,
      ...(userId ? { userId } : {}),
      name: body.name,
      spacetypeId: body.spacetype_id,
      ...(body.parent_space_id ? { parentSpaceId: body.parent_space_id } : {}),
      ...(body.depth !== undefined ? { depth: body.depth } : {}),
      ...(body.template_id ? { templateId: body.template_id } : {}),
      ...(body.config_overrides ? { configOverrides: body.config_overrides } : {}),
    });
    return c.json({ id: result.id, name: body.name, status: result.status, product_slug: result.product_slug, created_at: result.created_at }, 201);
  } catch (err) {
    if (err instanceof SpaceCreationError) {
      return c.json({ error_code: err.error_code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status as 400 | 402 | 404 | 409 | 429 | 503);
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

// ── Blueprint export and activation ─────────────────────────────────────────
app.post("/spaces/:spaceId/export-template", async (c) => {
  const { tenantId } = getCallerIdentity(c);
  const spaceId = c.req.param("spaceId");
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable", message: "Blueprint storage not configured" }, 503);
  const exportOptions = await c.req.json<{ projectId?: string; requiredExtensions?: string[]; name?: string; description?: string; templateCategory?: string; stateDeltaSuite?: StateDeltaSuite; entries?: Record<string, string> }>().catch(() => ({} as { projectId?: string; requiredExtensions?: string[]; name?: string; description?: string; templateCategory?: string; stateDeltaSuite?: StateDeltaSuite; entries?: Record<string, string> }));
  if (exportOptions.projectId !== undefined && (typeof exportOptions.projectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(exportOptions.projectId))) return c.json({ error_code: "invalid_project_id" }, 400);
  if (exportOptions.requiredExtensions !== undefined && (!Array.isArray(exportOptions.requiredExtensions) || exportOptions.requiredExtensions.length > 128 || exportOptions.requiredExtensions.some(id => typeof id !== "string" || !/^ext_[a-z0-9_-]{2,62}$/.test(id)))) return c.json({ error_code: "invalid_required_extensions" }, 400);
  const sourceId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
  const rawResponse = await c.env.SPACE_DO.get(sourceId).fetch(new Request("http://space-do/blueprints/export", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: spaceId,
      ...(exportOptions.projectId ? { project_id: exportOptions.projectId } : {}), ...(exportOptions.requiredExtensions ? { required_extensions: exportOptions.requiredExtensions } : {}),
      ...(exportOptions.name ? { name: exportOptions.name } : {}), ...(exportOptions.description ? { description: exportOptions.description } : {}),
      ...(exportOptions.templateCategory ? { template_category: exportOptions.templateCategory } : {}) }),
  }));
  if (!rawResponse.ok) return new Response(rawResponse.body, { status: rawResponse.status });
  const rawBlueprint = await rawResponse.json<SpaceBlueprint>();
  if (exportOptions.stateDeltaSuite) rawBlueprint.metadata.stateDeltaSuite = exportOptions.stateDeltaSuite;
  for (const project of rawBlueprint.projects) {
    const entry = project.id ? exportOptions.entries?.[project.id] : undefined;
    if (entry) project.configuration = { ...project.configuration, conformance_entry: entry };
  }
  const blueprint = sanitizeAndScrubBlueprint(rawBlueprint) as unknown as SpaceBlueprint;
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

app.get("/spaces/:spaceId/blueprints/:blueprintId/activation-preview", async c => {
  const identity = getCallerIdentity(c), tenantId = identity.tenantId, spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  if (!identity.userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  if (!await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first()) throw notFound("Space");
  const value = await loadCertifiedBlueprint(c.env, tenantId, c.req.param("blueprintId"));
  if (!value) throw notFound("Blueprint");
  const blueprint = value.blueprint, artifact = { ...blueprint } as SpaceBlueprint & { securityRating?: unknown };
  delete artifact.securityRating;
  if (!await verifyArtifactCertificate(artifact, value.conformanceCertificate, c.env.PLATFORM_SECRET, "state-delta")) return c.json({ error_code: "conformance_certificate_invalid" }, 422);
  if (value.conformanceCertificate.issuerTenantId !== tenantId) {
    const fork = await c.env.PLATFORM_DB.prepare(`SELECT f.certificate_json,f.artifact_json FROM marketplace_forks f JOIN marketplace_listings l ON l.id=f.listing_id WHERE f.tenant_id=? AND f.blueprint_id=? AND l.status='published' LIMIT 1`).bind(tenantId, blueprint.id).first<{ certificate_json: string; artifact_json: string }>();
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
  const rows = await result.json<{ installations: Array<{ extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null }> }>();
  const preview = previewBlueprintActivation(blueprint, installedSpaceExtensionPins(rows.installations ?? []), await installableSpaceExtensionPins(), runtimeReadiness);
  return c.json({ ...preview, blueprint_id: blueprint.id, target_space_id: spaceId, security });
});

app.post("/spaces/:spaceId/blueprints/:blueprintId/activate", async (c) => {
  const identity = getCallerIdentity(c);
  const tenantId = identity.tenantId;
  const spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) {
    return c.json({ error_code: "forbidden", message: "A verified Naelao session is required" }, 403);
  }
  if (!identity.userId) return c.json({ error_code: "human_activation_required" }, 403);
  if (!await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const owned = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'").bind(spaceId, tenantId).first();
  if (!owned) throw notFound("Space");
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
  // A valid publisher receipt alone does not grant every tenant a template license.
  // Publisher-owned exports may be activated directly; imported artifacts need a
  // tenant-scoped fork/entitlement created by the marketplace billing path.
  if (storedValue.conformanceCertificate.issuerTenantId !== tenantId) {
    const fork = await c.env.PLATFORM_DB.prepare(
      `SELECT f.certificate_json, f.artifact_json
       FROM marketplace_forks f JOIN marketplace_listings l ON l.id = f.listing_id
       WHERE f.tenant_id = ? AND f.blueprint_id = ? AND l.status = 'published' LIMIT 1`
    ).bind(tenantId, c.req.param("blueprintId")).first<{ certificate_json: string; artifact_json: string }>();
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
  const dependencies = await dependenciesResponse.json<{ installations: Array<{ extension_id?: string; scope?: string; status?: string; release_version?: string | null; manifest_sha256?: string | null }> }>();
  const readiness = previewBlueprintActivation(blueprint, installedSpaceExtensionPins(dependencies.installations ?? []), await installableSpaceExtensionPins(), runtimeReadiness);
  if (!readiness.ready) {
    const runtimeBlockers = readiness.blockers.filter(blocker => blocker.startsWith("required_runtime_unavailable:"));
    if (runtimeBlockers.length) return c.json({ error_code: "required_runtime_unavailable", runtime_requirements: readiness.runtime_requirements, blockers: runtimeBlockers }, 422);
    return c.json({ error_code: "required_extension_unavailable", blockers: readiness.blockers }, 422);
  }
  for (const extensionId of blueprint.requiredExtensions ?? []) {
    if (!DOGFOOD_EXTENSION_BY_ID[extensionId] || readiness.dependencies.some(dependency => dependency.extension_id === extensionId && dependency.status === "installed")) continue;
    const installed = await installFirstPartySpaceExtension(c.env, tenantId, spaceId, "naelao-template", extensionId);
    if (!installed.ok) return c.json({ error_code: "required_extension_install_failed", extension_id: extensionId, reason: installed.error }, 503);
  }
  const response = await c.env.SPACE_DO.get(targetId).fetch(new Request("http://space-do/blueprints/instantiate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint, target_space_id: spaceId, activation_key: blueprint.id }),
  }));
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
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
  await c.env.PLATFORM_DB.prepare("UPDATE spaces SET config_json=json_remove(COALESCE(config_json,'{}'),'$.pending_blueprint_id') WHERE id=? AND tenant_id=? AND json_extract(config_json,'$.pending_blueprint_id')=?")
    .bind(spaceId, tenantId, blueprint.id).run();
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
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
  const installed = await spaceStub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy, tenantId, spaceId, scope: "SPACE_SHARED", approvedSharedFilesystem, gatekeeperCapabilities: manifest.capabilityRequirements }) }));
  if (!installed.ok) return { ok: false, error: "extension_installation_rejected" };
  const result = await installed.json<{ installationId?: string }>().catch(() => ({} as { installationId?: string }));
  if (!result.installationId) return { ok: false, error: "extension_installation_id_missing" };
  const html = DOGFOOD_EXTENSION_CANVASES[extensionId];
  if (html) for (const gadget of manifest.gadgets.filter(item => item.scope === "SPACE_SHARED" && item.gadgetTier === 3)) {
    const actor = gadgetActorId(env.MICRO_APP_DO, { scope: "SPACE_SHARED", spaceId, appId: gadget.id });
    const initialized = await env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: gadget.id, scope: "SPACE_SHARED", gadgetTier: 3, defaultSchemaSql: gadget.defaultSchemaSql, migrations: gadget.migrations ?? [], html }) }));
    if (!initialized.ok) return { ok: false, error: "extension_canvas_initialization_failed" };
  }
  return { ok: true, installationId: result.installationId };
}

app.use("/spaces/:spaceId/shared-extensions/:extensionId/install", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extensions/:extensionId/install", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/shared-extensions/:extensionId/install", async c => {
  const spaceId = c.req.param("spaceId"), identity = getCallerIdentity(c);
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }> }>()
    .catch((): { approved_shared_filesystem?: Array<{ path: string; access: "READ" | "READ_WRITE" }> } => ({}));
  const result = await installFirstPartySpaceExtension(c.env, owned.tenantId, spaceId, identity.userId ?? "space-admin", c.req.param("extensionId"), body.approved_shared_filesystem ?? []);
  return result.ok ? c.json({ extension_id: c.req.param("extensionId"), installation_id: result.installationId, scope: "SPACE_SHARED" }, 201)
    : c.json({ error_code: result.error }, result.error === "first_party_extension_not_found" ? 404 : 503);
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
app.use("/spaces/:spaceId/shared-extension-apps", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/shared-extension-apps", async c => {
  const spaceId = c.req.param("spaceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return forwardToSpaceDO(stub, `/space-shared-extensions?${new URLSearchParams({ tenant_id: owned.tenantId, space_id: spaceId })}`, "GET");
});
app.use("/spaces/:spaceId/shared-extension-catalog", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-catalog", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/shared-extension-catalog", c => c.json({ extensions: Object.values(DOGFOOD_EXTENSION_BY_ID)
  .filter(manifest => manifest.gadgets.some(gadget => gadget.scope === "SPACE_SHARED" && gadget.gadgetTier === 3))
  .map(manifest => ({ id: manifest.id, name: manifest.gadgets.find(gadget => gadget.scope === "SPACE_SHARED")?.name ?? manifest.id,
    requested_shared_filesystem: manifest.shared_filesystem ?? [] })) }));

app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/filesystem-grants", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/filesystem-grants", requireBusinessMembership({ PATCH: "admin" }));
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
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId/lifecycle", requireBusinessMembership({ PATCH: "admin" }));
app.patch("/spaces/:spaceId/shared-extension-installations/:instanceId/lifecycle", async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const body = await c.req.json<{ action?: "enable" | "disable" }>().catch((): { action?: "enable" | "disable" } => ({}));
  if (body.action !== "enable" && body.action !== "disable") return c.json({ error_code: "extension_lifecycle_action_invalid" }, 400);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return stub.fetch(new Request("http://space-do/space-shared-extension-lifecycle", { method: "PATCH",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, owned.tenantId) },
    body: JSON.stringify({ tenantId: owned.tenantId, spaceId, instanceId, action: body.action }) }));
});

app.use("/spaces/:spaceId/shared-extension-installations/:instanceId", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/shared-extension-installations/:instanceId", requireBusinessMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/shared-extension-installations/:instanceId", async c => {
  const spaceId = c.req.param("spaceId"), instanceId = c.req.param("instanceId");
  const owned = await loadOwnedSpace(c, spaceId);
  if (!owned.ok) return c.json({ error_code: owned.error_code, message: owned.message }, owned.status);
  const stub = await spaceDoStub(c.env, spaceId, owned.tenantId);
  return stub.fetch(new Request(`http://space-do/extension-installation?${new URLSearchParams({ instance_id: instanceId, tenant_id: owned.tenantId, space_id: spaceId })}`, { method: "DELETE" }));
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
  if (tenantId && tenantId === c.env.NAELAO_DASHBOARD_TENANT_ID) {
    const root = await c.env.PLATFORM_DB.prepare(
      "SELECT spacetype_id, COALESCE(depth, 0) AS depth FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
    ).bind(spaceId, tenantId).first<{ spacetype_id: string; depth: number }>();
    if (root?.spacetype_id === "launchpad" && root.depth === 0) {
      return c.json({ error_code: "protected_platform_product", message: "The Naelao Launchpad root cannot be deleted" }, 409);
    }
  }
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
// URL — resolveEndUserBusinessRole now requires an actual (product-root or business-membership)
// role before the GET is allowed, same as requireBusinessMembership's other routes.
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

app.use("/internal/spaces/:spaceId/customer-conversations*", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.all("/internal/spaces/:spaceId/customer-conversations*", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const path = new URL(c.req.url).pathname;
  const suffix = path.slice(`/internal/spaces/${spaceId}/customer-conversations`.length);
  const query = c.req.method === "GET" ? `?space_id=${encodeURIComponent(spaceId)}` : "";
  return forwardToSpaceDO(stub, `/internal/customer-conversations${suffix}${query}`, c.req.method, c.req.raw.body);
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

app.get("/spaces/:spaceId/workflow-installations/:instanceId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const stub = await spaceDoStub(c.env, c.req.param("spaceId"), tenantId);
  const response = await stub.fetch(new Request("http://space-do/workflow-installation?" + new URLSearchParams({ instance_id: c.req.param("instanceId"), tenant_id: tenantId, space_id: c.req.param("spaceId"), ...(c.req.query("include_disabled") === "1" ? { include_disabled: "1" } : {}) })));
  if (!response.ok) return response;
  const result = await response.json<Record<string, unknown>>();
  const release = result.release as { signatureValid?: unknown; publisher?: { keyId?: unknown } } | null | undefined;
  const keyId = release?.publisher?.keyId;
  if (release && typeof keyId === "string") {
    const trusted = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
      WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, c.req.param("spaceId"), keyId).first();
    if (!trusted) release.signatureValid = false;
  }
  return c.json(result);
});

app.get("/spaces/:spaceId/internal/channel-installations", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
  const projectId = c.req.query("project_id") ?? "";
  if (!projectId) return c.json({ error_code: "project_id_required" }, 400);
  const space = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id=? AND tenant_id=? AND status='active'").bind(spaceId, tenantId).first();
  if (!space) throw notFound("Space");
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const response = await stub.fetch(new Request("http://space-do/channel-installations?" + new URLSearchParams({ project_id: projectId, tenant_id: tenantId, space_id: spaceId, ...(c.req.query("include_disabled") === "1" ? { include_disabled: "1" } : {}) })));
  if (!response.ok) return response;
  const result = await response.json<{ installations?: Array<{ publisher_key_id?: string }> }>();
  const keyIds = [...new Set((result.installations ?? []).flatMap(item => item.publisher_key_id ? [item.publisher_key_id] : []))];
  if (!keyIds.length) return c.json(result);
  const placeholders = keyIds.map(() => "?").join(",");
  const trusted = await c.env.PLATFORM_DB.prepare(`SELECT key_id FROM extension_publisher_keys
    WHERE tenant_id=? AND space_id=? AND status='active' AND key_id IN (${placeholders})`).bind(tenantId, spaceId, ...keyIds).all<{ key_id: string }>();
  const activeKeys = new Set((trusted.results ?? []).map(row => row.key_id));
  return c.json({ ...result, installations: (result.installations ?? []).filter(item => !item.publisher_key_id || activeKeys.has(item.publisher_key_id)) });
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
app.use("/spaces/:spaceId/runtime-catalog", requireBusinessMembership({ GET: "member" }));
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
app.use("/spaces/:spaceId/runtime-installations", requireBusinessMembership({ POST: "admin" }));
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
    if (!userId || !await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, userId)) return null;
  }
  return owned;
}
async function canEditGlossary(c: { env: Env; req: { header(name: string): string | undefined } }, spaceId: string): Promise<boolean> {
  const role = c.req.header("x-naelao-role") ?? "";
  if (role === "owner" || role === "admin") return true;
  if (role !== "product_end_user") return false;
  const userId = c.req.header("x-naelao-user-id") ?? "";
  if (!userId) return false;
  const membership = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, userId);
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
  const membership = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, userId);
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
app.use("/spaces/:spaceId/data-ops", requireBusinessMembership({ GET: "admin", POST: "admin" }));
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

/** Get the ProductUserDO stub for a (product, end-user) pair, HMAC-named to prevent enumeration.
 *  productId is a space id; the tenant that owns it scopes the HMAC so two builders can't collide
 *  on the same end_user_id namespace. */
async function productUserDoStub(env: Env, productId: string, endUserId: string, tenantId: string) {
  const doId = env.PRODUCT_USER_DO.idFromName(
    await getDOName("produser", `${productId}:${endUserId}`, tenantId, env.PLATFORM_SECRET)
  );
  return env.PRODUCT_USER_DO.get(doId);
}

/** Resolve `spaceId` to the PRODUCT ROOT space it belongs to (walking one `parent_space_id` hop —
 *  spec §49's own invariant: a business is never more than one hop below its product root).
 *  ProductUserDO is a PRODUCT-scoped concept (one instance per productId×endUserId — see
 *  productUserDoStub's own doc), so a signed-in end user's session/credits/preferences all live
 *  under the product root's id, never a business's own space id, even while they're actively
 *  inside a business. Mirrors the identical inline walk already done at
 *  /internal/product-sessions/verify, /internal/stream-tickets/issue, and loadPricingCatalog —
 *  extracted here because the credit routes below were found NOT doing this walk: a
 *  business-scoped assistant session (no projectId) called .../credits/balance with the
 *  business's own space id, addressing a DIFFERENT, never-signed-up ProductUserDO with a
 *  permanent 0 balance, even though the end user's real (product-root-keyed) balance was well
 *  above zero — the live-reported "insufficient credits" bug despite a real 5000-credit grant. */
async function resolveProductRootSpace(
  env: Env,
  spaceId: string
): Promise<{ id: string; tenant_id: string } | null> {
  const space = await env.PLATFORM_DB.prepare(
    "SELECT tenant_id, parent_space_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(spaceId).first<{ tenant_id: string; parent_space_id: string | null }>();
  if (!space) return null;
  if (!space.parent_space_id) return { id: spaceId, tenant_id: space.tenant_id };
  const root = await env.PLATFORM_DB.prepare(
    "SELECT id, tenant_id FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(space.parent_space_id).first<{ id: string; tenant_id: string }>();
  return root?.tenant_id === space.tenant_id ? root : null;
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
  const businessRole = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : null;
  const qs = new URLSearchParams({ space_id: spaceId, user_id: identity.userId ?? "" });
  if (!identity.userId || businessRole === "admin" || businessRole === "owner") qs.set("space_manager", "1");
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
  await c.env.PLATFORM_DB.prepare("DELETE FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?").bind(c.req.header("x-naelao-tenant-id"), spaceId, projectId).run();
  return c.json({ unpublished: true });
});
app.get("/internal/spaces/:spaceId/blackboard/cards", async c => {
  const spaceId = c.req.param("spaceId"), visible = await visibleAutomationProjectIds(c, spaceId);
  if (visible instanceof Response) return visible;
  const cursor = c.req.query("after") ?? "";
  if (cursor && !/^[A-Za-z0-9._:-]{1,160}$/.test(cursor)) return c.json({ error_code:"invalid_cursor" },400);
  const candidates = [...new Set(visible)].sort().filter(id => id > cursor);
  const page = candidates.slice(0,100);
  if (!page.length) return c.json({ cards: [], next_cursor: null, truncated: false });
  const placeholders = page.map(() => "?").join(",");
  const cards = await c.env.PLATFORM_DB.prepare(`SELECT project_id,summary,capabilities_json,evidence_json,updated_at FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id IN (${placeholders}) ORDER BY project_id`).bind(c.req.header("x-naelao-tenant-id"), spaceId, ...page).all<{ project_id: string; summary: string; capabilities_json: string; evidence_json: string; updated_at: string }>();
  return c.json({ next_cursor: candidates.length > page.length ? page[page.length-1] : null, truncated: candidates.length > page.length, cards: cards.results.map(card => ({ projectId: card.project_id, summary: card.summary, capabilities: JSON.parse(card.capabilities_json), evidence: JSON.parse(card.evidence_json), updatedAt: card.updated_at })) });
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
  await c.env.PLATFORM_DB.batch([
    c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO space_blackboard_requests(tenant_id,space_id,id,source_project_id,target_project_id,objective,expected_result,deadline,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)")
      .bind(tenant,spaceId,b.id,b.source_project_id,b.target_project_id,b.objective.trim(),b.expected_result.trim(),deadline,user,now,now),
    c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO space_blackboard_events(tenant_id,space_id,event_id,project_id,request_id,kind,created_at) SELECT tenant_id,space_id,id||':pending',target_project_id,id,'request.pending',created_at FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=? AND source_project_id=? AND target_project_id=? AND objective=? AND expected_result=? AND deadline IS ? AND created_by=?")
      .bind(tenant,spaceId,b.id,b.source_project_id,b.target_project_id,b.objective.trim(),b.expected_result.trim(),deadline,user),
  ]);
  const row = await c.env.PLATFORM_DB.prepare("SELECT * FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND id=?").bind(tenant,spaceId,b.id).first<{source_project_id:string;target_project_id:string;objective:string;expected_result:string;deadline:string|null;created_by:string}>();
  if (!row || row.source_project_id !== b.source_project_id || row.target_project_id !== b.target_project_id || row.objective !== b.objective.trim() || row.expected_result !== b.expected_result.trim() || row.deadline !== deadline || row.created_by !== user) return c.json({ error_code: "request_id_conflict" }, 409);
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
app.post("/internal/spaces/:spaceId/blackboard/events/:projectId/:eventId/read", async c => {
  const spaceId=c.req.param("spaceId"), projectId=c.req.param("projectId"), eventId=c.req.param("eventId"), tenant=c.req.header("x-naelao-tenant-id")!, user=c.req.header("x-naelao-user-id")!;
  const denied=await requireReadableAutomationProject(c,spaceId,projectId); if(denied) return denied;
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) return c.json({ error_code:"invalid_event" },400);
  const event=await c.env.PLATFORM_DB.prepare("SELECT event_id FROM space_blackboard_events WHERE tenant_id=? AND space_id=? AND project_id=? AND event_id=?").bind(tenant,spaceId,projectId,eventId).first();
  if(!event) return c.json({ error_code:"event_not_found" },404);
  await c.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO space_blackboard_event_receipts(tenant_id,space_id,project_id,event_id,user_id,read_at) VALUES(?,?,?,?,?,?)").bind(tenant,spaceId,projectId,eventId,user,new Date().toISOString()).run();
  return c.json({ acknowledged:true,event_id:eventId });
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
// needs list/create/read here for a product_end_user caller — requireBusinessMembership adds the
// extra floor ONLY for that role (every other role is unaffected). rules/spend stay OFF the
// router's product_end_user allowlist entirely (server-to-server agent accounting, no-code rule
// config) — requireInternalHmac alone still fully gates them; no product_end_user request can
// ever reach them regardless of what's declared below.
app.use("/spaces/:spaceId/projects", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects", requireBusinessMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/projects/:projectId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId", requireBusinessMembership({ GET: "member" }));
registerProjectMcpRoutes(app, requireManageableAutomationProject);

// The LSP indexer is an optional, owner-installed project extension. Templates can name
// `ext_lsp_indexer`; installation and runtime checks remain project-scoped and fail closed.
app.post("/spaces/:spaceId/projects/:projectId/extensions/lsp-indexer", async (c) => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId");
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const identity = getCallerIdentity(c);
  const businessRole = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : identity.role;
  if (businessRole !== "owner" && businessRole !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  const manifest = DOGFOOD_EXTENSION_BY_ID["ext_lsp_indexer"];
  if (!manifest) return c.json({ error_code: "lsp_extension_unavailable" }, 503);
  const response = await (await spaceDoStub(c.env, spaceId, identity.tenantId)).fetch(new Request("http://space-do/extensions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId: identity.tenantId, spaceId,
      projectId, scope: "PROJECT_BOUND", gatekeeperCapabilities: manifest.capabilityRequirements }),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

// Owner/admin channel-only package installation. This path grants only the dedicated
// channel.invoke capability and deliberately excludes Canvas/Gadget/member tool primitives;
// those need their own host installers and grant review before they can be composed here.
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions", requireBusinessMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/channel-extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/channel-extensions", requireBusinessMembership({ POST: "admin" }));
const installChannelExtension = async (c: Context<{Bindings:Env}>) => {
  const spaceId = c.req.param("spaceId")!, projectId = c.req.param("projectId") || undefined;
  if (projectId) {
    const denied = await requireManageableAutomationProject(c, spaceId, projectId);
    if (denied) return denied;
  }
  const identity = getCallerIdentity(c);
  const role = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId)
    : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  if (!projectId) {
    const active=await c.env.PLATFORM_DB.prepare("SELECT s.id FROM spaces s JOIN orgs o ON o.id=s.tenant_id WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'").bind(spaceId,identity.tenantId).first();
    if(!active)return c.json({error_code:"space_unavailable"},403);
  }
  const body = await c.req.json<{ manifest?: unknown; scope?: unknown; handlerSources?: unknown; instanceKey?: string; upgrade?: boolean }>().catch(() => ({} as { manifest?: unknown; scope?: unknown; handlerSources?: unknown; instanceKey?: string; upgrade?: boolean }));
  const instanceKey = body.instanceKey ?? "default";
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return c.json({ error_code: "extension_instance_key_invalid" }, 400);
  if (body.upgrade !== undefined && body.upgrade !== true) return c.json({ error_code: "extension_upgrade_confirmation_invalid" }, 400);
  if (body.scope !== undefined && !(projectId ? ["PROJECT_BOUND", "PROJECT_SHARED"] : ["SPACE_SHARED"]).includes(String(body.scope))) return c.json({ error_code: "channel_install_scope_invalid" }, 400);
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try {
    manifest = validateExtensionManifest(body.manifest, { gatekeeperCapabilities: ["channel.invoke"] });
    const bundle = manifest.bundle;
    const channels = manifest.channels ?? [];
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
  const scope = !projectId ? "SPACE_SHARED" : body.scope === "PROJECT_SHARED" ? "PROJECT_SHARED" : "PROJECT_BOUND";
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
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
app.use("/spaces/:spaceId/extension-publishers", requireBusinessMembership({ GET: "admin", POST: "admin" }));
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
app.use("/spaces/:spaceId/extension-publishers/:keyId", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-publishers/:keyId", requireBusinessMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/extension-publishers/:keyId", async c => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "", spaceId = c.req.param("spaceId"), keyId = c.req.param("keyId"), identity = getCallerIdentity(c);
  if (!/^[a-f0-9]{64}$/.test(keyId) || !tenantId || !identity.userId) return c.json({ error_code: "publisher_key_id_invalid" }, 400);
  const result = await c.env.PLATFORM_DB.prepare(`UPDATE extension_publisher_keys SET status='revoked',revoked_by=?,revoked_at=datetime('now')
    WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(identity.userId, tenantId, spaceId, keyId).run();
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const invalidated = await stub.fetch(new Request(`http://space-do/extension-publisher-revoke?key_id=${encodeURIComponent(keyId)}`, { method: "POST" }));
  if (!invalidated.ok) return c.json({ error_code: "publisher_revocation_invalidation_unavailable" }, 503);
  return c.json({ revoked: true, key_id: keyId, changed: (result.meta?.changes ?? 0) > 0 });
});

// Project bundle installation for Canvas + Gadget + external channel + Durable Workflow
// compositions. Workflow code uses the host's restricted execute(step,ctx) ABI.
app.use("/spaces/:spaceId/projects/:projectId/extensions", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/extensions", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/extensions", async c => {
  const spaceId = c.req.param("spaceId"), projectId = c.req.param("projectId");
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const identity = getCallerIdentity(c);
  const role = identity.role === "product_end_user" && identity.userId
    ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId) : identity.role;
  if (role !== "owner" && role !== "admin") return c.json({ error_code: "space_admin_required" }, 403);
  const body = await c.req.json<{ manifest?: unknown; artifacts?: unknown; instanceKey?: string; upgrade?: boolean; publisherSignature?: { key_id?: unknown; signature?: unknown } }>().catch(() => ({} as { manifest?: unknown; artifacts?: unknown; instanceKey?: string; upgrade?: boolean; publisherSignature?: { key_id?: unknown; signature?: unknown } }));
  const instanceKey = body.instanceKey ?? "default";
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) return c.json({ error_code: "extension_instance_key_invalid" }, 400);
  if (body.upgrade !== undefined && body.upgrade !== true) return c.json({ error_code: "extension_upgrade_confirmation_invalid" }, 400);
  const requiredCapabilities = new Set<string>();
  let manifest: ReturnType<typeof validateExtensionManifest>;
  try {
    manifest = validateExtensionManifest(body.manifest, { gatekeeperCapabilities: ["extension.project_canvas", "extension.workflow", "channel.invoke"] });
    const bundle = manifest.bundle;
    const primitives = bundle?.primitives ?? [];
    if (!bundle || !primitives.length || primitives.some(item => !["canvas", "gadget", "channel", "workflow"].includes(item.kind))
      || manifest.containers?.length || manifest.daemons.length || manifest.commands.length || manifest.declaredPermissions.length)
      throw new Error("project_bundle_primitive_not_supported");
    if (bundle.primitives.some(item => item.kind === "canvas" || item.kind === "gadget")) requiredCapabilities.add("extension.project_canvas");
    if (bundle.primitives.some(item => item.kind === "workflow")) requiredCapabilities.add("extension.workflow");
    if (bundle.primitives.some(item => item.kind === "channel")) requiredCapabilities.add("channel.invoke");
    if (manifest.capabilityRequirements.length !== requiredCapabilities.size || manifest.capabilityRequirements.some(item => !requiredCapabilities.has(item)))
      throw new Error("project_bundle_capability_declaration_mismatch");
    const workflowIds = new Set(bundle.primitives.filter(item => item.kind === "workflow").map(item => item.id));
    if ((bundle.workerRoles ?? []).some(role => role.principal !== "project_member" || role.execution !== "worker" || !["workflow_step", "tool"].includes(role.invocation)
      || role.primitiveIds.some(id => !workflowIds.has(id)))) throw new Error("extension_worker_role_runtime_not_supported");
    const providerAllowlist = new Set(["whatsapp", "telegram", "slack", "discord", "email", "phone"]);
    const channels = bundle.primitives.filter(item => item.kind === "channel");
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
  // v1 runs one isolated execute(step, ctx) entrypoint; it can compose sequential
  // actions with step.do and ctx.tools.call. Additional roles become separate workflow parts.
  const workflowPaths = new Set(workflows.map(item => item.entry));
  if (canvases.some(item => !/^\.\/[A-Za-z0-9._-]{1,128}\.html$/.test(item.component)) || (!canvases.length && !gadgets.length && !channels.length && !workflows.length))
    return c.json({ error_code: "extension_artifact_declaration_invalid" }, 400);
  if (!body.artifacts || typeof body.artifacts !== "object" || Array.isArray(body.artifacts)) return c.json({ error_code: "extension_artifacts_required" }, 400);
  const artifacts = body.artifacts as Record<string, unknown>, required = new Set([
    ...canvases.map(item => item.component), ...channels.map(item => item.handlerScript), ...workflowPaths,
  ]);
  if (channels.some(channel => !/^\.\/[A-Za-z0-9._-]{1,128}\.(?:ts|js)$/.test(channel.handlerScript))) return c.json({ error_code: "extension_channel_artifact_invalid" }, 400);
  if (Object.keys(artifacts).length !== required.size || Object.keys(artifacts).some(path => !required.has(path))) return c.json({ error_code: "extension_artifacts_must_match_manifest" }, 400);
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "extension_artifact_storage_unavailable" }, 503);
  if ((channels.length || workflows.length) && !c.env.AGENTS_WORKER) return c.json({ error_code: "extension_source_validator_unavailable" }, 503);
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
    } else if (channels.some(channel => channel.handlerScript === path)) {
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
  const stub = await spaceDoStub(c.env, spaceId, identity.tenantId);
  const installed = await stub.fetch(new Request("http://space-do/extensions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, installedBy: identity.userId, tenantId: identity.tenantId, spaceId, projectId, scope: "PROJECT_BOUND", gatekeeperCapabilities: [...requiredCapabilities], artifactSha256: digest, instanceKey,
      publisherId: trustedPublisher.publisher_id, publisherKeyId, publisherSignature, publisherPayloadSha256, ...(body.upgrade ? { upgrade: true } : {}) }) }));
  if (!installed.ok) return new Response(installed.body, { status: installed.status, headers: { "content-type": installed.headers.get("content-type") ?? "application/json" } });
  const installedResult = await readBoundedResponseJson<{ release?: { version?: string; artifactSha256?: string; hostSignature?: string } }>(installed.clone(), 64 * 1024);
  if (canvases.length && (installedResult.release?.version !== bundle.version || installedResult.release.artifactSha256 !== digest
    || !/^[a-f0-9]{64}$/.test(installedResult.release.hostSignature ?? ""))) return c.json({ error_code: "extension_canvas_release_attestation_unavailable" }, 503);
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
    if (!init.ok) return c.json({ error_code: "extension_canvas_initialize_failed", message: (await readBoundedResponseText(init, 8 * 1024).catch(() => "")).slice(0, 300) }, init.status as 400 | 409 | 500);
  }
  for (const gadget of gadgets) {
    const appId = runtimeAppId(gadget.id);
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    const init = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/initialize", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: gadget.schemaSql ?? "", migrations: gadget.migrations ?? [] }) }));
    if (!init.ok) return c.json({ error_code: "extension_gadget_initialize_failed", message: (await readBoundedResponseText(init, 8 * 1024).catch(() => "")).slice(0, 300) }, init.status as 400 | 409 | 500);
  }
  if (canvases[0]) {
    const update = await stub.fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(identity.tenantId)}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewport_config: { component: "CanvasMount", resourceId: runtimeAppId(canvases[0].id) } }) }));
    if (!update.ok) return c.json({ error_code: "extension_canvas_mount_failed", installation: await readBoundedResponseJson(installed.clone(), 64 * 1024), message: (await readBoundedResponseText(update, 8 * 1024).catch(() => "")).slice(0, 300) }, 500);
  }
  return new Response(installed.body, { status: installed.status, headers: { "content-type": installed.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/extension-releases/rollback", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/extension-releases/rollback", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/extension-releases/rollback", async c => {
  const { tenantId, userId } = getCallerIdentity(c), spaceId = c.req.param("spaceId");
  if (!tenantId || !userId || !await canExportBlueprint(c, spaceId)) return c.json({ error_code: "owner_or_admin_required" }, 403);
  const body = await c.req.json<{ extension_id?: string; version?: string; project_id?: string }>().catch(() => ({} as { extension_id?: string; version?: string; project_id?: string }));
  if (!body.extension_id || !body.version || !body.project_id) return c.json({ error_code: "rollback_scope_required" }, 400);
  const denied = await requireManageableAutomationProject(c, spaceId, body.project_id);
  if (denied) return denied;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const installed = await stub.fetch(new Request("http://space-do/extension-installations?" + new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, extension_id: body.extension_id })));
  if (!installed.ok) return c.json({ error_code: "extension_installation_lookup_unavailable" }, 503);
  const rows = await readBoundedResponseJson<{ installations: Array<{ project_id: string | null }> }>(installed, 2 * 1024 * 1024);
  if (!rows.installations.some(item => item.project_id === body.project_id)) return c.json({ error_code: "project_extension_not_installed" }, 404);
  const response = await stub.fetch(new Request("http://space-do/extension-releases/rollback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extensionId: body.extension_id, version: body.version }) }));
  return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
});

app.use("/spaces/:spaceId/projects/:projectId/extensions/:extensionId/releases", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/extensions/:extensionId/releases", requireBusinessMembership({ GET: "admin" }));
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
  return stub.fetch(new Request("http://space-do/extension-releases?extension_id=" + encodeURIComponent(extensionId)));
});

app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId/session-state", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId/session-state", requireBusinessMembership({ GET: "admin", DELETE: "admin" }));
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
app.use("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId", requireBusinessMembership({ DELETE: "admin" }));
app.delete("/spaces/:spaceId/projects/:projectId/channel-extensions/:instanceId", async c => {
  const { spaceId, projectId, instanceId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  if (!c.env.AGENTS_WORKER) return c.json({ error_code: "channel_uninstall_unavailable" }, 503);
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized" }, 401);
  const cleanup = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/channel-extensions/session-state", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ spaceId, projectId, installationId: instanceId, action: "uninstall" }),
  }));
  if (!cleanup.ok) return new Response(cleanup.body, { status: cleanup.status, headers: { "content-type": "application/json" } });
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const removed = await stub.fetch(new Request("http://space-do/extension-installation?" + new URLSearchParams({
    instance_id: instanceId, tenant_id: tenantId, space_id: spaceId, project_id: projectId,
  }), { method: "DELETE" }));
  return new Response(removed.body, { status: removed.status, headers: { "content-type": "application/json" } });
});

app.use("/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/lifecycle", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
app.patch("/spaces/:spaceId/projects/:projectId/extension-installations/:instanceId/lifecycle", async c => {
  const { spaceId, projectId, instanceId } = c.req.param();
  const denied = await requireManageableAutomationProject(c, spaceId, projectId);
  if (denied) return denied;
  const body = await c.req.json<{ action?: "enable" | "disable" }>().catch((): { action?: "enable" | "disable" } => ({}));
  if (body.action !== "enable" && body.action !== "disable") return c.json({ error_code: "extension_lifecycle_action_invalid" }, 400);
  const tenantId = getCallerIdentity(c).tenantId;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return stub.fetch(new Request("http://space-do/project-extension-lifecycle", { method: "PATCH",
    headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) },
    body: JSON.stringify({ tenantId, spaceId, projectId, instanceId, action: body.action }) }));
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

// Step 21: a customer-bot's no-code automation rules ("after the customer says X, this happens")
// are now editable from the business's own Automation dashboard — opened to a business ADMIN (the
// person who owns the business), same admin-floor precedent as model-config/assistant-policy/
// scheduled-jobs. GET is member (any teammate may see how the bot is wired); POST/DELETE are admin.
// The `:ruleId` DELETE path ALSO gets requireInternalHmac here, closing a pre-existing gap — the
// bare-`/rules` app.use never matched the `/rules/:ruleId` sub-path, so DELETE had no came-through-
// router gate at all (harmless in practice — workers_dev=false + never router-allowlisted — but
// wrong; every sibling item path (members/:userId, local-grants/:grantId) gates both levels).
app.use("/spaces/:spaceId/projects/:projectId/rules", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/rules", requireBusinessMembership({ GET: "member", POST: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/rules/:ruleId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/rules/:ruleId", requireBusinessMembership({ DELETE: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/spend", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));

app.use("/spaces/:spaceId/projects/:projectId/usage", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/usage", requireBusinessMembership({ GET: "admin" }));
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
    c.executionCtx.waitUntil(c.env.AGENTS_WORKER.fetch(new Request(`http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications?project_id=${encodeURIComponent(created.id)}`,{method:"POST",headers:{"content-type":"application/json","x-naelao-tenant-id":tenantId,"x-naelao-user-id":identity.userId,"x-naelao-role":identity.role,"x-naelao-internal-token":await mintInternalToken(c.env.PLATFORM_SECRET,tenantId)},body:JSON.stringify({action:"identity"})})).then(()=>undefined).catch(()=>{console.warn("Project assistant identity provisioning deferred");}));
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

/** Stamp a canonical drop-in room into an existing SpaceDO. */
app.use("/spaces/:spaceId/project-templates/:templateId/stamp", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/project-templates/:templateId/stamp", requireBusinessMembership({ POST: "member" }));
app.post("/spaces/:spaceId/project-templates/:templateId/stamp", async (c) => {
  const spaceId = c.req.param("spaceId");
  const templateId = c.req.param("templateId");
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const body = await c.req.json<{ overrides?: { name?: string } }>().catch((): { overrides?: { name?: string } } => ({}));
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, "/project-templates/stamp", "POST", JSON.stringify({
    space_id: spaceId, template_id: templateId, overrides: body.overrides ?? {},
  }));
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
app.use("/spaces/:spaceId/projects/:projectId/mode", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/mode", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/projects/:projectId/subspace-migration-preflight", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/subspace-migration-preflight", requireBusinessMembership({ GET: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/graduate-to-subspace", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/graduate-to-subspace", requireBusinessMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/projects/:projectId/return-to-parent", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/return-to-parent", requireBusinessMembership({ POST: "admin" }));
for (const route of ["/spaces/:spaceId/sub-spaces/:subId/projects", "/spaces/:spaceId/sub-spaces/:subId/projects/*"]) {
  app.use(route, requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
  app.use(route, requireBusinessMembership({ GET: "member", POST: "member" }));
}
for (const route of ["/spaces/:spaceId/sub-spaces/:subId/members", "/spaces/:spaceId/sub-spaces/:subId/members/*"]) {
  app.use(route, requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
  app.use(route, requireBusinessMembership({ GET: "member", POST: "member", DELETE: "member" }));
}
app.use("/spaces/:spaceId/projects/:projectId/promote", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/promote", requireBusinessMembership({ POST: "admin" }));

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

// File types the shell's viewer renders natively (PDF and raster images). Office archives remain
// downloadable without parsing their untrusted ZIP/XML contents in the browser. Binary reads are
// returned as base64 instead of obj.text() so bytes are preserved exactly.
const VIEWABLE_BINARY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function viewableBinaryType(path: string): string | undefined {
  return VIEWABLE_BINARY_TYPES[(path.split(".").pop() ?? "").toLowerCase()];
}
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // chunked so a 2MB buffer never blows String.fromCharCode's arg limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
/** Read one workspace object: text inline, a viewable binary as base64, else a binary marker. */
async function readWorkspaceObject(obj: R2ObjectBody, relative: string): Promise<Response> {
  if (obj.size > WORKSPACE_MAX_FILE_BYTES) {
    return Response.json({ path: relative, size: obj.size, too_large: true, message: "File exceeds the 2MB inline view limit" });
  }
  const contentType = viewableBinaryType(relative);
  const bytes = await obj.arrayBuffer();
  if (bytes.byteLength !== obj.size || bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    return Response.json({ path: relative, size: obj.size, error_code: "workspace_file_changed_during_read" }, { status: 409 });
  }
  if (contentType) {
    const b64 = arrayBufferToBase64(bytes);
    return Response.json({ path: relative, size: obj.size, encoding: "base64", content_type: contentType, content: b64 });
  }
  return Response.json({ path: relative, size: obj.size, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) });
}
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workspace/files", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
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
app.use("/spaces/:spaceId/projects/:projectId/workspace/files/*", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/projects/:projectId/workspace/files/*", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const identity = getCallerIdentity(c);
  const tenantId = c.req.header("x-naelao-tenant-id") ?? identity.tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const access = await forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}?viewer_id=${encodeURIComponent(identity.userId)}`, "GET");
  if (!access.ok) return new Response(access.body, { status: access.status, headers: { "content-type": "application/json" } });
  if (!c.env.SCRIPTS_R2) return c.json({ error_code: "unavailable", message: "Workspace storage not configured" }, 503);
  const prefix = workspaceKeyPrefix(spaceId, projectId);
  const rest = c.req.path.split("/workspace/files/")[1] ?? "";
  // Collapse any .. traversal server-side; the key must stay inside the project's own prefix.
  const relative = decodeURIComponent(rest).split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  if (!relative) return c.json({ error_code: "bad_request", message: "file path required" }, 400);
  const obj = await c.env.SCRIPTS_R2.get(prefix + relative);
  if (!obj || obj.customMetadata?.deleted === "true") return c.json({ error_code: "not_found", message: "File not found" }, 404);
  return readWorkspaceObject(obj, relative);
});

// The visual workflow authoring surface can save only validated workflow source paths. It cannot
// overwrite arbitrary project artifacts or add capabilities; runtime grants remain authoritative.
app.use("/spaces/:spaceId/projects/:projectId/workflows/plan", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/workflows/plan", requireBusinessMembership({ POST: "admin" }));
app.post("/spaces/:spaceId/projects/:projectId/workflows/plan", async c => {
  const { spaceId, projectId } = c.req.param(), identity = getCallerIdentity(c);
  if (!identity.tenantId || !identity.userId) return c.json({ error_code: "unauthorized" }, 401);
  const role = identity.role === "product_end_user" ? await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, identity.userId) : identity.role;
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
  if (await c.env.SCRIPTS_R2.head(key)) return c.json({ error_code: "workflow_plan_draft_exists", message: "Choose a new workflow name to preserve the existing draft." }, 409);
  const compilation = await c.env.AGENTS_WORKER.fetch(new Request("http://agents-worker/internal/workflow-extensions/compile", {
    method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": identity.tenantId,
      "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, identity.tenantId) }, body: JSON.stringify({ source }),
  }));
  if (!compilation.ok) {
    const detail = await compilation.json<{ error_code?: string; message?: string }>().catch((): { error_code?: string; message?: string } => ({}));
    return c.json({ error_code: detail.error_code ?? "workflow_plan_compile_failed", message: detail.message }, 400);
  }
  const compiled = await compilation.json<{ digest?: string; bytes?: number }>();
  const saved = await c.env.SCRIPTS_R2.put(key, source, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "text/typescript; charset=utf-8" }, customMetadata: { authorId: identity.userId, kind: "compiled_workflow_plan" } });
  if (!saved) return c.json({ error_code: "workflow_plan_draft_exists", message: "Choose a new workflow name to preserve the existing draft." }, 409);
  return c.json({ saved: true, path: relative, digest: compiled.digest, bytes: compiled.bytes });
});

// The space worker authorizes node-level document editing; lease owner identity always comes
// from the verified shell session, never from a client-supplied holder_id.
app.use("/spaces/:spaceId/projects/:projectId/document-nodes/:nodeId/lease", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/projects/:projectId/document-nodes/:nodeId/lease", requireBusinessMembership({ POST: "member" }));
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
app.use("/spaces/:spaceId/tunnels", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/tunnels/*", requireBusinessMembership({ GET: "member", POST: "admin", DELETE: "admin" }));
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
// it. This wrapper adds the missing requireBusinessMembership check, then proxies to the
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
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  if (!c.env.AGENTS_WORKER) {
    return Response.json({ error_code: "connectors_unavailable", message: "Agents worker not configured" }, { status: 503 });
  }
  const identity = getCallerIdentity(c);
  // Prefer the already-verified header set by the
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
app.use("/spaces/:spaceId/llm-byok", requireBusinessMembership({ GET: "member", PUT: "admin" }));
app.use("/spaces/:spaceId/llm-byok/models", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/models", requireBusinessMembership({ GET: "member" }));
app.use("/spaces/:spaceId/llm-byok/select", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/select", requireBusinessMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/llm-byok/remove", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/remove", requireBusinessMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/llm-byok/:provider", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/llm-byok/:provider", requireBusinessMembership({ DELETE: "admin" }));

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
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  if (!(await authorizeDepartmentMember(stub, userId, spaceId, "read")).permitted)
    return c.json({ error_code: "forbidden" }, 403);
  return forwardToSpaceDO(stub, `/projects/${encodeURIComponent(projectId)}/sub-spaces`, "GET");
});

app.post("/spaces/:spaceId/projects/:projectId/sub-spaces", async (c) => {
  const { spaceId, projectId } = c.req.param();
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized" }, 401);
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

// Tenant-provided OAuth apps use the same admin boundary as platform OAuth. Forward credentials
// only to the Agents worker's vault-sealing setup route; they are never echoed to the client.
app.use("/spaces/:spaceId/connectors/custom-oauth-start", requireBusinessMembership({ POST: "admin" }));
app.use("/spaces/:spaceId/connectors/custom-oauth-redirect", requireBusinessMembership({ GET: "admin" }));
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
app.use("/spaces/:spaceId/connectors/provider-connect-start", requireBusinessMembership({ POST: "admin" }));
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
app.use("/spaces/:spaceId/agents/custom", requireBusinessMembership({ POST: "admin" }));
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
  const userId = c.req.query("user_id");
  if (userId) qs.set("user_id", userId);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const res = await forwardToSpaceDO(stub, `/presence?${qs.toString()}`, "GET");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});

// Event triggers (@naelao/events) — no-code "after X happens (thread created, project
// created, ...), run script Y." Automation is always owned by a project.
app.use("/spaces/:spaceId/event-triggers", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/event-triggers", requireBusinessMembership({ GET: "member", POST: "admin" }));
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
// reachable route in this file already has. POST/PATCH/DELETE were originally un-allowlisted
// entirely — Phase 3 item 27/28's Crons editing UI (below) added requireBusinessMembership's
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
// job at all, only a JWT builder. requireBusinessMembership's admin floor is what makes this
// safe (same precedent as model-config/assistant-policy PATCH): a plain member still can't
// create/edit one, and a caller who isn't a member of THIS business at all is refused before
// reaching the handler. GET keeps its existing member floor, just expressed as middleware
// instead of an inline check so PATCH/DELETE below can share the same convention.
app.use("/spaces/:spaceId/scheduled-jobs", requireBusinessMembership({ GET: "member", POST: "admin" }));
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
app.use("/spaces/:spaceId/project-steward/reviews", requireBusinessMembership({ GET: "member" }));
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
app.use("/spaces/:spaceId/project-steward/reviews/decision", requireBusinessMembership({ POST: "admin" }));
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
app.use("/spaces/:spaceId/scheduled-jobs/:jobId", requireBusinessMembership({ PATCH: "admin", DELETE: "admin" }));
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
    const role = await resolveEndUserBusinessRole(c.env.PLATFORM_DB, spaceId, callerIdentity.userId);
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

// Internal read used by NaelaoAgentDO's final model gate. Public callers are checked at
// /agent/run, but scheduled/channel/worker dispatches can enter the DO directly; keeping this
// lookup behind the platform HMAC makes the DO's policy decision independent of its ingress.
app.use("/internal/spaces/:spaceId/model-policy", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.get("/internal/spaces/:spaceId/model-policy", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT config_json, parent_space_id FROM spaces WHERE id = ? AND tenant_id = ?"
  ).bind(spaceId, tenantId).first<{ config_json: string | null; parent_space_id: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "Space not found" }, 404);
  let policy: SpaceModelPolicy | null = null;
  try {
    const localConfig = JSON.parse(row.config_json || "{}") as {
      model_policy?: { mode?: string; allowedModelIds?: unknown };
      productConfig?: { modelPolicy?: { mode?: string; allowedModelIds?: unknown } };
    };
    const productRow = row.parent_space_id
      ? await c.env.PLATFORM_DB.prepare("SELECT config_json FROM spaces WHERE id = ? AND tenant_id = ?").bind(row.parent_space_id, tenantId).first<{ config_json: string | null }>()
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

// Space-scoped user preferences. The user id is always derived from verified claims so callers
// can change only their own presentation and detail-filter preferences.
app.use("/spaces/:spaceId/preferences", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/preferences", requireBusinessMembership({ GET: "member", PUT: "member" }));
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

// Browser Web Push: membership is checked here, then the tenant-scoped internal HMAC protects
// the Notifications Worker storage operation. A user can only enroll/remove their own endpoint.
app.use("/spaces/:spaceId/push-notifications", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/push-notifications", requireBusinessMembership({ GET: "member", PUT: "member", DELETE: "member" }));
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
// route: `requireBusinessMembership({ GET: "member" })` above already defaults PATCH to
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
// agents worker's tasks prebuilt mints this via mintInternalToken); requireBusinessMembership
// then checks the ACTING PERSON the agent is running on behalf of (forwarded x-naelao-user-id) —
// a plain member may read/create/progress tasks, same floor as creating a thread.
app.use("/spaces/:spaceId/tasks", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tasks", requireBusinessMembership({ GET: "member", POST: "member" }));
app.use("/spaces/:spaceId/tasks/:taskId", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/tasks/:taskId", requireBusinessMembership({ PATCH: "member", DELETE: "member" }));

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
app.use("/spaces/:spaceId/pull-request-cards", requireBusinessMembership({ GET: "member", POST: "member" }));
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
app.use("/spaces/:spaceId/tasks/:taskId/lease", requireBusinessMembership({ POST: "member" }));
app.post("/spaces/:spaceId/tasks/:taskId/lease", async c => {
  const { spaceId, taskId } = c.req.param();
  const tenantId = c.req.header("x-naelao-tenant-id");
  if (!tenantId || !spaceId || !taskId) return c.json({ error_code: "unauthorized" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  return forwardToSpaceDO(stub, `/tasks/${encodeURIComponent(taskId)}/lease`, "POST", await readBoundedRequestText(c.req.raw, 1024 * 1024));
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
  const { tenantId, userId } = getCallerIdentity(c);
  if (!tenantId || !userId) return c.json({ error_code: "unauthorized", message: "Missing authenticated user or tenant" }, 401);

  // Resolve the product (D1) to gate on productConfig + know the parent space_type.
  const product = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json, tenancy_mode, depth, parent_space_id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
  ).bind(spaceId, tenantId).first<{ spacetype_id: string; config_json: string | null; tenancy_mode: string; depth: number; parent_space_id: string | null }>();
  if (!product) throw notFound("Space");
  if (product.depth >= 1 || product.parent_space_id) {
    return c.json({ error_code: "max_depth_exceeded", message: "A department cannot have child spaces" }, 400);
  }
  if (product.spacetype_id !== "launchpad") {
    return c.json({ error_code: "invalid_hierarchy", message: "Departments require a Launchpad root" }, 400);
  }

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

  const parentId = body.parent_id ?? spaceId;
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const auth = await forwardToSpaceDO(stub, `/hierarchy-authorize?user_id=${encodeURIComponent(userId)}&target_space_id=${encodeURIComponent(parentId)}`, "GET");
  const authorization = await auth.json<{ permitted?: boolean }>().catch(() => ({} as { permitted?: boolean }));
  if (!auth.ok || authorization.permitted !== true) return c.json({ error_code: "forbidden", message: "Administrative membership is required" }, 403);

  // Builders (owner/admin) may select a type (subject to agency_shell rules in the DO);
  // end-user roles are forced to the parent's type.
  const payload = {
    parent_id: parentId,
    name: body.name,
    scenario_type: "organizational" as const,
    ...(body.space_type ? { space_type: body.space_type } : { force_parent_type: true }),
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
  if (!auth.ok) return c.json({ error_code: "forbidden", message: "Administrative membership is required" }, 403);
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
app.use("/spaces/:spaceId/agent-analytics", requireBusinessMembership({ GET: "member" }));
app.get("/spaces/:spaceId/agent-analytics", async (c) => {
  const spaceId = c.req.param("spaceId");
  const tenantId = c.req.header("x-naelao-tenant-id") ?? getCallerIdentity(c).tenantId;
  if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
  const stub = await spaceDoStub(c.env, spaceId, tenantId);
  const qs = new URL(c.req.url).search;
  const res = await forwardToSpaceDO(stub, `/agent-analytics${qs}`, "GET");
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
  const root = await resolveProductRootSpace(c.env, spaceId);
  if (!root) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
  if (root.tenant_id !== c.req.header("x-naelao-tenant-id")) return c.json({error_code:"forbidden"},403);

  const stub = await productUserDoStub(c.env, root.id, endUserId, root.tenant_id);
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
  let body: {credits:number;reason?:string;model?:string;idempotency_key?:string};
  try {body=JSON.parse(await readBoundedRequestText(c.req.raw,16384));} catch {return c.json({error_code:"bad_request"},400);}
  if (!body || !Number.isSafeInteger(body.credits) || body.credits <= 0
    || body.idempotency_key !== undefined && (typeof body.idempotency_key !== "string" || body.idempotency_key.length < 1 || body.idempotency_key.length > 200)) {
    return c.json({error_code:"bad_request",message:"credits must be a positive safe integer and the retry key must be bounded"},400);
  }
  const root = await resolveProductRootSpace(c.env, spaceId);
  if (!root) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
  if (root.tenant_id !== c.req.header("x-naelao-tenant-id")) return c.json({error_code:"forbidden"},403);
  const stub = await productUserDoStub(c.env, root.id, endUserId, root.tenant_id);
  const deductRes = await stub.fetch(new Request("http://do/credits/deduct", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credits: body.credits, reason: body.reason ?? "agent_run", ...(body.model ? { model: body.model } : {}), ...(body.idempotency_key ? {idempotency_key:body.idempotency_key}:{}) }),
  }));
  const result = await deductRes.json<{ balance_credits: number; error?: string }>();
  return c.json(result, deductRes.status as 201 | 402 | 400);
});

app.use("/internal/product-users/:spaceId/:endUserId/credits/reservations", requireInternalHmac((c) => (c as unknown as { env: Env }).env.PLATFORM_SECRET));
app.post("/internal/product-users/:spaceId/:endUserId/credits/reservations", async (c) => {
  const spaceId = c.req.param("spaceId"), endUserId = c.req.param("endUserId");
  let body: {action?:string;reservation_id?:string;run_id?:string;credits?:number};
  try {body=JSON.parse(await readBoundedRequestText(c.req.raw,16384));} catch {return c.json({error_code:"bad_request"},400);}
  if (!body || !body.action || !body.run_id) return c.json({ error_code: "bad_request" }, 400);
  const root = await resolveProductRootSpace(c.env, spaceId);
  if (!root) return c.json({ error_code: "not_found" }, 404);
  if (root.tenant_id !== c.req.header("x-naelao-tenant-id")) return c.json({error_code:"forbidden"},403);
  const stub = await productUserDoStub(c.env, root.id, endUserId, root.tenant_id);
  const response = await stub.fetch(new Request("http://do/credits/reservations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
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
  const root = await resolveProductRootSpace(c.env, spaceId);
  if (!root) return c.json({ error_code: "not_found", message: "Product not found" }, 404);
  if (root.tenant_id !== c.req.header("x-naelao-tenant-id")) return c.json({error_code:"forbidden"},403);
  // Pricing (like the plan/credit-pack catalog — see loadPricingCatalog's own comment) is
  // authored on the product ROOT, never on a business's own row — read the root's config, not
  // whatever spaceId was passed in.
  const rootRow = await c.env.PLATFORM_DB.prepare(
    "SELECT spacetype_id, config_json FROM spaces WHERE id = ? AND status != 'deleted'"
  ).bind(root.id).first<{ spacetype_id: string; config_json: string | null }>();
  if (!rootRow) return c.json({ error_code: "not_found", message: "Product not found" }, 404);

  const pc = await loadEffectiveProductConfig(c.env, rootRow.spacetype_id, rootRow.config_json);
  const pricingConfig = pc?.pricingConfig;
  const isFreeOrUnconfigured = !pricingConfig || pricingConfig.model === "free";
  const monthlyCredits = pricingConfig?.creditsIncludedPerMonth
    ?? (isFreeOrUnconfigured ? FREE_TIER_DEFAULT_SIGNUP_CREDITS : 0);
  if (monthlyCredits <= 0) return c.json({ granted: false, reason: "no_monthly_allowance" });

  const monthKey = new Date().toISOString().slice(0, 7); // "2026-07" — one grant per calendar month
  const stub = await productUserDoStub(c.env, root.id, endUserId, root.tenant_id);
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
  let spaceConfig: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(space.config_json ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) spaceConfig = parsed as Record<string, unknown>; } catch { /* malformed legacy config uses product default */ }

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
  const root = await resolveProductRootSpace(c.env, spaceId);
  if (!root || !tenantId || root.tenant_id !== tenantId) return c.json({ error_code: "not_found", message: "End user not found" }, 404);
  const row = await c.env.PLATFORM_DB.prepare(
    "SELECT email, display_name, first_seen_at, last_seen_at, suspended_at, email_verified_at, preferred_language FROM product_end_users WHERE product_space_id = ? AND end_user_id = ?"
  ).bind(root.id, userId).first<{ email: string | null; display_name: string | null; first_seen_at: string; last_seen_at: string | null; suspended_at: string | null; email_verified_at: string | null; preferred_language: string | null }>();
  if (!row) return c.json({ error_code: "not_found", message: "End user not found" }, 404);

  const stub = await productUserDoStub(c.env, root.id, userId, root.tenant_id);
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
    preferred_language: row.preferred_language,
  });
});

app.patch("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductRootSpace(c.env, spaceId);
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
  const root = await resolveProductRootSpace(c.env, spaceId);
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
// roster row's PII. Deliberately does NOT cascade into business_memberships or SpaceDO's own
// thread/message history (a separate, older GDPR erasure mechanism — see G-AO31 above) — a real,
// documented boundary for a future pass, not silently dropped.
app.delete("/spaces/:spaceId/product-users/me", async (c) => {
  const spaceId = c.req.param("spaceId");
  const { role, userId, tenantId } = getCallerIdentity(c);
  if (role !== "product_end_user" || !userId) {
    return c.json({ error_code: "not_an_end_user", message: "This route is for product end users only" }, 404);
  }
  const root = await resolveProductRootSpace(c.env, spaceId);
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
// Three-Tier Platform Model, Phase C (docs/spec-appendix A1.17) — businesses, space switcher, invites.
registerBusinessRoutes(app);

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
    if (env.PROVISION_QUEUE) {
      const provisions = await dispatchPendingProvisioningOutbox(env.PLATFORM_DB, env.PROVISION_QUEUE);
      console.log(`[provisioning-outbox] sent=${provisions.sent} deferred=${provisions.deferred}`);
    }
    if (env.EVENTS_QUEUE) {
      const erasures = await dispatchPendingErasureOutbox(env.PLATFORM_DB, env.EVENTS_QUEUE);
      console.log(`[erasure-outbox] sent=${erasures.sent} deferred=${erasures.deferred}`);
    }
  },
} satisfies ExportedHandler<Env>;
