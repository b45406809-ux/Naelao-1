import type { D1Database } from "@cloudflare/workers-types";

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
