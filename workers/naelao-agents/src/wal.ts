export interface WALEntry {
  id: string;
  runId: string;
  toolName: string;
  toolArgs: string;
  toolResult: string | null;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'timeout';
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export function createWALEntry(
  sql: SqlStorage,
  entry: Omit<WALEntry, 'id' | 'startedAt' | 'completedAt' | 'error'>
): WALEntry {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  sql.exec(
    `INSERT INTO run_wal (id, run_id, tool_name, tool_args, tool_result, status, started_at, completed_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    id, entry.runId, entry.toolName, entry.toolArgs, entry.toolResult ?? null, entry.status, now
  );
  return { ...entry, id, startedAt: now, completedAt: null, error: null };
}

export function markWALRunning(sql: SqlStorage, entryId: string): void {
  sql.exec(`UPDATE run_wal SET status = 'running' WHERE id = ?`, entryId);
}

export function markWALComplete(sql: SqlStorage, entryId: string, result: unknown): void {
  sql.exec(
    `UPDATE run_wal SET status = 'complete', tool_result = ?, completed_at = ? WHERE id = ?`,
    JSON.stringify(result), new Date().toISOString(), entryId
  );
}

export function markWALFailed(sql: SqlStorage, entryId: string, error: string): void {
  sql.exec(
    `UPDATE run_wal SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
    error, new Date().toISOString(), entryId
  );
}

export function markWALTimeout(sql: SqlStorage, entryId: string): void {
  sql.exec(
    `UPDATE run_wal SET status = 'timeout', completed_at = ? WHERE id = ?`,
    new Date().toISOString(), entryId
  );
}

export function getPendingWALEntries(sql: SqlStorage, runId: string): WALEntry[] {
  return [...sql.exec<WALEntry>(
    `SELECT * FROM run_wal WHERE run_id = ? AND status = 'pending' ORDER BY started_at ASC`,
    runId
  )];
}

export function cleanOldWALEntries(sql: SqlStorage): void {
  sql.exec(
    `DELETE FROM run_wal WHERE status IN ('complete', 'failed') AND started_at < datetime('now', '-7 days')`
  );
}
