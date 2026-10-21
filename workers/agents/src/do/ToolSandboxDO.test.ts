import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { sandboxWorkspacePrefix, ToolSandboxDO } from "./ToolSandboxDO.js";

describe("sandbox workspace ownership", () => {
  it("keeps the Space Assistant, each Space-wide extension, and projects in distinct durable prefixes", () => {
    expect(sandboxWorkspacePrefix({ spaceId: "space" })).toBe("spaces/space/workspace/");
    expect(sandboxWorkspacePrefix({ spaceId: "space", installationId: "install-a" }))
      .toBe("spaces/space/space-workspace/extensions/install-a/workspace/");
    expect(sandboxWorkspacePrefix({ spaceId: "space", installationId: "install-b" }))
      .not.toBe(sandboxWorkspacePrefix({ spaceId: "space", installationId: "install-a" }));
    expect(sandboxWorkspacePrefix({ spaceId: "space", projectId: "project" }))
      .toBe("spaces/space/projects/project/workspace/");
    expect(sandboxWorkspacePrefix({ spaceId: "space", projectId: "project", installationId: "install-a" }))
      .toBe("spaces/space/projects/project/workspace/");
  });
});

describe("ToolSandboxDO Runtime and State Coordination", () => {
  async function createTestSandbox(options: { timeoutMs?: number; hangExecution?: boolean; actorId?: string; runId?: string; sidecar?: boolean; platformDb?: boolean; hangReservation?: boolean } = {}) {
    const storage = new Map();
    const analyticsPoints: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    let alarmTime = null;
    let containerRunning = false;
    let tenantActive = true;
    let announceReservation: (() => void) | undefined;
    let releaseReservation: (() => void) | undefined;
    const reservationStarted = new Promise<void>(resolve => { announceReservation = resolve; });
    const reservationGate = new Promise<Response>(resolve => { releaseReservation = () => resolve(Response.json({ ok: true })); });
    const billingCalls: string[] = [];

    const mockContainer = {
      get running() {
        return containerRunning;
      },
      start: vi.fn(() => {
        containerRunning = true;
      }),
      interceptOutboundHttps: vi.fn(async () => undefined),
      destroy: vi.fn(async () => { containerRunning = false; }),
      inspect: vi.fn(async () => ({ image: "registry.example/tool@sha256:" + "a".repeat(64) })),
      getTcpPort: vi.fn(() => ({
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/exec" && options.hangExecution) return new Promise<Response>(() => undefined);
          if (url.pathname === "/workspace/list") return Response.json({ files: [] });
          if (url.pathname.endsWith("/display/capture")) {
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
          }
          if (url.pathname.endsWith("/display/mouse")) {
            return Response.json({ ok: true, x: 10, y: 20, button: "left" });
          }
          if (url.pathname.endsWith("/display/type")) {
            return Response.json({ ok: true, text: "hello world" });
          }
          return Response.json({ ok: true });
        },
      })),
    };

    const mockCtx = {
      container: mockContainer,
      exports: { PackageEgress: () => ({ fetch: async (request) => new Response(request.url) }) },
      storage: {
        get: async (k) => storage.get(k),
        put: async (k, v) => {
          storage.set(k, v);
        },
        delete: async (k) => {
          storage.delete(k);
        },
        setAlarm: async (time) => {
          alarmTime = time;
        },
        deleteAlarm: async () => {
          alarmTime = null;
        },
      },
    };

    const realSandbox = new ToolSandboxDO(mockCtx, {
      PLATFORM_SECRET: "test-secret",
      SCRIPTS_R2: { list: async () => ({ objects: [], truncated: false }), get: async () => null },
      CONCURRENCY_DO: {},
      BILLING_WORKER: { fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        billingCalls.push(path);
        if (options.hangReservation && path.endsWith("/reserve")) {
          announceReservation?.();
          return reservationGate;
        }
        return Response.json({ ok: true });
      } },
      ANALYTICS: { writeDataPoint: (point) => { analyticsPoints.push(point); } },
      ...(options.platformDb ? { PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => tenantActive ? { id: "space" } : null }) }) } } : {}),
    } as never);
    const sandbox = { alarm: () => realSandbox.alarm(), fetch: async (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("x-naelao-internal-token", await mintInternalToken("test-secret", "tenant"));
      headers.set("x-naelao-container-scope", JSON.stringify({ tenantId: "tenant", spaceId: "space", actorId: options.actorId ?? "owner", agentId: "worker", runId: options.runId ?? "run",
        ...(options.sidecar ? { projectId: "project", installationId: "install-a", installationScope: "PROJECT_SHARED", image: "registry.example/tool@sha256:" + "a".repeat(64), dynamicImage: true } : {}),
        executionId: crypto.randomUUID(), timeoutMs: options.timeoutMs ?? 55000, deadline: Date.now() + (options.timeoutMs ?? 55000) }));
      return realSandbox.fetch(new Request(request, { headers }));
    } };
    const initialPrewarm = options.hangReservation ? undefined : await sandbox.fetch(new Request("https://sandbox/prewarm", { method: "POST", body: "{}" }));
    return { sandbox, storage, getAlarmTime: () => alarmTime, mockContainer, initialPrewarm, analyticsPoints, billingCalls, reservationStarted, releaseReservation: () => releaseReservation?.(), setTenantActive: (active: boolean) => { tenantActive = active; } };
  }

  it("rejects container operations for a suspended tenant before reserving or starting execution", async () => {
    const { sandbox, storage, mockContainer, setTenantActive } = await createTestSandbox({ platformDb: true });
    const reservationId = storage.get("container_meter")?.reservationId;
    const starts = mockContainer.start.mock.calls.length;
    setTenantActive(false);
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: "tenant_suspended" });
    expect(storage.get("container_meter")?.reservationId).toBe(reservationId);
    expect(mockContainer.start).toHaveBeenCalledTimes(starts);
  });

  it("aborts and destroys active execution on suspension without publishing its workspace", async () => {
    const { sandbox, storage, mockContainer, setTenantActive } = await createTestSandbox({ platformDb: true, hangExecution: true });
    const preparedBefore = [...storage.keys()].filter(key => String(key).startsWith("execution:")).length;
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    for (let attempt = 0; attempt < 100 && [...storage.keys()].filter(key => String(key).startsWith("execution:")).length <= preparedBefore; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
    expect([...storage.keys()].filter(key => String(key).startsWith("execution:")).length).toBeGreaterThan(preparedBefore);
    setTenantActive(false);
    await sandbox.alarm();
    const response = await execution;
    expect(response.status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(storage.has("workspace_pending_publication")).toBe(false);
  });

  it("releases a reservation that completes after suspension", async () => {
    const { sandbox, storage, mockContainer, billingCalls, reservationStarted, releaseReservation, setTenantActive } = await createTestSandbox({ platformDb: true, hangReservation: true });
    const execution = sandbox.fetch(new Request("https://sandbox/prewarm", { method: "POST", body: "{}" }));
    await reservationStarted;
    expect(storage.has("container_reservation_pending")).toBe(true);
    setTenantActive(false);
    await sandbox.alarm();
    releaseReservation();
    const response = await execution;
    expect(response.status).toBe(409);
    expect(storage.has("container_reservation_pending")).toBe(false);
    expect(storage.has("container_meter")).toBe(false);
    expect(mockContainer.start).not.toHaveBeenCalled();
    expect(billingCalls.filter(path => path.endsWith("/release")).length).toBeGreaterThanOrEqual(1);
  });

  it("coordinates 4D shell state and rejects conflicting revisions", async () => {
    const { sandbox } = await createTestSandbox();
    const initRes = await sandbox.fetch(
      new Request("https://sandbox/session/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: 1,
          patch: { cwd: "/workspace/src" },
        }),
      })
    );
    expect(await initRes.json()).toMatchObject({
      cwd: "/workspace/src",
      revision: 2,
    });

    const conflictRes = await sandbox.fetch(
      new Request("https://sandbox/session/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: 1,
          patch: { cwd: "/workspace/dist" },
        }),
      })
    );
    expect(conflictRes.status).toBe(409);
    expect(await conflictRes.json()).toMatchObject({
      error: "workspace_state_conflict",
      revision: 2,
    });
  });

  it("requires the authenticated attachment reader scope for video media extraction", async () => {
    const { sandbox, mockContainer } = await createTestSandbox({ actorId: "attachment-reader", runId: "task-a" });
    const forwardsBefore = mockContainer.getTcpPort.mock.calls.length;
    const invalid = await sandbox.fetch(new Request("https://sandbox/media/extract-audio", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", taskId: "other-task", videoBase64: "AQID" }),
    }));
    expect(invalid.status).toBe(403);
    expect(mockContainer.getTcpPort).toHaveBeenCalledTimes(forwardsBefore);

    const valid = await sandbox.fetch(new Request("https://sandbox/media/extract-audio", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", taskId: "task-a", videoBase64: "AQID" }),
    }));
    expect(valid.status).toBe(200);
    expect(mockContainer.getTcpPort).toHaveBeenCalled();
  });

  it("CAS-syncs workspace hashes, tracks lockfiles, and excludes node_modules", async () => {
    const { sandbox, storage } = await createTestSandbox();
    const first = await sandbox.fetch(new Request("https://sandbox/workspace/state-sync", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "package.json": { content: "{}", expected_hash: null }, "node_modules/x/a.js": { content: "ignored" } } }),
    }));
    const result = await first.json();
    expect(result).toMatchObject({ ok: true, rehydrate: true });
    expect(Object.keys(storage.get("workspace_files"))).toEqual(["package.json"]);
    const stale = await sandbox.fetch(new Request("https://sandbox/workspace/state-sync", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "package.json": { content: "new", expected_hash: "stale" } } }),
    }));
    expect(stale.status).toBe(409);
  });

  it("requires hashes on normal container workspace writes", async () => {
    const { sandbox, storage } = await createTestSandbox();
    const missing = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "src/main.ts": "one" } }),
    }));
    expect(missing.status).toBe(400);

    const created = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "src/main.ts": "one" }, expected_hashes: { "src/main.ts": null } }),
    }));
    expect(created.status).toBe(200);
    const hash = storage.get("workspace_files")["src/main.ts"].hash;
    const stale = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "src/main.ts": "two" }, expected_hashes: { "src/main.ts": null } }),
    }));
    expect(stale.status).toBe(409);
    const updated = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "src/main.ts": "two" }, expected_hashes: { "src/main.ts": hash } }),
    }));
    expect(updated.status).toBe(200);
  });

  it("implements virtual display automation endpoints", async () => {
    const { sandbox } = await createTestSandbox();
    const captureRes = await sandbox.fetch(
      new Request("https://sandbox/display/capture", { method: "POST" })
    );
    expect(captureRes.status).toBe(200);
    const bytes = new Uint8Array(await captureRes.arrayBuffer());
    expect(bytes[0]).toBe(0x89);

    const mouseRes = await sandbox.fetch(
      new Request("https://sandbox/display/mouse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 10, y: 20 }),
      })
    );
    expect(await mouseRes.json()).toMatchObject({ ok: true, x: 10, y: 20 });
  });

  it("schedules 60s idle alarm on activity", async () => {
    const { sandbox, getAlarmTime } = await createTestSandbox();
    const start = Date.now();
    await sandbox.fetch(
      new Request("https://sandbox/workspace/list", { method: "POST" })
    );
    expect(getAlarmTime()).toBeGreaterThanOrEqual(start + 59_000);
  });

  it("hard-stops a hung container execution and returns the Durable Workflow guidance", async () => {
    const { sandbox, mockContainer } = await createTestSandbox({ timeoutMs: 1000, hangExecution: true });
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    await new Promise(resolve => setTimeout(resolve, 1050));
    const response = await execution;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false,
      error: "container_execution_time_limit_exceeded: maximum 1000ms; move waits and schedules to a Durable Workflow and keep each container step bounded",
      workspace_may_require_reconciliation: true });
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
  });

  it("does not extend base-container idle time from an active-task hint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { sandbox, getAlarmTime, mockContainer } = await createTestSandbox();
    await sandbox.fetch(new Request("https://sandbox/exec", {
      method: "POST",
      headers: { "content-type": "application/json", "x-avos-task-active": "1" },
      body: "{}",
    }));
    expect(mockContainer.start).toHaveBeenCalledWith({ enableInternet: false });
    expect(mockContainer.interceptOutboundHttps).toHaveBeenCalledTimes(9);
    expect(mockContainer.interceptOutboundHttps).toHaveBeenCalledWith("registry.npmjs.org", expect.any(Object));
    expect(getAlarmTime()).toBe(1_060_000);
    vi.setSystemTime(1_060_000);
    await sandbox.alarm();
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("returns to the 60s window when a task completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { sandbox, storage, getAlarmTime } = await createTestSandbox();
    await sandbox.fetch(new Request("https://sandbox/exec", {
      method: "POST",
      headers: { "content-type": "application/json", "x-avos-task-active": "1" },
      body: "{}",
    }));
    expect(storage.get("task_active")).toBe(true);
    vi.setSystemTime(1_010_000);
    const response = await sandbox.fetch(new Request("https://sandbox/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    }));
    expect(await response.json()).toMatchObject({ idle_window_ms: 60_000 });
    expect(storage.has("task_active")).toBe(false);
    expect(getAlarmTime()).toBe(1_070_000);
    vi.useRealTimers();
  });

  it("keeps an exact marketplace sidecar warm only for the bounded reuse lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { sandbox, storage, getAlarmTime, mockContainer, initialPrewarm, analyticsPoints } = await createTestSandbox({ sidecar: true, runId: "worker-run" });
    expect(initialPrewarm).toBeDefined();
    if (!initialPrewarm) throw new Error("expected initial prewarm response");
    expect(initialPrewarm.status, await initialPrewarm.clone().text()).toBe(200);
    expect(mockContainer.start).toHaveBeenCalledOnce();
    expect(mockContainer.destroy).not.toHaveBeenCalled();
    expect(storage.get("sidecar_warm_expires_at")).toBe(2_005_000);
    expect(getAlarmTime()).toBe(2_005_000);

    const reused = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(reused.ok).toBe(true);
    expect(mockContainer.start).toHaveBeenCalledOnce();
    expect(mockContainer.destroy).not.toHaveBeenCalled();
    expect(getAlarmTime()).toBe(2_005_000);

    vi.setSystemTime(2_005_000);
    await sandbox.alarm();
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(storage.has("sidecar_warm_expires_at")).toBe(false);
    expect(analyticsPoints).toHaveLength(1);
    expect(analyticsPoints[0]?.blobs?.[0]).toBe("container.runtime.lifecycle");
    expect(analyticsPoints[0]?.blobs?.[1]).toBe("marketplace-sidecar");
    expect(analyticsPoints[0]?.doubles?.[0]).toBeGreaterThanOrEqual(5_000);
    expect(analyticsPoints[0]?.doubles?.[4]).toBe(1); // exact warm reuse
    vi.useRealTimers();
  });

  it("destroys a marketplace sidecar after failed or indeterminate execution", async () => {
    const { sandbox, storage, mockContainer, analyticsPoints } = await createTestSandbox({ sidecar: true, timeoutMs: 1000, hangExecution: true, runId: "worker-failure" });
    const result = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(result.status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(storage.has("sidecar_warm_expires_at")).toBe(false);
    expect(analyticsPoints).toHaveLength(1);
    expect(analyticsPoints[0]?.doubles?.[6]).toBe(2); // prewarm and failed command are both measured
    // The enforced deadline is 1,000 ms; runtime sampling can finish slightly before the
    // timer boundary because the execution abort and cleanup race on the isolate event loop;
    // allow up to 1.5 seconds for loaded-runner cleanup without accepting a multi-second miss.
    expect(analyticsPoints[0]?.doubles?.[7]).toBeGreaterThanOrEqual(900);
    expect(analyticsPoints[0]?.doubles?.[7]).toBeLessThanOrEqual(1500);
    expect(storage.has("container_runtime_metrics")).toBe(false);
  });

  it("stays warm before 60s and snapshots then hibernates at 60s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { sandbox, storage, mockContainer } = await createTestSandbox();
    await sandbox.fetch(new Request("https://sandbox/workspace/list", { method: "POST" }));
    vi.setSystemTime(1_059_999);
    await sandbox.alarm();
    expect(mockContainer.destroy).not.toHaveBeenCalled();
    vi.setSystemTime(1_060_000);
    await sandbox.alarm();
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(storage.get("container_status")).toBe("hibernated");
    vi.useRealTimers();
  });
});
