/** Persist a wake-policy change and cancel every claim that has not crossed the
 * dispatch-acceptance boundary in one D1 transaction. */
export async function persistBlackboardWakePolicy(
  db: D1Database,
  input: { tenantId: string; spaceId: string; projectId: string; userId: string; wakeEnabled: boolean; updatedAt: string; nowSeconds: number },
): Promise<void> {
  const statements = [db.prepare(`INSERT INTO space_blackboard_policies
      (tenant_id,space_id,project_id,wake_enabled,authorized_user_id,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(tenant_id,space_id,project_id) DO UPDATE SET
      wake_enabled=excluded.wake_enabled,
      authorized_user_id=excluded.authorized_user_id,
      updated_at=excluded.updated_at`)
    .bind(input.tenantId,input.spaceId,input.projectId,input.wakeEnabled?1:0,input.userId,input.updatedAt)];
  if (!input.wakeEnabled) {
    statements.push(db.prepare(`UPDATE space_blackboard_wakes SET status='held',lease_until=NULL,updated_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=?
        AND (status='pending' OR (status='running' AND dispatch_accepted=0))`)
      .bind(input.nowSeconds,input.tenantId,input.spaceId,input.projectId));
  }
  await db.batch(statements);
}
