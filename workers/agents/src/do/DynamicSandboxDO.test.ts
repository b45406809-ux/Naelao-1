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
function runtime(options: { tier?: string; cpu?: number; memory?: number; capacity?: ReturnType<typeof capacityService>; enabled?: boolean; snapshots?: boolean } = {}) {
  const records = new Map<string, any>();
  const capacity = options.capacity ?? capacityService();
  const billing: any[] = [];
  let running = false;
  let info: any;
  let alarmAt = 0;
  let task: Promise<Response> | undefined;
  const transport = {
    images: { base: image, tool: image }, get running() { return running; },
    start: vi.fn((args: any) => { running = true; info = { image: args.containerSnapshot ? "" : args.image, labels: args.labels }; }),
    destroy: vi.fn(async () => { running = false; }),
    inspect: vi.fn(async () => running ? info : null),
    snapshotContainer: vi.fn(async () => ({ id: "snapshot-one", size: 1024 })),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/build" && task) return task;
      return Response.json({ ok: true });
    } }),
  };
  const ctx = { container: transport, storage: {
    get: async (key: string) => structuredClone(records.get(key)), put: async (key: string, v: any) => { records.set(key, structuredClone(v)); },
    delete: async (key: string) => records.delete(key), setAlarm: async (at: number) => { alarmAt = at; },
  } };
  const env = { PLATFORM_SECRET: "secret", DYNAMIC_CONTAINERS_ENABLED: options.enabled === false ? "false" : "true",
    DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED: options.snapshots ? "true" : "false", CONCURRENCY_DO: capacity.namespace,
    PLATFORM_DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () =>
      sql.includes("SELECT plan_tier") ? { plan_tier: options.tier ?? "free" } : sql.includes("config_json")
        ? { config_json: JSON.stringify({ compliance: { airGappedOnly: true } }) } : { id: "space" } }) }) },
    CONTAINER_IMAGE_REGISTRY: JSON.stringify([{ image, binding: "TOOL_SANDBOX", schedulingPolicy: "durable_object", networkPolicy: "none",
      cpuCores: options.cpu ?? .0625, memoryMb: options.memory ?? 256 }]),
    BILLING_WORKER: { fetch: async (request: Request) => { billing.push({ path: new URL(request.url).pathname, ...await request.json() as any }); return Response.json({ ok: true }); } },
  };
  let sandbox = new DynamicSandboxDO(ctx as never, env as never);
  async function invoke(path = "/prewarm", scopeChanges = {}) {
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", actorId: "owner", agentId: "worker", runId: "run",
      installationId: "install", installationScope: "PROJECT_SHARED", image, dynamicImage: true,
      executionId: crypto.randomUUID(), timeoutMs: 55000, deadline: Date.now() + 55000, ...scopeChanges };
    return sandbox.fetch(new Request("http://sandbox" + path, { method: "POST", body: "{}", headers: {
      "x-naelao-container-scope": JSON.stringify(scope), "x-naelao-internal-token": await mintInternalToken("secret", scope.tenantId),
    } }));
  }
  return { invoke, transport, records, capacity, env, billing, get alarmAt() { return alarmAt; }, alarm: () => sandbox.alarm(),
    restart: () => { sandbox = new DynamicSandboxDO(ctx as never, env as never); },
    setInfo: (v: any) => { info = v; }, hangBuild: () => { task = new Promise<Response>(() => undefined); },
    legacy: () => new ToolSandboxDO(ctx as never, env as never) };
}
afterEach(() => vi.restoreAllMocks());

describe("Cloudflare dynamic execution", () => {
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
    expect(r.records.has("dynamic_snapshot")).toBe(false);
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
  it("falls back to the approved image if the provider rejects an idle checkpoint", async () => {
    let now = 5000000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = runtime({ snapshots: true }); await r.invoke();
    now += 5001; await r.alarm();
    r.transport.start.mockImplementationOnce(() => { throw new Error("snapshot_expired"); });
    expect((await r.invoke()).ok).toBe(true);
    expect(r.transport.start).toHaveBeenLastCalledWith(expect.objectContaining({ image }));
    expect(r.transport.start.mock.calls.at(-1)?.[0].containerSnapshot).toBeUndefined();
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
