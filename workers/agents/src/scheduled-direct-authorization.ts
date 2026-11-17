import type { D1Database } from "@cloudflare/workers-types";

export type ScheduledServiceResumeContext = {
  trigger: "scheduled_job";
  service_identity_id: string;
  authorization_revision: string;
};

/** Reconcile the checkpointed actor with the session authority. Older suspended rows may predate
 * context persistence, so the authenticated session may recover the exact actor; disagreement or
 * malformed checkpoint JSON is a hard conflict. */
export function reconcileScheduledServiceResumeContext(
  savedJson: string | null | undefined,
  sessionIdentity?: { id: string; authorizationRevision: string },
): ScheduledServiceResumeContext | undefined {
  let saved: ScheduledServiceResumeContext | undefined;
  if (savedJson) {
    const value = JSON.parse(savedJson) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.trigger !== "scheduled_job"
      || typeof value.service_identity_id !== "string" || !/^scheduled_job:[A-Za-z0-9_-]{1,128}$/.test(value.service_identity_id)
      || typeof value.authorization_revision !== "string" || !value.authorization_revision || value.authorization_revision.length > 128)
      throw new Error("scheduled_resume_context_invalid");
    saved = { trigger: "scheduled_job", service_identity_id: value.service_identity_id, authorization_revision: value.authorization_revision };
  }
  if (sessionIdentity && saved && (saved.service_identity_id !== sessionIdentity.id
    || saved.authorization_revision !== sessionIdentity.authorizationRevision)) throw new Error("scheduled_resume_identity_mismatch");
  if (sessionIdentity) return { trigger: "scheduled_job", service_identity_id: sessionIdentity.id,
    authorization_revision: sessionIdentity.authorizationRevision };
  return saved;
}

/** Last-boundary fence for owner-configured scheduled jobs that invoke a script directly.
 * The revision is minted from scheduled_jobs.updated_at by the queue consumer; this check
 * prevents an old queue message from dispatching after a pause, edit, retarget, or delete. */
export async function scheduledDirectScriptIsCurrent(
  db: D1Database,
  input: { tenantId: string; spaceId: string; projectId: string; scriptName: string; serviceIdentityId: string; authorizationRevision: string },
): Promise<boolean> {
  const match = /^scheduled_job:([A-Za-z0-9_-]{1,128})$/.exec(input.serviceIdentityId);
  if (!match || !input.authorizationRevision || input.authorizationRevision.length > 128) return false;
  const row = await db.prepare(`SELECT 1 AS current FROM scheduled_jobs
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND enabled=1
      AND updated_at=? AND script_name=? AND goal IS NULL LIMIT 1`)
    .bind(match[1], input.tenantId, input.spaceId, input.projectId, input.authorizationRevision, input.scriptName)
    .first<{ current: number }>();
  return row?.current === 1;
}

/** A resumed scheduled goal must still belong to the exact enabled job revision that created
 * its approval checkpoint. A human approving the old exact action does not revive a paused or
 * edited job. */
export async function scheduledGoalIsCurrent(
  db: D1Database,
  input: { tenantId: string; spaceId: string; projectId: string; agentId: string; serviceIdentityId: string; authorizationRevision: string },
): Promise<boolean> {
  const match = /^scheduled_job:([A-Za-z0-9_-]{1,128})$/.exec(input.serviceIdentityId);
  if (!match || !input.authorizationRevision || input.authorizationRevision.length > 128) return false;
  const row = await db.prepare(`SELECT 1 AS current FROM scheduled_jobs
    WHERE id=? AND tenant_id=? AND space_id=? AND project_id=? AND enabled=1
      AND updated_at=? AND goal IS NOT NULL AND agent_id IS ? LIMIT 1`)
    .bind(match[1], input.tenantId, input.spaceId, input.projectId, input.authorizationRevision, input.agentId)
    .first<{ current: number }>();
  return row?.current === 1;
}
