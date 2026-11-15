import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveAndCleanupProjectWorkspace, getProjectWorkspaceCleanupStatus } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("archiveAndCleanupProjectWorkspace", () => {
  it("confirms cleanup for the exact encoded project and forwards a bounded-page cursor", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({ archived: true, erased: true, hasMore: true, nextCursor: "opaque-page-2", providerConnectionsDeleted: false });
    }));

    const result = await archiveAndCleanupProjectWorkspace("space/a", "generated project:1", {
      sessionToken: "session-a", endUserId: "owner-a",
    }, "opaque-page-1");

    expect(result).toMatchObject({ archived: true, hasMore: true, nextCursor: "opaque-page-2", providerConnectionsDeleted: false });
    expect(new URL(requestUrl).pathname).toBe("/v1/spaces/space%2Fa/projects/generated%20project%3A1");
    expect(requestInit?.method).toBe("DELETE");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer session-a");
    expect(new Headers(requestInit?.headers).get("x-naelao-end-user-id")).toBe("owner-a");
    expect(JSON.parse(String(requestInit?.body))).toEqual({ confirm: true, cursor: "opaque-page-1" });
  });

  it("reads bounded server progress for the exact requested generated projects", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({ items: [{ projectId: "generated-a", status: "cleaning", phase: "bridge", cleanupPage: 2,
        jurisdiction: "eu", requestedAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:01:00.000Z",
        providerDeletion: { total: 1, deleted: 0, pending: 1, unresolved: 0 } }] });
    }));

    const result = await getProjectWorkspaceCleanupStatus("space/a", ["generated-a", "generated-b"], {
      sessionToken: "session-a", endUserId: "owner-a",
    });

    expect(result.items).toMatchObject([{ projectId: "generated-a", status: "cleaning", cleanupPage: 2,
      providerDeletion: { total: 1, pending: 1 } }]);
    expect(new URL(requestUrl).pathname).toBe("/v1/spaces/space%2Fa/workspace-cleanup-status");
    expect(requestInit?.method).toBe("POST");
    expect(JSON.parse(String(requestInit?.body))).toEqual({ projectIds: ["generated-a", "generated-b"] });
  });
});
