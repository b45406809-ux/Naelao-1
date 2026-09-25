import { describe, expect, it, vi } from "vitest";
import { ToolSandboxDO } from "./ToolSandboxDO.js";

describe("ToolSandboxDO Runtime and State Coordination", () => {
  function createTestSandbox() {
    const storage = new Map();
    let alarmTime = null;
    let containerRunning = false;

    const mockContainer = {
      get running() {
        return containerRunning;
      },
      start: vi.fn(() => {
        containerRunning = true;
      }),
      getTcpPort: () => ({
        fetch: async (req) => {
          const url = new URL(req.url);
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
      }),
    };

    const mockCtx = {
      container: mockContainer,
      storage: {
        get: async (k) => storage.get(k),
        put: async (k, v) => {
          storage.set(k, v);
        },
        setAlarm: async (time) => {
          alarmTime = time;
        },
        deleteAlarm: async () => {
          alarmTime = null;
        },
      },
    };

    const sandbox = new ToolSandboxDO(mockCtx, {});
    return { sandbox, storage, getAlarmTime: () => alarmTime, mockContainer };
  }

  it("coordinates 4D shell state and rejects conflicting revisions", async () => {
    const { sandbox } = createTestSandbox();
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

  it("implements virtual display automation endpoints", async () => {
    const { sandbox } = createTestSandbox();
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
    const { sandbox, getAlarmTime } = createTestSandbox();
    const start = Date.now();
    await sandbox.fetch(
      new Request("https://sandbox/workspace/list", { method: "POST" })
    );
    expect(getAlarmTime()).toBeGreaterThanOrEqual(start + 59_000);
  });
});
