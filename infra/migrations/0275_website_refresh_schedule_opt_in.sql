-- Owners may opt a previously approved single-page website source into bounded refreshes.
-- Schedules are deliberately not enabled by default and are not restored from archives.
CREATE TABLE IF NOT EXISTS kb_source_refresh_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE REFERENCES kb_documents(id) ON DELETE CASCADE,
  connection_ref TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  interval_hours INTEGER NOT NULL CHECK (interval_hours IN (24,168)),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  next_run_at TEXT,
  last_run_at TEXT,
  last_result TEXT CHECK (last_result IS NULL OR last_result IN ('updated','unchanged','failed','paused')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 96),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count BETWEEN 0 AND 100),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((enabled=1 AND next_run_at IS NOT NULL) OR enabled=0)
);

CREATE INDEX IF NOT EXISTS idx_kb_source_refresh_schedules_due
  ON kb_source_refresh_schedules(enabled,next_run_at,lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_kb_source_refresh_schedules_owner
  ON kb_source_refresh_schedules(tenant_id,space_id,project_id,owner_user_id,enabled);

CREATE TRIGGER IF NOT EXISTS kb_source_refresh_schedule_requires_current_grant
BEFORE INSERT ON kb_source_refresh_schedules
WHEN NEW.enabled=1 AND (
  NOT EXISTS (
    SELECT 1 FROM kb_documents d JOIN website_connections wc
      ON wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id AND wc.space_id=d.space_id
        AND wc.project_id=d.project_id AND wc.owner_user_id=NEW.owner_user_id AND wc.status='active'
    WHERE d.id=NEW.document_id AND d.tenant_id=NEW.tenant_id AND d.space_id=NEW.space_id
      AND d.project_id=NEW.project_id AND d.source_adapter='website' AND d.source_state='current'
      AND d.source_connection_ref=NEW.connection_ref AND d.status='indexed'
  ) OR NOT EXISTS (
    SELECT 1 FROM project_access pa WHERE pa.tenant_id=NEW.tenant_id AND pa.space_id=NEW.space_id
      AND pa.project_id=NEW.project_id AND pa.user_id=NEW.owner_user_id AND pa.role_rank>=40
  )
)
BEGIN SELECT RAISE(ABORT, 'website refresh schedule requires current owner-approved source'); END;

CREATE TRIGGER IF NOT EXISTS kb_source_refresh_schedule_update_requires_current_grant
BEFORE UPDATE OF enabled,connection_ref,owner_user_id,document_id,tenant_id,space_id,project_id ON kb_source_refresh_schedules
WHEN NEW.enabled=1 AND (
  NOT EXISTS (
    SELECT 1 FROM kb_documents d JOIN website_connections wc
      ON wc.id=d.source_connection_ref AND wc.tenant_id=d.tenant_id AND wc.space_id=d.space_id
        AND wc.project_id=d.project_id AND wc.owner_user_id=NEW.owner_user_id AND wc.status='active'
    WHERE d.id=NEW.document_id AND d.tenant_id=NEW.tenant_id AND d.space_id=NEW.space_id
      AND d.project_id=NEW.project_id AND d.source_adapter='website' AND d.source_state='current'
      AND d.source_connection_ref=NEW.connection_ref AND d.status='indexed'
  ) OR NOT EXISTS (
    SELECT 1 FROM project_access pa WHERE pa.tenant_id=NEW.tenant_id AND pa.space_id=NEW.space_id
      AND pa.project_id=NEW.project_id AND pa.user_id=NEW.owner_user_id AND pa.role_rank>=40
  )
)
BEGIN SELECT RAISE(ABORT, 'website refresh schedule requires current owner-approved source'); END;

CREATE TRIGGER IF NOT EXISTS kb_source_refresh_schedule_pause_on_connection_revoke
AFTER UPDATE OF status ON website_connections
WHEN NEW.status!='active'
BEGIN
  UPDATE kb_source_refresh_schedules SET enabled=0,next_run_at=NULL,lease_token=NULL,lease_expires_at=NULL,
    last_result='paused',last_error_code='website_connection_revoked',generation=generation+1,updated_at=datetime('now')
  WHERE connection_ref=NEW.id AND tenant_id=NEW.tenant_id AND space_id=NEW.space_id AND enabled=1;
END;

CREATE TRIGGER IF NOT EXISTS kb_source_refresh_schedule_pause_on_source_change
AFTER UPDATE OF status,source_state,source_adapter,source_connection_ref ON kb_documents
WHEN NEW.status='deleting' OR NEW.source_state!='current' OR NEW.source_adapter!='website' OR NEW.source_connection_ref IS NULL
BEGIN
  UPDATE kb_source_refresh_schedules SET enabled=0,next_run_at=NULL,lease_token=NULL,lease_expires_at=NULL,
    last_result='paused',last_error_code='website_source_unavailable',generation=generation+1,updated_at=datetime('now')
  WHERE document_id=NEW.id AND enabled=1;
END;
