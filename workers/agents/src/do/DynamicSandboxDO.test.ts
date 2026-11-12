import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { DynamicSandboxDO } from "./DynamicSandboxDO.js";
import { ToolSandboxDO } from "./ToolSandboxDO.js";
import { assertDynamicPlan, dynamicCreditsPerHour, selectDynamicProfile } from "../script-engine/dynamic-containers.js";

const image = `registry.cloudflare.com/${"1".repeat(32)}/tools@sha256:${"a".repeat(64)}`;
function capacityService() {
  const held = new Map<string, Map<string, number>>();
  const calls: string[] = [];
  return { held, calls, namespace: { idFromName: (v: string) => v, get: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    const { key, holder_id: holder, limit, ttl_ms: ttl } = await request.json() as any;
    calls.push(path);
    const slots = held.get(key) ?? new Map(); held.set(key, slots);
    for (const [id, until] of slots) if (until <= Date.now()) slots.delete(id);
    if (path === "/release") { slots.delete(holder); return Response.json({ released: true }); }
    if (!slots.has(holder) && slots.size >= limit) return Response.json({ granted: false });
    slots.set(holder, Date.now() + ttl); return Response.json({ granted: true });
  } }) } };
}
function runtime(options: { tier?: string; cpu?: number; memory?: number; profile?: string; capacity?: ReturnType<typeof capacityService>; enabled?: boolean; snapshots?: boolean; erased?: boolean; writerAdmissionFails?: boolean; loseMainClaimAck?: boolean } = {}) {
  const records = new Map<string, any>();
  const projectMainRegistry = new Map<string, { runtimeObjectName: string; allocationGeneration: number; allocationToken?: string; fencingToken: number; activeBranch: string; state: string }>();
  const capacity = options.capacity ?? capacityService();
  const billing: any[] = [];
  const snapshotRetentionWrites: string[] = [];
  let running = false;
  let info: any;
  let alarmAt = 0;
  let task: Promise<Response> | undefined;
  let markTaskStarted: (() => void) | undefined;
  let releaseTask: ((response: Response) => void) | undefined;
  let taskStarted = new Promise<void>(resolve => { markTaskStarted = resolve; });
  let transactionTail = Promise.resolve();
  let controlReady = true;
  let workspaceErased = options.erased ?? false;
  let loseMainClaimAck = options.loseMainClaimAck ?? false;
  const transport = {
    images: { base: image, tool: image }, get running() { return running; },
    start: vi.fn((args: any) => { running = true; info = { image: args.containerSnapshot ? "" : args.image, labels: args.labels }; }),
    destroy: vi.fn(async () => { running = false; }),
    inspect: vi.fn(async () => running ? info : null),
    snapshotContainer: vi.fn(async () => ({ id: "snapshot-one", size: 1024 })),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      if (["/build", "/exec"].includes(new URL(request.url).pathname) && task) { markTaskStarted?.(); return task; }
      if (new URL(request.url).pathname === "/control/init" && !controlReady) return Response.json({ ok: false }, { status: 503 });
      return Response.json({ ok: true });
    } }),
  };
  const ctx = { id: { toString: () => "test-durable-object-id" }, container: transport, storage: {
    get: async (key: string) => structuredClone(records.get(key)), put: async (key: string, v: any) => { records.set(key, structuredClone(v)); },
    delete: async (key: string) => records.delete(key), setAlarm: async (at: number) => { alarmAt = at; },
    transaction: async (operation: (tx: any) => Promise<unknown>) => {
      if (options.writerAdmissionFails) throw new Error("storage_transaction_unavailable");
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await operation({ get: async (key: string) => structuredClone(records.get(key)),
        put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
        delete: async (key: string) => records.delete(key) }); }
      finally { release(); }
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map([...records.entries()].filter(([key]) => key.startsWith(prefix))),
  } };
  const env = { PLATFORM_SECRET: "secret", DYNAMIC_CONTAINERS_ENABLED: options.enabled === false ? "false" : "true",
    DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED: options.snapshots ? "true" : "false", CONCURRENCY_DO: capacity.namespace,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => sql.includes("SELECT plan_tier") ? { plan_tier: options.tier ?? "free" }
        : sql.includes("SELECT profile FROM project_main_runtime_profiles") ? options.profile ? { profile: options.profile } : null
        : sql.includes("workspace_erasure_tombstones")
        ? workspaceErased ? { erased: 1 } : null : sql.includes("config_json")
        ? { config_json: JSON.stringify({ compliance: { airGappedOnly: true } }) } : { id: "space" },
      run: async () => {
        if (sql.includes("workspace_runtime_snapshot_retention")) {
          snapshotRetentionWrites.push(sql);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO project_main_runtime_registry")) {
          const [tenantId, spaceId, projectId, runtimeObjectName, generation, branch] = values as [string, string, string, string, number, string];
          const key = [tenantId, spaceId, projectId].join(":");
          const prior = projectMainRegistry.get(key);
          if (prior && (prior.runtimeObjectName !== runtimeObjectName || prior.allocationGeneration !== generation || prior.state === "erased")) return { meta: { changes: 0 } };
          projectMainRegistry.set(key, { runtimeObjectName, allocationGeneration: generation, allocationToken: prior?.allocationToken,
            fencingToken: (prior?.fencingToken ?? 0) + (prior && prior.activeBranch !== branch ? 1 : 0), activeBranch: branch, state: prior?.state ?? "registered" });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE project_main_runtime_registry")) {
          const row = [...projectMainRegistry.values()][0];
          if (!row) return { meta: { changes: 0 } };
          if (sql.includes("recover-project-main-generation")) {
            const [, , , , objectName, generation, token, branch] = values as [string, string, string, string, string, number, string, string];
            const matches = row.runtimeObjectName === objectName && row.allocationGeneration === generation
              && row.allocationToken === token && row.activeBranch === branch;
            return { meta: { changes: matches ? 1 : 0 } };
          }
          if (sql.includes("retry-project-main-generation")) {
            const [, , , , objectName, generation, token, branch] = values as [string, string, string, string, string, number, string, string];
            const matches = row.runtimeObjectName === objectName && row.allocationGeneration === generation
              && row.allocationToken === token && row.activeBranch === branch && row.state !== "erased";
            if (matches) row.state = "recovery_required";
            return { meta: { changes: matches ? 1 : 0 } };
          }
          if (sql.includes("claim-project-main-generation")) {
            const [generation, token, , , , , objectName, expectedGeneration, branch] = values as [number, string, string, string, string, string, string, number, string];
            const matches = row.runtimeObjectName === objectName && row.allocationGeneration === expectedGeneration
              && row.activeBranch === branch && row.state !== "erased";
            if (!matches) return { meta: { changes: 0 } };
            row.allocationGeneration = generation; row.allocationToken = token; row.state = "recovery_required";
            if (loseMainClaimAck) { loseMainClaimAck = false; throw new Error("simulated_lost_d1_ack"); }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("activate-project-main-generation")) {
            const [, , , , objectName, generation, branch] = values as [string, string, string, string, string, number, string];
            const matches = row.runtimeObjectName === objectName && row.allocationGeneration === generation
              && row.activeBranch === branch && row.state !== "erased";
            if (matches) row.state = "active";
            return { meta: { changes: matches ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 1 } };
      },
    }) }) },
    CONTAINER_IMAGE_REGISTRY: JSON.stringify([{ image, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object", networkPolicy: "none",
      cpuCores: options.cpu ?? .0625, memoryMb: options.memory ?? 256 }]),
    BILLING_WORKER: { fetch: async (request: Request) => { billing.push({ path: new URL(request.url).pathname, ...await request.json() as any }); return Response.json({ ok: true }); } },
  };
  let sandbox = new DynamicSandboxDO(ctx as never, env as never);
  async function invoke(path = "/prewarm", scopeChanges: Record<string, unknown> = {}) {
    const { mainComputer = false, ...overrides } = scopeChanges;
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "owner", agentId: "worker", runId: "run",
      ...(!mainComputer ? { installationId: "install", installationScope: "PROJECT_SHARED", image, dynamicImage: true } : {}),
      executionId: crypto.randomUUID(), timeoutMs: 55000, deadline: Date.now() + 55000, ...overrides };
    return sandbox.fetch(new Request("http://sandbox" + path, { method: "POST",
      body: JSON.stringify(path === "/exec" ? { spaceId: scope.spaceId, projectId: scope.projectId, workspaceBranch: scope.workspaceBranch } : {}),
      headers: {
        "x-naelao-container-scope": JSON.stringify(scope), "x-naelao-internal-token": await mintInternalToken("secret", scope.tenantId),
        "x-naelao-runtime-object-name": "sandbox:" + scope.spaceId + ":" + scope.projectId,
      } }));
  }
  async function profile(reset?: boolean, suppliedToken?: string) {
    const token = suppliedToken ?? await mintInternalToken("secret", "tenant");
    return sandbox.fetch(new Request("http://sandbox/_internal/profile", { method: "POST", body: JSON.stringify({ tenantId: "tenant", ...(reset ? { reset: true } : {}) }),
      headers: { "x-naelao-internal-token": token } }));
  }
  async function eraseProject() {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" };
    return sandbox.fetch(new Request("http://sandbox/_internal/workspace/erase", { method: "POST", body: JSON.stringify({ scope, confirm: true }),
      headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken("secret", "tenant") } }));
  }
  return { invoke, profile, transport, records, capacity, env, billing, projectMainRegistry, snapshotRetentionWrites, get alarmAt() { return alarmAt; }, alarm: () => sandbox.alarm(),
    restart: () => { sandbox = new DynamicSandboxDO(ctx as never, env as never); },
    setInfo: (v: any) => { info = v; }, hangBuild: () => { taskStarted = new Promise<void>(resolve => { markTaskStarted = resolve; }); task = new Promise<Response>(resolve => { releaseTask = resolve; }); },
    waitForExecution: () => taskStarted,
    releaseExecution: () => { releaseTask?.(Response.json({ ok: true })); task = undefined; },
    setControlReady: (value: boolean) => { controlReady = value; }, setWorkspaceErased: (value: boolean) => { workspaceErased = value; }, eraseProject,
    legacy: () => new ToolSandboxDO(ctx as never, env as never) };
}
afterEach(() => vi.restoreAllMocks());

