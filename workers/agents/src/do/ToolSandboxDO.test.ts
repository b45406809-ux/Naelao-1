import { describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { sandboxWorkspacePrefix, ToolSandboxDO } from "./ToolSandboxDO.js";
import { WorkspaceCoordinatorDO } from "../workspace/WorkspaceCoordinatorDO.js";
import { workspaceCoordinatorRequest } from "../workspace/workspace-client.js";

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
      .toBe("spaces/space/projects/project/extensions/install-a/workspace/");
  });
});

describe("ToolSandboxDO Runtime and State Coordination", () => {
  async function createTestSandbox(options: { timeoutMs?: number; hangExecution?: boolean; taintedExecution?: boolean; actorId?: string; runId?: string; sidecar?: boolean; sidecarExecutionSeconds?: number; platformDb?: boolean; hangReservation?: boolean; airGapped?: boolean; unifiedWorkspace?: boolean; workspaceProject?: boolean; workspaceProjectUnmigrated?: boolean; failCheckpointOnce?: boolean } = {}) {
    const storage = new Map();
    const analyticsPoints: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    let alarmTime = null;
    let containerRunning = false;
    let tenantActive = true;
    let workspaceErased = false;
    let airGapped = options.airGapped ?? false;
    let announceReservation: (() => void) | undefined;
    let releaseReservation: (() => void) | undefined;
    let announceExecution: (() => void) | undefined;
    const reservationStarted = new Promise<void>(resolve => { announceReservation = resolve; });
    const reservationGate = new Promise<Response>(resolve => { releaseReservation = () => resolve(Response.json({ ok: true })); });
    const executionStarted = new Promise<void>(resolve => { announceExecution = resolve; });
    const billingCalls: string[] = [];
    const containerFiles: Record<string, string> = {};
    const r2Objects = new Map<string, Uint8Array>();
    const r2 = {
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...r2Objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, size: r2Objects.get(key)!.byteLength })), truncated: false }),
      head: async (key: string) => { const bytes = r2Objects.get(key); return bytes ? { size: bytes.byteLength, etag: `etag-${key}`, customMetadata: { sha256: "" } } : null; },
      get: async (key: string) => {
        const bytes = r2Objects.get(key);
        return bytes ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null;
      },
      put: async (key: string, value: Uint8Array | string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) => {
        if (options?.onlyIf?.etagDoesNotMatch === "*" && r2Objects.has(key)) return null;
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        r2Objects.set(key, bytes.slice());
        return { key, size: bytes.byteLength };
      },
    };
    const coordinatorStorage = new Map<string, unknown>();
    const coordinator = new WorkspaceCoordinatorDO({ storage: {
      get: async (key: string) => coordinatorStorage.get(key),
      put: async (key: string, value: unknown) => coordinatorStorage.set(key, structuredClone(value)),
      delete: async (key: string) => coordinatorStorage.delete(key),
      getAlarm: async () => null,
      setAlarm: async (_scheduledTime: number) => undefined,
      list: async ({ prefix = "", startAfter, limit = 1000 }: { prefix?: string; startAfter?: string; limit?: number } = {}) => new Map(
        [...coordinatorStorage.entries()].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit),
      ),
      transaction: async (callback: (txn: unknown) => Promise<unknown>) => callback({
        get: async (key: string) => coordinatorStorage.get(key),
        put: async (key: string, value: unknown) => coordinatorStorage.set(key, structuredClone(value)),
        delete: async (key: string) => coordinatorStorage.delete(key),
      }),
    } } as never, { PLATFORM_SECRET: "test-secret", SCRIPTS_R2: r2 } as never);
    const workspaceNamespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (request: Request) => {
        if (options.failCheckpointOnce && new URL(request.url).pathname === "/v1/checkpoint") {
          options.failCheckpointOnce = false;
          return Response.json({ error_code: "workspace_test_checkpoint_interrupted" }, { status: 503 });
        }
        return coordinator.fetch(request);
      } }),
    };
    if (options.unifiedWorkspace && options.workspaceProject && !options.workspaceProjectUnmigrated) {
      await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: workspaceNamespace, PLATFORM_SECRET: "test-secret" } as never,
        { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" }, "/v1/initialize",
        { body: { scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" }, branch: "main", entries: [] } });
    }

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
          if (url.pathname === "/exec" && options.hangExecution) {
            announceExecution?.();
            return new Promise<Response>(() => undefined);
          }
          if (url.pathname === "/exec" && options.taintedExecution)
            return Response.json({ ok: false, error: "guest_process_cleanup_unverified" }, { status: 500, headers: { "x-naelao-container-tainted": "1" } });
          if (url.pathname === "/workspace/list") return Response.json({ files: options.unifiedWorkspace ? Object.keys(containerFiles) : [] });
          if (url.pathname === "/workspace/write") {
            const body = await req.clone().json<{ files?: Record<string, string>; files_base64?: Record<string, string> }>().catch(() => ({}));
            if (options.unifiedWorkspace) {
              for (const [path, content] of Object.entries(body.files ?? {})) containerFiles[path] = content;
              for (const [path, content] of Object.entries(body.files_base64 ?? {})) containerFiles[path] = new TextDecoder().decode(Uint8Array.from(atob(content), character => character.charCodeAt(0)));
            }
            return Response.json({ ok: true });
          }
          if (url.pathname === "/workspace/read") {
            const body = await req.clone().json<{ paths?: string[] }>().catch(() => ({}));
            const selected = body.paths ?? Object.keys(containerFiles);
            return Response.json({ files_base64: Object.fromEntries(selected.filter(path => path in containerFiles).map(path => [path, btoa(containerFiles[path]!)])) });
          }
          if (url.pathname === "/workspace/delete") {
            const body = await req.clone().json<{ paths?: string[] }>().catch(() => ({}));
            for (const path of body.paths ?? []) delete containerFiles[path];
            return Response.json({ ok: true });
          }
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
        list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map(
          [...storage.entries()].filter(([key]) => String(key).startsWith(prefix)),
        ),
        setAlarm: async (time) => {
          alarmTime = time;
        },
        deleteAlarm: async () => {
          alarmTime = null;
        },
      },
    };

    const sandboxEnv = {
      PLATFORM_SECRET: "test-secret",
      SCRIPTS_R2: options.unifiedWorkspace ? r2 : { list: async () => ({ objects: [], truncated: false }), get: async () => null },
      ...(options.unifiedWorkspace ? { WORKSPACE_COORDINATOR: workspaceNamespace, UNIFIED_WORKSPACE_ENABLED: "true" } : { UNIFIED_WORKSPACE_ENABLED: "false" }),
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
      ...(options.platformDb || options.workspaceProject || options.workspaceProjectUnmigrated || options.sidecar ? { PLATFORM_DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => {
              if (!tenantActive) return null;
              if (query.includes("sidecar_runtime_execution_profiles")) return options.sidecarExecutionSeconds === undefined
                ? null : { max_execution_seconds: options.sidecarExecutionSeconds };
              if (query.includes("workspace_erasure_tombstones")) return workspaceErased ? { erased: 1 } : null;
              return query.includes("config_json")
                ? { config_json: airGapped ? JSON.stringify({ compliance: { airGappedOnly: true } }) : "{}" }
                : { id: "space" };
            },
          }),
        }),
      } } : {}),
    } as never;
    let realSandbox = new ToolSandboxDO(mockCtx, sandboxEnv);
    const sandbox = { alarm: () => realSandbox.alarm(), fetch: async (request: Request) => {
      const headers = new Headers(request.headers);
      const testExecutionId = headers.get("x-test-execution-id");
      headers.delete("x-test-execution-id");
      headers.set("x-naelao-internal-token", await mintInternalToken("test-secret", "tenant"));
      headers.set("x-naelao-container-scope", JSON.stringify({ tenantId: "tenant", spaceId: "space", ...(options.workspaceProject ? { projectId: "project" } : {}), actorId: options.actorId ?? "owner", agentId: "worker", runId: options.runId ?? "run",
        ...(options.sidecar ? { projectId: "project", installationId: "install-a", containerId: "container-a", installationScope: "PROJECT_SHARED", image: "registry.example/tool@sha256:" + "a".repeat(64), dynamicImage: false } : {}),
        executionId: testExecutionId ?? crypto.randomUUID(), timeoutMs: options.timeoutMs ?? 55000, deadline: Date.now() + (options.timeoutMs ?? 55000) }));
      return realSandbox.fetch(new Request(request, { headers }));
    } };
    const initialPrewarm = options.hangReservation ? undefined : await sandbox.fetch(new Request("https://sandbox/prewarm", { method: "POST", body: "{}" }));
    return { sandbox, recreate: () => { realSandbox = new ToolSandboxDO(mockCtx, sandboxEnv); }, storage, coordinatorStorage, getAlarmTime: () => alarmTime, mockContainer, initialPrewarm, analyticsPoints, billingCalls, reservationStarted, executionStarted, releaseReservation: () => releaseReservation?.(), setTenantActive: (active: boolean) => { tenantActive = active; }, setAirGapped: (enabled: boolean) => { airGapped = enabled; }, setWorkspaceErased: (erased: boolean) => { workspaceErased = erased; }, coordinator, r2Objects };
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

  it("blocks execution after project erasure and preserves the local barrier through a database restore", async () => {
    const { sandbox, storage, mockContainer, setWorkspaceErased } = await createTestSandbox({ platformDb: true, workspaceProject: true });
    const startCount = mockContainer.start.mock.calls.length;
    storage.set("workspace_files", { "secret.txt": { content: "private project data", hash: "a".repeat(64) } });
    storage.set("workspace_snapshot", { "secret.txt": "private project data" });
    setWorkspaceErased(true);
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ ok: false, error: "workspace_project_erased" });
    expect(storage.get("workspace_erasure_blocked")).toMatchObject({ tenantId: "tenant", spaceId: "space", projectId: "project" });
    expect(mockContainer.start).toHaveBeenCalledTimes(startCount);
    expect(storage.get("workspace_files")).toBeUndefined();
    expect(storage.get("workspace_snapshot")).toBeUndefined();

    setWorkspaceErased(false);
    const replay = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(replay.status).toBe(410);
    expect(mockContainer.start).toHaveBeenCalledTimes(startCount);
  });

  it("aborts an active project execution when the erasure alarm observes a late tombstone", async () => {
    const { sandbox, storage, mockContainer, executionStarted, setWorkspaceErased } = await createTestSandbox({
      platformDb: true, workspaceProject: true, hangExecution: true,
    });
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    await executionStarted;
    setWorkspaceErased(true);
    await sandbox.alarm();
    expect(mockContainer.destroy).toHaveBeenCalled();
    expect(storage.get("workspace_erasure_blocked")).toMatchObject({ projectId: "project" });
    expect(storage.get("workspace_pending_coordinator_checkpoint")).toBeUndefined();
    await execution;
    expect([...storage.keys()].some(key => String(key).startsWith("execution:"))).toBe(false);
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

  it("requires the authenticated attachment reader scope for audio and frame extraction", async () => {
    const { sandbox, mockContainer } = await createTestSandbox({ actorId: "attachment-reader", runId: "task-a" });
    const forwardsBefore = mockContainer.getTcpPort.mock.calls.length;
    let validForwarded = 0;
    for (const path of ["/media/extract-audio", "/media/extract-video-frames"]) {
      const invalid = await sandbox.fetch(new Request(`https://sandbox${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "tenant", spaceId: "space", taskId: "other-task", videoBase64: "AQID" }),
      }));
      expect(invalid.status).toBe(403);
      expect(mockContainer.getTcpPort).toHaveBeenCalledTimes(forwardsBefore + validForwarded);

      const valid = await sandbox.fetch(new Request(`https://sandbox${path}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "tenant", spaceId: "space", taskId: "task-a", videoBase64: "AQID" }),
      }));
      expect(valid.status).toBe(200);
      validForwarded++;
    }
    expect(mockContainer.getTcpPort).toHaveBeenCalled();
  });

  it("CAS-syncs workspace hashes, tracks lockfiles, and excludes node_modules", async () => {
    const { sandbox, storage } = await createTestSandbox();
    const first = await sandbox.fetch(new Request("https://sandbox/workspace/state-sync", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", files: { "package.json": { content: "{}", expected_hash: null } } }),
    }));
    const result = await first.json();
    expect(result).toMatchObject({ ok: true, rehydrate: true });
    expect(Object.keys(storage.get("workspace_files"))).toEqual(["package.json"]);
    const stale = await sandbox.fetch(new Request("https://sandbox/workspace/state-sync", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant", spaceId: "space", files: { "package.json": { content: "new", expected_hash: "a".repeat(64) } } }),
    }));
    expect(stale.status).toBe(409);
  });

  it("rejects workspace identity mismatches, unsafe paths, and malformed write payloads before forwarding", async () => {
    const { sandbox, mockContainer, storage } = await createTestSandbox();
    const callsBefore = mockContainer.getTcpPort.mock.calls.length;
    const stateSync = (body: unknown) => sandbox.fetch(new Request("https://sandbox/workspace/state-sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await stateSync({ tenantId: "other", spaceId: "space", files: {} })).status).toBe(403);
    storage.set("workspace_scope", { spaceId: "space", projectId: "project", installationId: "install-a", installationScope: "PROJECT_SHARED" });
    expect((await stateSync({ tenantId: "tenant", spaceId: "space", files: {} })).status).toBe(409);
    storage.delete("workspace_scope");
    expect((await stateSync({ tenantId: "tenant", spaceId: "space", files: { "../outside": { content: "x", expected_hash: null } } })).status).toBe(400);
    expect((await stateSync({ tenantId: "tenant", spaceId: "space", files: { ".env": { content: "secret", expected_hash: null } } })).status).toBe(400);
    const unsafeWrite = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: { "../outside": "x" }, expected_hashes: { "../outside": null } }),
    }));
    expect(unsafeWrite.status).toBe(400);
    const emptyWrite = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(emptyWrite.status).toBe(400);
    expect(mockContainer.getTcpPort).toHaveBeenCalledTimes(callsBefore);
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
    expect(storage.get("workspace_files")["src/main.ts"].hash).toMatch(/^[a-f0-9]{64}$/);
    // Real canonical readback/stale revision coverage lives in specialized-workspaces.test.ts;
    // this boundary fixture intentionally has an empty, read-only R2 double.
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

  it("applies the persisted sidecar execution ceiling to new executions", async () => {
    const { sandbox, mockContainer } = await createTestSandbox({ sidecar: true, sidecarExecutionSeconds: 1, hangExecution: true });
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: JSON.stringify({ code: "sleep" }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("maximum 1000ms") });
    expect(mockContainer.destroy).toHaveBeenCalled();
  });

  it("does not extend base-container idle time from an active-task hint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { sandbox, getAlarmTime, mockContainer } = await createTestSandbox({ platformDb: true });
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

  it("does not grant trusted-host network interception to an air-gapped Space", async () => {
    const { sandbox, mockContainer } = await createTestSandbox({ platformDb: true, airGapped: true });
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mockContainer.start).toHaveBeenCalledWith({ enableInternet: false });
    expect(mockContainer.interceptOutboundHttps).not.toHaveBeenCalled();
  });

  it("fails closed when the Space network policy store is unavailable", async () => {
    const { sandbox, mockContainer } = await createTestSandbox();
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(response.status).toBe(200);
    expect(mockContainer.start).toHaveBeenCalledWith({ enableInternet: false });
    expect(mockContainer.interceptOutboundHttps).not.toHaveBeenCalled();
  });

  it("revokes warm-container package egress when the Space becomes air-gapped", async () => {
    const { sandbox, mockContainer, setAirGapped } = await createTestSandbox({ platformDb: true });
    const first = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(first.status).toBe(200);
    expect(mockContainer.interceptOutboundHttps).toHaveBeenCalledTimes(9);

    setAirGapped(true);
    const second = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(second.status).toBe(200);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(mockContainer.start).toHaveBeenCalledTimes(2);
    expect(mockContainer.interceptOutboundHttps).toHaveBeenCalledTimes(9);
  });

  it("hard-stops an active container when an air-gap is enabled mid-run", async () => {
    const { sandbox, mockContainer, setAirGapped, executionStarted } = await createTestSandbox({ platformDb: true, hangExecution: true });
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    await executionStarted;
    expect(mockContainer.interceptOutboundHttps).toHaveBeenCalledTimes(9);

    setAirGapped(true);
    await sandbox.alarm();
    const response = await execution;
    expect(response.status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
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
      body: JSON.stringify({ status: "completed", tenantId: "tenant", spaceId: "space" }),
    }));
    expect(await response.json()).toMatchObject({ idle_window_ms: 60_000 });
    expect(storage.has("task_active")).toBe(false);
    expect(getAlarmTime()).toBe(1_070_000);
    vi.useRealTimers();
  });

  it("keeps an exact installed specialist sandbox warm only for the bounded reuse lease", async () => {
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
    const lifecycle = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.lifecycle");
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.blobs?.[1]).toBe("marketplace-sidecar");
    expect(lifecycle[0]?.doubles?.[0]).toBeGreaterThanOrEqual(5_000);
    expect(lifecycle[0]?.doubles?.[4]).toBe(1); // exact warm reuse
    const lifecycleV2 = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.lifecycle_v2");
    expect(lifecycleV2).toHaveLength(1);
    expect(lifecycleV2[0]?.blobs?.[8]).toBe("workspace-metrics-v2");
    expect(lifecycleV2[0]?.doubles).toHaveLength(20);
    expect(lifecycleV2[0]?.doubles?.slice(-3)).toEqual([0, 0, 0]);
    const pricing = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.pricing");
    expect(pricing).toHaveLength(1);
    expect(pricing[0]?.blobs?.slice(1, 4)).toEqual(["marketplace-sidecar", "internal_credits", expect.any(String)]);
    expect(pricing[0]?.doubles?.[2]).toBe(5); // default internal rate-card credits/hour, not provider spend
    expect(pricing[0]?.doubles?.[3]).toBe(0); // default rate source
    expect(analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.execution")).toHaveLength(2); // prewarm and user execution
    vi.useRealTimers();
  });

  it("destroys a installed specialist sandbox after failed or indeterminate execution", async () => {
    const { sandbox, storage, mockContainer, analyticsPoints } = await createTestSandbox({ sidecar: true, timeoutMs: 1000, hangExecution: true, runId: "worker-failure" });
    const result = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    expect(result.status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect(storage.has("sidecar_warm_expires_at")).toBe(false);
    const lifecycle = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.lifecycle");
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.doubles?.[6]).toBe(2); // prewarm and failed command are both measured
    // The enforced deadline is 1,000 ms; runtime sampling can finish slightly before the
    // timer boundary because the execution abort and cleanup race on the isolate event loop;
    // allow up to 1.5 seconds for loaded-runner cleanup without accepting a multi-second miss.
    expect(lifecycle[0]?.doubles?.[7]).toBeGreaterThanOrEqual(900);
    expect(lifecycle[0]?.doubles?.[7]).toBeLessThanOrEqual(1500);
    expect(storage.has("container_runtime_metrics")).toBe(false);
  });

  it("destroys a container whose guest process cleanup could not be verified", async () => {
    const { sandbox, storage, mockContainer } = await createTestSandbox({ taintedExecution: true, runId: "worker-tainted" });
    const response = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: "{}" }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body).toMatchObject({ ok: false, workspace_may_require_reconciliation: true });
    expect(body).not.toHaveProperty("workspace_sync");
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    expect([...storage.values()].some(value => value?.status === "indeterminate")).toBe(true);
  });

  it("suspension force-stops the active runtime without publishing past its checked branch", async () => {
    const { sandbox, coordinator, setTenantActive, executionStarted, mockContainer } = await createTestSandbox({ platformDb: true, unifiedWorkspace: true, workspaceProject: true, hangExecution: true, timeoutMs: 5000, runId: "suspended-run" });
    await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "drafts/suspend.txt": "already checkpointed" }, expected_hashes: { "drafts/suspend.txt": null } }),
    }));
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: JSON.stringify({ code: "export async function run() { return true; }" }) }));
    await executionStarted;
    setTenantActive(false);
    await sandbox.alarm();
    expect((await execution).status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = (branch: string) => workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(branch)}`, {}).then(result => result.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("suspended-run")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await read("main")).toMatchObject({ head: { revision: 1 }, entries: [] });
    expect(await read(`runs/${runHash.slice(0, 32)}`)).toMatchObject({ head: { revision: 2 }, entries: [{ path: "drafts/suspend.txt" }] });
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

  it("routes an internal project sandbox checkpoint through the atomic workspace coordinator and reports per-execution byte dimensions", async () => {
    const { sandbox, coordinator, r2Objects, storage, analyticsPoints } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "workspace-run" });
    const written = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "notes/result.txt": "committed from container" }, expected_hashes: { "notes/result.txt": null } }),
    }));
    expect(written.status, await written.clone().text()).toBe(200);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, "/v1/read?branch=main", {});
    const workspace = await read.json() as { head?: { revision: number }; entries?: Array<{ path: string; sha256: string; objectKey: string }> };
    expect(workspace.head?.revision).toBe(1);
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("workspace-run")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const branchRead = await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(`runs/${runHash.slice(0, 32)}`)}`, {});
    const runBranch = await branchRead.json() as { head?: { revision: number }; entries?: Array<{ path: string; sha256: string; objectKey: string }> };
    expect(runBranch.head?.revision).toBe(2);
    expect(runBranch.entries).toMatchObject([{ path: "notes/result.txt" }]);
    expect(r2Objects.has(runBranch.entries![0]!.objectKey)).toBe(true);
    expect(storage.get("container_runtime_metrics")).toMatchObject({ workspaceBytesCaptured: 24, workspaceBytesStaged: 24, workspaceCheckpoints: 1 });
    const executionMetrics = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.execution").at(-1);
    expect(executionMetrics?.blobs?.[8]).toBe("workspace-metrics-v1");
    expect(executionMetrics?.doubles).toHaveLength(4); // list/read/write/delete counters are emitted per execution
    const executionMetricsV2 = analyticsPoints.filter((point) => point.blobs?.[0] === "container.runtime.execution_v2").at(-1);
    expect(executionMetricsV2?.blobs?.[8]).toBe("workspace-metrics-v2");
    expect(executionMetricsV2?.doubles?.slice(6, 10)).toEqual([0, 24, 24, 1]); // hydrated, captured, staged bytes, successful checkpoints
    expect(executionMetricsV2?.doubles?.slice(11, 14)).toEqual([0, 0, expect.any(Number)]); // failures, failed latency, pending stage age
    expect(executionMetricsV2?.blobs?.join(" ")).not.toContain("workspace-run");
  });

  it("accepts workspace writes above the legacy 2 MiB cap and checkpoints the full content", async () => {
    const { sandbox, coordinator } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "large-workspace-run" });
    const content = "x".repeat(20 * 1024 * 1024);
    const written = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "uploads/large.txt": content }, expected_hashes: { "uploads/large.txt": null } }),
    }));
    expect(written.status, await written.clone().text()).toBe(200);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("large-workspace-run")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const read = await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(`runs/${runHash.slice(0, 32)}`)}`, {});
    const workspace = await read.json() as { entries?: Array<{ path: string; size: number; sha256: string }> };
    const expectedHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(workspace.entries).toMatchObject([{ path: "uploads/large.txt", size: 20 * 1024 * 1024, sha256: expectedHash }]);
  }, 90_000);

  it("requires the barrier migration workflow instead of implicitly importing an existing project during hydration", async () => {
    const { sandbox, coordinatorStorage, r2Objects } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, workspaceProjectUnmigrated: true, runId: "unmigrated-project" });
    const response = await sandbox.fetch(new Request("https://sandbox/workspace/list", { method: "POST" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: "Error: workspace_project_migration_required" });
    expect([...coordinatorStorage.keys()].some(key => String(key).includes("workspace-v1/"))).toBe(false);
    expect([...r2Objects.keys()].some(key => String(key).includes("/content/"))).toBe(false);
  });

  it("replays a staged checkpoint after Durable Object reconstruction without publishing partial state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { sandbox, recreate, coordinator, coordinatorStorage, storage, analyticsPoints } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "restart-recovery", failCheckpointOnce: true });
    const attempted = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "recovery/state.txt": "survives restart" }, expected_hashes: { "recovery/state.txt": null } }),
    }));
    expect(attempted.status).toBe(409);
    const pending = storage.get("workspace_pending_coordinator_checkpoint") as { stageId?: string; changes?: unknown[] };
    expect(pending.stageId).toBeTruthy();
    expect(pending.changes).toBeUndefined();
    const originalSession = storage.get("workspace_session") as { id: string };
    expect(coordinatorStorage.get(`session:${originalSession.id}`)).toMatchObject({ status: "active", allocationGeneration: originalSession.allocationGeneration, fence: originalSession.fence });
    const failedSample = analyticsPoints.filter(point => point.blobs?.[0] === "container.runtime.execution_v2").at(-1);
    expect(failedSample?.doubles?.[11]).toBe(1);
    expect(failedSample?.doubles?.[12]).toBeGreaterThanOrEqual(0);
    vi.setSystemTime(Date.now() + 1_500);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const mainBeforeRecovery = await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, "/v1/read?branch=main", {}).then(response => response.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    expect(mainBeforeRecovery).toMatchObject({ head: { revision: 1 }, entries: [] });

    recreate();
    const resumed = await sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", body: JSON.stringify({ code: "return true" }) }));
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect(storage.get("workspace_pending_coordinator_checkpoint")).toBeUndefined();
    const completed = await sandbox.fetch(new Request("https://sandbox/lifecycle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", tenantId: "tenant", spaceId: "space", projectId: "project" }),
    }));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ ok: true, status: "completed" });
    expect(storage.get("workspace_pending_coordinator_checkpoint")).toBeUndefined();
    const mainAfterRecovery = await workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, "/v1/read?branch=main", {}).then(response => response.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string; objectKey: string }> }>);
    expect(mainAfterRecovery).toMatchObject({ head: { revision: 2 }, entries: [{ path: "recovery/state.txt" }] });
    const recoveredSample = analyticsPoints.filter(point => point.blobs?.[0] === "container.runtime.execution_v2").at(-1);
    expect(recoveredSample?.doubles?.[9]).toBe(1);
    expect(recoveredSample?.doubles?.[13]).toBeGreaterThanOrEqual(1_500);
    vi.useRealTimers();
  });

  it("merges a completed run branch into its requested branch only after checked publication", async () => {
    const { sandbox, coordinator } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "completion-run" });
    const write = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "src/result.txt": "finished" }, expected_hashes: { "src/result.txt": null } }),
    }));
    expect(write.status, await write.clone().text()).toBe(200);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = async () => workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, "/v1/read?branch=main", {}).then(response => response.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    expect((await read()).head.revision).toBe(1);
    const completed = await sandbox.fetch(new Request("https://sandbox/lifecycle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", tenantId: "tenant", spaceId: "space", projectId: "project" }),
    }));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ ok: true, status: "completed" });
    expect(await read()).toMatchObject({ head: { revision: 2 }, entries: [{ path: "src/result.txt" }] });
  });

  it("flushes a blocked run to its isolated branch without merging it into main", async () => {
    const { sandbox, coordinator } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "blocked-run" });
    await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "drafts/blocked.txt": "preserved" }, expected_hashes: { "drafts/blocked.txt": null } }),
    }));
    const response = await sandbox.fetch(new Request("https://sandbox/lifecycle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "blocked", tenantId: "tenant", spaceId: "space", projectId: "project" }),
    }));
    expect(response.status).toBe(200);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = (branch: string) => workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(branch)}`, {}).then(result => result.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("blocked-run")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await read("main")).toMatchObject({ head: { revision: 1 }, entries: [] });
    expect(await read(`runs/${runHash.slice(0, 32)}`)).toMatchObject({ head: { revision: 2 }, entries: [{ path: "drafts/blocked.txt" }] });
  });

  it("cancels an active execution while retaining its checked run branch and leaving main unchanged", async () => {
    const { sandbox, coordinator, executionStarted, mockContainer } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, hangExecution: true, timeoutMs: 5000, runId: "cancel-run" });
    await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "drafts/cancelled.txt": "staged before cancel" }, expected_hashes: { "drafts/cancelled.txt": null } }),
    }));
    const executionId = "exec-cancel-1";
    const execution = sandbox.fetch(new Request("https://sandbox/exec", { method: "POST", headers: { "x-test-execution-id": executionId }, body: JSON.stringify({ code: "export async function run() { return true; }" }) }));
    await executionStarted;
    const cancelled = await sandbox.fetch(new Request("https://sandbox/cancel", { method: "POST", headers: { "x-test-execution-id": executionId } }));
    expect(cancelled.status).toBe(200);
    expect((await execution).status).toBe(409);
    expect(mockContainer.destroy).toHaveBeenCalledOnce();
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = (branch: string) => workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(branch)}`, {}).then(result => result.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cancel-run")))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await read("main")).toMatchObject({ head: { revision: 1 }, entries: [] });
    expect(await read(`runs/${runHash.slice(0, 32)}`)).toMatchObject({ head: { revision: 2 }, entries: [{ path: "drafts/cancelled.txt" }] });
  });

  it.each(["failed", "indeterminate"] as const)("keeps a %s execution's checked branch isolated from main", async status => {
    const runId = `${status}-run`;
    const { sandbox, coordinator } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId });
    const write = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "drafts/result.txt": `${status} output` }, expected_hashes: { "drafts/result.txt": null } }),
    }));
    expect(write.status).toBe(200);
    const response = await sandbox.fetch(new Request("https://sandbox/lifecycle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, tenantId: "tenant", spaceId: "space", projectId: "project" }),
    }));
    expect(response.status).toBe(200);
    const scope = { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" as const };
    const read = (branch: string) => workspaceCoordinatorRequest({ WORKSPACE_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }),
    }, PLATFORM_SECRET: "test-secret" }, scope, `/v1/read?branch=${encodeURIComponent(branch)}`, {}).then(result => result.json() as Promise<{ head: { revision: number }; entries: Array<{ path: string }> }>);
    const runHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await read("main")).toMatchObject({ head: { revision: 1 }, entries: [] });
    expect(await read(`runs/${runHash.slice(0, 32)}`)).toMatchObject({ head: { revision: 2 }, entries: [{ path: "drafts/result.txt" }] });
  });

  it("reopens a new checked session after a cold runtime replacement", async () => {
    const { sandbox, storage, mockContainer } = await createTestSandbox({ unifiedWorkspace: true, workspaceProject: true, runId: "replacement-run" });
    await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "src/before-replacement.txt": "persisted" }, expected_hashes: { "src/before-replacement.txt": null } }),
    }));
    const prior = storage.get("workspace_session");
    await mockContainer.destroy();
    const next = await sandbox.fetch(new Request("https://sandbox/workspace/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", projectId: "project", files: { "src/after-replacement.txt": "new generation" }, expected_hashes: { "src/after-replacement.txt": null } }),
    }));
    expect(next.status, await next.clone().text()).toBe(200);
    expect(storage.get("workspace_runtime_generation")).toBe(2);
    expect(storage.get("workspace_session").id).not.toBe(prior.id);
    expect(storage.get("workspace_session").generation).toBe(2);
  });
});
