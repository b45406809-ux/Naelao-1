import { describe, expect, it } from "vitest";
import {
  ContainerVirtualDisplay,
  MultiplexedBridge,
  WorkspaceStateCoordinator,
  authorizeProject,
  canAccessSpace,
  defineLaunchpadSpace,
  isGitTracked,
  microForkName,
  normalizeWorkspacePath,
  planEnvironmentHandoff,
  requireManageableAutomationProject,
  routeRuntime,
  selectContainerBackend,
  shouldStopContainer,
} from "./launchpad-runtime.js";

describe("Launchpad Hierarchy & Space Isolation", () => {
  it("enforces two-level hierarchy constraints", () => {
    expect(
      defineLaunchpadSpace({ id: "root", depth: 0, parentId: null })
    ).toMatchObject({
      depth: 0,
      parentId: null,
      type: "launchpad",
    });
    expect(
      defineLaunchpadSpace({ id: "dept", depth: 1, parentId: "root" })
    ).toMatchObject({
      depth: 1,
      parentId: "root",
      type: "launchpad",
    });
    expect(() => {
      // @ts-expect-error invalid depth
      defineLaunchpadSpace({ id: "grandchild", depth: 2, parentId: "dept" });
    }).toThrow();
    expect(() =>
      defineLaunchpadSpace({ id: "bad-root", depth: 0, parentId: "other" })
    ).toThrow();
    expect(() =>
      defineLaunchpadSpace({ id: "bad-dept", depth: 1, parentId: null })
    ).toThrow();
  });

  it("governs parent oversight and member isolation", () => {
    const root = defineLaunchpadSpace({ id: "root", depth: 0, parentId: null });
    const dept = defineLaunchpadSpace({
      id: "dept",
      depth: 1,
      parentId: "root",
    });
    expect(
      canAccessSpace(dept, { userId: "cfo", parentRole: "admin" }, "manage")
    ).toBe(true);
    expect(
      canAccessSpace(dept, { userId: "dev", role: "member" }, "read")
    ).toBe(true);
    expect(
      canAccessSpace(dept, { userId: "dev", role: "member" }, "manage")
    ).toBe(false);
    expect(
      canAccessSpace(root, { userId: "dev", role: "member" }, "read")
    ).toBe(true);
    expect(canAccessSpace(root, { userId: "dev" }, "read")).toBe(false);
  });

  it("conceals unauthorized private projects identically to absent projects", () => {
    expect(
      authorizeProject({ visibility: "public", isSpaceMember: true })
    ).toEqual({ allowed: true });
    expect(
      authorizeProject({
        visibility: "private",
        isSpaceMember: true,
        projectRole: "editor",
      })
    ).toEqual({ allowed: true });
    expect(
      authorizeProject({
        visibility: "private",
        isSpaceMember: true,
        isSpaceAdmin: true,
      })
    ).toEqual({ allowed: true });
    expect(
      authorizeProject({ visibility: "private", isSpaceMember: true })
    ).toEqual({ allowed: false, status: 404 });
    expect(
      authorizeProject({ visibility: "public", isSpaceMember: false })
    ).toEqual({ allowed: false, status: 404 });
  });

  it("anchors automations to active projects", () => {
    expect(
      requireManageableAutomationProject({
        spaceId: "s1",
        projectId: "p1",
        projectSpaceId: "s1",
        projectStatus: "active",
        userRole: "owner",
      })
    ).toEqual({ allowed: true });

    expect(() =>
      requireManageableAutomationProject({
        spaceId: "s1",
        projectId: "p1",
        projectSpaceId: "s2",
        projectStatus: "active",
        isSpaceAdmin: true,
      })
    ).toThrow("project_not_found");
  });
});

