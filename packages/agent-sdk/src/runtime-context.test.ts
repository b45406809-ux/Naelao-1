import { describe, expect, it } from "vitest";
import { actorAddress, createProjectMcpClient, scopedInstallationId } from "./runtime-context.js";

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
