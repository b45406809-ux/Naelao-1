import { describe, expect, it } from "vitest";
import { actorAddress, createProjectMcpClient, createRuntimeContext, scopedInstallationId, sharedDrivePath } from "./runtime-context.js";

describe("three workspace SDK boundaries", () => {
  it("keeps assistant/project files and the optional shared drive on separate roots", async () => {
    const reads: string[] = [];
    const fs = { read: async (path: string) => { reads.push(path); return path; }, write: async () => undefined,
      edit: async () => undefined, diff: async () => "", grep: async () => [], glob: async () => [] };
    const space = { createProject: async () => ({}), listProjects: async () => [], sendNotification: async () => ({}) };
    const context = createRuntimeContext({ scope: "SPACE_WIDE", spaceId: "s", services: { fs, sharedDrive: fs, space } as never });
    expect("sharedDrive" in createRuntimeContext({ scope: "SPACE_WIDE", spaceId: "s", services: { fs, space } as never })).toBe(false);
    await context.fs.read("notes.txt");
    await context.sharedDrive?.read("dropzones/audio/input.wav");
    expect(reads).toEqual(["/workspace/notes.txt", "/space/shared/dropzones/audio/input.wav"]);
    await expect(context.sharedDrive!.read("../../assistant/memory.sqlite")).rejects.toThrow("Path escapes /space/shared");
    expect(() => sharedDrivePath("/space/shared/../assistant/private")).toThrow("Path escapes /space/shared");
  });
  it("does not allow the shared-drive service to be attached to a project runtime", () => {
    const fs = { read: async () => "", write: async () => undefined, edit: async () => undefined, diff: async () => "", grep: async () => [], glob: async () => [] };
    expect(() => createRuntimeContext({ scope: "PROJECT_BOUND", projectId: "p", services: { fs, sharedDrive: fs } as never })).toThrow("shared_drive_requires_space_scope");
  });
});

describe("actorAddress", () => {
  it("structurally isolates private, project and space actors", () => {
    expect(actorAddress({ scope: "USER_PRIVATE", spaceId: "s", userId: "u" })).toBe("actor:personal:s:u");
    expect(actorAddress({ scope: "PROJECT_BOUND", spaceId: "s", projectId: "p" })).toBe("actor:project:s:p");
    expect(actorAddress({ scope: "SPACE_WIDE", spaceId: "s" })).toBe("actor:space:s");
  });
});

describe("scopedInstallationId instance keys", () => {
  const base = { tenantId: "t", spaceId: "s", projectId: "p", extensionId: "ext_bot", scope: "PROJECT_BOUND" as const };
  it("keeps the default identity stable and isolates explicitly named instances", () => {
    expect(scopedInstallationId(base)).toBe(scopedInstallationId({ ...base, instanceKey: "default" }));
    expect(scopedInstallationId({ ...base, instanceKey: "trading_live" })).not.toBe(scopedInstallationId({ ...base, instanceKey: "trading_paper" }));
  });
  it("rejects invalid instance keys", () => {
    expect(() => scopedInstallationId({ ...base, instanceKey: "../shared" })).toThrow("invalid_instance_key");
  });
});

describe("project MCP response bounds", () => {
  it("rejects streamed oversized responses without relying on Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    const fetch = async () => new Response(body);
    const client = createProjectMcpClient({
      spacesWorker: { fetch },
      spaceId: "space-1",
      tenantId: "tenant-1",
      internalToken: "internal",
    });

    await expect(client.listTools("project-1")).rejects.toThrow(
      "project_mcp_response_too_large"
    );
  });
});