describe("Namespace Boundaries & Execution Routing", () => {
  it("strictly separates /workspace/ and /.avos/", () => {
    expect(normalizeWorkspacePath("src/index.ts")).toBe(
      "/workspace/src/index.ts"
    );
    expect(normalizeWorkspacePath("/.avos/skills/mine.ts")).toBe(
      "/.avos/skills/mine.ts"
    );
    expect(isGitTracked("/workspace/file.txt")).toBe(true);
    expect(isGitTracked("/.avos/state.json")).toBe(false);
    expect(() => normalizeWorkspacePath("..\\secret")).toThrow();
    expect(() =>
      normalizeWorkspacePath("/workspace/%2e%2e/.avos/secret")
    ).toThrow();
    expect(() =>
      normalizeWorkspacePath("/workspace/../.avos/secret.json")
    ).toThrow();
  });

  it("routes intents to the minimal capable compute tier", () => {
    expect(routeRuntime({ tool: "Read" })).toMatchObject({
      tier: 1,
      engine: "artifact-vfs",
    });
    expect(routeRuntime({ tool: "Bash", command: "ls" })).toMatchObject({
      tier: 2,
      engine: "isolate-shell",
    });
    expect(
      routeRuntime({ tool: "Bash", pythonImports: ["json", "math"] })
    ).toMatchObject({ tier: 2, engine: "pyodide" });
    expect(routeRuntime({ tool: "Bash", needsDurability: true })).toMatchObject(
      { tier: 3, engine: "workflow" }
    );
    expect(routeRuntime({ tool: "Browser" })).toMatchObject({
      tier: 4,
      engine: "kitesurf",
    });
    expect(
      routeRuntime({ tool: "Browser", needsScreenshot: true })
    ).toMatchObject({ tier: 5, engine: "chromium" });
    expect(
      routeRuntime({ tool: "Bash", pythonImports: ["torch"] })
    ).toMatchObject({ tier: 6, engine: "container" });
  });

  it("selects container backend and validates handoffs", () => {
    expect(
      selectContainerBackend({ gpu: true, localTunnelAuthorized: true })
    ).toBe("local_workstation");
    expect(() =>
      selectContainerBackend({ gpu: true, localTunnelAuthorized: false })
    ).toThrow();
    expect(
      selectContainerBackend({ native: false, browserAvailable: true })
    ).toBe("webcontainer");
    expect(selectContainerBackend({ native: true })).toBe("cloudflare_container");
    expect(() =>
      planEnvironmentHandoff("webcontainer", "webcontainer", [
        "/workspace/package.json",
      ])
    ).toThrow();
    expect(() =>
      planEnvironmentHandoff("webcontainer", "cloudflare_container", [
        "/workspace/node_modules/pkg",
      ])
    ).toThrow();
  });

  it("evaluates container idle lease boundaries at 60s", () => {
    const lease = { projectId: "p", lastUsedAt: 100_000 };
    expect(shouldStopContainer(lease, 159_999)).toBe(false);
    expect(shouldStopContainer(lease, 160_000)).toBe(true);
  });

  it("coordinates 4-dimension state and detects conflicts", () => {
    const coord = new WorkspaceStateCoordinator({
      cwd: "/workspace",
      env: { FOO: "bar" },
      gitHead: "a",
      revision: 1,
    });
    expect(coord.update(1, { cwd: "/workspace/src" })).toMatchObject({
      cwd: "/workspace/src",
      revision: 2,
    });
    expect(() => coord.update(1, { cwd: "/workspace/lib" })).toThrow(
      "workspace_state_conflict"
    );
  });

  it("formats task micro-fork names", () => {
    expect(microForkName("Task #402: Clean DB")).toBe(
      "avos/task/task-402-clean-db"
    );
    expect(() => microForkName("   ")).toThrow();
  });

  it("multiplexes binary/JSON calls without correlation cross-talk", async () => {
    const outbox: string[] = [];
    const bridge = new MultiplexedBridge((msg: string) => {
      outbox.push(msg);
    });
    const p1 = bridge.call<string>("terminal", "exec", { cmd: "echo 1" });
    const p2 = bridge.call<string>("terminal", "exec", { cmd: "echo 2" });

    const [raw1, raw2] = outbox;
    if (!raw1 || !raw2) throw new Error("Bridge did not send both calls");
    const msg1 = JSON.parse(raw1);
    const msg2 = JSON.parse(raw2);
    expect(msg1.id).not.toBe(msg2.id);

    bridge.handleMessage(JSON.stringify({ id: msg2.id, result: "two" }));
    bridge.handleMessage(JSON.stringify({ id: msg1.id, result: "one" }));

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1).toBe("one");
    expect(res2).toBe("two");
  });

  it("dispatches virtual display actions and captures real frames", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).endsWith("/display/capture")) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      }
      return new Response(JSON.stringify({ ok: true }));
    };

    const display = new ContainerVirtualDisplay("https://container", mockFetch);
    const frame = await display.capture();
    expect(frame[0]).toBe(0x89);
    await display.mouse(100, 200, "left");
    await display.type("automation text");

    expect(calls.map((c) => c.url)).toEqual([
      "https://container/display/capture",
      "https://container/display/mouse",
      "https://container/display/type",
    ]);
  });

  it("rejects streamed display frames above the container's 16 MiB response cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const display = new ContainerVirtualDisplay("https://container", async () => new Response(body));

    await expect(display.capture()).rejects.toThrow("display_capture_too_large");
  });
});
