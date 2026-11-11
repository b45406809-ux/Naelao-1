import { applyDurableObjectJurisdiction } from "@naelao/security";
import { mintInternalToken, verifyInternalToken, readBoundedResponseJson } from "@naelao/http";
import { EntitlementsChecker } from "@naelao/entitlements";
import { ToolSandboxDO, type ContainerRuntime } from "./ToolSandboxDO.js";
import { parseApprovedContainerImages, type ContainerInvocationScope } from "../script-engine/container-policy.js";
import { assertDynamicPlan, dynamicCreditsPerHour, dynamicPlanLimits, isDynamicProfile, selectDynamicProfile, type DynamicProfile } from "../script-engine/dynamic-containers.js";

interface DynamicBindings {
  PLATFORM_SECRET: string;
  DATA_JURISDICTION?: "eu";
  PLATFORM_DB?: D1Database;
  CONCURRENCY_DO?: DurableObjectNamespace;
  CONTAINER_IMAGE_REGISTRY?: string;
  DYNAMIC_CONTAINERS_ENABLED?: string;
  DYNAMIC_CONTAINER_BASE_PROFILE?: string;
  DYNAMIC_CONTAINER_MAX_INSTANCES?: string;
  DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED?: string;
}
interface Selection { image: string; profile: DynamicProfile; owner: string; fingerprint: string; tier: string }
interface SavedSnapshot {
  id: string;
  fingerprint: string;
  ownerFingerprint?: string;
  imageDigest?: string;
  profile?: DynamicProfile;
  allocationGeneration?: number;
  sizeBytes?: number;
  createdAt: number;
  expiresAt?: number;
}
interface Capacity { holder: string; tenant: string; expiresAt: number }
const SNAPSHOT_RECOVERY_TTL_MS = 29 * 24 * 60 * 60 * 1000;
function snapshotMetadataInvalid(snapshot: SavedSnapshot): boolean {
  return snapshot.sizeBytes !== undefined && (!Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0)
    || snapshot.allocationGeneration !== undefined && (!Number.isSafeInteger(snapshot.allocationGeneration) || snapshot.allocationGeneration < 0)
    || snapshot.expiresAt !== undefined && !Number.isFinite(snapshot.expiresAt);
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, "0")).join("");
}

/** New application for Cloudflare's immutable durable_object scheduling policy. All execution,
 * CAS workspace publication, authorization, cancellation and billing stay in ToolSandboxDO.
 */
