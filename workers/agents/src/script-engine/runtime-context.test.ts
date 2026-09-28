import { describe, expect, it, vi } from "vitest";
import { createRuntimeContext, type RuntimeContextServices } from "@naelao/agent-sdk";

function services(): RuntimeContextServices {
  return {
    fs: { read: vi.fn(async () => ""), write: vi.fn(async () => undefined), edit: vi.fn(async () => undefined), diff: vi.fn(async () => ""), grep: vi.fn(async () => []), glob: vi.fn(async () => []) },
    vault: { fetchWithAuth: vi.fn(async () => new Response()) },
    browser: { navigate: vi.fn(), click: vi.fn(), type: vi.fn(), extract: vi.fn() },
    mcp: { call: vi.fn(), listTools: vi.fn() }, connectors: { call: vi.fn() }, run: { runSkill: vi.fn() },
    project: { getJournal: vi.fn(), updateJournal: vi.fn(), createTask: vi.fn(), listThreads: vi.fn(), postMessage: vi.fn() },
    space: { createProject: vi.fn(), listProjects: vi.fn(), getWalletBalance: vi.fn(), sendNotification: vi.fn() },
  };
}

describe("createRuntimeContext", () => {
  it("physically exposes only the caller's authority scope", () => {
    const space = createRuntimeContext({ scope: "SPACE_WIDE", spaceId: "s", services: services() });
    const project = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: services() });
    expect("space" in space).toBe(true); expect("project" in space).toBe(false);
    expect("project" in project).toBe(true); expect("space" in project).toBe(false);
  });

  it("normalizes paths and rejects escapes", async () => {
    const backing = services();
    const context = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: backing });
    await context.fs.write("src/a.ts", "x");
    expect(backing.fs.write).toHaveBeenCalledWith("/workspace/src/a.ts", "x");
    await expect(context.fs.read("/workspace/../../etc/passwd")).rejects.toThrow("escapes");
  });

  it("routes semantic connector proxy calls through the host adapter", async () => {
    const backing = services();
    const context = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: backing });
    const send = context.connectors.use("primary_inbox").send_email as (p: Record<string, unknown>) => Promise<unknown>;
    await send({ to: "person@example.test" });
    expect(backing.connectors.call).toHaveBeenCalledWith("primary_inbox", "send_email", { to: "person@example.test" }, []);
  });

  it("maps the primary calendar surface to standardized namespaced tools", async () => {
    const backing = services();
    const context = createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: backing });
    await context.connectors.use("primary_calendar").get_availability({ startDate: "2026-01-01", endDate: "2026-01-02" });
    expect(backing.connectors.call).toHaveBeenCalledWith("primary_calendar", "calendar.get_availability", { startDate: "2026-01-01", endDate: "2026-01-02" }, []);
  });
});
