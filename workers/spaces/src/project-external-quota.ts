export interface ExternalQuotaSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Single-writer atomic allowance check for external channel messages in the SpaceDO. */
export function recordExternalMessage(
  sql: ExternalQuotaSql,
  input: { eventId: string; projectId: string; installationId: string; provider: string; subjectHash: string; day: string; dailyCap: number },
): { allowed: boolean; count: number; deduplicated: boolean } {
  const cap = Math.max(0, Math.floor(input.dailyCap));
  const retentionStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  sql.exec("DELETE FROM project_external_quota_usage WHERE day < ?", retentionStart);
  sql.exec("DELETE FROM project_external_quota_decisions WHERE day < ?", retentionStart);
  const prior = sql.exec("SELECT allowed,count_after FROM project_external_quota_decisions WHERE event_id=?", input.eventId)
    .toArray() as Array<{ allowed: number; count_after: number }>;
  const existingDecision = prior[0];
  if (existingDecision) return { allowed: existingDecision.allowed === 1, count: existingDecision.count_after, deduplicated: true };
  const current = sql.exec(
    `SELECT message_count FROM project_external_quota_usage
      WHERE project_id=? AND installation_id=? AND provider=? AND subject_hash=? AND day=?`,
    input.projectId, input.installationId, input.provider, input.subjectHash, input.day,
  ).toArray() as Array<{ message_count?: number }>;
  const count = Number(current[0]?.message_count ?? 0);
  const allowed = !(cap > 0 && count >= cap);
  const nextCount = allowed ? count + 1 : count;
  if (allowed) sql.exec(
    `INSERT INTO project_external_quota_usage(project_id,installation_id,provider,subject_hash,day,message_count,updated_at)
     VALUES(?,?,?,?,?,1,?)
     ON CONFLICT(project_id,installation_id,provider,subject_hash,day) DO UPDATE
       SET message_count=message_count+1,updated_at=excluded.updated_at`,
    input.projectId, input.installationId, input.provider, input.subjectHash, input.day, Date.now(),
  );
  sql.exec("INSERT INTO project_external_quota_decisions(event_id,project_id,installation_id,provider,subject_hash,day,allowed,count_after,daily_cap,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    input.eventId, input.projectId, input.installationId, input.provider, input.subjectHash, input.day, allowed ? 1 : 0, nextCount, cap, Date.now());
  return { allowed, count: nextCount, deduplicated: false };
}
