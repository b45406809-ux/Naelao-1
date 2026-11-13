/** Revoke a project's published discovery and pending collaboration state. The batch is
 * idempotent; deleting events also cascades their read receipts and queued delivery rows. */
export async function retireProjectCoordination(db: D1Database, tenantId: string, spaceId: string, projectId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM space_blackboard_events WHERE tenant_id=? AND space_id=? AND
      (project_id=? OR request_id IN (SELECT id FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND (source_project_id=? OR target_project_id=?)))`)
      .bind(tenantId, spaceId, projectId, tenantId, spaceId, projectId, projectId),
    db.prepare("DELETE FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND (source_project_id=? OR target_project_id=?)")
      .bind(tenantId, spaceId, projectId, projectId),
    db.prepare("DELETE FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_sharing_policies WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_policy_uses WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_policies WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
  ]);
}

/** Atomically remove a card and pending requests against it. Accepted requests remain as an
 * explicit collaboration record, while pending request events are withdrawn with the card. */
export async function unpublishBlackboardProject(db: D1Database, tenantId: string, spaceId: string, projectId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM space_blackboard_events WHERE tenant_id=? AND space_id=? AND
      (project_id=? OR request_id IN (SELECT id FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND target_project_id=? AND status='pending'))`)
      .bind(tenantId, spaceId, projectId, tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_requests WHERE tenant_id=? AND space_id=? AND target_project_id=? AND status='pending'")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_sharing_policies WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
    db.prepare("DELETE FROM space_blackboard_policy_uses WHERE tenant_id=? AND space_id=? AND project_id=?")
      .bind(tenantId, spaceId, projectId),
  ]);
}

/** A published card is the host authority for a new request-to-use proposal. The conditional
 * insert closes the race between a preliminary card read and concurrent unpublication. */
export async function createBlackboardRequestIfPublished(db: D1Database, input: {
  tenantId: string; spaceId: string; requestId: string; sourceProjectId: string; targetProjectId: string;
  objective: string; expectedResult: string; deadline: string | null; userId: string; now: string;
}): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO space_blackboard_requests(tenant_id,space_id,id,source_project_id,target_project_id,objective,expected_result,deadline,status,created_by,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'pending',?,?,? WHERE EXISTS (
        SELECT 1 FROM space_blackboard_cards WHERE tenant_id=? AND space_id=? AND project_id=?
      )`)
      .bind(input.tenantId, input.spaceId, input.requestId, input.sourceProjectId, input.targetProjectId,
        input.objective, input.expectedResult, input.deadline, input.userId, input.now, input.now,
        input.tenantId, input.spaceId, input.targetProjectId),
    db.prepare(`INSERT OR IGNORE INTO space_blackboard_events(tenant_id,space_id,event_id,project_id,request_id,kind,created_at)
      SELECT tenant_id,space_id,id||':pending',target_project_id,id,'request.pending',created_at FROM space_blackboard_requests
      WHERE tenant_id=? AND space_id=? AND id=? AND source_project_id=? AND target_project_id=? AND objective=?
        AND expected_result=? AND deadline IS ? AND created_by=?`)
      .bind(input.tenantId, input.spaceId, input.requestId, input.sourceProjectId, input.targetProjectId,
        input.objective, input.expectedResult, input.deadline, input.userId),
  ]);
}
