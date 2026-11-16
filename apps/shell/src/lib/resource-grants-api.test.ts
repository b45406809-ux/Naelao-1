import { afterEach, describe, expect, it, vi } from "vitest";
import { approveProjectExtensionResourceGrant, getProjectExtensionResourceGrants, revokeProjectExtensionResourceGrant } from "./api";

describe("Project extension resource grant caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads, approves and revokes through the authenticated exact-install route", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const session = { sessionToken: "session-token", endUserId: "project-owner" };
    await getProjectExtensionResourceGrants("space one", "project/1", "install:1", session);
    await approveProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["catalog"] });
    await approveProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "attachments", expected_revision: 0, operations: ["get"], tables: [] });
    await revokeProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "records", expected_revision: 1 });

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual(Array(4).fill(
      "/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants"));
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer session-token");
    expect(calls[0]![1].cache).toBe("no-store");
    expect(calls[1]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["catalog"] });
    expect(calls[2]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ requirement_id: "attachments", expected_revision: 0, operations: ["get"], tables: [] });
    expect(calls[3]![1].method).toBe("DELETE");
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({ requirement_id: "records", expected_revision: 1 });
  });
});
