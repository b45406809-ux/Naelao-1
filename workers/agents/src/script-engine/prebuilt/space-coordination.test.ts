import { describe, expect, it, vi } from "vitest";
import { spaceCoordination } from "./space-coordination.js";
import { PREBUILT_SCRIPTS } from "./index.js";
import type { PrebuiltOpContext } from "./index.js";

describe("Space coordination assistant read", () => {
  it("is registered as a platform prebuilt", () => {
    expect(PREBUILT_SCRIPTS["space-coordination"]).toBe(spaceCoordination);
  });

  it("requires an acting member and performs no request without one", async () => {
    const fetch = vi.fn();
    const ctx = { env: { tenantId: "tenant", spaceId: "space", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await expect(spaceCoordination.operations["coordination.list_facts"]!({}, ctx)).rejects.toThrow("space_coordination_member_context_required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the authenticated member identity, forwards only the host cursor, and returns advisory fields", async () => {
    const fetch = vi.fn(async () => Response.json({ schema_version: 2, entries: [
      { entry_id: "fact-1", capability_key: "official.website", label: "Company website", audience: "space_members", status: "active", version: 2, advisory_only: true, created_by: "owner-secret" },
      { entry_id: "bad-row", capability_key: 12, label: "invalid", audience: "space_members", version: 1 },
    ], next_after: "v2~members~2026-01-01~fact-2" }));
    const ctx = { env: { tenantId: "tenant", spaceId: "space / one", userId: "member-1", callerRole: "member", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    const result = await spaceCoordination.operations["coordination.list_facts"]!({ after: "opaque-cursor" }, ctx) as {
      entries: Array<Record<string, unknown>>; next_after: string; advisory_only: boolean; untrusted: boolean;
    };
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.url).toBe("http://spaces-worker/spaces/space%20%2F%20one/coordination-registry/v2?after=opaque-cursor");
    expect(request.headers.get("x-naelao-user-id")).toBe("member-1");
    expect(request.headers.get("x-naelao-role")).toBe("member");
    expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
    expect(result).toMatchObject({ advisory_only: true, untrusted: true, next_after: "v2~members~2026-01-01~fact-2" });
    expect(result.entries).toEqual([{ entry_id: "fact-1", capability_key: "official.website", label: "Company website",
      audience: "space_members", status: "active", version: 2, advisory_only: true }]);
    expect(JSON.stringify(result)).not.toContain("owner-secret");
  });

  it("rejects oversized or malformed cursors before the host call", async () => {
    const fetch = vi.fn();
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", callerRole: "product_end_user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await expect(spaceCoordination.operations["coordination.list_facts"]!({ after: "x".repeat(257) }, ctx)).rejects.toThrow("space_coordination_cursor_invalid");
    await expect(spaceCoordination.operations["coordination.list_facts"]!({ after: { cursor: "bad" } }, ctx)).rejects.toThrow("space_coordination_cursor_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unavailable responses without returning partial facts", async () => {
    const fetch = vi.fn(async () => new Response("failed", { status: 503 }));
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", callerRole: "product_end_user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await expect(spaceCoordination.operations["coordination.list_facts"]!({}, ctx)).rejects.toThrow("space_coordination_unavailable_503");
  });

  it("rejects a malformed host page instead of reporting an empty registry", async () => {
    const fetch = vi.fn(async () => Response.json({ schema_version: 2, entries: "invalid", next_after: null }));
    const ctx = { env: { tenantId: "t", spaceId: "s", userId: "u", callerRole: "product_end_user", platformSecret: "secret", spacesWorker: { fetch } } } as unknown as PrebuiltOpContext;
    await expect(spaceCoordination.operations["coordination.list_facts"]!({}, ctx)).rejects.toThrow("space_coordination_response_invalid");
  });
});