describe("Cloudflare dynamic execution", () => {
  it("keeps one project main runtime across branch handoffs and advances its fence once", async () => {
    const r = runtime();
    const key = "tenant:space:project";
    expect((await r.invoke("/prewarm", { mainComputer: true })).status).toBe(200);
    expect(r.projectMainRegistry.get(key)).toMatchObject({
      runtimeObjectName: "sandbox:space:project", allocationGeneration: 1, fencingToken: 0, activeBranch: "main", state: "active",
    });
    const handoff = await r.invoke("/prewarm", { mainComputer: true, workspaceBranch: "feature/research" });
    expect(handoff.status, await handoff.clone().text()).toBe(200);
    expect(r.projectMainRegistry.get(key)).toMatchObject({ fencingToken: 1, activeBranch: "feature/research" });
    expect((await r.invoke("/prewarm", { mainComputer: true, workspaceBranch: "feature/research" })).status).toBe(200);
    expect(r.projectMainRegistry.get(key)).toMatchObject({ fencingToken: 1, activeBranch: "feature/research" });
    expect(r.projectMainRegistry.size).toBe(1);
  });

  it("applies a persisted project main size preference at allocation time", async () => {
    const r = runtime({ profile: "lite" });
    const response = await r.invoke("/prewarm", { mainComputer: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(r.transport.start).toHaveBeenCalledWith(expect.objectContaining({ instance: "lite" }));
  });

  it("rejects a stale local generation before starting a replacement container", async () => {
    const r = runtime();
    const key = "tenant:space:project";
    expect((await r.invoke("/prewarm", { mainComputer: true })).status).toBe(200);
    await r.transport.destroy();
    r.records.set("workspace_runtime_generation", 0);
    r.projectMainRegistry.get(key)!.allocationGeneration = 4;
    r.restart();

    const response = await r.invoke("/prewarm", { mainComputer: true });
    expect(response.status).toBe(503);
    expect(r.transport.start).toHaveBeenCalledOnce();
    expect(r.projectMainRegistry.get(key)?.allocationGeneration).toBe(4);
  });

  it("recovers a main allocation generation when the D1 claim acknowledgement is lost", async () => {
    const r = runtime({ loseMainClaimAck: true });
    const key = "tenant:space:project";
    const interrupted = await r.invoke("/prewarm", { mainComputer: true });
    expect(interrupted.status).toBe(409);
    expect(r.projectMainRegistry.get(key)).toMatchObject({ allocationGeneration: 1, state: "recovery_required" });
    expect(r.transport.start).not.toHaveBeenCalled();

    r.restart();
    const recovered = await r.invoke("/prewarm", { mainComputer: true });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(r.projectMainRegistry.get(key)).toMatchObject({ allocationGeneration: 1, state: "active" });
    expect(r.transport.start).toHaveBeenCalledOnce();
    expect(r.records.get("workspace_runtime_generation")).toBe(1);
  });

  it("serializes project-main writers across normal branches until the active run finishes", async () => {
    const r = runtime({ tier: "growth" });
    r.hangBuild();
    const first = r.invoke("/build", { mainComputer: true, executionId: "writer-one", workspaceBranch: "main" });
    const firstState = await Promise.race([
      r.waitForExecution().then(() => "harness_started"),
      first.then(async (response) => `request_returned_${response.status}_${(await response.clone().text()).slice(0,160)}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("request_stalled_before_harness"), 1500)),
    ]);
    expect(firstState).toBe("harness_started");
    let competingCompleted = false;
    const competing = r.invoke("/build", { mainComputer: true, executionId: "writer-two", workspaceBranch: "feature/next" })
      .then((response) => { competingCompleted = true; return response; });
    await Promise.resolve();
    expect(competingCompleted).toBe(false);
    r.releaseExecution();
    expect((await first).status).toBe(200);
    expect((await competing).status).toBe(200);
  });

  it("fails closed before container work when project-main writer admission storage is unavailable", async () => {
    const r = runtime({ writerAdmissionFails: true });
    const response = await r.invoke("/build", { mainComputer: true, workspaceBranch: "main" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "project_main_writer_admission_unavailable" });
    expect(r.transport.start).not.toHaveBeenCalled();
  });

  it("exposes tenant-authenticated managed profile status and reset", async () => {
    let now = 2_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true });
    expect(await (await r.profile()).json()).toMatchObject({ enabled: true, state: "empty", can_restore: false });
    await r.invoke();
    expect(await (await r.profile()).json()).toMatchObject({ state: "active", can_restore: false });
    now += 5001;
    await r.alarm();
    expect(await (await r.profile()).json()).toMatchObject({ state: "checkpointed", can_restore: true });
    expect(await (await r.profile(true)).json()).toEqual({ reset: true, providerSnapshotPurge: "not_supported" });
    expect(r.records.has("dynamic_snapshot")).toBe(false);
    expect(r.records.has("dynamic_selection")).toBe(false);
    expect(r.transport.destroy).toHaveBeenCalledOnce();
  });
  it("rejects unauthenticated profile reads and resets", async () => {
    const r = runtime();
    expect((await r.profile(false, "invalid-token")).status).toBe(403);
    expect(r.records.size).toBe(0);
  });
  it("chooses the smallest supported size and enforces plan resource ceilings", () => {
    expect(selectDynamicProfile(.0625, 256)).toBe("lite");
    expect(selectDynamicProfile(.25, 1024)).toBe("standard-1");
    expect(selectDynamicProfile(1, 4096)).toBe("standard-2");
    expect(() => selectDynamicProfile(5, 256)).toThrow("unsupported");
    expect(() => assertDynamicPlan("standard-2", "free")).toThrow("subscription_resource_limit");
    expect(dynamicCreditsPerHour("standard-1")).toBeGreaterThan(dynamicCreditsPerHour("lite"));
  });
  it("starts the approved image as lite and reuses a warm allocation without new leases or billing reservations", async () => {
    const r = runtime();
    expect((await r.invoke()).status).toBe(200);
    expect(r.transport.start).toHaveBeenCalledWith(expect.objectContaining({ image, instance: "lite", enableInternet: false }));
    expect((await r.invoke()).status).toBe(200);
    expect(r.transport.start).toHaveBeenCalledOnce();
    expect(r.capacity.calls.filter(v => v === "/acquire")).toHaveLength(2);
    expect(r.billing.filter(v => v.path.endsWith("/reserve"))).toHaveLength(1);
    expect(r.records.get("container_meter").creditsPerHour).toBe(dynamicCreditsPerHour("lite"));
  });
  it("fails closed on disabled rollout, unapproved images, or subscription limits before allocation", async () => {
    for (const r of [runtime({ enabled: false }), runtime({ cpu: 1, memory: 6144 })]) {
      expect((await r.invoke()).status).toBe(409); expect(r.transport.start).not.toHaveBeenCalled();
      expect(r.billing).toHaveLength(0);
    }
    const r = runtime(); delete r.transport.images.tool; r.transport.images.base = "other";
    expect(await (await r.invoke()).json()).toMatchObject({ error: expect.stringContaining("not_in_deployed_image_map") });
    expect(r.transport.start).not.toHaveBeenCalled();
  });
  it("caps simultaneous tenant allocations under a 24-way start storm and releases after eviction and idle", async () => {
    let now = 1000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const capacity = capacityService();
    const runtimes = Array.from({ length: 24 }, () => runtime({ capacity }));
    const responses = await Promise.all(runtimes.map(r => r.invoke()));
    expect(responses.filter(r => r.ok)).toHaveLength(1);
    const winner = runtimes[responses.findIndex(r => r.ok)]!;
    expect(capacity.held.get("global")?.size).toBe(1);
    now += 5001; winner.restart(); await winner.alarm();
    expect(winner.transport.destroy).toHaveBeenCalledOnce();
    expect(capacity.held.get("global")?.size).toBe(0);
    expect((await runtimes[0]!.invoke()).ok).toBe(true);
  });
  it("restores a same-owner, same-image snapshot after idle and validates provider labels with the empty restored image", async () => {
    let now = 2000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true });
    expect((await r.invoke()).ok).toBe(true);
    now += 5001; r.restart(); await r.alarm();
    expect(r.records.get("dynamic_snapshot")?.id).toBe("snapshot-one");
    expect((await r.invoke()).ok).toBe(true);
    expect(r.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ containerSnapshot: { id: "snapshot-one" } }));
    expect(r.transport.start.mock.calls.at(-1)?.[0].image).toBeUndefined();
    r.setInfo({ image: "", labels: { naelao_owner: "other" } });
    expect((await r.invoke()).ok).toBe(false);
    expect(r.records.has("dynamic_snapshot")).toBe(true);
    expect(await (await r.profile()).json()).toMatchObject({ state: "recovery_required", recovery_error: "dynamic_snapshot_identity_mismatch" });
  });
  it("restores an installed runtime snapshot on a later worker run for the same installation", async () => {
    let now = 2500000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true });
    expect((await r.invoke("/prewarm", { runId: "worker-run-one" })).status).toBe(200);
    now += 5001; r.restart(); await r.alarm();
    expect(r.records.get("dynamic_snapshot")?.id).toBe("snapshot-one");
    expect((await r.invoke("/prewarm", { runId: "worker-run-two", executionId: "second-execution" })).status).toBe(200);
    expect(r.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ containerSnapshot: { id: "snapshot-one" } }));
  });
  it("rejects a different tenant before restoring a saved snapshot", async () => {
    let now = 3000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    expect(await (await r.invoke("/prewarm", { tenantId: "tenant-two" })).json()).toMatchObject({ error: expect.stringContaining("owner_mismatch") });
    expect(r.transport.start).toHaveBeenCalledOnce();
    expect(r.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ image }));
    expect(r.transport.start.mock.calls.at(-1)?.[0].containerSnapshot).toBeUndefined();
  });
  it("settles the persisted resource tariff and releases capacity at the allocation deadline", async () => {
    let now = 4000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime(); await r.invoke();
    const meter = r.records.get("container_meter");
    now = meter.expiresAt + 1; r.restart(); await r.alarm();
    const settlement = r.billing.find(v => v.path.endsWith("/settle"));
    expect(settlement.quantity).toBe(Math.ceil(meter.creditsPerHour * (now - meter.allocatedAt) / 3600000));
    expect(r.capacity.held.get("global")?.size).toBe(0);
  });
  it("enforces the global ceiling across different tenants", async () => {
    const capacity = capacityService();
    const runtimes = Array.from({ length: 16 }, () => runtime({ capacity, tier: "enterprise" }));
    const responses = await Promise.all(runtimes.map((r, index) => r.invoke("/prewarm", { tenantId: "tenant-" + index })));
    expect(responses.filter(r => r.ok)).toHaveLength(5);
    expect(capacity.held.get("global")?.size).toBe(5);
  });
  it("releases both capacity slots when the billing hold fails before startup", async () => {
    const r = runtime();
    r.env.BILLING_WORKER.fetch = async () => new Response(null, { status: 503 });
    expect((await r.invoke()).ok).toBe(false);
    expect(r.transport.start).not.toHaveBeenCalled();
    expect(r.capacity.held.get("global")?.size).toBe(0);
    expect(r.capacity.held.get("tenant:tenant")?.size).toBe(0);
  });
  it("fails closed on snapshot restore failure and preserves the previous recovery point", async () => {
    let now = 5000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    const lastGood = structuredClone(r.records.get("dynamic_snapshot"));
    r.transport.start.mockImplementationOnce(() => { throw new Error("snapshot_expired"); });
    const failed = await r.invoke("/prewarm", { executionId: "restore-failed" });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ error: "Error: dynamic_snapshot_restore_failed" });
    expect(r.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ containerSnapshot: { id: "snapshot-one" } }));
    expect(r.transport.start.mock.calls.at(-1)?.[0].image).toBeUndefined();
    expect(r.records.get("dynamic_snapshot")).toEqual(lastGood);
    expect(await (await r.profile()).json()).toMatchObject({ state: "recovery_required", recovery_error: "dynamic_snapshot_restore_failed", can_restore: true });
    expect((await r.invoke("/prewarm", { executionId: "restore-retried" })).status).toBe(200);
    expect(r.records.get("dynamic_snapshot")).toEqual(lastGood);
  });

  it("retains the prior recovery point when a replacement snapshot attempt fails", async () => {
    let now = 5100000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    const lastGood = structuredClone(r.records.get("dynamic_snapshot"));
    expect((await r.invoke("/prewarm", { executionId: "after-restore" })).status).toBe(200);
    r.transport.snapshotContainer.mockRejectedValueOnce(new Error("snapshot_write_failed"));
    now += 5001; await r.alarm();
    expect(r.records.get("dynamic_snapshot")).toEqual(lastGood);
    expect(await (await r.profile()).json()).toMatchObject({ state: "checkpointed", can_restore: true, snapshot_save_error: "dynamic_snapshot_save_failed" });
  });

  it("does not silently start an empty image when a retained snapshot has expired", async () => {
    let now = 5200000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    now += 30 * 24 * 60 * 60 * 1000;
    const result = await r.invoke("/prewarm", { executionId: "expired-restore" });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "Error: dynamic_snapshot_expired" });
    expect(r.transport.start).toHaveBeenCalledTimes(1);
    expect(r.records.has("dynamic_snapshot")).toBe(true);
    expect(await (await r.profile()).json()).toMatchObject({ state: "recovery_required", can_restore: false, recovery_error: "dynamic_snapshot_expired" });
  });

  it("rejects tampered snapshot provenance metadata and preserves the recovery record", async () => {
    let now = 5250000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    const saved = structuredClone(r.records.get("dynamic_snapshot"));
    r.records.set("dynamic_snapshot", { ...saved, imageDigest: "f".repeat(64) });
    const result = await r.invoke("/prewarm", { executionId: "tampered-snapshot" });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: "Error: dynamic_snapshot_incompatible" });
    expect(r.transport.start).toHaveBeenCalledOnce();
    expect(r.records.get("dynamic_snapshot")).toMatchObject({ id: "snapshot-one", imageDigest: "f".repeat(64) });
    expect(await (await r.profile()).json()).toMatchObject({ state: "recovery_required", can_restore: false, recovery_error: "dynamic_snapshot_incompatible" });
  });

  it("surfaces a restored container readiness failure and keeps its recovery point", async () => {
    let now = 5300000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    const lastGood = structuredClone(r.records.get("dynamic_snapshot"));
    r.setControlReady(false);
    const result = await r.invoke("/prewarm", { executionId: "not-ready", timeoutMs: 15, deadline: now + 15 });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: expect.stringContaining("container_execution_time_limit_exceeded") });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(r.records.get("dynamic_snapshot")).toEqual(lastGood);
    expect(await (await r.profile()).json()).toMatchObject({ state: "recovery_required", can_restore: true, recovery_error: "dynamic_snapshot_restore_failed" });
  });

  it("keeps the project main computer owner stable across worker runs", async () => {
    const r = runtime();
    const mainScope = { installationId: undefined, installationScope: undefined, image: undefined, dynamicImage: false };
    expect((await r.invoke("/prewarm", { ...mainScope, runId: "main-run-one" })).status).toBe(200);
    const previousOwner = r.records.get("dynamic_selection").owner;
    r.restart();
    expect((await r.invoke("/prewarm", { ...mainScope, runId: "main-run-two", executionId: "main-run-two-exec" })).status).toBe(200);
    expect(r.records.get("dynamic_selection").owner).toBe(previousOwner);
    expect(r.transport.start).toHaveBeenCalledOnce();
  });

  it("does not restore a private runtime snapshot after project erasure or a database rollback", async () => {
    let now = 5500000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true });
    expect((await r.invoke("/prewarm", { mainComputer: true })).status).toBe(200);
    now += 60001; await r.alarm();
    expect(r.records.get("dynamic_snapshot")?.id).toBe("snapshot-one");
    expect(r.snapshotRetentionWrites.some(sql => sql.includes("INSERT OR IGNORE INTO workspace_runtime_snapshot_retention"))).toBe(true);
    r.restart();
    r.setWorkspaceErased(true);
    const erased = await r.invoke("/prewarm", { executionId: "after-erasure" });
    expect(erased.status).toBe(410);
    expect(await (await r.profile()).json()).toMatchObject({ workspace_erasure_blocked: true, recovery_error: "workspace_erased", can_restore: false });
    expect(r.records.has("dynamic_snapshot")).toBe(false);
    expect(r.snapshotRetentionWrites.some(sql => sql.includes("UPDATE workspace_runtime_snapshot_retention"))).toBe(true);
    r.setWorkspaceErased(false);
    expect((await r.invoke("/prewarm", { executionId: "after-database-restore" })).status).toBe(410);
    expect(r.transport.start).toHaveBeenCalledOnce();
  });
  it("clears local checkpoint pointers after an authenticated project erasure notification", async () => {
    const r = runtime({ snapshots: true, erased: true });
    r.records.set("dynamic_snapshot", { id: "snapshot-1", fingerprint: "f", createdAt: Date.now() });
    r.records.set("dynamic_selection", { image, profile: "lite", owner: "owner", fingerprint: "f", tier: "growth" });
    const response = await r.eraseProject();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ erased: true, runtimeKind: "dynamic_sandbox", localStatePurged: true, providerSnapshotPurge: "not_supported" });
    expect(r.records.has("dynamic_snapshot")).toBe(false);
    expect(r.records.has("dynamic_selection")).toBe(false);
    expect(r.records.get("dynamic_snapshot_erasure_status")).toBe("provider_snapshot_purge_not_supported");
  });
  it("destroys a timed-out dynamic execution and returns its concurrency leases", async () => {
    const r = runtime(); await r.invoke(); r.hangBuild();
    // Leave enough time for auth, policy, and metering setup under a loaded test runner;
    // the mocked build remains pending so this still exercises the execution timeout path.
    const response = await r.invoke("/build", { timeoutMs: 200, deadline: Date.now() + 200 });
    expect(response.ok).toBe(false);
    expect(r.transport.destroy).toHaveBeenCalledOnce();
    expect(r.capacity.held.get("global")?.size).toBe(0);
    expect(r.records.has("dynamic_snapshot")).toBe(false);
  });

  it("serializes idle snapshot/destruction with an arriving execution", async () => {
    let now = 6000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    let entered!: () => void, release!: (value: { id: string; size: number }) => void;
    const enteredSnapshot = new Promise<void>(resolve => { entered = resolve; });
    r.transport.snapshotContainer.mockImplementationOnce(() => {
      entered(); return new Promise(resolve => { release = resolve; });
    });
    now += 5001; const idle = r.alarm(); await enteredSnapshot;
    const arriving = r.invoke();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(r.transport.destroy).not.toHaveBeenCalled();
    expect(r.transport.start).toHaveBeenCalledOnce();
    release({ id: "snapshot-two", size: 1 });
    await idle; expect((await arriving).ok).toBe(true);
    expect(r.transport.destroy).toHaveBeenCalledOnce();
    expect(r.transport.start).toHaveBeenCalledTimes(2);
  });

});