export class DynamicSandboxDO extends ToolSandboxDO {
  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof ToolSandboxDO>[1]) {
    super(ctx, env);
    const bindings = env as DynamicBindings;
    applyDurableObjectJurisdiction(env as Record<string, unknown>, bindings.DATA_JURISDICTION, ["CONCURRENCY_DO"]);
  }
  private selected: Selection | undefined;
  private get bindings(): DynamicBindings { return this.env as DynamicBindings; }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/_internal/profile") {
      const scope: { tenantId?: string; reset?: boolean } = await request.json<{ tenantId?: string; reset?: boolean }>().catch(() => ({}));
      if (!scope.tenantId || !this.bindings.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined,
        scope.tenantId, this.bindings.PLATFORM_SECRET)) return new Response(null, { status: 403 });
      if (scope.reset === true) {
        await this.stopContainer().catch(() => undefined);
        await this.ctx.storage.delete("dynamic_snapshot");
        await this.ctx.storage.delete("dynamic_restored");
        await this.ctx.storage.delete("dynamic_snapshot_restore_candidate");
        await this.ctx.storage.delete("dynamic_snapshot_restored_id");
        await this.ctx.storage.delete("dynamic_snapshot_restore_error");
        await this.ctx.storage.delete("dynamic_snapshot_save_error");
        await this.ctx.storage.delete("dynamic_selection");
        return Response.json({ reset: true, providerSnapshotPurge: "not_supported" });
      }
      const snapshot = await this.ctx.storage.get<SavedSnapshot>("dynamic_snapshot");
      const selection = await this.ctx.storage.get<Selection>("dynamic_selection");
      const restoreError = await this.ctx.storage.get<string>("dynamic_snapshot_restore_error")
        ?? (await this.ctx.storage.get<string>("dynamic_snapshot_restore_candidate") ? "dynamic_snapshot_restore_incomplete" : undefined);
      const saveError = await this.ctx.storage.get<string>("dynamic_snapshot_save_error");
      const snapshotExpiresAt = snapshot ? (snapshot.expiresAt ?? snapshot.createdAt + SNAPSHOT_RECOVERY_TTL_MS) : undefined;
      const selectedImageDigest = selection ? await digest(selection.image) : undefined;
      const snapshotStatusError = snapshot
        ? !snapshot.id || !snapshot.fingerprint || !Number.isFinite(snapshot.createdAt) || snapshotMetadataInvalid(snapshot) ? "dynamic_snapshot_record_invalid"
          : this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED !== "true" ? "dynamic_snapshot_restore_disabled"
            : selection?.fingerprint !== snapshot.fingerprint ? "dynamic_snapshot_incompatible"
              : snapshot.ownerFingerprint !== undefined && snapshot.ownerFingerprint !== selection?.owner ? "dynamic_snapshot_incompatible"
                : snapshot.imageDigest !== undefined && snapshot.imageDigest !== selectedImageDigest ? "dynamic_snapshot_incompatible"
                  : snapshot.profile !== undefined && JSON.stringify(snapshot.profile) !== JSON.stringify(selection?.profile) ? "dynamic_snapshot_incompatible"
                    : !Number.isFinite(snapshotExpiresAt) ? "dynamic_snapshot_record_invalid"
                      : snapshotExpiresAt! <= Date.now() ? "dynamic_snapshot_expired" : undefined
        : undefined;
      const recoveryError = restoreError ?? snapshotStatusError;
      const retryableRestoreFailure = restoreError === "dynamic_snapshot_restore_failed"
        || restoreError === "dynamic_snapshot_restore_incomplete";
      const canRestore = Boolean(snapshot && !snapshotStatusError && (!restoreError || retryableRestoreFailure)
        && this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED === "true");
      return Response.json({ enabled: this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED === "true",
        state: recoveryError ? "recovery_required" : snapshot ? "checkpointed" : this.container?.running ? "active" : "empty",
        image: selection?.image, checkpoint_created_at: snapshot?.createdAt,
        checkpoint_size_bytes: snapshot?.sizeBytes, checkpoint_generation: snapshot?.allocationGeneration,
        checkpoint_expires_at: snapshotExpiresAt, recovery_error: recoveryError,
        snapshot_save_error: saveError,
        can_restore: canRestore });
    }
    if (new URL(request.url).pathname === "/_internal/images") {
      if (!this.bindings.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined,
        "naelao-container-catalogue", this.bindings.PLATFORM_SECRET)) return new Response(null, { status: 403 });
      return Response.json({ enabled: this.bindings.DYNAMIC_CONTAINERS_ENABLED === "true", images: Object.values(this.container?.images ?? {}) });
    }
    const response = await super.fetch(request);
    const restoreCandidate = await this.ctx.storage.get<string>("dynamic_snapshot_restore_candidate");
    if (restoreCandidate && !response.ok && !await this.ctx.storage.get("dynamic_snapshot_restore_error"))
      await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_restore_failed");
    return response;
  }

  protected override async prepareAllocation(scope: ContainerInvocationScope): Promise<void> {
    const env = this.bindings;
    if (env.DYNAMIC_CONTAINERS_ENABLED !== "true") throw new Error("dynamic_containers_disabled");
    // The authoritative plan is read at execution time; model/tool arguments cannot raise it.
    if (!env.PLATFORM_DB) throw new Error("container_subscription_service_unavailable");
    const tier = await new EntitlementsChecker(env.PLATFORM_DB).getTenantTier(scope.tenantId);
    let image = this.container?.images?.base;
    const baseProfile = env.DYNAMIC_CONTAINER_BASE_PROFILE ?? "standard-1";
    if (!isDynamicProfile(baseProfile)) throw new Error("container_base_profile_invalid");
    let profile: DynamicProfile = baseProfile;
    if (scope.installationId) {
      const approved = parseApprovedContainerImages(env.CONTAINER_IMAGE_REGISTRY).find(pin => pin.image === scope.image);
      if (!approved || approved.schedulingPolicy !== "durable_object") throw new Error("container_dynamic_image_not_approved");
      image = approved.image;
      profile = selectDynamicProfile(approved.cpuCores, approved.memoryMb);
    } else if (scope.image || scope.dynamicImage) throw new Error("container_installation_required");
    if (!image || !Object.values(this.container?.images ?? {}).includes(image)) throw new Error("container_image_not_in_deployed_image_map");
    assertDynamicPlan(profile, tier);
    // Project-scoped main computers survive run boundaries. Non-project assistant sessions
    // remain run-scoped, while installed sidecars remain bound to their installation identity.
    const owner = await digest(JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId ?? null,
      scope.installationId ?? null, scope.installationScope ?? null,
      scope.installationId || scope.projectId ? null : scope.runId]));
    // Egress-policy changes invalidate snapshots as well as warm processes.
    const fingerprint = await digest(JSON.stringify([image, profile, owner,
      await this.ctx.storage.get("container_egress_profile")]));
    const selected: Selection = { image, profile, owner, fingerprint, tier };
    const current = await this.ctx.storage.get<Selection>("dynamic_selection");
    if (current && current.owner !== owner) throw new Error("container_session_owner_mismatch");
    if (current && (current.image !== image || current.profile !== profile)) await this.stopContainer();
    this.selected = selected;
    await this.ctx.storage.put("dynamic_selection", selected);
  }

  protected override allocationCreditsPerHour(): number | undefined {
    return this.selected ? dynamicCreditsPerHour(this.selected.profile) : undefined;
  }

  private async capacityRequest(path: "acquire" | "release", key: string, capacity: Capacity, limit?: number): Promise<void> {
    const env = this.bindings;
    if (!env.CONCURRENCY_DO || !env.PLATFORM_SECRET) throw new Error("container_capacity_service_unavailable");
    const stub = env.CONCURRENCY_DO.get(env.CONCURRENCY_DO.idFromName("dynamic-container-capacity"));
    const response = await stub.fetch(new Request("http://concurrency/" + path, { method: "POST", headers: {
      "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, capacity.tenant),
    }, body: JSON.stringify({ key, holder_id: capacity.holder, ...(limit ? { limit, ttl_ms: Math.max(1, capacity.expiresAt - Date.now()) } : {}) }), signal: AbortSignal.timeout(5000) }));
    if (!response.ok) throw new Error("container_capacity_service_unavailable");
    const body = await readBoundedResponseJson<{ granted?: boolean; released?: boolean }>(response, 8192);
    if (path === "acquire" && !body.granted) throw new Error("container_concurrency_limit");
    if (path === "release" && !body.released) throw new Error("container_capacity_release_failed");
  }

  protected override async reserveCapacity(scope: ContainerInvocationScope, holder: string, expiresAt: number): Promise<void> {
    const limit = Number(this.bindings.DYNAMIC_CONTAINER_MAX_INSTANCES ?? "5");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("container_global_limit_invalid");
    const previous = await this.ctx.storage.get<Capacity>("dynamic_capacity");
    if (previous && previous.holder !== holder) await this.releaseCapacity();
    const capacity = { holder, tenant: scope.tenantId, expiresAt: expiresAt + 60000 };
    // Persist intent first: a lost acquire response is reclaimed by cleanup or the lease TTL.
    await this.ctx.storage.put("dynamic_capacity", capacity);
    try {
      await this.capacityRequest("acquire", "global", capacity, limit);
      await this.capacityRequest("acquire", "tenant:" + scope.tenantId, capacity, dynamicPlanLimits(this.selected?.tier ?? "free").concurrency);
    } catch (error) { await this.releaseCapacity(); throw error; }
  }

  protected override async releaseCapacity(): Promise<void> {
    const capacity = await this.ctx.storage.get<Capacity>("dynamic_capacity");
    if (!capacity) return;
    await this.capacityRequest("release", "global", capacity);
    await this.capacityRequest("release", "tenant:" + capacity.tenant, capacity);
    await this.ctx.storage.delete("dynamic_capacity");
  }

  protected override async startContainer(container: ContainerRuntime, _scope: ContainerInvocationScope | null): Promise<void> {
    const selected = this.selected;
    if (!selected) throw new Error("container_selection_required");
    // Compute after the base class has configured the new egress profile.
    selected.fingerprint = await digest(JSON.stringify([selected.image, selected.profile, selected.owner,
      await this.ctx.storage.get("container_egress_profile")]));
    await this.ctx.storage.put("dynamic_selection", selected);
    const snapshot = await this.ctx.storage.get<SavedSnapshot>("dynamic_snapshot");
    const labels = { naelao_owner: selected.owner, naelao_image: await digest(selected.image) };
    const options = { instance: selected.profile, enableInternet: false, labels };
    await this.ctx.storage.put("dynamic_restored", false);
    if (snapshot) {
      // An incompatible, expired, disabled, or failed restore must be visible to the caller.
      // Starting a clean image here would silently present an empty computer as a restoration.
      await this.ctx.storage.put("dynamic_snapshot_restore_candidate", snapshot.id);
      if (!snapshot.id || !snapshot.fingerprint || !Number.isFinite(snapshot.createdAt) || snapshotMetadataInvalid(snapshot)) {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_record_invalid");
        throw new Error("dynamic_snapshot_record_invalid");
      }
      if (this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED !== "true") {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_restore_disabled");
        throw new Error("dynamic_snapshot_restore_disabled");
      }
      if (snapshot.fingerprint !== selected.fingerprint) {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_incompatible");
        throw new Error("dynamic_snapshot_incompatible");
      }
      if (snapshot.ownerFingerprint !== undefined && snapshot.ownerFingerprint !== selected.owner ||
          snapshot.imageDigest !== undefined && snapshot.imageDigest !== await digest(selected.image) ||
          snapshot.profile !== undefined && JSON.stringify(snapshot.profile) !== JSON.stringify(selected.profile)) {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_incompatible");
        throw new Error("dynamic_snapshot_incompatible");
      }
      const expiresAt = snapshot.expiresAt ?? snapshot.createdAt + SNAPSHOT_RECOVERY_TTL_MS;
      if (!Number.isFinite(expiresAt)) {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_record_invalid");
        throw new Error("dynamic_snapshot_record_invalid");
      }
      if (expiresAt <= Date.now()) {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_expired");
        throw new Error("dynamic_snapshot_expired");
      }
      await this.ctx.storage.put("dynamic_restored", true);
      try {
        container.start({ ...options, containerSnapshot: { id: snapshot.id } });
      } catch {
        await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_restore_failed");
        throw new Error("dynamic_snapshot_restore_failed");
      }
      return;
    }
    await this.ctx.storage.delete("dynamic_snapshot_restore_candidate");
    await this.ctx.storage.delete("dynamic_snapshot_restored_id");
    await this.ctx.storage.delete("dynamic_snapshot_restore_error");
    await this.ctx.storage.put("dynamic_restored", false);
    container.start({ ...options, image: selected.image });
  }

  protected override async verifyContainer(container: ContainerRuntime, _scope: ContainerInvocationScope | null): Promise<void> {
    const selected = this.selected ?? await this.ctx.storage.get<Selection>("dynamic_selection");
    if (!selected) throw new Error("container_selection_required");
    const info = await container.inspect?.();
    const restored = await this.ctx.storage.get<boolean>("dynamic_restored");
    if (!info || info.labels?.naelao_owner !== selected.owner || info.labels?.naelao_image !== await digest(selected.image)
      || (info.image !== selected.image && !(info.image === "" && restored))) {
      if (restored) await this.ctx.storage.put("dynamic_snapshot_restore_error", "dynamic_snapshot_identity_mismatch");
      throw new Error("container_deployed_image_digest_mismatch");
    }
    if (restored) {
      const snapshotId = await this.ctx.storage.get<string>("dynamic_snapshot_restore_candidate");
      if (!snapshotId) throw new Error("dynamic_snapshot_restore_receipt_missing");
      await this.ctx.storage.put("dynamic_snapshot_restored_id", snapshotId);
      await this.ctx.storage.delete("dynamic_snapshot_restore_candidate");
      await this.ctx.storage.delete("dynamic_snapshot_restore_error");
    }
  }

  protected override async discardCheckpoint(): Promise<void> {
    // A failed command or failed replacement snapshot cannot invalidate the last verified
    // private-filesystem recovery point. The authenticated profile reset is the explicit
    // control that drops its reference; the provider snapshot itself remains subject to TTL.
  }

  protected override async beforeIdleStop(container: ContainerRuntime): Promise<void> {
    if (this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED !== "true" || !container.snapshotContainer) return;
    const selected = await this.ctx.storage.get<Selection>("dynamic_selection");
    if (!selected) return;
    // Snapshot only after successful, quiescent execution; R2 remains authoritative for files.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([container.snapshotContainer(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot_timeout")), 5000);
      })]);
      if (!snapshot.id || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0) throw new Error("snapshot_receipt_invalid");
      const createdAt = Date.now();
      const generation = await this.ctx.storage.get<number>("workspace_runtime_generation") ?? 0;
      const verified: SavedSnapshot = {
        id: snapshot.id, fingerprint: selected.fingerprint, ownerFingerprint: selected.owner,
        imageDigest: await digest(selected.image), profile: selected.profile, allocationGeneration: generation,
        sizeBytes: snapshot.size, createdAt, expiresAt: createdAt + SNAPSHOT_RECOVERY_TTL_MS,
      };
      // One durable pointer update keeps the previous verified snapshot usable until this
      // replacement has actually completed and its receipt is persisted.
      await this.ctx.storage.put("dynamic_snapshot", verified);
      await this.ctx.storage.delete("dynamic_snapshot_restore_candidate");
      await this.ctx.storage.delete("dynamic_snapshot_restored_id");
      await this.ctx.storage.delete("dynamic_snapshot_restore_error");
      await this.ctx.storage.delete("dynamic_snapshot_save_error");
    } catch {
      // Keep the last verified recovery point when snapshot creation, timeout, or persistence
      // fails. Container snapshot objects expire at the provider's TTL if their pointer is lost.
      await this.ctx.storage.put("dynamic_snapshot_save_error", "dynamic_snapshot_save_failed");
    }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
