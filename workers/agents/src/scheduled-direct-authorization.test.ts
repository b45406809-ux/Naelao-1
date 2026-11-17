import { describe, expect, it, vi } from "vitest";
import { scheduledDirectScriptIsCurrent } from "./scheduled-direct-authorization.js";

function database(result: { current: number } | null) {
  const first = vi.fn(async () => result);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as never, prepare, bind, first };
}

describe("scheduled direct-script authorization fence", () => {
  const input = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", scriptName: "daily-review",
    serviceIdentityId: "scheduled_job:job-a", authorizationRevision: "2026-11-17T12:00:00.000Z" };

  it("admits only the exact enabled job revision and script target", async () => {
    const fixture = database({ current: 1 });
    await expect(scheduledDirectScriptIsCurrent(fixture.db, input)).resolves.toBe(true);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("updated_at=? AND script_name=? AND goal IS NULL");
    expect(fixture.bind).toHaveBeenCalledWith("job-a", "tenant-a", "space-a", "project-a", input.authorizationRevision, "daily-review");
  });

  it.each([
    ["paused, deleted, or stale job", null, input],
    ["invalid service identity", { current: 1 }, { ...input, serviceIdentityId: "job-a" }],
    ["missing revision", { current: 1 }, { ...input, authorizationRevision: "" }],
  ])("rejects %s", async (_name, result, candidate) => {
    const fixture = database(result as { current: number } | null);
    await expect(scheduledDirectScriptIsCurrent(fixture.db, candidate as typeof input)).resolves.toBe(false);
    if (candidate === input) expect(fixture.first).toHaveBeenCalledOnce();
    else expect(fixture.prepare).not.toHaveBeenCalled();
  });
});
