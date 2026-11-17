import { afterEach, describe, expect, it, vi } from "vitest";
import { approveProjectExtensionResourceGrant, getProjectExtensionResourceGrants, hasReviewableProjectExtensionResources, revokeProjectExtensionResourceGrant, setProjectExtensionResourceBudget } from "./api";

describe("Project extension resource grant caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes jobs alongside object and structured-data requirements in the owner inventory", () => {
    expect(hasReviewableProjectExtensionResources([{ id: "queue", kind: "jobs", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([{ id: "db", kind: "structured_data", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([{ id: "files", kind: "objects", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([])).toBe(false);
    expect(hasReviewableProjectExtensionResources(undefined)).toBe(false);
  });

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
    await setProjectExtensionResourceBudget("space one", "project/1", "install:1", session,
      { expected_revision: 0, max_run_credits: 25, monthly_credits: 250 });

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      ...Array(4).fill("/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants"),
      "/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants/budget",
    ]);
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer session-token");
    expect(calls[0]![1].cache).toBe("no-store");
    expect(calls[1]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["catalog"] });
    expect(calls[2]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ requirement_id: "attachments", expected_revision: 0, operations: ["get"], tables: [] });
    expect(calls[3]![1].method).toBe("DELETE");
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({ requirement_id: "records", expected_revision: 1 });
    expect(calls[4]![1].method).toBe("PUT");
    expect(new Headers(calls[4]![1].headers).get("authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ expected_revision: 0, max_run_credits: 25, monthly_credits: 250 });
  });
});
