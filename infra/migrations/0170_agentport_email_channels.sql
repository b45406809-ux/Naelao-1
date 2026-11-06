-- Promote mailboxes provisioned before native email channels were exposed. Keep each existing
-- account ID, address, owner, grant, webhook, and status intact while adding the channel view.
INSERT OR IGNORE INTO agentport_channels
  (id,tenant_id,service_id,account_id,provider_channel_id,display_name,status,created_at,updated_at)
SELECT 'chn-email:'||e.account_id,e.tenant_id,'ap_email:'||e.tenant_id,e.account_id,e.address,e.address,
  CASE WHEN e.status='active' AND a.status='active' THEN 'active' ELSE 'revoked' END,e.created_at,e.updated_at
FROM agentport_email_accounts e
JOIN agentport_accounts a ON a.id=e.account_id AND a.tenant_id=e.tenant_id;

UPDATE agentport_services
SET capabilities_json='["channels","email.send","email.receive","messages.read","messages.send"]',
    updated_at=datetime('now')
WHERE id LIKE 'ap_email:%';
