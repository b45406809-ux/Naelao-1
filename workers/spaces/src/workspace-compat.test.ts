import { describe, expect, it, vi } from "vitest";
import { verifyInternalToken } from "@naelao/http";
import { readWorkspaceCompat } from "./workspace-compat.js";

const input = {
  enabled: true,
  platformSecret: "test-secret",
  tenantId: "tenant",
  spaceId: "space",
  projectId: "project",
  jurisdiction: "global" as const,
};

describe("unified workspace compatibility reads", () => {
  it("keeps the legacy reader untouched while the feature flag is off", async () => {
    const fetch = vi.fn();
    await expect(readWorkspaceCompat({ ...input, enabled: false, agentsWorker: { fetch } as never }))
      .resolves.toEqual({ kind: "legacy" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads manifest entries from the authorized Agents adapter when enabled", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/internal/workspaces/compat-read");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant");
      expect(await verifyInternalToken(request.headers.get("x-naelao-internal-token"), "tenant", "test-secret")).toBe(true);
      expect(await request.json()).toMatchObject({ scope: { tenantId: "tenant", spaceId: "space", projectId: "project", jurisdiction: "global" }, branch: "main", path: "report.pdf" });
      return Response.json({ canonical: true, head: { branch: "main", revision: 4, updatedAt: "2026-11-08T00:00:00.000Z" }, entries: [
        { path: "report.pdf", sha256: "a".repeat(64), size: 4, executable: false, objectKey: `workspace-v1/tenant/space/project/global/content/${"a".repeat(64)}` },
      ] });
    });
    const result = await readWorkspaceCompat({ ...input, path: "report.pdf", agentsWorker: { fetch } as never });
    expect(result).toMatchObject({ kind: "canonical", head: { branch: "main", revision: 4 }, entries: [{ path: "report.pdf", objectKey: `workspace-v1/tenant/space/project/global/content/${"a".repeat(64)}` }] });
  });

  it("uses legacy R2 only before the coordinator has initialized a head", async () => {
    const result = await readWorkspaceCompat({ ...input, agentsWorker: { fetch: async () => Response.json({ canonical: false }) } as never });
    expect(result).toEqual({ kind: "legacy" });
  });

  it("fails closed on coordinator errors and malformed canonical responses", async () => {
    const failed = await readWorkspaceCompat({ ...input, agentsWorker: { fetch: async () => Response.json({ error_code: "workspace_storage_unavailable" }, { status: 503 }) } as never });
    expect(failed.kind).toBe("error");
    if (failed.kind === "error") expect(failed.response.status).toBe(503);

    const malformed = await readWorkspaceCompat({ ...input, agentsWorker: { fetch: async () => Response.json({ canonical: true, entries: [] }) } as never });
    expect(malformed.kind).toBe("error");
    if (malformed.kind === "error") expect(malformed.response.status).toBe(503);
  });
});
