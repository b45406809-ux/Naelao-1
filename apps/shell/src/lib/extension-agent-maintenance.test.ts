import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjectExtensionAgentMaintenance, grantProjectExtensionAgentMaintenance, revokeProjectExtensionAgentMaintenance } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("project extension agent maintenance API", () => {
  it("uses the installation-scoped authenticated grant route for list, grant, and revoke", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({ permission: "settings.propose", eligible_agents: [], grants: [] });
    }));
    const session = { sessionToken: "session-token", endUserId: "owner-a" };
    await getProjectExtensionAgentMaintenance("space/a", "project-a", "instance-a", session);
    await grantProjectExtensionAgentMaintenance("space/a", "project-a", "instance-a", session, { agentId: "agent-a", expectedRevision: 0 });
    await revokeProjectExtensionAgentMaintenance("space/a", "project-a", "instance-a", session, { agentId: "agent-a", expectedRevision: 1 });

    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      "/v1/spaces/space%2Fa/projects/project-a/extension-installations/instance-a/agent-maintenance-grants",
      "/v1/spaces/space%2Fa/projects/project-a/extension-installations/instance-a/agent-maintenance-grants",
      "/v1/spaces/space%2Fa/projects/project-a/extension-installations/instance-a/agent-maintenance-grants",
    ]);
    expect(requests.map(request => request.init?.method ?? "GET")).toEqual(["GET", "PUT", "DELETE"]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ agent_id: "agent-a", permission: "settings.propose", expected_revision: 0 });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ agent_id: "agent-a", permission: "settings.propose", expected_revision: 1 });
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer session-token");
      expect(headers.get("x-naelao-end-user-id")).toBe("owner-a");
    }
  });
});
