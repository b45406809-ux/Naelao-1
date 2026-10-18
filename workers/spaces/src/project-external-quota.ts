export interface ExternalQuotaSql {
  exec(sql: string, ...bindings: unknown[]): { rowsWritten: number; toArray(): unknown[] };
}

/** Single-writer atomic allowance check for external channel messages in the SpaceDO. */
export function recordExternalMessage(
  sql: ExternalQuotaSql,
  input: { eventId: string; projectId: string; installationId: string; provider: string; subjectHash: string; legacySubjectHash?: string; day: string; dailyCap: number },
): { allowed: boolean; count: number; deduplicated: boolean; notifyOwner: boolean } {
  const cap = Math.max(0, Math.floor(input.dailyCap));
  const retentionStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  sql.exec("DELETE FROM project_external_quota_usage WHERE day < ?", retentionStart);
  sql.exec("DELETE FROM project_external_quota_decisions WHERE day < ?", retentionStart);
  sql.exec("DELETE FROM project_external_quota_subject_usage WHERE day < ?", retentionStart);
  const prior = sql.exec("SELECT allowed,count_after FROM project_external_quota_decisions WHERE event_id=? AND installation_id=? AND provider=?", input.eventId, input.installationId, input.provider)
    .toArray() as Array<{ allowed: number; count_after: number }>;
  const existingDecision = prior[0];
  if (existingDecision) return { allowed: existingDecision.allowed === 1, count: existingDecision.count_after, deduplicated: true, notifyOwner: false };
  const current = sql.exec(
    `SELECT message_count FROM project_external_quota_subject_usage
      WHERE project_id=? AND provider=? AND subject_hash=? AND day=?`,
    input.projectId, input.provider, input.subjectHash, input.day,
  ).toArray() as Array<{ message_count?: number }>;
  // Preserve this installation's pre-upgrade usage for the current UTC day. Historical rows used
  // an installation-keyed sender digest, so they cannot be safely joined across instances.
  const legacy = input.legacySubjectHash ? sql.exec(
    `SELECT message_count FROM project_external_quota_usage
      WHERE project_id=? AND installation_id=? AND provider=? AND subject_hash=? AND day=?`,
    input.projectId, input.installationId, input.provider, input.legacySubjectHash, input.day,
  ).toArray() as Array<{ message_count?: number }> : [];
  const legacyCount = Number(legacy[0]?.message_count ?? 0);
  let globalCount = Number(current[0]?.message_count ?? 0);
  if (legacyCount > 0) {
    // Fold this installation's old counter into the shared subject counter exactly once, then
    // remove the keyed legacy row. The enclosing SpaceDO transaction makes the move atomic.
    sql.exec(`INSERT INTO project_external_quota_subject_usage(project_id,provider,subject_hash,day,message_count,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,provider,subject_hash,day) DO UPDATE
      SET message_count=project_external_quota_subject_usage.message_count+excluded.message_count,updated_at=excluded.updated_at`,
    input.projectId, input.provider, input.subjectHash, input.day, legacyCount, Date.now());
    sql.exec(`DELETE FROM project_external_quota_usage WHERE project_id=? AND installation_id=? AND provider=? AND subject_hash=? AND day=?`,
      input.projectId, input.installationId, input.provider, input.legacySubjectHash, input.day);
    globalCount += legacyCount;
  }
  const count = globalCount;
  const allowed = !(cap > 0 && count >= cap);
  const nextCount = allowed ? count + 1 : count;
  if (allowed) sql.exec(
    `INSERT INTO project_external_quota_subject_usage(project_id,provider,subject_hash,day,message_count,updated_at)
     VALUES(?,?,?, ?,1,?)
     ON CONFLICT(project_id,provider,subject_hash,day) DO UPDATE
       SET message_count=message_count+1,updated_at=excluded.updated_at`,
    input.projectId, input.provider, input.subjectHash, input.day, Date.now(),
  );
  let notifyOwner = false;
  if (!allowed) {
    if (current[0] || legacyCount > 0) {
      notifyOwner = sql.exec(`UPDATE project_external_quota_subject_usage SET owner_notified_at=?,updated_at=?
        WHERE project_id=? AND provider=? AND subject_hash=? AND day=? AND owner_notified_at IS NULL`,
      Date.now(), Date.now(), input.projectId, input.provider, input.subjectHash, input.day).rowsWritten > 0;
    } else {
      notifyOwner = sql.exec(`INSERT INTO project_external_quota_subject_usage(project_id,provider,subject_hash,day,message_count,updated_at,owner_notified_at)
        VALUES(?,?,?,?,0,?,?)`, input.projectId, input.provider, input.subjectHash, input.day, Date.now(), Date.now()).rowsWritten > 0;
    }
  }
  sql.exec("INSERT INTO project_external_quota_decisions(event_id,project_id,installation_id,provider,subject_hash,day,allowed,count_after,daily_cap,owner_notified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    input.eventId, input.projectId, input.installationId, input.provider, input.subjectHash, input.day, allowed ? 1 : 0, nextCount, cap, notifyOwner ? 1 : 0, Date.now());
  return { allowed, count: nextCount, deduplicated: false, notifyOwner };
}
