import { describe, expect, it, vi } from "vitest";
import { connectorPollIsCurrent, reconcileScheduledServiceResumeContext, scheduledDirectScriptGrantConfig, scheduledGoalGrantConfig, scheduledGoalIsCurrent } from "./scheduled-direct-authorization.js";

function database(result: Record<string, unknown> | null) {
  const first = vi.fn(async () => result);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as never, prepare, bind, first };
}

describe("scheduled direct-script authorization fence", () => {
  const input = { tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", scriptName: "daily-review",
    serviceIdentityId: "scheduled_job:job-a", authorizationRevision: "2026-11-17T12:00:00.000Z" };

  it("loads the budget only from the same enabled direct-script job revision", async () => {
    const fixture = database({ approved_actions_json: '["project.update"]', max_run_credits: 75 });
    await expect(scheduledDirectScriptGrantConfig(fixture.db, input)).resolves.toEqual({ approvedActions: ["project.update"], maxRunCredits: 75 });
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("updated_at=? AND script_name=? AND goal IS NULL");
    expect(fixture.bind).toHaveBeenCalledWith("job-a", "tenant-a", "space-a", "project-a", input.authorizationRevision, "daily-review");
  });

  it.each([
    ["paused, deleted, or stale job", null, input],
    ["invalid service identity", { approved_actions_json: '["project.update"]', max_run_credits: 500 }, { ...input, serviceIdentityId: "job-a" }],
    ["missing revision", { approved_actions_json: '["project.update"]', max_run_credits: 500 }, { ...input, authorizationRevision: "" }],
  ])("rejects %s", async (_name, result, candidate) => {
    const fixture = database(result as Record<string, unknown> | null);
    await expect(scheduledDirectScriptGrantConfig(fixture.db, candidate as typeof input)).resolves.toBeNull();
    if (candidate === input) expect(fixture.first).toHaveBeenCalledOnce();
    else expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("keeps an approved goal resume fenced to the same enabled job revision and agent", async () => {
    const fixture = database({ current: 1 });
    await expect(scheduledGoalIsCurrent(fixture.db, { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
      agentId: "agent-a", serviceIdentityId: input.serviceIdentityId, authorizationRevision: input.authorizationRevision })).resolves.toBe(true);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("updated_at=? AND goal IS NOT NULL AND ((agent_id IS NULL AND ?='naelao-agent') OR agent_id=?)");
    expect(fixture.bind).toHaveBeenCalledWith("job-a", "tenant-a", "space-a", "project-a", input.authorizationRevision, "agent-a", "agent-a");
  });

  it("loads grants and budget only from the exact current goal-job revision", async () => {
    const first = vi.fn(async () => ({ approved_actions_json: '["project.update"]', max_run_credits: 500 }));
    const bind = vi.fn(() => ({ first })), prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as never;
    await expect(scheduledGoalGrantConfig(db, { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
      agentId: "agent-a", serviceIdentityId: input.serviceIdentityId, authorizationRevision: input.authorizationRevision }))
      .resolves.toEqual({ approvedActions: ["project.update"], maxRunCredits: 500 });
    expect(prepare.mock.calls[0]?.[0]).toContain("updated_at=? AND goal IS NOT NULL AND ((agent_id IS NULL AND ?='naelao-agent') OR agent_id=?)");
    expect(bind).toHaveBeenCalledWith("job-a", "tenant-a", "space-a", "project-a", input.authorizationRevision, "agent-a", "agent-a");

    first.mockResolvedValueOnce({ approved_actions_json: '["*"]', max_run_credits: 500 } as never);
    await expect(scheduledGoalGrantConfig(db, { tenantId: input.tenantId, spaceId: input.spaceId, projectId: input.projectId,
      agentId: "agent-a", serviceIdentityId: input.serviceIdentityId, authorizationRevision: input.authorizationRevision })).resolves.toBeNull();
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

describe("connector-poll authorization fence", () => {
  it("admits only the exact enabled connector configuration revision", async () => {
    const fixture = database({ current: 1 });
    await expect(connectorPollIsCurrent(fixture.db, { tenantId: "tenant-a", spaceId: "space-a", connectorId: "connector-a",
      connectorName: "shopify", authorizationRevision: "2026-11-17T12:00:00.000Z" })).resolves.toBe(true);
    expect(fixture.prepare.mock.calls[0]?.[0]).toContain("enabled=1 AND updated_at=?");
    expect(fixture.bind).toHaveBeenCalledWith("connector-a", "tenant-a", "space-a", "shopify", "2026-11-17T12:00:00.000Z");
  });

  it("denies stale or malformed connector identity without falling back to the current row", async () => {
    const stale = database(null);
    await expect(connectorPollIsCurrent(stale.db, { tenantId: "tenant-a", spaceId: "space-a", connectorId: "connector-a",
      connectorName: "shopify", authorizationRevision: "old-revision" })).resolves.toBe(false);
    const malformed = database({ current: 1 });
    await expect(connectorPollIsCurrent(malformed.db, { tenantId: "tenant-a", spaceId: "space-a", connectorId: "bad/id",
      connectorName: "shopify", authorizationRevision: "revision" })).resolves.toBe(false);
    expect(malformed.prepare).not.toHaveBeenCalled();
  });
});
