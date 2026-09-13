import {
  WorkspaceStateCoordinator,
  authorizeProject,
  canAccessSpace,
  defineLaunchpadSpace,
  defineProjectAutomation,
  isGitTracked,
  microForkName,
  normalizeWorkspacePath,
  routeRuntime,
  shouldStopContainer,
} from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";

describe("Launchpad workspace runtime", () => {
  const root = defineLaunchpadSpace({
    id: "company",
    depth: 0,
    parentId: null,
  });
  const legal = defineLaunchpadSpace({
    id: "legal",
    depth: 1,
    parentId: root.id,
  });

  it("enforces a two-level Launchpad-only hierarchy", () => {
    expect(root.type).toBe("launchpad");
    expect(legal.type).toBe("launchpad");
    expect(() =>
      defineLaunchpadSpace({ id: "bad", depth: 1, parentId: null })
    ).toThrow();
  });

  it("inherits administration downward but not ordinary membership", () => {
    expect(
      canAccessSpace(legal, { userId: "boss", parentRole: "admin" }, "manage")
    ).toBe(true);
    expect(
      canAccessSpace(root, { userId: "lawyer", role: "member" }, "manage")
    ).toBe(false);
    expect(
      canAccessSpace(legal, { userId: "lawyer", role: "member" }, "read")
    ).toBe(true);
  });

  it("conceals inaccessible private projects with a 404", () => {
    expect(
      authorizeProject({ visibility: "private", isSpaceMember: true })
    ).toEqual({ allowed: false, status: 404 });
    expect(
      authorizeProject({
        visibility: "private",
        isSpaceMember: true,
        projectRole: "viewer",
      })
    ).toEqual({ allowed: true });
    expect(
      authorizeProject({ visibility: "public", isSpaceMember: true })
    ).toEqual({ allowed: true });
  });

  it("requires every automation to belong to a project", () => {
    expect(() =>
      defineProjectAutomation({
        id: "a",
        projectId: "",
        kind: "cron",
        entrypoint: "sync",
      })
    ).toThrow();
  });

  it("keeps deliverables and AVOS metadata in separate namespaces", () => {
    expect(normalizeWorkspacePath("src/index.ts")).toBe(
      "/workspace/src/index.ts"
    );
    expect(isGitTracked("/.avos/shared/skills/a.ts")).toBe(false);
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow();
  });

  it("routes the six-tier ladder without exposing tier selection", () => {
    expect(routeRuntime({ tool: "Read" }).tier).toBe(1);
    expect(
      routeRuntime({ tool: "Bash", pythonImports: ["pandas"] }).engine
    ).toBe("pyodide");
    expect(routeRuntime({ tool: "Bash", needsDurability: true }).tier).toBe(3);
    expect(routeRuntime({ tool: "Browser" }).engine).toBe("kitesurf");
    expect(
      routeRuntime({ tool: "Browser", needsScreenshot: true }).engine
    ).toBe("chromium");
    expect(routeRuntime({ tool: "Bash", needsNative: true }).tier).toBe(6);
  });

  it("uses a strict sixty-second container idle window", () => {
    expect(
      shouldStopContainer({ projectId: "p", lastUsedAt: 1_000 }, 60_999)
    ).toBe(false);
    expect(
      shouldStopContainer({ projectId: "p", lastUsedAt: 1_000 }, 61_000)
    ).toBe(true);
  });

  it("rejects stale state writers across all synchronized dimensions", () => {
    const state = new WorkspaceStateCoordinator({
      cwd: "/workspace",
      env: {},
      gitHead: "a",
      revision: 0,
    });
    expect(state.update(0, { cwd: "/workspace/src" }).revision).toBe(1);
    expect(() => state.update(0, { gitHead: "b" })).toThrow(
      "workspace_state_conflict"
    );
    expect(microForkName("Fix checkout #42")).toBe("avos/task/fix-checkout-42");
  });
});
