import { describe, expect, it, vi } from "vitest";
import { reconcileScheduledServiceResumeContext, scheduledDirectScriptIsCurrent, scheduledGoalIsCurrent } from "./scheduled-direct-authorization.js";

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

  it("keeps an approved goal resume fenced to the same enabled job revision and agent", async () => {
    const fixture = database({ current: 1 });
    await expect(scheduledGoalIsCurrent(fixture.db, { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
      agentId: "agent-a", serviceIdentityId: input.serviceIdentityId, authorizationRevision: input.authorizationRevision })).resolves.toBe(true);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("updated_at=? AND goal IS NOT NULL AND agent_id IS ?");
    expect(fixture.bind).toHaveBeenCalledWith("job-a", "tenant-a", "space-a", "project-a", input.authorizationRevision, "agent-a");
  });

  it("recovers legacy suspended identity from the persisted session and rejects checkpoint disagreement", () => {
    const identity = { id: input.serviceIdentityId, authorizationRevision: input.authorizationRevision };
    expect(reconcileScheduledServiceResumeContext(null, identity)).toEqual({ trigger: "scheduled_job",
      service_identity_id: identity.id, authorization_revision: identity.authorizationRevision });
    expect(() => reconcileScheduledServiceResumeContext(JSON.stringify({ trigger: "scheduled_job",
      service_identity_id: "scheduled_job:other", authorization_revision: identity.authorizationRevision }), identity)).toThrow("scheduled_resume_identity_mismatch");
    expect(() => reconcileScheduledServiceResumeContext("{bad-json", identity)).toThrow();
  });
});
