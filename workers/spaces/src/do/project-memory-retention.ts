import { execute, queryAll, queryOne } from "@naelao/db";

type Sql = Parameters<typeof queryOne>[0];

/** D9: Project memory is deleted 30 days after the Project is deleted. */
export const PROJECT_MEMORY_RETENTION_DAYS = 30;
export const PROJECT_MEMORY_SWEEP_PROJECTS_PER_PASS = 5;
export const PROJECT_MEMORY_SWEEP_ROWS_PER_PASS = 500;
const MEMORY_TABLES = ["project_facts", "project_fabric", "project_wiki"] as const;
const DAY_MS = 86_400_000;

export interface ProjectMemoryHold { project_id: string; reason: string; actor_id: string; created_at: string; expires_at: string | null }

/** Record the deletion time once; a repeated delete retry keeps the first timestamp. */
export function markProjectDeleted(sql: Sql, projectId: string, nowMs: number): void {
  execute(sql, "INSERT OR IGNORE INTO project_deletion_tombstones(project_id,deleted_at) VALUES(?,?)", projectId, new Date(nowMs).toISOString());
}

export function hasPendingProjectMemoryTombstones(sql: Sql): boolean {
  return !!queryOne(sql, "SELECT 1 AS pending FROM project_deletion_tombstones WHERE memory_purged_at IS NULL LIMIT 1");
}

export function getProjectMemoryHold(sql: Sql, projectId: string): ProjectMemoryHold | null {
  return queryOne<ProjectMemoryHold>(sql, "SELECT project_id,reason,actor_id,created_at,expires_at FROM project_memory_holds WHERE project_id=?", projectId) ?? null;
}

export function setProjectMemoryHold(sql: Sql, hold: { projectId: string; reason: string; actorId: string; expiresAt: string | null }, nowMs: number): ProjectMemoryHold {
  execute(sql, `INSERT INTO project_memory_holds(project_id,reason,actor_id,created_at,expires_at) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET reason=excluded.reason,actor_id=excluded.actor_id,created_at=excluded.created_at,expires_at=excluded.expires_at`,
    hold.projectId, hold.reason, hold.actorId, new Date(nowMs).toISOString(), hold.expiresAt);
  return getProjectMemoryHold(sql, hold.projectId)!;
}

export function clearProjectMemoryHold(sql: Sql, projectId: string): boolean {
  const existed = !!getProjectMemoryHold(sql, projectId);
  if (existed) execute(sql, "DELETE FROM project_memory_holds WHERE project_id=?", projectId);
  return existed;
}

/**
 * Bounded, idempotent sweep. Only memory rows of Projects deleted more than 30 days ago, never a
 * live Project, never under an unexpired hold. Returns counts only (callers log nothing else).
 */
export function sweepDeletedProjectMemory(sql: Sql, nowMs: number): { projects: number; rows: number; more: boolean } {
  const cutoff = new Date(nowMs - PROJECT_MEMORY_RETENTION_DAYS * DAY_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const due = queryAll<{ project_id: string }>(sql, `SELECT t.project_id FROM project_deletion_tombstones t
    WHERE t.memory_purged_at IS NULL AND t.deleted_at <= ?
      AND NOT EXISTS (SELECT 1 FROM project_memory_holds h WHERE h.project_id=t.project_id AND (h.expires_at IS NULL OR h.expires_at > ?))
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.status='active')
    ORDER BY t.deleted_at LIMIT ?`, cutoff, nowIso, PROJECT_MEMORY_SWEEP_PROJECTS_PER_PASS + 1);
  let budget = PROJECT_MEMORY_SWEEP_ROWS_PER_PASS, rows = 0, projects = 0, more = due.length > PROJECT_MEMORY_SWEEP_PROJECTS_PER_PASS;
  for (const { project_id: projectId } of due.slice(0, PROJECT_MEMORY_SWEEP_PROJECTS_PER_PASS)) {
    if (budget <= 0) { more = true; break; }
    let remaining = false;
    for (const table of MEMORY_TABLES) {
      if (budget > 0) {
        const batch = queryAll<{ rowid: number }>(sql, `SELECT rowid FROM ${table} WHERE project_id=? LIMIT ?`, projectId, budget);
        for (const row of batch) execute(sql, `DELETE FROM ${table} WHERE rowid=?`, row.rowid);
        budget -= batch.length; rows += batch.length;
      }
      if (queryOne(sql, `SELECT 1 AS present FROM ${table} WHERE project_id=? LIMIT 1`, projectId)) remaining = true;
    }
    if (remaining) { more = true; continue; }
    execute(sql, "UPDATE project_deletion_tombstones SET memory_purged_at=? WHERE project_id=?", nowIso, projectId);
    projects += 1;
  }
  return { projects, rows, more };
}
