-- MS-29 operator seed: offerings and commercial agreements for the existing managed paths.
--
-- NEVER AUTO-APPLIED. OPERATOR REVIEW REQUIRED. Nothing in the repository, CI or a deploy runs this file.
-- Apply it by hand to one environment at a time, after reading it, with:
--   wrangler d1 execute <PLATFORM_DB> --env <env> --file docs/operations/managed-offerings-seed.sql
--
-- Prerequisites: migrations 0291 and 0292 are applied, and the capability rows below exist
-- (agentmail/agentmail v1 from 0179, cloudflare/workers-ai v1 from 0210).
--
-- Safe by construction: offerings are inserted as 'draft' and agreements as 'unverified'. With
-- MANAGED_OFFERINGS_ENABLED="false" (every worker default) these rows change no behaviour. They only
-- matter once an operator (a) verifies the capability version, (b) sets the offering to 'available' and
-- (c) approves the agreement through the MS-28 operator routes
--   POST /internal/managed-services/offerings/:id
--   POST /internal/managed-services/agreements/:id/approve
-- (each write is audited with actor and reason) AND the owner turns the flag on. Turning the flag on is an
-- owner decision, not part of this script. INSERT OR IGNORE: re-running never overwrites an operator edit.
--
-- What each row encodes (it reproduces the rules Billing hard-coded before MS-29):
--   agentmail:agentmail      quote_policy 'required_for_recurring' -> a quote is required for provision and
--                            renew; send, read, search and the rest reserve quote-less (MS-19 AgentMail send).
--   cloudflare:workers-ai    quote_policy 'always' -> every generate-text reservation needs its consumed quote.
-- Strategies: Billing reserves Naelao credits for Naelao-managed resources, so it tries 'first_party' then
-- 'managed_master' (see workers/billing/src/managed-reserve-policy.ts). AgentMail is distributed under a
-- standard-terms agreement that permits master-account distribution; Workers AI is Naelao's own Cloudflare
-- account, so its agreement is type 'first_party'.
-- charge_components_json is '[]' on purpose: real prices and provider terms are the operator's to enter.
-- Timestamps are epoch milliseconds (2026-11-26T00:00:00Z = 1795651200000).

INSERT OR IGNORE INTO managed_service_offerings(
  id, provider, service_id, capability_version, resource_type, category, display_name,
  access_modes_json, strategies_json, regions_json, configuration_schema_json, charge_components_json,
  quote_policy, data_handling_json, preference_rank, status, created_at, updated_at)
VALUES
  ('offering-agentmail-agentmail', 'agentmail', 'agentmail', 1, 'inbox', 'email', 'AgentMail inbox',
   '["managed"]', '["managed_master"]', '["us"]', '{}', '[]',
   'required_for_recurring', '{}', 100, 'draft', 1795651200000, 1795651200000),
  ('offering-cloudflare-workers-ai', 'cloudflare', 'workers-ai', 1, 'model_inference', 'model', 'Workers AI text generation',
   '["managed"]', '["first_party"]', '["global"]', '{}', '[]',
   'always', '{}', 100, 'draft', 1795651200000, 1795651200000);

INSERT OR IGNORE INTO managed_service_commercial_agreements(
  id, provider, agreement_type, permitted_offering_ids_json,
  permits_managed_provisioning, permits_master_account_distribution, permits_subaccount_distribution, permits_shared_resources,
  permitted_regions_json, effective_from, expires_at, verification_status, evidence_sha256, approved_by, approved_at,
  created_at, updated_at)
VALUES
  ('agreement-agentmail-standard', 'agentmail', 'standard_terms', '["offering-agentmail-agentmail"]',
   1, 1, 0, 0, '["us"]', 1795651200000, NULL, 'unverified', NULL, NULL, NULL, 1795651200000, 1795651200000),
  ('agreement-cloudflare-first-party', 'cloudflare', 'first_party', '["offering-cloudflare-workers-ai"]',
   1, 0, 0, 0, '["global"]', 1795651200000, NULL, 'unverified', NULL, NULL, NULL, 1795651200000, 1795651200000);

-- Audit rows for the seed itself.
INSERT OR IGNORE INTO managed_service_offering_audit(id, offering_id, actor_id, before_json, after_json, reason, created_at)
VALUES
  ('seed-ms29-offering-agentmail', 'offering-agentmail-agentmail', 'operator-seed-script', NULL, '{"status":"draft"}', 'MS-29 seed (draft, operator review required)', 1795651200000),
  ('seed-ms29-offering-workers-ai', 'offering-cloudflare-workers-ai', 'operator-seed-script', NULL, '{"status":"draft"}', 'MS-29 seed (draft, operator review required)', 1795651200000);
INSERT OR IGNORE INTO managed_service_commercial_agreement_audit(id, agreement_id, actor_id, before_json, after_json, reason, created_at)
VALUES
  ('seed-ms29-agreement-agentmail', 'agreement-agentmail-standard', 'operator-seed-script', NULL, '{"verification_status":"unverified"}', 'MS-29 seed (unverified, operator review required)', 1795651200000),
  ('seed-ms29-agreement-cloudflare', 'agreement-cloudflare-first-party', 'operator-seed-script', NULL, '{"verification_status":"unverified"}', 'MS-29 seed (unverified, operator review required)', 1795651200000);

