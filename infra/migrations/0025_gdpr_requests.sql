-- G-GD01..GD06: GDPR erasure and data export requests
CREATE TABLE IF NOT EXISTS gdpr_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_type TEXT NOT NULL,                -- 'erasure', 'export', 'rectification'
  subject_type TEXT NOT NULL,                -- 'end_user', 'org_member'
  subject_id TEXT NOT NULL,
  subject_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending', 'processing', 'completed', 'failed'
  requested_by TEXT NOT NULL,                -- user_id of the requester
  workflow_run_id TEXT,                      -- CF Workflow run ID for erasure workflow
  export_r2_key TEXT,                        -- R2 key for data export ZIP
  export_expires_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gdpr_tenant ON gdpr_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gdpr_subject ON gdpr_requests (subject_id, request_type);
