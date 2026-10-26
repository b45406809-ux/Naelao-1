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
interface SavedSnapshot { id: string; fingerprint: string; createdAt: number }
interface Capacity { holder: string; tenant: string; expiresAt: number }
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
    if (new URL(request.url).pathname === "/_internal/images") {
      if (!this.bindings.PLATFORM_SECRET || !await verifyInternalToken(request.headers.get("x-naelao-internal-token") ?? undefined,
        "naelao-container-catalogue", this.bindings.PLATFORM_SECRET)) return new Response(null, { status: 403 });
      return Response.json({ enabled: this.bindings.DYNAMIC_CONTAINERS_ENABLED === "true", images: Object.values(this.container?.images ?? {}) });
    }
    return super.fetch(request);
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
    const owner = await digest(JSON.stringify([scope.tenantId, scope.spaceId, scope.projectId, scope.installationId,
      scope.installationScope, scope.installationId ? null : scope.runId]));
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
    const restore = this.bindings.DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED === "true" && snapshot?.fingerprint === selected.fingerprint
      && snapshot.createdAt > Date.now() - 29 * 86400000;
    await this.ctx.storage.delete("dynamic_snapshot"); // one attempt; failed restores retry from the image
    const labels = { naelao_owner: selected.owner, naelao_image: await digest(selected.image) };
    await this.ctx.storage.put("dynamic_restored", Boolean(restore));
    const options = { instance: selected.profile, enableInternet: false, labels };
    try {
      container.start({ ...options, ...(restore ? { containerSnapshot: { id: snapshot!.id } } : { image: selected.image }) });
    } catch (error) {
      if (!restore) throw error;
      await this.ctx.storage.put("dynamic_restored", false);
      container.start({ ...options, image: selected.image });
    }
  }

  protected override async verifyContainer(container: ContainerRuntime, _scope: ContainerInvocationScope | null): Promise<void> {
    const selected = this.selected ?? await this.ctx.storage.get<Selection>("dynamic_selection");
    if (!selected) throw new Error("container_selection_required");
    const info = await container.inspect?.();
    if (!info || info.labels?.naelao_owner !== selected.owner || info.labels?.naelao_image !== await digest(selected.image)
      || (info.image !== selected.image && !(info.image === "" && await this.ctx.storage.get("dynamic_restored"))))
      throw new Error("container_deployed_image_digest_mismatch");
  }

  protected override async discardCheckpoint(): Promise<void> { await this.ctx.storage.delete("dynamic_snapshot"); }

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
      await this.ctx.storage.put("dynamic_snapshot", { id: snapshot.id, createdAt: Date.now(), fingerprint: selected.fingerprint } satisfies SavedSnapshot);
    } catch { await this.ctx.storage.delete("dynamic_snapshot"); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