-- ---------------------------------------------------------------------------------------------------------------------
-- MS-35: Naelao Email (first-party managed inbox, V-spec MD-10 / OD-3).
--
-- NEVER AUTO-APPLIED. OPERATOR REVIEW REQUIRED. Prerequisites: migrations 0291, 0292, 0294-0300 are applied, Naelao Email has a
-- managed domain (OD-2), an R2 bucket and the NEMAIL_WEBHOOK_KEY secret, and NAELAO_EMAIL_ENABLED is on in workers/email.
--
-- What is inserted (all safe by construction, none of it changes behaviour while MANAGED_OFFERINGS_ENABLED is "false"):
--   * a DRAFT capability version naelao/email v1 (status 'draft', no verifier, no expiry: admission rejects it as
--     capability_unsupported until an operator verifies it with the capability verify routes);
--   * the offering off_naelao_email_inbox_v1 with status 'testing' (admitted only for tenants an operator lists in
--     testing_tenant_ids_json, '[]' = nobody), quote_policy 'required_for_recurring' (a quote for provision/renew, none for send/read);
--   * a 'first_party' agreement in status 'unverified' (admission answers provider_not_approved until an operator approves it
--     through POST /internal/managed-services/agreements/:id/approve).
-- Price (OD-3, a starting rate revisited after 30 days of measured cost; 1 credit = $0.01):
--   rental 100 credits per month, which includes 1,000 sends (meter email.message.sent);
--   usage 10 credits per additional 1,000 sends, rounded up per settlement (D8).
-- Release 1 plan limits (MR-EM-8): 10 inboxes per tenant, new-tenant 100 sends/day for 14 days then 1,000/day.
-- Region 'global': Naelao Email has one deployment. Timestamps are epoch milliseconds (2026-11-26T00:00:00Z = 1795651200000);
-- capability timestamps are ISO-8601. INSERT OR IGNORE: re-running never overwrites an operator edit.
-- ---------------------------------------------------------------------------------------------------------------------

INSERT OR IGNORE INTO managed_service_capability_versions(
  provider, service_id, version, category, operations_json, regions_json, account_modes_json,
  isolation_model, provisioning_json, metering_json, external_effects_json, evidence_json,
  status, created_at, updated_at)
VALUES
  ('naelao', 'email', 1, 'email',
   '["provision","deprovision","lookup","send","read"]', '["global"]', '["naelao_managed"]',
   'tenant_scoped_inboxes',
   '{"createIdempotency":"idempotency_key_header","unknownCreateRecovery":"lookup","scopedCredential":"per_tenant_api_key"}',
   '{"meters":["email.message.sent","email.storage"],"priceVersion":"operator_required"}',
   '["create_inbox","delete_inbox","send_message"]',
   '[]',
   'draft', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z');

INSERT OR IGNORE INTO managed_service_offerings(
  id, provider, service_id, capability_version, resource_type, category, display_name,
  access_modes_json, strategies_json, regions_json, configuration_schema_json, charge_components_json,
  quote_policy, data_handling_json, preference_rank, status, testing_tenant_ids_json, created_at, updated_at)
VALUES
  ('off_naelao_email_inbox_v1', 'naelao', 'email', 1, 'inbox', 'email', 'Naelao Email inbox',
   '["managed"]', '["first_party"]', '["global"]',
   '{"type":"object","properties":{"local_part":{"type":"string"},"display_name":{"type":"string","maxLength":120}},"additionalProperties":false}',
   '[{"kind":"rental","interval":"month","credits":100,"included_sends":1000},{"kind":"usage","meter":"email.message.sent","included":1000,"unit_credits_per":{"qty":1000,"credits":10}}]',
   'required_for_recurring',
   '{"operator":"naelao","subprocessors":["cloudflare"],"regions":["global"],"retention":"messages kept until the inbox is deleted"}',
   100, 'testing', '[]', 1795651200000, 1795651200000);

INSERT OR IGNORE INTO managed_service_commercial_agreements(
  id, provider, agreement_type, permitted_offering_ids_json,
  permits_managed_provisioning, permits_master_account_distribution, permits_subaccount_distribution, permits_shared_resources,
  permitted_regions_json, effective_from, expires_at, verification_status, evidence_sha256, approved_by, approved_at,
  created_at, updated_at)
VALUES
  ('agreement-naelao-email-first-party', 'naelao', 'first_party', '["off_naelao_email_inbox_v1"]',
   1, 0, 0, 0, '["global"]', 1795651200000, NULL, 'unverified', NULL, NULL, NULL, 1795651200000, 1795651200000);

INSERT OR IGNORE INTO managed_service_offering_audit(id, offering_id, actor_id, before_json, after_json, reason, created_at)
VALUES
  ('seed-ms35-offering-naelao-email', 'off_naelao_email_inbox_v1', 'operator-seed-script', NULL, '{"status":"testing","testing_tenant_ids":[]}', 'MS-35 seed (testing, nobody admitted, operator review required)', 1795651200000);
INSERT OR IGNORE INTO managed_service_commercial_agreement_audit(id, agreement_id, actor_id, before_json, after_json, reason, created_at)
VALUES
  ('seed-ms35-agreement-naelao-email', 'agreement-naelao-email-first-party', 'operator-seed-script', NULL, '{"verification_status":"unverified"}', 'MS-35 seed (unverified, operator review required)', 1795651200000);
