-- Notification attempts are independent of event processing acknowledgements. No provider
-- content or webhook secret is stored in this table.
CREATE TABLE IF NOT EXISTS agentport_event_notifications (
  delivery_id TEXT PRIMARY KEY REFERENCES agentport_event_deliveries(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agentport_notifications_due ON agentport_event_notifications(status,available_at);
