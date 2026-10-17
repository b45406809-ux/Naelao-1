export interface ExternalQuotaSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Single-writer atomic allowance check for external channel messages in the SpaceDO. */
export function recordExternalMessage(
  sql: ExternalQuotaSql,
  input: { projectId: string; installationId: string; provider: string; subjectHash: string; day: string; dailyCap: number },
): { allowed: boolean; count: number } {
  const cap = Math.max(0, Math.floor(input.dailyCap));
  const retentionStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  sql.exec("DELETE FROM project_external_quota_usage WHERE day < ?", retentionStart);
  const current = sql.exec(
    `SELECT message_count FROM project_external_quota_usage
      WHERE project_id=? AND installation_id=? AND provider=? AND subject_hash=? AND day=?`,
    input.projectId, input.installationId, input.provider, input.subjectHash, input.day,
  ).toArray() as Array<{ message_count?: number }>;
  const count = Number(current[0]?.message_count ?? 0);
  if (cap > 0 && count >= cap) return { allowed: false, count };
  sql.exec(
    `INSERT INTO project_external_quota_usage(project_id,installation_id,provider,subject_hash,day,message_count,updated_at)
     VALUES(?,?,?,?,?,1,?)
     ON CONFLICT(project_id,installation_id,provider,subject_hash,day) DO UPDATE
       SET message_count=message_count+1,updated_at=excluded.updated_at`,
    input.projectId, input.installationId, input.provider, input.subjectHash, input.day, Date.now(),
  );
  return { allowed: true, count: count + 1 };
}
