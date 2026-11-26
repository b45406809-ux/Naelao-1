-- MS-35: the Agents worker's per-tenant Naelao Email API key (managed offering off_naelao_email_inbox_v1). Not applied remotely.
-- key_envelope_json is an authenticated-encryption envelope (@naelao/crypto, AES-256-GCM, key derived from PLATFORM_SECRET and the
-- tenant id, additional data bound to the tenant). The plaintext key is never stored, returned or logged.
CREATE TABLE IF NOT EXISTS managed_naelao_email_tenants (
  tenant_id TEXT PRIMARY KEY,
  nemail_tenant_id TEXT NOT NULL UNIQUE,
  key_envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
