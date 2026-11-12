-- Keep the existing Telnyx phone owner and payer records in the shared managed-service
-- inventory. This draft manifest is deliberately not operator-verified and creates no
-- AgentPort service, grant, or managed billing entitlement.
INSERT OR IGNORE INTO managed_service_capability_versions(
  provider,service_id,version,category,operations_json,regions_json,account_modes_json,isolation_model,
  provisioning_json,metering_json,external_effects_json,evidence_json,status,created_at,updated_at)
VALUES('telnyx','phone-number',1,'telephony','["search","quote","order","configure","sms","voice","detach","release"]','[]',
  '["user_connected","naelao_managed"]','customer_provider_account',
  '{"managedOrdering":"not_enabled_by_registry","customerOrderRecovery":"read_only_customer_reference"}',
  '{"providerUsageReceipt":"existing_customer_or_operator_reconciliation"}',
  '["purchase_number","configure_callbacks","send_sms","place_call","release_number"]','[]','draft',datetime('now'),datetime('now'));

CREATE TRIGGER IF NOT EXISTS managed_service_telnyx_binding_insert
AFTER INSERT ON assistant_phone_bindings WHEN NEW.provider='telnyx'
BEGIN
  INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
    owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,lifecycle_state,metadata_json,created_at,updated_at)
  SELECT 'telnyx-'||NEW.id,i.tenant_id,i.space_id,i.project_id,'telnyx','phone-number',
    CASE WHEN NEW.payer='managed' THEN 'naelao_managed' ELSE 'user_connected' END,
    COALESCE(NEW.provider_number_sid,NEW.id),NEW.provider_account_sid,'user',i.owner_user_id,
    CASE WHEN NEW.payer='managed' THEN 'platform' ELSE 'user' END,
    CASE WHEN NEW.payer='managed' THEN 'naelao' ELSE i.owner_user_id END,
    CASE WHEN NEW.payer='managed' THEN 'organization' ELSE NULL END,
    CASE WHEN NEW.payer='managed' THEN i.tenant_id ELSE NULL END,
    CASE NEW.status WHEN 'active' THEN 'active' WHEN 'billing_hold' THEN 'billing_hold'
      WHEN 'released' THEN 'retired' WHEN 'detached' THEN 'retired' WHEN 'failed' THEN 'failed'
      WHEN 'indeterminate' THEN 'unknown' ELSE 'provisioning' END,
    json_object('phone_binding_id',NEW.id,'purpose',NEW.purpose,'payer',NEW.payer),NEW.created_at,NEW.updated_at
  FROM assistant_communication_identities i WHERE i.id=NEW.identity_id
  ON CONFLICT(id) DO UPDATE SET provider_resource_ref=excluded.provider_resource_ref,provider_account_ref=excluded.provider_account_ref,
    connection_mode=excluded.connection_mode,provider_payer_type=excluded.provider_payer_type,provider_payer_id=excluded.provider_payer_id,
    credit_payer_type=excluded.credit_payer_type,credit_payer_id=excluded.credit_payer_id,lifecycle_state=excluded.lifecycle_state,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS managed_service_telnyx_binding_update
AFTER UPDATE OF provider,payer,provider_account_sid,provider_number_sid,status,updated_at ON assistant_phone_bindings
WHEN NEW.provider='telnyx'
BEGIN
  INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
    owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,lifecycle_state,metadata_json,created_at,updated_at)
  SELECT 'telnyx-'||NEW.id,i.tenant_id,i.space_id,i.project_id,'telnyx','phone-number',
    CASE WHEN NEW.payer='managed' THEN 'naelao_managed' ELSE 'user_connected' END,
    COALESCE(NEW.provider_number_sid,NEW.id),NEW.provider_account_sid,'user',i.owner_user_id,
    CASE WHEN NEW.payer='managed' THEN 'platform' ELSE 'user' END,
    CASE WHEN NEW.payer='managed' THEN 'naelao' ELSE i.owner_user_id END,
    CASE WHEN NEW.payer='managed' THEN 'organization' ELSE NULL END,
    CASE WHEN NEW.payer='managed' THEN i.tenant_id ELSE NULL END,
    CASE NEW.status WHEN 'active' THEN 'active' WHEN 'billing_hold' THEN 'billing_hold'
      WHEN 'released' THEN 'retired' WHEN 'detached' THEN 'retired' WHEN 'failed' THEN 'failed'
      WHEN 'indeterminate' THEN 'unknown' ELSE 'provisioning' END,
    json_object('phone_binding_id',NEW.id,'purpose',NEW.purpose,'payer',NEW.payer),NEW.created_at,NEW.updated_at
  FROM assistant_communication_identities i WHERE i.id=NEW.identity_id
  ON CONFLICT(id) DO UPDATE SET provider_resource_ref=excluded.provider_resource_ref,provider_account_ref=excluded.provider_account_ref,
    connection_mode=excluded.connection_mode,provider_payer_type=excluded.provider_payer_type,provider_payer_id=excluded.provider_payer_id,
    credit_payer_type=excluded.credit_payer_type,credit_payer_id=excluded.credit_payer_id,lifecycle_state=excluded.lifecycle_state,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at;
END;

INSERT OR IGNORE INTO managed_service_accounts(
  id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
  owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,lifecycle_state,metadata_json,created_at,updated_at)
SELECT 'telnyx-'||b.id,i.tenant_id,i.space_id,i.project_id,'telnyx','phone-number',
  CASE WHEN b.payer='managed' THEN 'naelao_managed' ELSE 'user_connected' END,
  COALESCE(b.provider_number_sid,b.id),b.provider_account_sid,'user',i.owner_user_id,
  CASE WHEN b.payer='managed' THEN 'platform' ELSE 'user' END,
  CASE WHEN b.payer='managed' THEN 'naelao' ELSE i.owner_user_id END,
  CASE WHEN b.payer='managed' THEN 'organization' ELSE NULL END,
  CASE WHEN b.payer='managed' THEN i.tenant_id ELSE NULL END,
  CASE b.status WHEN 'active' THEN 'active' WHEN 'billing_hold' THEN 'billing_hold'
    WHEN 'released' THEN 'retired' WHEN 'detached' THEN 'retired' WHEN 'failed' THEN 'failed'
    WHEN 'indeterminate' THEN 'unknown' ELSE 'provisioning' END,
  json_object('phone_binding_id',b.id,'purpose',b.purpose,'payer',b.payer),b.created_at,b.updated_at
FROM assistant_phone_bindings b JOIN assistant_communication_identities i ON i.id=b.identity_id
WHERE b.provider='telnyx';
