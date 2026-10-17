const LEASE_MS = 10 * 60 * 1000;

/** A single daily Space steward pass. D1's conditional upsert is the cross-isolate claim. */
export async function claimProjectStewardRun(
  db: D1Database,
  input: { spaceId: string; tenantId: string; runDay: string; dayStart: number; now?: number },
): Promise<string | null> {
  const now = input.now ?? Date.now();
  const token = crypto.randomUUID();
  const result = await db.prepare(`
    INSERT INTO project_steward_runs(space_id,tenant_id,claimed_day,claim_token,lease_until,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(space_id) DO UPDATE SET tenant_id=excluded.tenant_id,claimed_day=excluded.claimed_day,
      claim_token=excluded.claim_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at
    WHERE COALESCE(project_steward_runs.last_successful_run_at,0) < ?
      AND (project_steward_runs.lease_until <= ? OR project_steward_runs.claimed_day != ?)
  `).bind(input.spaceId, input.tenantId, input.runDay, token, now + LEASE_MS, now, input.dayStart, now, input.runDay).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return token;
}

export async function finishProjectStewardRun(
  db: D1Database,
  input: { spaceId: string; runDay: string; claimToken: string; reportJson?: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  if (input.reportJson !== undefined) {
    const result = await db.prepare(`UPDATE project_steward_runs SET last_successful_run_at=?,report_json=?,claim_token=NULL,lease_until=0,updated_at=?
      WHERE space_id=? AND claimed_day=? AND claim_token=?`).bind(now, input.reportJson, now, input.spaceId, input.runDay, input.claimToken).run();
    return (result.meta.changes ?? 0) === 1;
  }
  const result = await db.prepare(`UPDATE project_steward_runs SET claim_token=NULL,lease_until=0,updated_at=?
    WHERE space_id=? AND claimed_day=? AND claim_token=?`).bind(now, input.spaceId, input.runDay, input.claimToken).run();
  return (result.meta.changes ?? 0) === 1;
}
