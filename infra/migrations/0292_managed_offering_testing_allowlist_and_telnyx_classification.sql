-- MS-28 (V-spec §6.2, MR-CAT-3, MR-RES-1): fail-closed admission support and the MS-27 trigger gap.
-- Not applied to any remote database by the repository.

-- Offerings in status 'testing' are admitted only for tenants on this operator-managed allowlist
-- (JSON array of tenant ids). Stored as offering data so it is audited with every offering write.
ALTER TABLE managed_service_offerings ADD COLUMN testing_tenant_ids_json TEXT NOT NULL DEFAULT '[]';

-- The 0202 Telnyx registry triggers inserted managed_service_accounts rows without access_mode or
-- provisioning_strategy, so rows created after the 0291 backfill stayed unclassified. Recreate them
-- with the same behaviour plus the MR-RES-1 mapping from the payer-derived connection_mode
-- (naelao_managed -> managed/managed_master, user_connected -> byok/customer_connection).
DROP TRIGGER IF EXISTS managed_service_telnyx_binding_insert;
CREATE TRIGGER managed_service_telnyx_binding_insert
AFTER INSERT ON assistant_phone_bindings WHEN NEW.provider='telnyx'
BEGIN
  INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
    owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,lifecycle_state,metadata_json,created_at,updated_at,
    access_mode,provisioning_strategy)
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
    json_object('phone_binding_id',NEW.id,'purpose',NEW.purpose,'payer',NEW.payer),NEW.created_at,NEW.updated_at,
    CASE WHEN NEW.payer='managed' THEN 'managed' ELSE 'byok' END,
    CASE WHEN NEW.payer='managed' THEN 'managed_master' ELSE 'customer_connection' END
  FROM assistant_communication_identities i WHERE i.id=NEW.identity_id
  ON CONFLICT(id) DO UPDATE SET provider_resource_ref=excluded.provider_resource_ref,provider_account_ref=excluded.provider_account_ref,
    connection_mode=excluded.connection_mode,provider_payer_type=excluded.provider_payer_type,provider_payer_id=excluded.provider_payer_id,
    credit_payer_type=excluded.credit_payer_type,credit_payer_id=excluded.credit_payer_id,lifecycle_state=excluded.lifecycle_state,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,
    access_mode=excluded.access_mode,provisioning_strategy=excluded.provisioning_strategy;
END;

DROP TRIGGER IF EXISTS managed_service_telnyx_binding_update;
CREATE TRIGGER managed_service_telnyx_binding_update
AFTER UPDATE OF provider,payer,provider_account_sid,provider_number_sid,status,updated_at ON assistant_phone_bindings
WHEN NEW.provider='telnyx'
BEGIN
  INSERT INTO managed_service_accounts(
    id,tenant_id,space_id,project_id,provider,service_id,connection_mode,provider_resource_ref,provider_account_ref,
    owner_type,owner_id,provider_payer_type,provider_payer_id,credit_payer_type,credit_payer_id,lifecycle_state,metadata_json,created_at,updated_at,
    access_mode,provisioning_strategy)
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
    json_object('phone_binding_id',NEW.id,'purpose',NEW.purpose,'payer',NEW.payer),NEW.created_at,NEW.updated_at,
    CASE WHEN NEW.payer='managed' THEN 'managed' ELSE 'byok' END,
    CASE WHEN NEW.payer='managed' THEN 'managed_master' ELSE 'customer_connection' END
  FROM assistant_communication_identities i WHERE i.id=NEW.identity_id
  ON CONFLICT(id) DO UPDATE SET provider_resource_ref=excluded.provider_resource_ref,provider_account_ref=excluded.provider_account_ref,
    connection_mode=excluded.connection_mode,provider_payer_type=excluded.provider_payer_type,provider_payer_id=excluded.provider_payer_id,
    credit_payer_type=excluded.credit_payer_type,credit_payer_id=excluded.credit_payer_id,lifecycle_state=excluded.lifecycle_state,
    metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,
    access_mode=excluded.access_mode,provisioning_strategy=excluded.provisioning_strategy;
END;

-- Classify rows the old triggers wrote after the 0291 backfill (same MR-RES-1 mapping; only
-- rows whose classification is still unset are touched).
UPDATE managed_service_accounts
   SET access_mode = CASE connection_mode
         WHEN 'naelao_managed' THEN 'managed'
         WHEN 'user_connected' THEN 'byok'
         WHEN 'provider_managed' THEN 'managed'
       END,
       provisioning_strategy = CASE connection_mode
         WHEN 'naelao_managed' THEN 'managed_master'
         WHEN 'user_connected' THEN 'customer_connection'
         WHEN 'provider_managed' THEN 'native_subaccount'
       END
 WHERE access_mode IS NULL AND provisioning_strategy IS NULL;
